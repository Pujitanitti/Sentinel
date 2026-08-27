FROM node:22-slim AS base
WORKDIR /repo
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway

# Install every workspace's deps (npm workspaces need the full tree to link
# internal @sentinel/* packages), then build only what the gateway needs.
RUN npm install --no-audit --no-fund
RUN npm run build --workspace=@sentinel/shared \
  && npm run build --workspace=@sentinel/config \
  && npm run build --workspace=@sentinel/logger \
  && npm run build --workspace=@sentinel/redis \
  && npm run build --workspace=@sentinel/database \
  && npm run build --workspace=@sentinel/rate-limiter \
  && npm run build --workspace=@sentinel/abuse-detector \
  && npm run build --workspace=@sentinel/gateway

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/gateway/dist/server.js"]
