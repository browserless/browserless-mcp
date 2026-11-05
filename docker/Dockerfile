FROM node:26-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/ scripts/
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --production

FROM node:26-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

LABEL org.opencontainers.image.source=https://github.com/browserless/browserless-mcp
LABEL org.opencontainers.image.description="Browserless MCP Server"

WORKDIR /app

ENV NODE_ENV=production
ENV TRANSPORT=httpStream
ENV PORT=8080

COPY --from=builder /app/build/src build/src/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json .
COPY bin/ bin/

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "build/src/index.js"]
