FROM caddy:2.11.4-alpine

# The upstream binary carries cap_net_bind_service. With no-new-privileges,
# Linux correctly refuses to execute a file that would acquire that capability.
# Compose lowers the unprivileged-port boundary inside the container instead.
USER root
RUN setcap -r /usr/bin/caddy && install -d -m 0755 /etc/paper-caddy
COPY --chmod=0444 infra/paper-workspace/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0444 infra/paper-workspace/Caddyfile.auth /etc/paper-caddy/Caddyfile.auth
COPY --chmod=0444 infra/paper-workspace/Caddyfile.password /etc/paper-caddy/Caddyfile.password

# Keep the image non-root even when it is started outside the compose profile.
USER 1000:1000
