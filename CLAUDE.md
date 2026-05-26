# Crema — Spec projet

Système de messagerie local entre Raspberry Pi (trois aujourd'hui : 4B, 3B+ et un 3ᵉ « pi-desk ») équipés d'écrans tactiles (7" cible, 3.5" sur pi-desk), installés en permanent dans une maison partagée. Chaque Pi affiche une horloge/veilleuse au repos. Les messages sont envoyés depuis un téléphone (PWA) ou via raccourcis tactiles directs sur l'écran. Ils peuvent inclure des options de réponse préfabriquées et un TTL exprimant la fenêtre de disponibilité de l'émetteur.

Le nom *Crema* évoque la couche dorée d'un espresso de spécialité — clin d'œil au rituel café partagé qui a inspiré le projet. La palette visuelle des écrans reprend littéralement cette teinte amber.

## Étape actuelle : V7.2 (profil petit écran + watchdog Wi-Fi USB, en fonctionnement)

La roadmap V0→V6 est livrée, plus le **transport dual** (V7.0), le **surnom
d'affichage** (V7.1) et le **profil petit écran + watchdog Wi-Fi USB** (V7.2).
Tourne sur **trois Pi** : `pi-aurel`, `pi-slibar` et `pi-desk` (3ᵉ Pi, écran
tactile 3.5"). Crema est aujourd'hui un
**système pair-à-pair symétrique complet** : code identique sur chaque Pi,
découverte mDNS automatique, messages/réponses/raccourcis/TTL, historique
SQLite, accusés "vu" (V6.1) et indicateur de frappe (V6.2). **Aucun serveur
central** — le "serveur" du projet = le process Node qui tourne sur chaque Pi.

**Surnom (V7.1)** : chaque Pi a un `nickname` optionnel éditable depuis
`/settings` (défaut vide), nom effectif affiché = `nickname || owner`. C'est une
**couche présentation propagée** sur les 3 transports (TXT mDNS, broker
`register`/`profile:update`, `/me`) ; `owner` reste l'**identité de routage
immuable**. Stocké dans `data/identity.json` (`store.js`). Maj à chaud sans
reboot via `transport.announceProfile()`. Voir mémoire `v7-1-display-nickname`.

**Profil petit écran + watchdog Wi-Fi (V7.2)** : `pi-desk` tourne sur un écran
Waveshare 3.5" (800×480 rendu sur un 3,5 pouces). Un **profil d'affichage `sm`**
re-compose le stage idle/message avec des cibles tactiles plus grandes, activé
par Pi via `data/screen-profile` (ou `CREMA_SCREEN=sm`) — vrai profil CSS, pas un
zoom. Comme `pi-desk` utilise une **clé Wi-Fi USB** au driver `rtl8xxxu`
capricieux (se fige après quelques heures), un **watchdog** systemd optionnel
(`./wifi-watchdog-on.sh`) la récupère sans replug physique. Voir
`docs/pi-desk-3.5-screen.md`, `docs/usb-wifi-dongle.md` et les mémoires
`pi-desk-waveshare-touch` / `pi-desk-wifi-rtl8xxxu-drop`.

**Architecture en place** :
- **Découverte** : `peers.js` — chaque Pi s'annonce et browse le service mDNS
  `crema`, maintient une `peerMap`. Health-check `/me` toutes les 10s (drop
  après 3 échecs) + recréation advertisement/browser toutes les 2h (anti-rust,
  cf. décrochage mDNS observé à ~4h). Voir mémoire `mdns-on-raspberry-pi`.
- **Transport** : abstrait derrière un *seam* (`transport.js`) avec trois modes,
  choisis par `CREMA_TRANSPORT` (défaut **`dual`**). Voir « Transport : trois
  modes » plus bas.
  - `dual` (défaut) : broker primaire + p2p secours, **les deux actifs en même
    temps**, failover automatique. Broker découvert par mDNS ou épinglé.
  - `p2p` : échanges HTTP **directs de Pi à Pi** vers l'IP du pair (`POST /inbox`,
    `/reply`, `/read-receipt`, `/typing`), retry avec re-résolution `.local`.
  - `broker` : client Socket.IO vers un relais LAN central (pas de secours).
- **État** : chaque Pi a **son propre SQLite** (`db.js`), ses pending messages
  avec timers TTL, son historique. Pas de duplication entre Pi.
- **Idle** : horloge + thème jour/nuit (SunCalc, `/theme-schedule`), présence du
  pair, raccourcis tactiles.

**Fichiers** :
- `server.js` — Express + Socket.IO, routes pages + API (`/me`, `/peers`, `/theme-schedule`, `/history.json`, `/logs.json`)
- `config.js` — env/identité (`OWNER`, `INSTANCE_ID`, ports, bornes TTL, `CREMA_TRANSPORT`/`CREMA_BROKER_URL`/`CREMA_BROKER_TOKEN`)
- `transport.js` — sélecteur dual/p2p/broker derrière une interface commune
- `transport-dual.js` — composite broker-primaire/p2p-secours + agrégation de présence (défaut)
- `transport-p2p.js` — transport P2P (enveloppe `peers.js` + HTTP direct)
- `transport-broker.js` — transport broker (client Socket.IO)
- `discover-broker.js` — découverte mDNS du broker côté Pi (`_crema-broker._tcp`)
- `peers.js` — découverte mDNS + health-check + dedup same-owner (détail du transport p2p)
- `messaging.js` — pipeline d'envoi/réponse + handlers entrants inbox/accusés/typing
- `store.js` — réponses par défaut, raccourcis, DND (JSON dans `data/`)
- `db.js` — historique SQLite
- `logger.js` — logs structurés vers `/logs` + Socket.IO
- `public/` — `index.html` (PWA), `display.html` (écran), `settings.html`, `history.html`, `logs.html`, `theme.css`
- `broker/` — le relais LAN autonome (`server.js`, `install-broker.sh`, `start-broker.sh`, `test-protocol.mjs`)
- `install-pi.sh`, `start.sh`, `start-display.sh` — setup/lancement Pi
- `pin-broker.sh` (dual + URL épinglée), `reset-transport.sh` (retour dual+découverte), `disable-broker.sh` (force p2p), `enable-broker.sh` (force broker pur) — bascule transport
- `wifi-watchdog-on.sh` / `wifi-watchdog-off.sh` — watchdog Wi-Fi USB (Pi à clé USB, ex. pi-desk ; cf. `docs/usb-wifi-dongle.md`)
- `docs/` — `setup`, `transport`, `broker-protocol`, `architecture`, `operations`, `pi-desk-3.5-screen`, `usb-wifi-dongle`

## Transport : trois modes (dual | p2p | broker)

Le transport est interchangeable derrière `transport.js`, sélectionné par
`CREMA_TRANSPORT` (défaut **`dual`**). Spec complète : `docs/broker-protocol.md`.

- **`dual`** (défaut) — `transport-dual.js` compose p2p **et** broker en même
  temps : broker primaire, p2p secours, failover automatique dans les deux sens.
  Pas de split-brain (chaque Pi joignable par les deux chemins). Le broker est
  trouvé par découverte mDNS (`_crema-broker._tcp`, `discover-broker.js`) ou
  épinglé via `CREMA_BROKER_URL` (IP statique = primaire robuste).
- **`p2p`** — découverte mDNS + HTTP direct Pi↔Pi seulement. Pas de broker.
  Fragilité : la stack mDNS/avahi.
- **`broker`** — client Socket.IO d'un relais LAN central seulement, pas de
  secours. Le relais (`broker/server.js`) est *stateless* (annuaire
  `owner→socket` + routage), ne persiste rien.

**Émission en dual** : broker d'abord, repli HTTP direct sur échec, jamais les
deux. **Réception** : déjà dual-capable sans code dédié (routes HTTP p2p +
`transport.onDeliver` broker toujours câblés dans `messaging.js`). **Présence
agrégée** par le composite (un `peer:down` net n'est émis que quand plus aucun
chemin ne voit le pair). **Badge écran** : filigrane vertical bas-gauche piloté
par `transport.health()` / event `transport:health` (rien si broker OK, sinon
« p2p · direct » ou « hors-ligne »).

Bascule (drop-in systemd, réversible, sans toucher `crema.service`) :
- Épingler le broker en gardant le secours : `./pin-broker.sh ws://<ip>:4000 [token]`
- Retour au défaut (dual + découverte) : `./reset-transport.sh`
- Forcer p2p pur : `./disable-broker.sh` — forcer broker pur (debug) : `./enable-broker.sh ws://<ip>:4000 [token]`
- Installer le relais sur le serveur dédié : `broker/install-broker.sh`
  (service `crema-broker.service`, annonce mDNS optionnelle, token via `CREMA_BROKER_TOKEN`).

Le broker tourne en pur JS (testable sur Mac : `cd broker && npm start` — l'annonce
mDNS, native, se désactive proprement si `mdns` n'est pas compilé). Le chemin
p2p dépend de `mdns`/`better-sqlite3` natifs (voir mémoire
`mdns-build-fails-node24-mac` : pas de boot du serveur Pi sur le Mac). **NB : un
broker live tourne sur le Mac (:4000), cf. mémoire `live-broker-on-mac`.**

## Pré-requis matériel/setup

- Pi de dev : Raspberry Pi 4B
- OS : Raspberry Pi OS **avec desktop** (pas Lite — Chromium kiosk requis dès V2)
- Hostname : `pi-aurel` (à configurer via `raspi-config` ou `/etc/hostname`)
- Wi-Fi maison + SSH activé
- Node.js 20 LTS (installation via nvm, pas apt)
- Écran HDMI branché pour les tests (n'importe lequel)

## Workflow de dev

- **Source de vérité** : repo Git sur GitHub (public — aucun secret commité, `data/` et tokens broker hors repo ; clone HTTPS sans auth)
- **Édition** : Claude Code sur Mac, repo cloné en local
- **Déploiement Pi** : `git pull` manuel sur chaque Pi (+ `install-pi.sh` pour le setup initial) ; automatisation (webhook / GitHub Actions ssh) toujours envisageable mais pas en place
- **Pas de CI/CD** pour l'instant

## Tests de stabilité

`stability-test.js` (npm script : `npm run stability-test`) est un harness de probing externe à faire tourner sur les deux Pi en parallèle pour détecter décrochages mDNS, redémarrages serveur, échecs HTTP cross-Pi et soucis système (temp CPU, Wi-Fi). Output : JSONL dans `./logs/stability-<host>-<date>.jsonl`.

Sondes :
- `/me` localhost toutes les 5s (rotation `instanceId` = restart serveur détecté)
- `/peers` localhost toutes les 15s (mDNS toujours visible ?)
- `/me` peer toutes les 30s (HTTP cross-Pi)
- temp CPU / load / RAM / signal Wi-Fi toutes les 60s
- heartbeat console + résumé horaire + résumé final propre sur SIGINT

Lancement typique (runs longs, 24h+) : SSH sur chaque Pi, `TERM=xterm-256color tmux new -d -s stab 'npm run stability-test'`. Le préfixe `TERM=` contourne le souci ghostty SSH. Réattacher : `tmux attach -t stab`. Stopper proprement (déclenche le `summary:final`) : `Ctrl+C` dans le tmux ou `tmux send-keys -t stab C-c` depuis l'extérieur.

Pour détecter un reboot Pi pendant un run : `journalctl --list-boots` + `last -x | grep reboot`.

## Stack technique

- **Backend** : Node.js 20 + Express + Socket.IO
- **Frontend** : HTML/CSS/JS vanilla (pas de framework au V0 ; possibilité de migrer vers React/Vue plus tard si pertinent)
- **Persistence** : SQLite (`db.js`) pour l'historique ; JSON (`store.js`) pour réponses/raccourcis/DND/surnom (`data/identity.json`)
- **Découverte réseau** : en mode `p2p`, mDNS via le paquet `mdns` (PAS `bonjour-service` — abandonné, voir mémoire `mdns-on-raspberry-pi` pour les patches libavahi/resolverSequence obligatoires sur Pi). En mode `broker`, pas de mDNS : annuaire centralisé côté relais.
- **Transport broker** : `socket.io` (relais) + `socket.io-client` (Pi)

## Roadmap

- ✅ **V0** — MVP mono-Pi, message s'affiche 30s, idle statique `Prêt`
- ✅ **V1** — Second Pi + découverte mDNS automatique + sélection destinataire dans la PWA
- ✅ **V2** — Idle state propre : horloge + veilleuse jour/nuit + présence du Pi distant ("Slibar en ligne")
- ✅ **V3** — Réponses rapides par défaut (boutons tactiles configurables, dispos sur tout message reçu)
- ✅ **V4** — Options de réponse personnalisées à l'envoi + TTL avec smart defaults + mini barre de progression d'expiration
- ✅ **V5** — Raccourcis d'envoi sur l'écran tactile, créés/édités depuis la PWA
- ✅ **V6** — Historique conversations (SQLite), accusés "vu" (V6.1), indicateur de frappe (V6.2)
- ✅ **V7.0** — Transport broker LAN puis **transport `dual`** (broker primaire + p2p secours, par défaut ; voir « Transport : trois modes »)
- ✅ **V7.1** — Surnom d'affichage éditable, propagé sur les 3 transports (voir « Étape actuelle »)
- ✅ **V7.2** — Profil petit écran (`sm`, pi-desk 3.5") + watchdog Wi-Fi USB (récupération auto du dongle `rtl8xxxu`)

Roadmap initiale livrée, puis étendue (transport dual, surnom, profil petit
écran + watchdog Wi-Fi). Pistes encore ouvertes : accès hors domicile, multi-Pi
par personne (labels de pièce). Chaque version est restée indépendamment utile.

## Architecture cible (V1+)

Symétrique pair-à-pair : **code identique sur chaque Pi**. Chaque Pi expose sa propre interface web et reçoit ses propres messages. Découverte mDNS automatique sur le LAN. Pas de serveur central, pas de single point of failure. Pour ajouter un troisième Pi : flasher la même image, il se fait découvrir tout seul.

## Identité et destinataire

- Chaque Pi a un propriétaire (`pi-aurel` = Aurel, `pi-slibar` = Slibar, `pi-desk` = Desk). Tout message qui sort d'un Pi est signé par son propriétaire.
- Les réponses atterrissent **sur le Pi de l'émetteur** (l'écran = réceptacle principal, la PWA = juste l'émetteur).
- Naming des Pi peut inclure la pièce ("Slibar (salon)") quand il y aura plus d'un Pi par personne.

## Trois types d'interactions préréglées (objets distincts dans le data model)

1. **Raccourcis d'envoi** (V5) — boutons sur l'écran tactile en idle. Configurables par proprio du Pi. Envoient un message préfab vers la cible par défaut.
2. **Options de réponse personnalisées** (V4) — attachées à un message envoyé, définies à l'envoi, jetables une fois répondu.
3. **Réponses rapides par défaut** (V3) — barre permanente en bas de tout message reçu, configurées une fois par Pi (ex. `Vu`, `👍`, `Plus tard`).

## TTL (V4)

Chaque message a un `expires_at` qui exprime la fenêtre de disponibilité de l'émetteur. À l'expiration sans réponse, notif discrète côté émetteur ("expiré sans réponse"). À l'expiration avec réponse, retour idle.

Smart defaults selon le type de message :
- Message libre tapé : 5 min
- Raccourci "À table" : 5 min
- Raccourci "Bonne nuit" : 2 min
- Raccourci "J'arrive" : 15 min
- Message avec options de réponse : 1h

Modifiable à l'envoi via presets : `30s` / `5min` / `1h` / `Ce soir` / `Personnalisé…`

Affichage côté receveur : `Slibar · il y a 12s · encore 58min` en sous-titre, mini barre de progression discrète tout en bas du message.

## Modèle de données (préview)

**Message** : `id`, `from` (hostname Pi émetteur), `text`, `created_at`, `expires_at`, `response_options[]`, `response`

**Raccourci d'envoi** : `id`, `label`, `icon`, `text`, `default_target`, `default_ttl`

**Réponse par défaut** : `id`, `label`, `icon` — configurée par Pi

## Design — écran Pi (V2+)

Format 5:3 (cible 800×480 sur écran officiel 7", testable sur HDMI quelconque).
Un **profil `sm`** (V7.2) ré-adapte ce même stage aux panneaux physiquement
minuscules comme le 3.5" de pi-desk (cibles tactiles agrandies). Cf.
`docs/pi-desk-3.5-screen.md`.

Palette dark/warm (ambiance veilleuse) :
- Fond : `#1A1410`
- Horloge / accent principal : `#F4A65A` (amber glow)
- Texte messages : `#F2E4CC` (crème)
- Texte secondaire : `#9C7E54` (amber sourd)
- Présence (point vert) : `#87C459`
- Bezel (cadre) : `#0A0A0A`

Typo sans-serif, horloge 96px+, messages 38-46px, secondaire 11-13px.

Mode jour/nuit : transition vers tons plus vifs en journée, plus tamisés la nuit (détection par heure ou capteur de luminosité).

## Design — PWA mobile

Light theme, surfaces blanches, contrôles modernes standards. Composition : header destinataire (toggleable), champ texte, section "Options de réponse" en chips, section "Raccourcis enregistrés" en grille, bouton "Envoyer" en bas. À installer en PWA (manifest + service worker) à partir du V2 pour permettre l'ajout à l'écran d'accueil.

## Mockups visuels (déjà conçus pour V2+)

1. **Pi au repos** — fond chaud sombre, grosse horloge amber, date, météo en haut-gauche, présence "Slibar en ligne" en haut-droite, rangée de 4 raccourcis avec icônes Tabler + bouton "+" pour en créer.
2. **Pi reçoit un message simple** — indicateur "Nouveau message" en haut-gauche, sender en uppercase, "il y a Xs" en sous-titre, message en grand, rangée discrète de réponses par défaut en bas-droite.
3. **Pi reçoit un message avec options de réponse** — idem mais 3 gros boutons primaires (`Oui` / `Non` / `À voir`) à la place des réponses par défaut.
4. **PWA mobile** — header destinataire, champ texte, options de réponse en chips, raccourcis enregistrés en grille, bouton "Envoyer".
