FROM python:3.13-slim AS wheels
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends g++ && rm -rf /var/lib/apt/lists/*
COPY apps/paper_workspace/rebuttal/requirements.txt /build/requirements.txt
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

FROM python:3.13-slim
WORKDIR /app
COPY --from=wheels /wheels /wheels
COPY apps/paper_workspace/rebuttal/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --no-index --find-links /wheels -r requirements.txt && rm -rf /wheels && useradd --uid 10001 --create-home rebuttal && mkdir /data && chown rebuttal:rebuttal /data
COPY apps/paper_workspace/rebuttal/*.py /app/
USER rebuttal
EXPOSE 8020
CMD ["python", "server.py"]
