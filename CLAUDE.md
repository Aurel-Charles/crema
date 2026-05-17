# Crema — Spec projet

Système de messagerie local entre deux Raspberry Pi (4B + 3B+) équipés à terme d'écrans tactiles 7", installés en permanent dans une maison partagée. Chaque Pi affiche une horloge/veilleuse au repos. Les messages sont envoyés depuis un téléphone (PWA) ou via raccourcis tactiles directs sur l'écran. Ils peuvent inclure des options de réponse préfabriquées et un TTL exprimant la fenêtre de disponibilité de l'émetteur.

Le nom *Crema* évoque la couche dorée d'un espresso de spécialité — clin d'œil au rituel café partagé qui a inspiré le projet. La palette visuelle des écrans reprend littéralement cette teinte amber.

## Étape actuelle : V0 (MVP mono-Pi)

**Objectif** : prouver que la chaîne *téléphone → serveur Node → WebSocket → écran d'affichage* fonctionne, sur un seul Pi, sans rien d'autre.

**Comportement attendu** :
- Le Pi affiche `Prêt` en grand sur l'écran (idle statique pour le V0)
- Depuis le téléphone : accès à `http://pi-aurel.local:3000`
- Champ texte + bouton "Envoyer"
- À l'envoi, le message s'affiche sur l'écran pendant 30 secondes, puis retour à `Prêt`

**Hors scope V0** : mDNS, horloge stylée, réponses tactiles, TTL configurable, raccourcis, autostart, kiosk auto, multi-Pi. Tout ça arrive aux versions suivantes.

**Fichiers à créer** :
- `server.js` — Express + Socket.IO, routes `/` (sender) et `/display` (Pi)
- `public/index.html` — formulaire d'envoi (interface tel)
- `public/display.html` — écran d'affichage, écoute WebSocket
- `package.json`

**Démarrage manuel pour le V0** : `node server.js` sur le Pi, Chromium ouvert à la main vers `http://localhost:3000/display`.

## Pré-requis matériel/setup

- Pi de dev : Raspberry Pi 4B
- OS : Raspberry Pi OS **avec desktop** (pas Lite — Chromium kiosk requis dès V2)
- Hostname : `pi-aurel` (à configurer via `raspi-config` ou `/etc/hostname`)
- Wi-Fi maison + SSH activé
- Node.js 20 LTS (installation via nvm, pas apt)
- Écran HDMI branché pour les tests (n'importe lequel)

## Workflow de dev

- **Source de vérité** : repo Git sur GitHub (privé)
- **Édition** : Claude Code sur Mac, repo cloné en local
- **Déploiement Pi** : `git pull` manuel pour le V0 ; automatisation (webhook ou GitHub Actions ssh) à partir du V2
- **Pas de CI/CD au V0**

## Stack technique

- **Backend** : Node.js 20 + Express + Socket.IO
- **Frontend** : HTML/CSS/JS vanilla (pas de framework au V0 ; possibilité de migrer vers React/Vue plus tard si pertinent)
- **Persistence** : aucune au V0, SQLite à partir du V4
- **Découverte réseau** : mDNS via `bonjour-service` à partir du V1

## Roadmap

- **V0** — MVP mono-Pi, message s'affiche 30s, idle statique `Prêt`
- **V1** — Second Pi + découverte mDNS automatique + sélection destinataire dans la PWA
- **V2** — Idle state propre : horloge + veilleuse jour/nuit + présence du Pi distant ("Flo en ligne")
- **V3** — Réponses rapides par défaut (boutons tactiles configurables, dispos sur tout message reçu)
- **V4** — Options de réponse personnalisées à l'envoi + TTL avec smart defaults + mini barre de progression d'expiration
- **V5** — Raccourcis d'envoi sur l'écran tactile, créés/édités depuis la PWA
- **V6** — Historique conversations (SQLite), accusés "vu", présence temps réel

Chaque version est indépendamment utile. On peut s'arrêter à V3 si ça suffit déjà.

## Architecture cible (V1+)

Symétrique pair-à-pair : **code identique sur chaque Pi**. Chaque Pi expose sa propre interface web et reçoit ses propres messages. Découverte mDNS automatique sur le LAN. Pas de serveur central, pas de single point of failure. Pour ajouter un troisième Pi : flasher la même image, il se fait découvrir tout seul.

## Identité et destinataire

- Chaque Pi a un propriétaire (`pi-aurel` = Aurel, `pi-flo` = Flo). Tout message qui sort d'un Pi est signé par son propriétaire.
- Les réponses atterrissent **sur le Pi de l'émetteur** (l'écran = réceptacle principal, la PWA = juste l'émetteur).
- Naming des Pi peut inclure la pièce ("Flo (salon)") quand il y aura plus d'un Pi par personne.

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

Affichage côté receveur : `Flo · il y a 12s · encore 58min` en sous-titre, mini barre de progression discrète tout en bas du message.

## Modèle de données (préview)

**Message** : `id`, `from` (hostname Pi émetteur), `text`, `created_at`, `expires_at`, `response_options[]`, `response`

**Raccourci d'envoi** : `id`, `label`, `icon`, `text`, `default_target`, `default_ttl`

**Réponse par défaut** : `id`, `label`, `icon` — configurée par Pi

## Design — écran Pi (V2+)

Format 5:3 (cible 800×480 sur écran officiel 7", testable sur HDMI quelconque).

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

1. **Pi au repos** — fond chaud sombre, grosse horloge amber, date, météo en haut-gauche, présence "Flo en ligne" en haut-droite, rangée de 4 raccourcis avec icônes Tabler + bouton "+" pour en créer.
2. **Pi reçoit un message simple** — indicateur "Nouveau message" en haut-gauche, sender en uppercase, "il y a Xs" en sous-titre, message en grand, rangée discrète de réponses par défaut en bas-droite.
3. **Pi reçoit un message avec options de réponse** — idem mais 3 gros boutons primaires (`Oui` / `Non` / `À voir`) à la place des réponses par défaut.
4. **PWA mobile** — header destinataire, champ texte, options de réponse en chips, raccourcis enregistrés en grille, bouton "Envoyer".
