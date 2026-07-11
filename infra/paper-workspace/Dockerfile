FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY --chmod=644 apps/paper_workspace/static /usr/share/nginx/html
COPY --chmod=644 examples/paper-workspace-project /usr/share/nginx/html/project
USER root
RUN mkdir -p /usr/share/nginx/html/projects
COPY --chmod=644 infra/paper-workspace/nginx.conf /etc/nginx/conf.d/default.conf
RUN find /usr/share/nginx/html -type d -exec chmod 755 {} +
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
