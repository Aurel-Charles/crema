// Crema — shared "About" renderer (V7.6 — display gear panel).
//
// Surfaces the running version of this Pi plus its peers, with the V7.5
// "different version" badge. Single source of truth for /settings (the « À
// propos » section) and the display screen's gear panel — both call
// window.cremaAbout.render() with their own DOM nodes.
//
// Data comes from GET /me (my owner/nickname/version/instanceId) and GET
// /peers (the live roster). No socket here: callers re-run render() on their
// existing peer:up / peer:down subscriptions.
(function () {
  function describePeer(p) {
    const name = (p.nickname && p.nickname.trim()) ? `${p.owner} (« ${p.nickname} »)` : p.owner;
    return `${name} · ${p.version || '?'}`;
  }

  // V7.5 — binary comparison: badge only when both versions are known and
  // genuinely distinct (a '?' / unknown version never triggers a badge).
  function versionDiffers(peerVersion, myVersion) {
    return !!peerVersion && !!myVersion && peerVersion !== myVersion;
  }

  function peerRow(p, myVersion) {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = describePeer(p);
    row.appendChild(label);
    if (versionDiffers(p.version, myVersion)) {
      const badge = document.createElement('span');
      badge.className = 'ver-badge';
      badge.textContent = '≠ version';
      badge.title = `Version différente de la tienne (${myVersion})`;
      row.appendChild(badge);
    }
    return row;
  }

  // render({ selfEl, peersEl, peersLabelEl }) — fetch /me + /peers and fill the
  // provided nodes. Any node may be omitted. Returns the fetch promise so
  // callers can await if they want.
  async function render({ selfEl, peersEl, peersLabelEl } = {}) {
    try {
      const [me, peers] = await Promise.all([
        (await fetch('/me')).json(),
        (await fetch('/peers')).json(),
      ]);
      const sid = me.instanceId ? me.instanceId.slice(0, 8) : '?';
      if (selfEl) selfEl.textContent = `${describePeer(me)} · ${sid}`;
      if (peersLabelEl) peersLabelEl.textContent = peers.length ? `Pairs (${peers.length})` : 'Pairs';
      if (peersEl) {
        peersEl.innerHTML = '';
        if (!peers.length) {
          const empty = document.createElement('div');
          empty.textContent = 'Aucun pair connecté.';
          empty.style.opacity = '0.7';
          peersEl.appendChild(empty);
        } else {
          for (const p of peers) peersEl.appendChild(peerRow(p, me.version));
        }
      }
    } catch {
      if (selfEl) selfEl.textContent = '— (erreur de chargement)';
    }
  }

  window.cremaAbout = { render, describePeer, versionDiffers };
})();
