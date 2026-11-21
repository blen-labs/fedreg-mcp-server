# syntax=docker/dockerfile:1.7

# ---- Stage 1: build ---------------------------------------------------------
# Use the full Debian base so we have toolchains to compile isolated-vm.
FROM node:22-bookworm AS builder
WORKDIR /app

# Build deps for isolated-vm (native V8 isolate addon).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# pnpm-workspace.yaml approves the isolated-vm/esbuild build scripts, so the
# native sandbox addon compiles during install. The committed lockfile keeps
# the install reproducible.
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json ./
COPY src ./src
COPY schema ./schema
COPY web ./web
COPY legal ./legal
RUN pnpm build

# Trim to runtime deps only (preserves the compiled isolated-vm .node binary).
RUN pnpm prune --prod

# ---- Deno: the process-isolated sandbox used for authenticated HTTP serving ----
# Authenticated (and account-mode) HTTP runs user code only in a Deno subprocess, never in the
# server process, so the image must ship Deno. Pinned by digest, the same build as uspto-mcp-server.
FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Only libstdc++ is needed at runtime for the isolated-vm .node binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app -m -d /home/app app

COPY --from=deno /deno /usr/local/bin/deno

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    FEDREG_LOG_LEVEL=info \
    FEDREG_SANDBOX=auto \
    DENO_DIR=/home/app/.cache/deno

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/schema ./schema

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bin.js", "--http"]
