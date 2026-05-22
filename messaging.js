import { randomUUID } from 'crypto';
import { INSTANCE_ID, OWNER, MAX_LABEL_LENGTH, MAX_REPLIES } from './config.js';
import { clampTtl, findShortcut, getDefaultTarget } from './store.js';
import * as db from './db.js';
import { msgLog, errLog } from './logger.js';

const trunc = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// When /send succeeds, the message is kept here until either:
//   - the peer replies (we get an inbound delivery with replyToMsgId), or
//   - the TTL elapses (we emit msg:expired to our own display).
const pendingMessages = new Map(); // msgId -> { text, targetOwner, expiresAt, timer }

function sanitizeResponseOptions(input) {
  if (!Array.isArray(input)) return [];
  const cleaned = [];
  const seen = new Set();
  for (const item of input) {
    const label = typeof item === 'string'
      ? item.trim()
      : (typeof item?.label === 'string' ? item.label.trim() : '');
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    cleaned.push({ label });
    if (cleaned.length >= MAX_REPLIES) break;
  }
  return cleaned;
}

function trackPending({ id, text, targetOwner, expiresAt, io }) {
  const ttl = expiresAt - Date.now();
  const timer = setTimeout(() => {
    const entry = pendingMessages.get(id);
    if (!entry) return;
    pendingMessages.delete(id);
    msgLog('msg:expired', `« ${trunc(text)} » sans réponse de ${targetOwner}`, { id, targetOwner });
    io.emit('msg:expired', { id, text, targetOwner });
    db.setStatus(id, 'expired');
    io.emit('msg:status', { id, status: 'expired' });
  }, Math.max(0, ttl));
  pendingMessages.set(id, { text, targetOwner, expiresAt, timer });
}

function resolvePending(id) {
  const entry = pendingMessages.get(id);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingMessages.delete(id);
  return entry;
}

// ===== Inbound handlers (transport-agnostic) =====
//
// These hold all the receive-side logic. They are invoked either by the HTTP
// routes below (P2P transport: a peer POSTs directly) or by transport.onDeliver
// (broker transport: the broker pushes over WebSocket). The transport only
// decides how the bytes arrive — the handling is identical. Each returns
// { ok: true } or { ok: false, error } so the HTTP routes can map to a status.

function handleIncoming(payload, io) {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  const from = typeof payload?.from === 'string' ? payload.from.trim() : 'Inconnu';
  const fromInstanceId = typeof payload?.fromInstanceId === 'string' ? payload.fromInstanceId : null;
  const isReply = payload?.isReply === true;
  const id = typeof payload?.id === 'string' ? payload.id : null;
  const expiresAt = typeof payload?.expiresAt === 'string' ? payload.expiresAt : null;
  const replyToMsgId = typeof payload?.replyToMsgId === 'string' ? payload.replyToMsgId : null;
  const responseOptions = sanitizeResponseOptions(payload?.responseOptions);
  if (!text) return { ok: false, error: 'Message vide' };

  // If this is a reply to one of our own pending messages, clear its expiry
  // timer and grab the original text so we can show context on the display.
  // Fall back to DB if pending state was lost (e.g. server restart).
  let replyToText = null;
  if (isReply && replyToMsgId) {
    const original = resolvePending(replyToMsgId);
    if (original) {
      replyToText = original.text;
    } else {
      const stored = db.getMessage(replyToMsgId);
      if (stored) replyToText = stored.text;
    }
    db.setStatus(replyToMsgId, 'replied');
    io.emit('msg:status', { id: replyToMsgId, status: 'replied' });
  }

  const opts = responseOptions.length > 0 ? responseOptions : null;
  const rowId = id ?? randomUUID();
  db.insertMessage({
    id: rowId,
    direction: 'in',
    text,
    from,
    to: OWNER,
    expiresAt: expiresAt ? Date.parse(expiresAt) : null,
    isReply,
    replyToMsgId,
    replyToText,
    responseOptions: opts,
    status: 'received',
  });
  io.emit('history:new');
  msgLog(
    isReply ? 'msg:reply-received' : 'msg:received',
    `${isReply ? '↩ ' : ''}← ${from} : ${trunc(text)}`,
    { id: rowId, from, isReply }
  );

  io.emit('message', {
    id,
    text,
    from,
    fromInstanceId,
    isReply,
    expiresAt,
    replyToText,
    responseOptions: opts,
  });
  return { ok: true };
}

