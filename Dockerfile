# free-ai-router — MCP server (stdio transport)
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY index.js ./
COPY lib ./lib
COPY providers ./providers

# .env is expected to be mounted or provided via `docker run --env-file`.
# Do NOT COPY .env into the image.

# MCP uses stdio transport — no port to expose.
# Run with: docker run --rm -i --env-file .env free-ai-router
ENTRYPOINT ["node", "index.js"]
