# syntax=docker/dockerfile:1
# The generic TypeSystem server (ADR-0102, ADR-0120): one image for every deployment.
# It serves the deployment file TYPESYS_DEPLOYMENT names: MCP at /mcp, the governed API under /api.
# What it serves is mounted, never baked in:
#
#   docker run -p 3939:3939 ghcr.io/marlinspike/typesystem:<version>          # the airforce demonstration
#   npx typesys deploy package my.shared.deployment.json --target compose     # files that run yours (ADR-0119)
#
# The same image runs the one-shot steps a deployment needs:
#   node packages/host/dist/serve.js migrate            create or update its state's tables (ADR-0117)
#   node packages/cli/dist/bin.js audit verify <file>   check its audit trail (ADR-0105)
#
# Published by the hand-started "Image" workflow (.github/workflows/image.yml), never on a pull request.

# ---- build: every workspace compiled, then only what runs is kept ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Everything `npm ci` and `npm run build` read: the manifests, every package, the client bundler, and the
# demonstration deployments and packs the image serves by default. .dockerignore keeps out node_modules and dist.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY deployments ./deployments
COPY packs ./packs
RUN npm ci --no-audit --no-fund
RUN npm run build
# Runtime only: no compilers, test runners or sources (ADR-0120).
RUN npm prune --omit=dev --no-audit --no-fund \
  && find packages -maxdepth 2 \( -name src -o -name test \) -type d -prune -exec rm -rf {} + \
  && find . -name "*.tsbuildinfo" -delete \
  && rm -rf scripts

# ---- runtime: slim, non-root, read-only code ----
FROM node:22-bookworm-slim AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="TypeSystem" \
      org.opencontainers.image.description="The generic TypeSystem server: one governed runtime for the deployment file it is given" \
      org.opencontainers.image.source="https://github.com/marlinspike/TypeSystem" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and readable by all: the unprivileged `node` user that runs it cannot change its own code.
COPY --from=build /app ./
USER node
ENV PORT=3939
EXPOSE 3939
# Liveness against /healthz (ADR-0029), using Node's global fetch: no extra tools in the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3939)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENV TYPESYS_DEPLOYMENT=deployments/airforce.deployment.json
ENV TYPESYS_PACKS_DIR=/app/packs
CMD ["node", "packages/host/dist/serve.js"]