function handleReadReceipt(payload, io) {
  const id = typeof payload?.id === 'string' ? payload.id : '';
  if (!id) return { ok: false, error: 'id manquant' };
  // Only if still 'pending' — don't overwrite 'replied' or 'expired'.
  db.setStatusIfPending(id, 'read');
  io.emit('msg:status', { id, status: 'read' });
  return { ok: true };
}

function handleTypingInbound(payload, io) {
  const from = typeof payload?.from === 'string' ? payload.from.trim() : '';
  const state = payload?.state;
  if (!from || (state !== 'start' && state !== 'stop')) {
    return { ok: false, error: 'bad payload' };
  }
  io.emit('typing', { from, state });
  return { ok: true };
}

function dispatchInbound(kind, payload, io) {
  if (kind === 'inbox') return handleIncoming(payload, io);
  if (kind === 'read-receipt') return handleReadReceipt(payload, io);
  if (kind === 'typing') return handleTypingInbound(payload, io);
  return { ok: false, error: 'bad-kind' };
}

// ===== Outbound pipeline =====

// Shared send pipeline used by /send and /shortcut/send. Generates the msgId +
// expiresAt, hands the payload to the transport (which owns reachability and
// any retry), then registers the pending message so the expiry timer can fire.
async function sendToPeer(peer, { text, ttlMs, responseOptions = null, io, transport }) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const opts = responseOptions && responseOptions.length > 0 ? responseOptions : null;
  const payload = { id, text, from: OWNER, fromInstanceId: INSTANCE_ID, expiresAt, responseOptions: opts };

  const result = await transport.deliver(
    { owner: peer.owner, instanceId: peer.instanceId },
    'inbox',
    payload,
  );
  if (!result.ok) throw new Error(result.error || 'undeliverable');

  const expiresAtMs = Date.parse(expiresAt);
  trackPending({ id, text, targetOwner: peer.owner, expiresAt: expiresAtMs, io });
  db.insertMessage({
    id,
    direction: 'out',
    text,
    from: OWNER,
    to: peer.owner,
    expiresAt: expiresAtMs,
    responseOptions: opts,
    status: 'pending',
  });
  io.emit('history:new');
  msgLog('msg:sent', `→ ${peer.owner} : ${trunc(text)}`, { id, to: peer.owner, ttlMs: expiresAtMs - Date.now() });
  return { id, expiresAt };
}

