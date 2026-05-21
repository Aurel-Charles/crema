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

ENV NODE_ENV=production \
  PORT=3000

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libavahi-compat-libdnssd1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY *.js ./
COPY broker ./broker
COPY public ./public

RUN mkdir -p data \
  && chown -R node:node /app

USER node

EXPOSE 3000 4000

CMD ["node", "server.js"]
