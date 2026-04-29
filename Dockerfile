# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
COPY tsconfig*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Cache buster - change this value to force rebuild of source files
ARG CACHE_BUST=1

# Copy ALL TypeScript source files
COPY server.ts db.ts types.ts ./
COPY auth ./auth
COPY services ./services
COPY activityLogs ./activityLogs

# Verify auth directory exists
RUN ls -la auth/

# Build TypeScript to JavaScript
RUN npm run build:server

# Verify auth was compiled
RUN ls -la dist/auth/

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
