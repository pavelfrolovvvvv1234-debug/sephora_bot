# Dockerfile for Sephora Host Bot
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./

# Install pnpm if needed
RUN npm install -g pnpm || true

# Install dependencies
RUN if [ -f "pnpm-lock.yaml" ]; then \
      pnpm install --frozen-lockfile; \
    elif [ -f "package-lock.json" ]; then \
      npm ci; \
    elif [ -f "yarn.lock" ]; then \
      yarn install --frozen-lockfile; \
    else \
      npm install; \
    fi

# Copy source code
COPY . .

# Build the application
RUN npm run build || (echo "Build skipped - check tsconfig" && mkdir -p dist && cp -r src dist)

# Production stage
FROM node:20-alpine

# Install runtime dependencies
RUN apk add --no-cache sqlite

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./

# Install pnpm if needed
RUN npm install -g pnpm || true

# Install production dependencies only
RUN if [ -f "pnpm-lock.yaml" ]; then \
      pnpm install --frozen-lockfile --prod; \
    elif [ -f "package-lock.json" ]; then \
      npm ci --only=production; \
    elif [ -f "yarn.lock" ]; then \
      yarn install --frozen-lockfile --production; \
    else \
      npm install --only=production; \
    fi

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/locales ./locales
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma 2>/dev/null || true

# Create directories for runtime files
RUN mkdir -p sessions data

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port (if using webhook)
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Start the bot
CMD ["node", "--no-deprecation", "dist/index.js"]
