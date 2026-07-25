FROM node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573

ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash-completion \
        ca-certificates \
        curl \
        gh \
        git \
        less \
        openssh-server \
        procps \
        ripgrep \
        sudo \
        tar \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node assets/image/npm /home/node/.local
USER node
RUN npm ci --omit=dev --ignore-scripts --prefix /home/node/.local \
    && node /home/node/.local/node_modules/@anthropic-ai/claude-code/install.cjs \
    && node /home/node/.local/node_modules/snyk/wrapper_dist/bootstrap.js exec
ENV PATH=/home/node/.local/node_modules/.bin:${PATH}

USER root
COPY assets/image/tools.lock.json assets/image/install-native-tools.sh assets/image/smoke-test.sh /opt/boxdown/image-tools/
RUN chmod 0755 \
        /opt/boxdown/image-tools/install-native-tools.sh \
        /opt/boxdown/image-tools/smoke-test.sh \
    && /opt/boxdown/image-tools/install-native-tools.sh \
        "$TARGETARCH" \
        /opt/boxdown/image-tools/tools.lock.json \
    && mkdir -p /home/node/.cache/boxdown/coding-agent-clis \
    && touch \
        /home/node/.cache/boxdown/coding-agent-clis/codex.stamp \
        /home/node/.cache/boxdown/coding-agent-clis/claude.stamp \
    && chown -R node:node /home/node/.cache

USER node
