FROM node:22-slim AS base
WORKDIR /repo
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY apps/demo-api ./apps/demo-api

RUN npm install --no-audit --no-fund
RUN npm run build --workspace=@sentinel/config \
  && npm run build --workspace=@sentinel/logger \
  && npm run build --workspace=@sentinel/demo-api

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "apps/demo-api/dist/server.js"]
