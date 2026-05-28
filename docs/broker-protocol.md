# Crema — Protocole du broker LAN

> Statut : **implémenté et en production.** Le broker tourne, et le transport
> par défaut est désormais **`dual`** (broker primaire + p2p secours, les deux
> actifs en même temps) avec découverte mDNS du broker. Voir la section
> « Mode dual + découverte ». Le protocole WebSocket ci-dessous est inchangé.

## Pourquoi

Le P2P actuel (mDNS + `fetch` direct de Pi à Pi) fonctionne mais sa découverte
réseau est la principale source de friction (patches libavahi, rebirth toutes
les 2h contre le rust, health-check applicatif). Le broker LAN remplace **la
seule couche transport + découverte** par un point de rendez-vous unique sur le
réseau local. Le reste du code Pi (display, PWA, SQLite, TTL, réponses,
raccourcis) ne change pas.

Le broker est introduit **sans détruire le P2P** : les deux transports vivent
derrière une interface commune (`transport.js`), sélectionnée par
`CREMA_TRANSPORT`. Trois modes : `dual` (défaut), `p2p`, `broker`. En `dual`,
les deux tournent ensemble (broker primaire, p2p secours) — c'est le failover
automatique décrit plus bas.

## Principe directeur

Le broker est **bête et stateless** : un annuaire en mémoire (`owner → socket`)
+ un routeur. Il ne connaît rien au contenu des messages (TTL, réponses,
accusés), il ne persiste rien (chaque Pi garde son propre SQLite). Il sait
seulement *qui est connecté* et *à qui faire passer un paquet*.

Transport : **Socket.IO** (déjà dans le projet). Chaque Pi devient un *client*
Socket.IO du broker, en plus d'être serveur Socket.IO pour sa propre PWA/écran.

## Équivalence avec le P2P actuel

| Aujourd'hui (P2P)                          | Avec broker                              |
| ------------------------------------------ | ---------------------------------------- |
| mDNS `serviceUp`/`serviceDown` + `peerMap` | annuaire `owner → socket` côté broker    |
| `io.emit('peer:up'/'peer:down')` local     | le broker diffuse `peer:up`/`peer:down`  |
| `POST /inbox` direct vers l'IP du pair     | event `deliver` kind `inbox`             |
| `POST /read-receipt`                       | event `deliver` kind `read-receipt`      |
| `POST /typing`                             | event `deliver` kind `typing`            |
| Code HTTP 502 → « injoignable »            | ack callback `{ ok: false }`             |
| health-check `/me` + rebirth 2h            | déconnexion WebSocket = `peer:down`      |

