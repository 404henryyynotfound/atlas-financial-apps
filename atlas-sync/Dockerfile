# Zero-dependency Node 20 image for atlas-sync.
FROM node:20-alpine

# PORT can be overridden at build time (EXPOSE uses the build value) and at
# runtime with `docker run -e PORT=...`. DATA_FILE must be on the mounted
# volume so state survives container replacement.
ARG PORT=8787
ENV PORT=${PORT} \
    DATA_FILE=/app/data/store.json \
    NODE_ENV=production

WORKDIR /app

COPY package.json server.js ./

RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE ${PORT}

# Mount a persistent volume here: -v atlas-sync-data:/app/data
VOLUME ["/app/data"]

USER node

CMD ["node", "server.js"]
