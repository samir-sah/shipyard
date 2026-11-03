FROM node:24.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/timeout \
    && mkdir -p /work && chown node:node /work
COPY build.sh /usr/local/bin/shipyard-build
RUN chmod 755 /usr/local/bin/shipyard-build
ENV CI=true GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 npm_config_cache=/tmp/npm
WORKDIR /work
USER node
ENTRYPOINT ["/usr/local/bin/shipyard-build"]
