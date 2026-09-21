# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# curl é exigido pelo healthcheck que o Coolify injeta no container; sem ele o
# deploy marca a aplicação como unhealthy e faz rollback mesmo com o app no ar.
RUN apk add --no-cache curl \
 && addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
# Editável sem rebuild se montado como volume
COPY --chown=app:app knowledge ./knowledge
USER app
EXPOSE 3000
# Volume para o refresh token rotativo da Olist
VOLUME ["/data"]
# start-period generoso: a validação de configuração derruba o processo de
# propósito quando falta segredo, e o container reinicia em laço até ser
# corrigido — não adianta marcar saudável antes de ele estabilizar.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]