export function init({ app, io, transport }) {
  // Receive-side hook for transports that push (broker). No-op for P2P, where
  // inbound arrives through the HTTP routes below.
  transport.onDeliver((from, kind, payload) => dispatchInbound(kind, payload, io));

  app.post('/send', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const target = typeof req.body?.target === 'string' ? req.body.target : '';
    if (!text) return res.status(400).json({ error: 'Message vide' });
    if (!target) return res.status(400).json({ error: 'Destinataire manquant' });

    const peer = transport.findPeer({ instanceId: target });
    if (!peer) return res.status(404).json({ error: 'Destinataire introuvable' });

    const responseOptions = sanitizeResponseOptions(req.body?.responseOptions);
    const defaultTtl = responseOptions.length > 0 ? 3600_000 : 300_000;
    const ttlMs = clampTtl(req.body?.ttlMs) ?? defaultTtl;

    try {
      const result = await sendToPeer(peer, { text, ttlMs, responseOptions, io, transport });
      return res.json({ ok: true, ...result });
    } catch (err) {
      errLog('msg:send-failed', `Envoi → ${peer.owner} échoué : ${err.message}`, { to: peer.owner });
      return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
    }
  });

  app.post('/shortcut/send', async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!id) return res.status(400).json({ error: 'Raccourci manquant' });
    const shortcut = findShortcut(id);
    if (!shortcut) return res.status(404).json({ error: 'Raccourci introuvable' });

    // Recipient resolution: explicit override (the screen passes the current
    // global target for global shortcuts) → the shortcut's pinned target →
    // the stored global recipient. Empty everywhere = no destination.
    const override = typeof req.body?.targetOwner === 'string' ? req.body.targetOwner.trim() : '';
    const wantOwner = override || shortcut.targetOwner || getDefaultTarget();
    if (!wantOwner) return res.status(400).json({ error: 'Aucun destinataire' });

    const peer = transport.findPeer({ owner: wantOwner });
    if (!peer) return res.status(404).json({ error: `${wantOwner} hors ligne` });

    try {
      const result = await sendToPeer(peer, { text: shortcut.text, ttlMs: shortcut.ttlMs, io, transport });
      return res.json({ ok: true, ...result });
    } catch (err) {
      errLog('msg:shortcut-failed', `Raccourci → ${peer.owner} échoué : ${err.message}`, { to: peer.owner });
      return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
    }
  });

  app.post('/reply', async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const replyToMsgId = typeof req.body?.replyToMsgId === 'string' ? req.body.replyToMsgId : null;
    if (!to) return res.status(400).json({ error: 'Destinataire manquant' });
    if (!label) return res.status(400).json({ error: 'Réponse vide' });

    const peer = transport.findPeer({ instanceId: to });
    if (!peer) return res.status(404).json({ error: 'Destinataire introuvable' });

    const payload = {
      text: label,
      from: OWNER,
      fromInstanceId: INSTANCE_ID,
      isReply: true,
      replyToMsgId,
    };

    const result = await transport.deliver(
      { owner: peer.owner, instanceId: peer.instanceId },
      'inbox',
      payload,
    );
    if (!result.ok) {
      errLog('msg:reply-failed', `Réponse → ${peer.owner} échouée : ${result.error}`, { to: peer.owner });
      return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
    }

    const original = replyToMsgId ? db.getMessage(replyToMsgId) : null;
    db.insertMessage({
      id: randomUUID(),
      direction: 'out',
      text: label,
      from: OWNER,
      to: peer.owner,
      isReply: true,
      replyToMsgId,
      replyToText: original?.text ?? null,
      status: 'sent',
    });
    io.emit('history:new');
    // Tell our own clients the original message is now answered. The display
    // dismisses it if it's still on screen (or drops it from its queue) — this
    // is what makes a reply sent from the PWA clear the screen. A reply tapped
    // on the screen itself runs its own ✓/exit and ignores this signal.
    if (replyToMsgId) io.emit('msg:answered', { replyToMsgId });
    msgLog('msg:reply-sent', `↩ → ${peer.owner} : ${trunc(label)}`, { to: peer.owner, replyToMsgId });
    return res.json({ ok: true });
  });

  // ===== HTTP inbound routes (P2P transport) =====
  // A peer POSTs straight to these. They funnel into the shared handlers so the
  // logic stays identical to the broker's pushed deliveries.

  app.post('/inbox', (req, res) => {
    const r = handleIncoming(req.body, io);
    return res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : { error: r.error });
  });

  app.post('/read-receipt', (req, res) => {
    const r = handleReadReceipt(req.body, io);
    return res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : { error: r.error });
  });

  app.post('/typing', (req, res) => {
    const r = handleTypingInbound(req.body, io);
    return res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : { error: r.error });
  });

  // ===== Outbound best-effort signals from our own clients =====
  io.on('connection', (socket) => {
    // Our display tells us it just showed a message → forward a read receipt to
    // the original sender. Best-effort: drop silently if the peer is gone.
    socket.on('msg:read', async ({ id, fromInstanceId } = {}) => {
      if (!id || !fromInstanceId) return;
      await transport.deliver({ instanceId: fromInstanceId }, 'read-receipt', { id }).catch(() => {});
    });

    // PWA tells us "I'm typing toward X" → forward to X. Best-effort and noisy.
    socket.on('typing', async ({ target, state } = {}) => {
      if (!target || (state !== 'start' && state !== 'stop')) return;
      await transport.deliver({ instanceId: target }, 'typing', { from: OWNER, state }).catch(() => {});
    });
  });
}
