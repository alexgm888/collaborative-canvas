# --- Build stage: installs everything and compiles client + server ---
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
RUN npm ci

COPY packages ./packages
RUN npm run build

# --- Runtime stage: only production dependencies and build output ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev -w @canvas/server

COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist

EXPOSE 3001
USER node
CMD ["node", "packages/server/dist/index.js"]
