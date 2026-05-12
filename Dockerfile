# syntax=docker/dockerfile:1.6
#
# Spendex Pay — Streamable HTTP MCP server. Two-stage build so the final
# image only ships `dist/` + runtime node_modules, no TypeScript toolchain.
#
# Run locally:
#   docker build -t spendex-mcp .
#   docker run --rm -p 3001:3001 -e SPENDEX_DEV=true spendex-mcp
#
# In production (Fly.io, Railway, Render) inject the real env vars from the
# host — the container itself never reads a .env file.

# ---------- builder ----------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install ALL deps (including dev) so we have tsc + vitest available.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the source tree and produce dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Trim node_modules down to production-only for the final stage.
RUN npm prune --omit=dev

# ---------- runtime ---------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Copy only what's needed to run the HTTP transport.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Run as the unprivileged `node` user that ships with the official image.
USER node

EXPOSE 3001

# `npm run start:http` resolves to `node dist/http-server.js`.
CMD ["node", "dist/http-server.js"]
