import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import SunCalc from 'suncalc';
import { join } from 'path';

import { OWNER, INSTANCE_ID, PORT, LAT, LON, PUBLIC_DIR } from './config.js';
import { createTransport } from './transport.js';
import * as store from './store.js';
import * as messaging from './messaging.js';
import * as db from './db.js';
import * as logger from './logger.js';
import { sysLog } from './logger.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Topology lives behind the transport seam (p2p | broker). Created early so the
// routes and connection handler below can read its peer list.
const transport = createTransport({ io });

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
app.get('/display', (req, res) => res.sendFile(join(PUBLIC_DIR, 'display.html')));
app.get('/settings', (req, res) => res.sendFile(join(PUBLIC_DIR, 'settings.html')));
app.get('/history', (req, res) => res.sendFile(join(PUBLIC_DIR, 'history.html')));
app.get('/logs', (req, res) => res.sendFile(join(PUBLIC_DIR, 'logs.html')));

app.get('/me', (req, res) => {
  res.json({ owner: OWNER, instanceId: INSTANCE_ID, transport: transport.health() });
});

app.get('/peers', (req, res) => {
  res.json(transport.listPeers());
});

app.get('/theme-schedule', (req, res) => {
  const now = new Date();
  const today = SunCalc.getTimes(now, LAT, LON);
  const tomorrow = SunCalc.getTimes(new Date(now.getTime() + 24 * 3600 * 1000), LAT, LON);
  res.json({
    sunrise: today.sunrise.toISOString(),
    sunset: today.sunset.toISOString(),
    nextSunrise: tomorrow.sunrise.toISOString(),
  });
});

app.get('/history.json', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  res.json({ owner: OWNER, groups: db.listGroupedByDay(limit) });
});

app.get('/logs.json', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
  const category = typeof req.query.category === 'string' && req.query.category !== 'all'
    ? req.query.category
    : null;
  res.json({ owner: OWNER, events: db.listEvents({ limit, category }) });
});

app.post('/logs/cleanup', (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.body?.days) || 7));
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const removed = db.cleanupEvents(cutoff);
  sysLog('logs:cleanup', `${removed} évènements antérieurs à ${days} j supprimés`, { days, removed });
  res.json({ ok: true, removed });
});

io.on('connection', (socket) => {
  socket.emit('peers:init', transport.listPeers());
  socket.emit('transport:health', transport.health());
});

db.init();
logger.init({ io });
await store.init({ app, io });
messaging.init({ app, io, transport });
transport.init();

httpServer.listen(PORT, () => {
  console.log(`Crema — ${OWNER} on http://localhost:${PORT}`);
  sysLog('server:start', `Crema démarré (${OWNER}) sur port ${PORT}`, { owner: OWNER, port: PORT, instanceId: INSTANCE_ID });
});

function shutdown() {
  console.log('\nArrêt…');
  sysLog('server:stop', 'Crema en cours d\'arrêt');
  transport.stop();
  db.close();
  // 2s grace to let the mDNS "bye" packet reach peers, so they don't keep us
  // in their peerMap until avahi's ~2 min TTL expires. systemd's default
  // TimeoutStopSec is 90s, so this is well within budget.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
