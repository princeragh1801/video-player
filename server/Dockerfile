# Pinned: the node:22.23 slim image ships a truncated node binary that segfaults (exit 139).
FROM node:22.22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
