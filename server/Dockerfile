# Build stage: better-sqlite3-multiple-ciphers (the encrypted database, Security A2) has no prebuilt binary for this
# Node version, so it is compiled here (the full image has python3, make and g++). Only node_modules is kept.
FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
