# Relay do global-agents. Build a partir da raiz do repositório:
#   docker compose -f deploy/relay/docker-compose.yml build
# (ou: podman build -f deploy/relay/Dockerfile -t global-agents-relay .)

# ---- build: instala o workspace, compila o relay e as dependências dele, e separa só o que vai para produção ----
FROM node:24-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
RUN pnpm install --frozen-lockfile --filter @global-agents/relay...
COPY packages/protocol packages/protocol
COPY apps/relay apps/relay
RUN pnpm --filter @global-agents/relay... build
# `--legacy`: no pnpm 10 o `deploy` sem ele exige `inject-workspace-packages=true` no workspace inteiro.
RUN pnpm deploy --legacy --filter @global-agents/relay --prod /out

# ---- runtime: só o relay compilado e as dependências de produção ----
FROM node:24-alpine
# openssl gera o certificado autoassinado na primeira subida; tzdata faz o TZ do compose valer.
RUN apk add --no-cache openssl tzdata \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
ENV NODE_ENV=production DATA_DIR=/data PORT=8443
EXPOSE 8443
VOLUME ["/data"]
CMD ["node", "dist/main.js"]
