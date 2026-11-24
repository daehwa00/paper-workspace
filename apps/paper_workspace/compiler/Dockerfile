FROM python:3.13-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra texlive-bibtex-extra texlive-plain-generic texlive-science tex-gyre \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends poppler-utils pandoc util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=644 apps/paper_workspace/compiler/*.py /app/compiler/
COPY --chmod=644 apps/paper_workspace/compiler/server.py /app/server.py
COPY --chmod=644 scripts/paper_platform/runtime_common.py /app/runtime_common.py
COPY --chmod=755 scripts/paper_platform/generate_project_thumbnails.py /app/generate_project_thumbnails.py
COPY --chmod=755 scripts/paper_platform/sync_project_runtime.py /app/sync_project_runtime.py
RUN chmod 755 /app /app/compiler && useradd --system --uid 10001 compiler
USER compiler
EXPOSE 8000
CMD ["python", "/app/server.py"]
