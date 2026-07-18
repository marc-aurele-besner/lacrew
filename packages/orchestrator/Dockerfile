# Public orchestrator image (PRD F2.9 / F2.16).
# Build from lacrew monorepo root:
#   docker build -f packages/orchestrator/Dockerfile -t lacrew-orchestrator .

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lacrew/core build \
 && pnpm --filter @lacrew/db build \
 && pnpm --filter @lacrew/sdk build \
 && pnpm --filter @lacrew/adapter-agents-mcp build \
 && pnpm --filter @lacrew/orchestrator build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8788
COPY --from=build /app /app
WORKDIR /app/packages/orchestrator
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