Sur le fil, une **réponse** n'est qu'un `inbox` avec `isReply: true` (déjà le cas
aujourd'hui : `/reply` poste vers le `/inbox` du pair). Donc seulement **3 kinds**
de livraison : `inbox`, `read-receipt`, `typing`.

## Configuration

```
CREMA_TRANSPORT   = dual | p2p | broker  # défaut: dual
CREMA_BROKER_URL  = ws://serveur:4000    # épingle le broker (sinon: découverte mDNS en dual)
CREMA_BROKER_TOKEN = <secret partagé>    # optionnel, vérifié au register
CREMA_BROKER_ADVERTISE = 0               # (côté broker) coupe l'annonce mDNS
```

- `dual` (défaut) : broker primaire + p2p secours, simultanés. `CREMA_BROKER_URL`
  vide ⇒ le broker est **découvert par mDNS** (`_crema-broker._tcp`) ; renseignée
  (IP statique réservée) ⇒ découverte court-circuitée, primaire robuste.
- `p2p` : mDNS + HTTP direct seulement, broker désactivé.
- `broker` : client broker seulement, pas de mDNS/p2p (pas de secours).

Scripts Pi : `pin-broker.sh` (dual + URL épinglée), `reset-transport.sh` (retour
au dual + découverte), `disable-broker.sh` (force p2p), `enable-broker.sh`
(force broker pur, debug).

## Événements WebSocket

### 1. `register` — Pi → broker
Émis dès la connexion. Annonce l'identité du Pi.
```js
emit('register', { owner: "Aurel", instanceId: "<uuid>", nickname?: "Bureau", version?: "v7.4.0", token?: "<secret>" })
```
`nickname` (V7.1) est le **surnom d'affichage** optionnel — une couche de
présentation par-dessus `owner`. `owner` reste l'identité de routage immuable :
le surnom ne sert jamais à router ni à dédupliquer. Vide/absent ⇒ on affiche
`owner`.
`version` (V7.4) est la **version runtime du Pi** (`git describe` ou
`CREMA_VERSION` env pour Docker), figée au démarrage. Propagation pure :
elle ne change rien au routage ni à la dedup, juste relayée dans `peers` /
`peer:up` pour qu'on puisse spotter un Pi en retard sans SSH.
Le broker enregistre `owner → socket`. Si un `owner` déjà présent se reconnecte
avec un **nouvel `instanceId`** (Pi redémarré), le broker remplace l'ancien
socket et émet `peer:down`(ancien) puis `peer:up`(nouveau) — équivalent du
*same-owner dedup* de `peers.js`.

Si `CREMA_BROKER_TOKEN` est défini côté broker et que le `token` reçu ne
correspond pas, le broker rejette la connexion (déconnexion immédiate).

### 2. `peers` — broker → Pi
Envoyé juste après un `register` réussi. Liste des pairs connectés (hors soi).
```js
emit('peers', [ { owner: "Flo", instanceId: "<uuid>", nickname: "Cuisine", version: "v7.4.0" } ])
```
Mappe sur l'actuel `peers:init`. `nickname` et `version` sont `""` si non
définis (vieux client pré-V7.4 par exemple).

### 3. `peer:up` / `peer:down` — broker → Pi
Diffusés à tous les autres Pi lors d'une (dé)connexion.
```js
emit('peer:up',   { owner, instanceId, nickname, version })
emit('peer:down', { owner, instanceId })
```

### 4. `deliver` — Pi → broker → Pi
Le cœur du routage. L'émetteur envoie :
```js
emit('deliver', {
  to:      { owner: "Flo" },   // clé de routage = owner (1 Pi/owner, cf. limites)
  kind:    "inbox",            // "inbox" | "read-receipt" | "typing"
  payload: { /* inchangé vs aujourd'hui, voir ci-dessous */ }
}, (ack) => { /* { ok: true } | { ok: false, error: "offline" } */ })
```
Le broker résout `to.owner` dans son annuaire et **relaie tel quel** :
```js
emit('deliver', { from: { owner: "Aurel", instanceId }, kind, payload })
```
Le Pi récepteur exécute **le même handler qu'aujourd'hui** pour ce kind (logique
inbox/receipt/typing extraite en fonction appelable par HTTP *ou* par cet event).

### 5. Ack callback — broker → émetteur
Remplace le code HTTP 502.
- destinataire connecté → `{ ok: true }`
- destinataire hors ligne → `{ ok: false, error: "offline" }` → l'émetteur
  affiche « Flo hors ligne », comme le 502 actuel.

### 6. `profile:update` — Pi → broker → Pi (V7.1)
Changement de **surnom d'affichage** à chaud, sans (dé)connexion. C'est
volontairement **un event distinct, pas un re-`register`** : un re-`register`
avec le même `owner` déclencherait le *same-owner dedup* du broker sur le Pi
lui-même (il couperait son propre socket précédent).
```js
// Pi → broker (le broker connaît déjà owner/instanceId via socket.data)
emit('profile:update', { nickname: "Bureau" })
// broker → tous les autres Pi
emit('profile:update', { owner, instanceId, nickname })
```
Le broker met à jour l'entrée d'annuaire (`registry[owner].nickname`) puis
rediffuse. Le Pi récepteur fait un *upsert* de présence (réémet un `peer:up`
local enrichi du nouveau nom — `peer:up` est idempotent côté front-ends).

Côté p2p, l'équivalent est une **recréation de l'advertisement mDNS** (le TXT
record porte `nickname`) ; le pair voit le nouveau TXT et réémet `peer:up`. En
`dual`, les deux chemins sont notifiés (`transport.announceProfile()`).

## Payloads par kind (identiques à l'existant)

```
inbox        : { id, text, from, fromInstanceId, expiresAt, responseOptions, isReply?, replyToMsgId? }
read-receipt : { id }
typing       : { from, state }          // state: "start" | "stop"
```

## Séquence — envoi d'un message

```
PWA Aurel ──POST /send──> serveur Pi-Aurel
serveur Pi-Aurel ──emit('deliver', {to:{owner:"Flo"}, kind:"inbox", payload})──> BROKER
                                                            └─ ack { ok: true }
BROKER ──emit('deliver', {from:{owner:"Aurel"}, kind:"inbox", payload})──> serveur Pi-Flo
serveur Pi-Flo ── (même handler qu'un POST /inbox) ──> io.emit('message') ──> écran Flo
```

## Mode dual + découverte (transport par défaut)

`transport-dual.js` compose `transport-p2p.js` **et** `transport-broker.js` en
même temps. C'est le défaut.

- **Réception** : déjà dual-capable sans code dédié. `messaging.js` enregistre
  toujours les routes HTTP (`/inbox`, `/read-receipt`, `/typing` → entrée p2p)
  *et* câble toujours `transport.onDeliver` (entrée broker). Il suffit que les
  deux soient vivants.
- **Émission** : `deliver()` tente le broker d'abord (s'il est connecté), repli
  HTTP direct sur tout `{ ok:false }`. **Jamais les deux** — pas de doublon. Un
  broker connu déconnecté renvoie `{ ok:false }` instantanément (pas de timeout),
  donc le coût par envoi est nul quand on est déjà en repli.
