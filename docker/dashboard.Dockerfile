FROM node:22-slim AS base
WORKDIR /repo
COPY package.json ./
COPY apps/dashboard ./apps/dashboard

ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:3000
ENV NEXT_PUBLIC_GATEWAY_URL=${NEXT_PUBLIC_GATEWAY_URL}

RUN npm install --no-audit --no-fund --workspace=@sentinel/dashboard --include-workspace-root
RUN npm run build --workspace=@sentinel/dashboard

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace=@sentinel/dashboard"]
