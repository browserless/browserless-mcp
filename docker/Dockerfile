FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/ scripts/
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --production

FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

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
