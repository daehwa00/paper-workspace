FROM python:3.13-slim

COPY --chmod=644 apps/paper_workspace/password_gate/server.py /app/server.py
COPY --chmod=644 apps/paper_workspace/static/assets/favicon-64.png /app/favicon-64.png
RUN useradd --system --uid 10003 passwordgate \
    && chmod 755 /app

USER passwordgate
EXPOSE 8079
CMD ["python", "/app/server.py"]
