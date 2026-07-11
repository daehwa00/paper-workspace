FROM python:3.13-slim
RUN pip install --no-cache-dir websockets==16.0 && useradd --system --uid 10002 collaboration
COPY --chmod=644 apps/paper_workspace/collaboration/server.py /app/server.py
RUN chmod 755 /app
USER collaboration
EXPOSE 8765
CMD ["python", "/app/server.py"]
