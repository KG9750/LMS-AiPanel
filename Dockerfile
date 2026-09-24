FROM node:24-bookworm-slim

ARG DOCKER_CLI_VERSION=27.5.1

WORKDIR /app

# Production deps only; dist/ is prebuilt on the host.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Static docker CLI for the docker adapter (`docker ps --all` against the mounted socket).
# download.docker.com names static builds x86_64/aarch64; map from BuildKit TARGETARCH.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      ARCH="x86_64"; \
    else \
      ARCH="aarch64"; \
    fi \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /tmp/docker.tgz \
       "https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz \
    && rm -rf /var/lib/apt/lists/*

COPY dist ./dist
COPY migrations ./migrations

ENV LMS_AIPANEL_HOST=0.0.0.0 \
    LMS_AIPANEL_PORT=3777 \
    LMS_AIPANEL_DATA_DIR=/data

EXPOSE 3777

CMD ["node", "dist/server/index.js"]
