import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import SunCalc from 'suncalc';
import { join } from 'path';

import { OWNER, INSTANCE_ID, PORT, LAT, LON, PUBLIC_DIR } from './config.js';
import * as peers from './peers.js';
import * as store from './store.js';
import * as messaging from './messaging.js';
import * as db from './db.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
app.get('/display', (req, res) => res.sendFile(join(PUBLIC_DIR, 'display.html')));
app.get('/settings', (req, res) => res.sendFile(join(PUBLIC_DIR, 'settings.html')));
app.get('/history', (req, res) => res.sendFile(join(PUBLIC_DIR, 'history.html')));

app.get('/me', (req, res) => {
  res.json({ owner: OWNER, instanceId: INSTANCE_ID });
});

app.get('/peers', (req, res) => {
  res.json(peers.listPeers());
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

io.on('connection', (socket) => {
  socket.emit('peers:init', peers.listPeers());
});

db.init();
await store.init({ app, io });
messaging.init({ app, io });
const peerLifecycle = peers.init({ io });

httpServer.listen(PORT, () => {
  console.log(`Crema — ${OWNER} on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nArrêt…');
  peerLifecycle.stop();
  db.close();
  // 2s grace to let the mDNS "bye" packet reach peers, so they don't keep us
  // in their peerMap until avahi's ~2 min TTL expires. systemd's default
  // TimeoutStopSec is 90s, so this is well within budget.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
