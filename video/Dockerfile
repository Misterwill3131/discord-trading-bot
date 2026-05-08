# ─────────────────────────────────────────────────────────────────────
# video/Dockerfile — Worker Remotion pour Railway
# ─────────────────────────────────────────────────────────────────────
# Service Railway séparé du bot principal. Tourne 24/7, polle le bot
# (BOT_URL/api/render-queue) toutes les 30s, render les jobs en MP4
# via Remotion + Chromium, upload back via multipart au bot.
#
# Variables d'env requises (à set dans Railway dashboard) :
#   BOT_URL                - URL publique du bot (ex: https://templeofboom.up.railway.app)
#   RENDER_WORKER_TOKEN    - même valeur que côté bot (Bearer auth)
#
# Image base : Debian Bookworm slim (Node 22) — équilibre taille/compat
# avec les libs natives de Chromium (Remotion 4.x utilise sa propre Chrome
# installée via 'remotion browser ensure' au build).
# ─────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim

# Dépendances système requises par Chromium headless (utilisé par Remotion
# pour rasteriser chaque frame de la composition React) + ffmpeg (encode H.264).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libnss3 \
      libpango-1.0-0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      wget \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Couche de cache séparée pour les deps : si package.json change pas,
# npm install est skippé sur les rebuilds.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copie le reste du sous-projet video/ (src, public, scripts, templates).
COPY . .

# Pré-télécharge Chromium que Remotion utilisera au runtime.
# Ça évite la latence du premier render (téléchargement ~200 MB sinon).
# `|| true` au cas où le download serait déjà fait par npm install.
RUN npx remotion browser ensure || true

# Crée le dossier de sortie utilisé par render-worker.ts (path.join(__dirname, '..', 'out', 'auto')).
RUN mkdir -p out/auto

# Le worker lui-même log abondamment — Railway voit tout via stdout.
CMD ["npm", "run", "worker"]
