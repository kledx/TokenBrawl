# =============================================================
# Stage 1: Build frontend (Vite + React)
# =============================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
# VITE_ARENA_WS_URL must be passed as a build arg for static embedding
ARG VITE_ARENA_WS_URL=ws://localhost/arena
ENV VITE_ARENA_WS_URL=${VITE_ARENA_WS_URL}
RUN npm run build

# =============================================================
# Stage 2: Arena WebSocket Server (runtime)
# =============================================================
FROM node:22-alpine AS arena

WORKDIR /app

# Only install production deps + tsx for running TypeScript directly
COPY package.json package-lock.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 3001

ENV NODE_ENV=production
ENV ARENA_PORT=3001

CMD ["npx", "tsx", "src/arena/startArena.ts"]

# =============================================================
# Stage 3: Web (Nginx serving Vite dist)
# =============================================================
FROM nginx:1.27-alpine AS web

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy built frontend
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
