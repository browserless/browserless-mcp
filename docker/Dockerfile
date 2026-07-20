FROM node:24-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/ scripts/
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --production

FROM node:24-slim

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
