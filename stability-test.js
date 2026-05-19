// Stability test harness — runs alongside the live Crema server and probes it
// from outside to detect drop-outs over long periods (typical run: 24h).
//
// Probes:
//   - GET /me on localhost every 5s   → Node process alive + instanceId rotation
//   - GET /peers on localhost every 15s → mDNS discovery still seeing the peer
//   - GET /me on peer hostname every 30s → cross-Pi HTTP reachability
//   - System metrics every 60s        → CPU temp, load, free RAM, Wi-Fi signal
//   - Heartbeat every 60s             → so the log shows it's alive
//   - Summary every hour              → consolidated stats
//   - Final summary on SIGINT/SIGTERM
//
// Usage:
//   node stability-test.js                  # auto-pick peer hostname
//   node stability-test.js pi-flo.local     # explicit peer
//
// Output:
//   logs/stability-<hostname>-<date>.jsonl  (one JSON event per line)
//   console (one heartbeat line per minute, all failures live)
//
// Stop with Ctrl+C — a final summary is printed and appended to the log.

import { hostname } from 'os';
import { execSync } from 'child_process';
import { mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';

const PORT = Number(process.env.PORT ?? 3000);
const LOCAL = `http://localhost:${PORT}`;
const HOST = hostname().replace(/\.local$/, '');

// Auto-pick the OTHER known Pi hostname when none is passed.
const KNOWN_PEERS = ['pi-aurel.local', 'pi-flo.local'];
const PEER_HOST = process.argv[2]
  ?? KNOWN_PEERS.find((h) => !h.startsWith(`${HOST}.`));

const LOG_DIR = join(process.cwd(), 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const today = new Date().toISOString().split('T')[0];
const LOG_FILE = join(LOG_DIR, `stability-${HOST}-${today}.jsonl`);
const log = createWriteStream(LOG_FILE, { flags: 'a' });

const startedAt = Date.now();
const stats = {
  local: { ok: 0, fail: 0, latSum: 0, latMax: 0, restarts: 0 },
  peers: { checks: 0, empty: 0, present: 0, transitions: 0 },
  peerHttp: { ok: 0, fail: 0, latSum: 0, latMax: 0 },
  sys: { thermalEvents: 0, loadEvents: 0, memEvents: 0 },
};
let lastInstanceId = null;
let lastPeerCount = null;
let lastPeerListSig = null;
let lastConsoleHeartbeat = 0;
const recentFailures = []; // ring buffer of last 20 failures for the summary

function emit(event, data = {}, level = 'info') {
  const entry = { t: new Date().toISOString(), level, event, ...data };
  log.write(JSON.stringify(entry) + '\n');
  if (level !== 'info' || event === 'heartbeat' || event === 'summary:hour' || event === 'summary:final' || event === 'start') {
    const tag = level === 'error' ? 'ERR ' : level === 'warn' ? 'WARN' : '    ';
    console.log(`${entry.t}  ${tag}  ${event}  ${shortData(data)}`);
  }
  if (level !== 'info') {
    recentFailures.push(entry);
    if (recentFailures.length > 20) recentFailures.shift();
  }
}

function shortData(data) {
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}

async function fetchJson(url, timeoutMs = 3000) {
  const start = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  return { body, ms: Date.now() - start };
}

// ─── Probe: local server ────────────────────────────────────────────────────
async function probeLocal() {
  try {
    const { body, ms } = await fetchJson(`${LOCAL}/me`, 2000);
    stats.local.ok++;
    stats.local.latSum += ms;
    if (ms > stats.local.latMax) stats.local.latMax = ms;

    if (lastInstanceId && body.instanceId !== lastInstanceId) {
      stats.local.restarts++;
      emit('local:server-restarted', {
        owner: body.owner,
        oldInstanceId: lastInstanceId.slice(0, 8),
        newInstanceId: body.instanceId.slice(0, 8),
      }, 'warn');
    }
    lastInstanceId = body.instanceId;
  } catch (err) {
    stats.local.fail++;
    emit('local:ping-fail', { err: err.message }, 'error');
  }
}

// ─── Probe: peer discovery via /peers ───────────────────────────────────────
async function probePeers() {
  stats.peers.checks++;
  try {
    const { body: peerList } = await fetchJson(`${LOCAL}/peers`, 2000);
    const count = peerList.length;
    const sig = peerList.map((p) => `${p.owner}:${p.instanceId.slice(0, 8)}`).sort().join(',');

    if (count === 0) stats.peers.empty++;
    else stats.peers.present++;

    if (lastPeerCount === null) {
      emit('peers:initial', { count, peers: sig });
    } else if (sig !== lastPeerListSig) {
      stats.peers.transitions++;
      const level = count < (lastPeerCount ?? 0) ? 'warn' : 'info';
      emit('peers:changed', { from: lastPeerListSig, to: sig, count }, level);
    }
    lastPeerCount = count;
    lastPeerListSig = sig;
  } catch (err) {
    emit('peers:check-fail', { err: err.message }, 'error');
  }
}

// ─── Probe: direct HTTP to peer hostname ────────────────────────────────────
async function probePeerHttp() {
  if (!PEER_HOST) return;
  try {
    const { body, ms } = await fetchJson(`http://${PEER_HOST}:${PORT}/me`, 3000);
    stats.peerHttp.ok++;
    stats.peerHttp.latSum += ms;
    if (ms > stats.peerHttp.latMax) stats.peerHttp.latMax = ms;
    // Only log if latency is suspicious — keeps the log readable.
    if (ms > 1000) emit('peer-http:slow', { peer: body.owner, ms }, 'warn');
  } catch (err) {
    stats.peerHttp.fail++;
    emit('peer-http:fail', { host: PEER_HOST, err: err.message }, 'error');
  }
}

// ─── Probe: system metrics (Pi-specific, gracefully degrades) ───────────────
function safeExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim(); }
  catch { return null; }
}

