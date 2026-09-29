# syntax=docker/dockerfile:1
# Multi-stage image for the TypeS MCP server over Streamable HTTP (ADR-0021, ADR-0029).
#
# Reference artifact: correct and runnable, NOT production-hardened. A real image would
# pin the base by digest, scan for CVEs, prune dev dependencies (or use a distroless
# runtime), and get its secrets from the orchestrator, not the environment defaults here.
# See docs/PRODUCTION-READINESS.md.

# ---- build stage: full toolchain, compiles every workspace ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Root manifests + every workspace package.json drive `npm ci`; copying the whole packages
# tree keeps the workspace install correct (at some cost to layer-cache reuse on source-only edits).
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build

# ---- runtime stage: slim, non-root ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The built workspace, including node_modules with its @typesys/* symlinks. `--chown` so the
# unprivileged `node` user shipped in the base image can read it. (Dev dependencies are kept for
# simplicity — this is a reference image; a production build would `npm prune --omit=dev` or copy
# only the built dist + production deps.)
COPY --from=build --chown=node:node /app ./
USER node
ENV PORT=3939
EXPOSE 3939
# Liveness against /healthz (ADR-0029), using Node 22's global fetch — no extra tools in the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3939)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/mcp-server/dist/bin-http.js"]
