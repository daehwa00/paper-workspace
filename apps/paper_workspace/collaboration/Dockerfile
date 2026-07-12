FROM node:20.19-alpine
WORKDIR /app
COPY apps/paper_workspace/collaboration/package.json apps/paper_workspace/collaboration/package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data/yjs && chown -R node:node /app /data
USER node
EXPOSE 8765
ENV HOST=0.0.0.0 PORT=8765 YPERSISTENCE=/data/yjs
VOLUME ["/data"]
CMD ["node", "node_modules/y-websocket/bin/server.cjs"]
