# IB Gateway on a VPS — Setup Guide

**Goal:** Run IB Gateway 24/7 on a remote server (not your home PC) so the Railway-hosted bot can connect to IBKR even when your machine is off.

**Architecture:**

```
┌────────────────────┐         ┌──────────────────────┐
│  Railway           │  TCP    │  VPS (Hetzner/...)   │
│  discord-trading-  │◄────────►  IB Gateway (docker) │
│  bot (Node)        │  4002   │  ghcr.io/gnzsnz/...  │
└────────────────────┘         └──────────────────────┘
                                         │
                                         ▼
                              Interactive Brokers (cloud)
```

---

## 1. Pick a VPS

| Provider | Cost | Pros | Cons |
|---|---|---|---|
| **Hetzner CX22** | ~€4/mo (~6 CAD) | Cheap, reliable, EU/US | Need credit card |
| **Oracle Free Tier** | Free forever | 0$/mo | Slower setup, can be reclaimed if idle |
| **DigitalOcean** | $6/mo | Simple UI, CA region | A bit pricier |
| **Contabo VPS S** | ~€5/mo | Lots of RAM | Less reliable network |

Recommended: **Hetzner CX22** in Ashburn (US) — closest to IBKR infra, low latency.

Once provisioned, SSH in and install Docker:

```bash
# Ubuntu 24.04 LTS
ssh root@<vps-ip>
curl -fsSL https://get.docker.com | sh
```

---

## 2. Start IB Gateway in Docker

Uses the community image `gnzsnz/ib-gateway` which bundles IB Gateway + IBC
(IB Controller) for automated login.

```bash
# On the VPS
mkdir -p /opt/ibgw && cd /opt/ibgw

# docker-compose.yml — paper trading profile
cat > docker-compose.yml <<'EOF'
services:
  ibgw:
    image: ghcr.io/gnzsnz/ib-gateway:stable
    container_name: ibgw
    restart: unless-stopped
    environment:
      TWS_USERID: ${IBKR_USER}
      TWS_PASSWORD: ${IBKR_PASS}
      TRADING_MODE: paper          # paper | live
      READ_ONLY_API: 'no'
      TWS_ACCEPT_INCOMING: accept
      BYPASS_WARNING: 'yes'
      AUTO_LOGOFF_DISABLED: 'yes'
      TIME_ZONE: America/New_York
    ports:
      - "4002:4002"                 # paper port; use 4001 for live
    # volume pour persister la config IBC entre restarts
    volumes:
      - ibgw-config:/home/ibgateway/config

volumes:
  ibgw-config:
EOF

# Fichier d'env avec tes credentials paper
cat > .env <<'EOF'
IBKR_USER=your_ibkr_paper_username
IBKR_PASS=your_ibkr_paper_password
EOF
chmod 600 .env

docker compose up -d
docker compose logs -f --tail 50
```

Tu dois voir `IBC2 API server listening on 0.0.0.0:4002` dans les logs quand c'est prêt (peut prendre 1-2 min au premier démarrage).

---

## 3. Sécuriser le port 4002

**⚠️ Ne jamais laisser 4002 ouvert à internet.** N'importe qui peut connecter = n'importe qui peut passer des ordres sur ton compte.

### Option sécurité A — Tailscale (recommandé)

Crée un réseau privé entre Railway et le VPS. Le bot voit le VPS en 100.x.y.z privé.

```bash
# Sur le VPS
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey=tskey-auth-XXXX --ssh
tailscale ip  # récupère l'IP 100.x.y.z
```

Pour que Railway rejoigne Tailscale, utilise le [Tailscale Docker image](https://tailscale.com/kb/1282/docker) comme sidecar.

Côté Railway, le bot se connecte via `IBKR_HOST=100.x.y.z` (IP tailscale du VPS).

### Option sécurité B — Firewall par IP (plus simple mais Railway change d'IP)

Railway n'a pas d'IP statique. On peut restreindre par IP de Cloudflare Tunnel ou équivalent. Compliqué à maintenir. Préfère A.

### Option sécurité C — VPN WireGuard (alternative à Tailscale)

Plus de travail à setup. Passe par Tailscale si c'est ton premier VPN.

---

## 4. Variables d'environnement Railway

Dans ton service Railway, ajoute :

```
IBKR_HOST=100.x.y.z          # IP Tailscale du VPS (ou IP publique si pas de VPN)
IBKR_PORT=4002               # paper ; 4001 pour live
IBKR_CLIENT_ID=1
```

Puis passe `mode: live` dans `/trading` Config une fois tout OK.

---

## 5. Tester la connexion

Avant d'activer le trading, lance un spike depuis le bot Railway :

1. Railway Dashboard → ton service → **Settings → Deploy → Run Command** :
   ```bash
   node trading/_spike.js
   ```
2. Logs doivent afficher `[ibkr] accountSummary: ...` avec ta NetLiquidation.

Si timeout → le port n'est pas accessible (vérifie Tailscale ou firewall). Si auth error → creds ou 2FA côté IBKR.

---

## 6. Gestion de la déconnexion quotidienne (auto-logout IBKR)

IBKR déconnecte automatiquement les sessions après ~24h (règle Sunday reset
surtout). L'image `gnzsnz/ib-gateway` gère ça via IBC :

- `AUTO_LOGOFF_DISABLED: 'yes'` désactive le logoff programmé.
- Si 2FA est activée sur ton compte → tu vas recevoir un push sur ton téléphone tous les ~24h à l'heure du reset dimanche (23h55 ET). Approuve-le sinon le gateway reste déconnecté.

Pour un trading bot 24/7 sans intervention, **désactive le 2FA** (Account
Management → Secure Login System → Secure Login System via SMS only, ou
équivalent). Discutable côté sécurité mais c'est le choix classique pour
les bots.

---

## 7. Monitoring

Ajoute un healthcheck simple côté bot Railway : si `reconcile()` échoue au
boot, trading est désactivé (déjà implémenté dans `trading/engine.js`). Tu
peux aussi poster une alerte Discord périodique "IBKR ping OK" en utilisant
le notifier existant.

---

## 8. Bascule vers live

Une fois paper stable pendant une semaine :

1. Sur IBKR web → passer le compte en mode live (ou utiliser un autre account).
2. Sur le VPS :
   ```bash
   docker compose down
   # Dans docker-compose.yml : TRADING_MODE: live
   # et ports: "4001:4001"
   # et .env avec les creds live
   docker compose up -d
   ```
3. Sur Railway : `IBKR_PORT=4001`, `mode: live` dans `/trading` Config.
4. **Démarre petit** : `riskPerTradePct: 0.25` pendant quelques jours, observe.
