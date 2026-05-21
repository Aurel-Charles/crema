// Broker protocol regression test: boots the broker as a child process and
// drives two simulated Pis (Aurel, Flo) through it, asserting the
// docs/broker-protocol.md contract. Run from broker/: `npm test`.
import { io as ioClient } from 'socket.io-client';
import { spawn } from 'child_process';

const PORT = 4555;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { (cond ? pass++ : fail++); console.log(`${cond ? '✅' : '❌'} ${msg}`); };

// Boot the broker as a child process (real entrypoint).
const broker = spawn('node', ['server.js'], {
  env: { ...process.env, BROKER_PORT: String(PORT) },
  stdio: 'ignore',
});

function client() {
  const s = ioClient(URL, { reconnection: false });
  const events = [];
  for (const ev of ['peers', 'peer:up', 'peer:down', 'deliver', 'profile:update', 'register:denied']) {
    s.on(ev, (data) => events.push({ ev, data }));
  }
  return { s, events };
}

const deliver = (s, to, kind, payload) =>
  new Promise((resolve) => s.emit('deliver', { to, kind, payload }, resolve));

try {
  await wait(600); // let the broker bind

  // --- Aurel registers (alone) ---
  const aurel = client();
  await new Promise((r) => aurel.s.on('connect', r));
  aurel.s.emit('register', { owner: 'Aurel', instanceId: 'aurel-1', nickname: 'Bureau' });
  await wait(200);
  ok(aurel.events.some((e) => e.ev === 'peers' && e.data.length === 0),
    'Aurel reçoit un roster vide (seul)');

  // --- Flo registers → Aurel should see peer:up, Flo gets roster with Aurel ---
  const flo = client();
  await new Promise((r) => flo.s.on('connect', r));
  flo.s.emit('register', { owner: 'Flo', instanceId: 'flo-1' });
  await wait(200);
  ok(flo.events.some((e) => e.ev === 'peers' && e.data.some((p) => p.owner === 'Aurel')),
    'Flo reçoit un roster contenant Aurel');
  ok(flo.events.some((e) => e.ev === 'peers'
      && e.data.some((p) => p.owner === 'Aurel' && p.nickname === 'Bureau')),
    'Le roster porte le surnom d’Aurel (« Bureau »)');
  ok(aurel.events.some((e) => e.ev === 'peer:up' && e.data.owner === 'Flo'),
    'Aurel reçoit peer:up pour Flo');

  // --- deliver by owner: Aurel → Flo inbox ---
  flo.events.length = 0;
  let ack = await deliver(aurel.s, { owner: 'Flo' }, 'inbox', { id: 'm1', text: 'salut' });
  ok(ack?.ok === true, 'deliver(owner) → ack {ok:true}');
  await wait(100);
  ok(flo.events.some((e) => e.ev === 'deliver' && e.data.kind === 'inbox'
      && e.data.payload.text === 'salut' && e.data.from.owner === 'Aurel'),
    'Flo reçoit le deliver inbox avec from=Aurel');

  // --- deliver by instanceId: Flo → Aurel read-receipt ---
  aurel.events.length = 0;
  ack = await deliver(flo.s, { instanceId: 'aurel-1' }, 'read-receipt', { id: 'm1' });
  ok(ack?.ok === true, 'deliver(instanceId) → ack {ok:true}');
  await wait(100);
  ok(aurel.events.some((e) => e.ev === 'deliver' && e.data.kind === 'read-receipt'
      && e.data.payload.id === 'm1'),
    'Aurel reçoit le read-receipt routé par instanceId');

  // --- deliver to unknown target → offline ---
  ack = await deliver(aurel.s, { owner: 'Fantome' }, 'inbox', { text: 'x' });
  ok(ack?.ok === false && ack.error === 'offline', 'deliver vers inconnu → {ok:false, offline}');

  // --- profile:update (V7.1): Aurel renomme → Flo est notifié, pas Aurel ---
  flo.events.length = 0;
  aurel.events.length = 0;
  aurel.s.emit('profile:update', { nickname: 'Salon' });
  await wait(150);
  ok(flo.events.some((e) => e.ev === 'profile:update' && e.data.owner === 'Aurel'
      && e.data.instanceId === 'aurel-1' && e.data.nickname === 'Salon'),
    'Flo reçoit le profile:update d’Aurel (owner immuable, surnom « Salon »)');
  ok(!aurel.events.some((e) => e.ev === 'profile:update'),
    'Aurel ne se reçoit pas lui-même (broadcast aux autres seulement)');

  // --- same-owner dedup: Flo reconnects with a new instanceId ---
  aurel.events.length = 0;
  const flo2 = client();
  await new Promise((r) => flo2.s.on('connect', r));
  flo2.s.emit('register', { owner: 'Flo', instanceId: 'flo-2' });
  await wait(250);
  ok(aurel.events.some((e) => e.ev === 'peer:down' && e.data.instanceId === 'flo-1'),
    'Dedup : Aurel voit peer:down de l’ancienne instance flo-1');
  ok(aurel.events.some((e) => e.ev === 'peer:up' && e.data.instanceId === 'flo-2'),
    'Dedup : Aurel voit peer:up de la nouvelle instance flo-2');

  // --- disconnect → peer:down ---
  aurel.events.length = 0;
  flo2.s.disconnect();
  await wait(250);
  ok(aurel.events.some((e) => e.ev === 'peer:down' && e.data.instanceId === 'flo-2'),
    'Déconnexion de Flo → Aurel reçoit peer:down');

  aurel.s.disconnect();
} catch (err) {
  console.error('Test crashed:', err);
  fail++;
} finally {
  broker.kill();
  console.log(`\n${pass} passés, ${fail} échoués`);
  process.exit(fail > 0 ? 1 : 0);
}
