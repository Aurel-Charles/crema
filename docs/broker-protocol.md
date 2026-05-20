# Crema — Protocole du broker LAN

> Statut : **spec validée, non implémentée.** Branche de travail : `feat/lan-broker`.
> Ce document fait foi avant d'écrire le code du broker et du transport.

## Pourquoi

Le P2P actuel (mDNS + `fetch` direct de Pi à Pi) fonctionne mais sa découverte
réseau est la principale source de friction (patches libavahi, rebirth toutes
les 2h contre le rust, health-check applicatif). Le broker LAN remplace **la
seule couche transport + découverte** par un point de rendez-vous unique sur le
réseau local. Le reste du code Pi (display, PWA, SQLite, TTL, réponses,
raccourcis) ne change pas.

Le broker est introduit **sans détruire le P2P** : les deux transports vivent
derrière une interface commune, sélectionnée par `CREMA_TRANSPORT=p2p|broker`.
Bascule manuelle, réversible d'un changement d'env. Pas de failover automatique.

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
CREMA_TRANSPORT   = p2p | broker        # défaut: p2p
CREMA_BROKER_URL  = ws://serveur.local:4000   # adresse du broker (mode broker)
CREMA_BROKER_TOKEN = <secret partagé>   # optionnel, vérifié au register
```

Déploiement : broker sur Mac (test) puis sur serveur LAN dédié (prod) — seule
`CREMA_BROKER_URL` change côté Pi, aucune ligne de code.

## Événements WebSocket

### 1. `register` — Pi → broker
Émis dès la connexion. Annonce l'identité du Pi.
```js
emit('register', { owner: "Aurel", instanceId: "<uuid>", token?: "<secret>" })
```
Le broker enregistre `owner → socket`. Si un `owner` déjà présent se reconnecte
avec un **nouvel `instanceId`** (Pi redémarré), le broker remplace l'ancien
socket et émet `peer:down`(ancien) puis `peer:up`(nouveau) — équivalent du
*same-owner dedup* de `peers.js`.

Si `CREMA_BROKER_TOKEN` est défini côté broker et que le `token` reçu ne
correspond pas, le broker rejette la connexion (déconnexion immédiate).

### 2. `peers` — broker → Pi
Envoyé juste après un `register` réussi. Liste des pairs connectés (hors soi).
```js
emit('peers', [ { owner: "Flo", instanceId: "<uuid>" } ])
```
Mappe sur l'actuel `peers:init`.

### 3. `peer:up` / `peer:down` — broker → Pi
Diffusés à tous les autres Pi lors d'une (dé)connexion.
```js
emit('peer:up',   { owner, instanceId })
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

- Failover automatique broker↔P2P (les deux transports ne tournent jamais en
  parallèle ; bascule = changement d'env + redémarrage).
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