function probeSystem() {
  const tempRaw = safeExec('vcgencmd measure_temp');
  const tempC = tempRaw ? Number(tempRaw.replace(/[^\d.]/g, '')) : null;

  const loadRaw = safeExec('cat /proc/loadavg');
  const load1 = loadRaw ? Number(loadRaw.split(' ')[0]) : null;

  const memRaw = safeExec("free -m | awk '/^Mem:/{print $2,$7}'");
  let memTotal = null, memAvail = null, memPct = null;
  if (memRaw) {
    const [t, a] = memRaw.split(' ').map(Number);
    memTotal = t; memAvail = a;
    memPct = Math.round(((t - a) / t) * 100);
  }

  const wifiRaw = safeExec("iwconfig wlan0 2>/dev/null | grep -E 'Link Quality|Signal level'");
  let signal = null, quality = null;
  if (wifiRaw) {
    const sigMatch = wifiRaw.match(/Signal level=(-?\d+)/);
    const qualMatch = wifiRaw.match(/Link Quality=(\d+)\/(\d+)/);
    if (sigMatch) signal = Number(sigMatch[1]);
    if (qualMatch) quality = `${qualMatch[1]}/${qualMatch[2]}`;
  }

  const data = { tempC, load1, memPct, memAvail, signal, quality };

  // Threshold alerts — cross at low frequency so we don't spam.
  if (tempC !== null && tempC > 75) { stats.sys.thermalEvents++; emit('sys:hot', data, 'warn'); }
  if (load1 !== null && load1 > 2) { stats.sys.loadEvents++; emit('sys:load-high', data, 'warn'); }
  if (memPct !== null && memPct > 85) { stats.sys.memEvents++; emit('sys:mem-high', data, 'warn'); }

  return data;
}

// ─── Heartbeat: one console line per minute ─────────────────────────────────
function heartbeat() {
  const sys = probeSystem();
  const uptimeMs = Date.now() - startedAt;
  const uptimeStr = formatDuration(uptimeMs);
  const localAvg = stats.local.ok ? Math.round(stats.local.latSum / stats.local.ok) : 0;
  const peerAvg = stats.peerHttp.ok ? Math.round(stats.peerHttp.latSum / stats.peerHttp.ok) : 0;
  emit('heartbeat', {
    uptime: uptimeStr,
    localOK: stats.local.ok,
    localFail: stats.local.fail,
    localAvgMs: localAvg,
    peerOK: stats.peerHttp.ok,
    peerFail: stats.peerHttp.fail,
    peerAvgMs: peerAvg,
    peerCount: lastPeerCount,
    restarts: stats.local.restarts,
    tempC: sys.tempC,
    load1: sys.load1,
    memPct: sys.memPct,
    signal: sys.signal,
  });
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

// ─── Summary (hourly + final) ───────────────────────────────────────────────
function summarize(kind) {
  const uptimeMs = Date.now() - startedAt;
  const localUptimePct = stats.local.ok + stats.local.fail > 0
    ? ((stats.local.ok / (stats.local.ok + stats.local.fail)) * 100).toFixed(2)
    : '—';
  const peerHttpUptimePct = stats.peerHttp.ok + stats.peerHttp.fail > 0
    ? ((stats.peerHttp.ok / (stats.peerHttp.ok + stats.peerHttp.fail)) * 100).toFixed(2)
    : '—';
  const peerDiscoveryPct = stats.peers.checks > 0
    ? ((stats.peers.present / stats.peers.checks) * 100).toFixed(2)
    : '—';
  emit(kind, {
    uptime: formatDuration(uptimeMs),
    localUptimePct,
    localRestarts: stats.local.restarts,
    localAvgMs: stats.local.ok ? Math.round(stats.local.latSum / stats.local.ok) : 0,
    localMaxMs: stats.local.latMax,
    peerHttpUptimePct,
    peerHttpAvgMs: stats.peerHttp.ok ? Math.round(stats.peerHttp.latSum / stats.peerHttp.ok) : 0,
    peerHttpMaxMs: stats.peerHttp.latMax,
    peerDiscoveryPct,
    peerTransitions: stats.peers.transitions,
    thermalEvents: stats.sys.thermalEvents,
    loadEvents: stats.sys.loadEvents,
    memEvents: stats.sys.memEvents,
  });
}

// ─── Boot ───────────────────────────────────────────────────────────────────
emit('start', {
  host: HOST,
  pid: process.pid,
  port: PORT,
  peerHost: PEER_HOST ?? '(none)',
  logFile: LOG_FILE,
});

const intervals = [
  setInterval(probeLocal, 5_000),
  setInterval(probePeers, 15_000),
  setInterval(probePeerHttp, 30_000),
  setInterval(heartbeat, 60_000),
  setInterval(() => summarize('summary:hour'), 3600_000),
];

// Initial run so the log shows state at t=0.
probeLocal();
probePeers();
probePeerHttp();

function shutdown() {
  console.log('\nArrêt en cours, génération du résumé final…');
  for (const i of intervals) clearInterval(i);
  summarize('summary:final');
  if (recentFailures.length > 0) {
    console.log('\nDernières alertes :');
    for (const f of recentFailures.slice(-10)) {
      console.log(`  ${f.t}  ${f.level.toUpperCase()}  ${f.event}  ${shortData(f)}`);
    }
  }
  log.end(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
