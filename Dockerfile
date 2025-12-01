# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source files
COPY server.ts db.ts types.ts ./
COPY services ./services

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

# Expose port (Railway will use PORT env var)
EXPOSE ${PORT:-3000}

# Start the server
CMD ["node", "dist/server.js"]
