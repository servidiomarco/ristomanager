# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Cache bust - update this to force rebuild
ARG CACHEBUST=1

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy ALL source files (not selective to avoid missing files)
COPY server.ts db.ts types.ts ./
COPY services ./services
COPY auth ./auth

# Build TypeScript to JavaScript
RUN npm run build:server

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Expose port 8080 (Railway's default)
EXPOSE 8080

# Start the server
CMD ["node", "dist/server.js"]
