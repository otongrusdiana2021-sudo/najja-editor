# Najja Editor — production image (no npm dependencies)
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js mcp-stdio.js ./
COPY mcp ./mcp
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data/media /data/exports && chown -R node:node /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3333 \
    NAJJA_NO_OPEN=1 \
    NAJJA_DATA_DIR=/data
VOLUME /data
EXPOSE 3333
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3333/healthz >/dev/null || exit 1
CMD ["node", "server.js", "--no-open"]
