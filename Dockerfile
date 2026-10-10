# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
COPY tsconfig*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Cache buster - change this value to force rebuild of source files
ARG CACHE_BUST=1

# Copy ALL TypeScript source files
COPY server.ts db.ts types.ts platform.ts ./
COPY auth ./auth
COPY services ./services
COPY activityLogs ./activityLogs
COPY utils ./utils

# Verify auth directory exists
RUN ls -la auth/

# Build TypeScript to JavaScript
RUN npm run build:server

# Verify auth was compiled
RUN ls -la dist/auth/

# Production stage
FROM node:22-alpine

# Esplicito, non implicito: due guardie del codice leggono NODE_ENV — il
# driver fiscale mock («mai in produzione») e la CORS per le reti private
# (solo sviluppo/collaudo) — e senza questa riga erano entrambe inerti.
ENV NODE_ENV=production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Static assets served by the API (public booking page lives here)
COPY public ./public

# Migration files: plain JS eseguito a runtime da node-pg-migrate al boot
# (runMigrations in db.ts). Senza questa COPY il server parte ma lo schema
# resta fermo alla baseline di createSchema.
COPY migrations ./migrations

# I manuali che l'assistente «Chiedi a Sympotia» tiene nel prompt (vedi
# services/supportAssistant.ts): solo questi quattro, non tutta la cartella docs.
COPY docs/funzionalita-app.md docs/Manuale_Utente_CRM.md docs/manuale-operativo-comande-cucina-passe.md docs/manuale-food-cost.md ./docs/

# L'installatore del PC della cassa e la cassa finta per provarlo su una
# VM, serviti da GET /installa/cassa.ps1 e /installa/cassa-finta.ps1.
COPY scripts/installa-cassa.ps1 scripts/cassa-finta.ps1 ./scripts/

# Expose port 8080 (Railway's default)
EXPOSE 8080

# Start the server
CMD ["node", "dist/server.js"]
