# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /usr/src/app

# ---- dev: all deps + nodemon (used by docker-compose.yml) ----
FROM base AS dev
COPY package*.json ./
RUN npm ci
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---- prod: production deps only (last stage = default build target) ----
FROM base AS prod
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
