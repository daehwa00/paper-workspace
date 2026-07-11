FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.144.1
COPY --chmod=644 apps/paper_workspace/codex_bridge/server.mjs /app/server.mjs
COPY --chmod=644 apps/paper_workspace/codex_bridge/revision-schema.json /app/revision-schema.json
COPY --chmod=755 apps/paper_workspace/codex_bridge/start.sh /app/start.sh
RUN mkdir -p /home/node/.codex \
    && chmod 755 /app \
    && chown -R node:node /home/node/.codex /app

USER node
EXPOSE 8790
CMD ["sh", "/app/start.sh"]
