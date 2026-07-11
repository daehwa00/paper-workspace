FROM python:3.13-slim

COPY --chmod=644 apps/paper_workspace/backup/server.py /app/server.py
RUN useradd --system --uid 10001 backupsvc \
    && mkdir -p /data \
    && chmod 755 /app \
    && chown backupsvc:backupsvc /data

USER backupsvc
EXPOSE 8010
VOLUME ["/data"]
CMD ["python", "/app/server.py"]
