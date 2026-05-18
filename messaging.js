import { randomUUID } from 'crypto';
import { INSTANCE_ID, OWNER, MAX_LABEL_LENGTH, MAX_REPLIES } from './config.js';
import { clampTtl, findShortcut } from './store.js';
import { findPeerByInstanceId, findPeerByOwner, resolveHost } from './peers.js';

// When /send succeeds, the message is kept here until either:
//   - the peer replies (we get a /inbox hit with replyToMsgId), or
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

async function postInbox(address, port, payload) {
  const r = await fetch(`http://${address}:${port}/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

function trackPending({ id, text, targetOwner, expiresAt, io }) {
  const ttl = expiresAt - Date.now();
  const timer = setTimeout(() => {
    const entry = pendingMessages.get(id);
    if (!entry) return;
    pendingMessages.delete(id);
    console.log(`[pending] expired without reply → ${targetOwner}: ${text.slice(0, 30)}`);
    io.emit('msg:expired', { id, text, targetOwner });
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

// Shared send pipeline used by /send and /shortcut/send. Generates the msgId
// + expiresAt, posts to the peer (with one re-resolve retry on failure), and
// registers the pending message so the expiry timer can fire later.
async function sendToPeer(peer, { text, ttlMs, responseOptions = null, io }) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const opts = responseOptions && responseOptions.length > 0 ? responseOptions : null;
  const payload = { id, text, from: OWNER, fromInstanceId: INSTANCE_ID, expiresAt, responseOptions: opts };

  try {
    await postInbox(peer.address, peer.port, payload);
  } catch (err1) {
    console.warn(`[send] retry → ${peer.owner} (${err1.message})`);
    const fresh = await resolveHost(peer.host);
    peer.address = fresh;
    await postInbox(fresh, peer.port, payload);
  }

  trackPending({ id, text, targetOwner: peer.owner, expiresAt: Date.parse(expiresAt), io });
  return { id, expiresAt };
}

export function init({ app, io }) {
  app.post('/send', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const target = typeof req.body?.target === 'string' ? req.body.target : '';
    if (!text) return res.status(400).json({ error: 'Message vide' });
    if (!target) return res.status(400).json({ error: 'Destinataire manquant' });

    const peer = findPeerByInstanceId(target);
    if (!peer) return res.status(404).json({ error: 'Destinataire introuvable' });

    const responseOptions = sanitizeResponseOptions(req.body?.responseOptions);
    const defaultTtl = responseOptions.length > 0 ? 3600_000 : 300_000;
    const ttlMs = clampTtl(req.body?.ttlMs) ?? defaultTtl;

    try {
      const result = await sendToPeer(peer, { text, ttlMs, responseOptions, io });
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error(`[send] failed → ${peer.owner}:`, err.message);
      return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
    }
  });

  app.post('/shortcut/send', async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!id) return res.status(400).json({ error: 'Raccourci manquant' });
    const shortcut = findShortcut(id);
    if (!shortcut) return res.status(404).json({ error: 'Raccourci introuvable' });

    const peer = findPeerByOwner(shortcut.targetOwner);
    if (!peer) return res.status(404).json({ error: `${shortcut.targetOwner} hors ligne` });

    try {
      const result = await sendToPeer(peer, { text: shortcut.text, ttlMs: shortcut.ttlMs, io });
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error(`[shortcut] failed → ${peer.owner}:`, err.message);
      return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
    }
  });

  app.post('/reply', async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const replyToMsgId = typeof req.body?.replyToMsgId === 'string' ? req.body.replyToMsgId : null;
    if (!to) return res.status(400).json({ error: 'Destinataire manquant' });
    if (!label) return res.status(400).json({ error: 'Réponse vide' });

    const peer = findPeerByInstanceId(to);
    if (!peer) return res.status(404).json({ error: 'Destinataire introuvable' });

    const payload = {
      text: label,
      from: OWNER,
      fromInstanceId: INSTANCE_ID,
      isReply: true,
      replyToMsgId,
    };

    try {
      await postInbox(peer.address, peer.port, payload);
      return res.json({ ok: true });
    } catch (err1) {
      console.warn(`[reply] retry → ${peer.owner} (${err1.message})`);
      try {
        const fresh = await resolveHost(peer.host);
        peer.address = fresh;
        await postInbox(fresh, peer.port, payload);
        return res.json({ ok: true });
      } catch (err2) {
        console.error(`[reply] failed → ${peer.owner}:`, err2.message);
        return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
      }
    }
  });

  app.post('/inbox', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const from = typeof req.body?.from === 'string' ? req.body.from.trim() : 'Inconnu';
    const fromInstanceId = typeof req.body?.fromInstanceId === 'string' ? req.body.fromInstanceId : null;
    const isReply = req.body?.isReply === true;
    const id = typeof req.body?.id === 'string' ? req.body.id : null;
    const expiresAt = typeof req.body?.expiresAt === 'string' ? req.body.expiresAt : null;
    const replyToMsgId = typeof req.body?.replyToMsgId === 'string' ? req.body.replyToMsgId : null;
    const responseOptions = sanitizeResponseOptions(req.body?.responseOptions);
    if (!text) return res.status(400).json({ error: 'Message vide' });

    // If this is a reply to one of our own pending messages, clear its expiry
    // timer and grab the original text so we can show context on the display.
    let replyToText = null;
    if (isReply && replyToMsgId) {
      const original = resolvePending(replyToMsgId);
      if (original) replyToText = original.text;
    }

    io.emit('message', {
      id,
      text,
      from,
      fromInstanceId,
      isReply,
      expiresAt,
      replyToText,
      responseOptions: responseOptions.length > 0 ? responseOptions : null,
    });
    res.json({ ok: true });
  });
}
