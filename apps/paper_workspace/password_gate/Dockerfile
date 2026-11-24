FROM python:3.13-slim

COPY --chmod=644 apps/paper_workspace/password_gate/*.py /app/
COPY --chmod=644 apps/paper_workspace/static/assets/favicon-64.png /app/favicon-64.png
COPY --chmod=644 apps/paper_workspace/static/assets/paper-folio-light.svg apps/paper_workspace/static/assets/paper-folio-dark.svg /app/
COPY --chmod=644 apps/paper_workspace/static/theme.css apps/paper_workspace/static/login.css /app/
RUN useradd --system --uid 10003 passwordgate \
    && chmod 755 /app

USER passwordgate
EXPOSE 8079
CMD ["python", "/app/server.py"]
