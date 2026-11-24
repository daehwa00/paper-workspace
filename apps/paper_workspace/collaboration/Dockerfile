FROM node:22.23.1-alpine
WORKDIR /app
COPY --chmod=0444 apps/paper_workspace/collaboration/package.json apps/paper_workspace/collaboration/package-lock.json ./
RUN npm ci --omit=dev && chmod -R a+rX /app && mkdir -p /data/yjs && chown -R node:node /data
COPY --chown=node:node --chmod=0444 apps/paper_workspace/collaboration/server.cjs apps/paper_workspace/collaboration/source-merge.cjs apps/paper_workspace/collaboration/rebuttal-sources.cjs apps/paper_workspace/collaboration/atomic-source.cjs apps/paper_workspace/collaboration/http-helpers.cjs apps/paper_workspace/collaboration/runtime-sync.cjs apps/paper_workspace/collaboration/storage-quota.cjs apps/paper_workspace/collaboration/writeback.cjs ./
USER node
EXPOSE 8765
ENV HOST=0.0.0.0 PORT=8765 YPERSISTENCE=/data/yjs
VOLUME ["/data"]
CMD ["node", "server.cjs"]
