# Single-stage build: no frontend build step — the pages in public/ are plain
# static HTML/CSS/JS served directly by Express.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY public/ ./public/
EXPOSE 8080
CMD ["node", "server/index.js"]
