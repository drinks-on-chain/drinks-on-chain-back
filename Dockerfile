# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# Drinks on Chain · backend (NestJS + Prisma)
#   docker build -t drinks-on-chain-back .
# Imagen final: solo dependencias de producción, usuario no root, healthcheck
# a /v1/health. Con RUN_MIGRATIONS=true aplica `prisma migrate deploy` al
# arrancar (docker/entrypoint.sh).
# -----------------------------------------------------------------------------
ARG NODE_VERSION=22

# --- base: Node + pnpm (corepack, versión de package.json#packageManager) -----
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# openssl: motor de Prisma en Alpine
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN corepack install

# --- deps: todas las dependencias (build) -------------------------------------
FROM base AS deps
# Herramientas por si una dependencia nativa (bcrypt) no trae binario musl
RUN apk add --no-cache python3 make g++
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build: cliente de Prisma + compilación -----------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN pnpm exec prisma generate && pnpm build

# --- prod-deps: solo dependencias de producción -------------------------------
FROM base AS prod-deps
RUN apk add --no-cache python3 make g++
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod
COPY prisma ./prisma
RUN pnpm exec prisma generate

# --- runner -------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
ENV NODE_ENV=production \
    PORT=4000 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN apk add --no-cache openssl tini
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node package.json ./
COPY --chown=node:node --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/v1/health').then(r=>r.json()).then(b=>process.exit(b&&b.data&&b.data.status==='ok'?0:1)).catch(()=>process.exit(1))" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
