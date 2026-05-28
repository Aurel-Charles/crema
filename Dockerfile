FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    g++ \
    libavahi-compat-libdnssd-dev \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim

# V7.4 — `.git/` is excluded by .dockerignore, so `git describe` can't run
# inside the container; the CI workflow passes the resolved tag/sha through
# this build-arg, which the server reads via process.env.CREMA_VERSION
# (config.js detectVersion).
ARG GIT_DESCRIBE=unknown

ENV NODE_ENV=production \
  PORT=3000 \
  CREMA_TRANSPORT=broker \
  CREMA_EMBED_BROKER=1 \
  CREMA_BROKER_URL=ws://127.0.0.1:4000 \
  CREMA_BROKER_ADVERTISE=0 \
  CREMA_VERSION=$GIT_DESCRIBE

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libavahi-compat-libdnssd1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY *.js ./
COPY broker ./broker
COPY public ./public

RUN mkdir -p data \
  && chown -R node:node /app \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000 4000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
