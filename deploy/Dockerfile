# syntax=docker/dockerfile:1.7

# ---- Stage 1: build ---------------------------------------------------------
# isolated-vm 7 ships prebuilt binaries for Node 24/26 (glibc and musl), so no
# compiler toolchain is needed.
# Base images are pinned by digest; Dependabot (docker ecosystem) proposes digest bumps.
FROM node:26-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS builder
WORKDIR /app
# Node 25+ no longer bundles corepack; install the pnpm that package.json "packageManager" pins.
RUN npm install -g --ignore-scripts pnpm@12.21.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json ./
COPY src ./src
COPY schema ./schema
COPY web ./web
COPY legal ./legal
RUN pnpm build && pnpm prune --prod

# ---- Docs: the documentation site (site/, Astro Starlight), served at /docs --------------
# Its own pnpm root and lockfile. The build reads docs/sdk-reference.md and examples/*.js, and
# its link check reads package.json and release.yml.
FROM node:26-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS docs
WORKDIR /repo
RUN npm install -g --ignore-scripts pnpm@12.21.0
COPY site/package.json site/pnpm-lock.yaml site/pnpm-workspace.yaml ./site/
RUN cd site && pnpm install --frozen-lockfile
COPY site ./site
COPY docs/sdk-reference.md ./docs/
COPY examples ./examples
COPY package.json ./
COPY .github/workflows/release.yml ./.github/workflows/
RUN cd site && pnpm build

# ---- Deno: the process-isolated sandbox used for multi-user HTTP serving -----
FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:26-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates dumb-init \
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
COPY --from=docs /repo/site/dist ./docs-site
COPY LICENSE NOTICE ./

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# --http needs real authentication configured (FEDREG_AUTH_PROVIDER=accounts, or an OIDC
# provider); without it the server refuses to start rather than serving unauthenticated.
CMD ["node", "dist/bin.js", "--http"]