- **Pas de split-brain** : chaque Pi reste joignable par les deux chemins, donc
  un Pi qui ne voit que le broker et un autre qui ne voit que mDNS se parlent
  quand même.
- **Présence agrégée** : les deux transports émettent `peer:up`/`peer:down` ; le
  composite compte les sources et ne propage un `peer:down` net que quand **plus
  aucun** chemin ne voit le pair (sinon une coupure broker griserait à tort un
  pair encore joignable en p2p).

### Découverte du broker

Sans `CREMA_BROKER_URL`, le Pi browse `_crema-broker._tcp` (`discover-broker.js`,
même patch `resolverSequence` que `peers.js`) et se connecte au premier broker
annoncé. Le broker s'annonce via un `mdns` **optionnel** (`broker/server.js`,
import dynamique : absent/non-compilé ⇒ annonce désactivée, le relais marche
quand même — épingler `CREMA_BROKER_URL` côté Pi dans ce cas). Une fois connecté,
Socket.IO gère la reconnexion ; mDNS n'intervient plus que pour (re)trouver un
broker déplacé.

### État transport → écran

`transport.health()` renvoie `{ mode, broker }` (`broker`:
`connected|discovering|down|disabled`), exposé dans `/me` et poussé en
`transport:health` sur Socket.IO. L'écran affiche un filigrane vertical discret
en bas-gauche : rien si `connected`, « p2p · direct » si le pair reste joignable
en direct, « hors-ligne » sinon.

## Décisions actées

1. **Routage par `owner`** (pas `instanceId`). Valable tant qu'il y a 1 Pi par
   personne. *Limite assumée* : avec des labels de pièce (« Flo salon » / « Flo
   cuisine ») il faudra une clé composite `owner+room`.
2. **Pas de store-and-forward** : destinataire hors ligne = échec immédiat,
   comme aujourd'hui. Bufferisation possible plus tard, hors scope.
3. **Auth par token optionnel** activée par défaut côté config (`CREMA_BROKER_TOKEN`),
   désactivable. Évite qu'un appareil random du Wi-Fi se déclare « Flo ».
4. **Présence = connexion WebSocket**. Plus de health-check applicatif : le
   ping/pong intégré de Socket.IO détecte la déconnexion en quelques secondes et
   `peer:down` part tout seul. Plus simple et plus fiable que health-check + rebirth.

## Hors scope (volontairement)

- Persistance côté broker (chaque Pi reste seul maître de son historique).
- Accès hors du LAN domestique (ce serait un broker exposé = autre projet, autre
  modèle de sécurité).

## Plan d'implémentation (référence)

Sur la branche `feat/lan-broker` :

1. Extraire un seam transport derrière une interface commune :
   - `transport.deliver(to, kind, payload) → Promise<ack>`
   - `transport.onDeliver(handler)`
   - `transport.listPeers()` / `onPeerUp` / `onPeerDown`
2. `transport-p2p.js` — encapsule le code actuel (mDNS + `fetch` direct). Inchangé fonctionnellement.
3. `transport-broker.js` — client Socket.IO vers `CREMA_BROKER_URL`.
4. `broker/server.js` — le relais (annuaire + routage), déployable sur Mac puis serveur dédié.
5. Brancher `messaging.js` sur l'interface au lieu des `fetch` directs ; extraire les handlers inbox/receipt/typing en fonctions réutilisables.
6. Sélection par `CREMA_TRANSPORT` dans `config.js`.

Étapes de validation : (1) broker + 2 instances simulées sur Mac, (2) broker
Mac + les 2 vrais Pi, (3) broker sur serveur dédié.
