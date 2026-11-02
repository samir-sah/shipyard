FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY dashboard ./dashboard
RUN npm run build

FROM node:24.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/server/api.js"]
