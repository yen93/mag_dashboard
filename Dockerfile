# ---- Stage 1: build the React frontend ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---- Stage 2: runtime (Express serves API + built frontend) ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Server dependencies only.
COPY package.json ./
RUN npm install --omit=dev
# Server source and the built client from stage 1.
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
EXPOSE 8080
CMD ["node", "server/index.js"]
