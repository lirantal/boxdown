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
COPY assets/image/boxdown-ssh-runtime /usr/local/sbin/boxdown-ssh-runtime
COPY assets/image/boxdown-ssh-agent-proxy /usr/local/sbin/boxdown-ssh-agent-proxy
COPY assets/image/boxdown-sudoers /etc/sudoers.d/boxdown
COPY assets/image/tools.lock.json assets/image/install-native-tools.sh assets/image/smoke-test.sh assets/image/lifecycle-smoke-test.sh /opt/boxdown/image-tools/
RUN chmod 0755 \
        /usr/local/sbin/boxdown-ssh-runtime \
        /usr/local/sbin/boxdown-ssh-agent-proxy \
        /opt/boxdown/image-tools/install-native-tools.sh \
        /opt/boxdown/image-tools/smoke-test.sh \
        /opt/boxdown/image-tools/lifecycle-smoke-test.sh \
    && chmod 0440 /etc/sudoers.d/boxdown \
    && visudo -cf /etc/sudoers.d/boxdown \
    && /opt/boxdown/image-tools/install-native-tools.sh \
        "$TARGETARCH" \
        /opt/boxdown/image-tools/tools.lock.json

RUN install -d -m 0755 -o node -g node /opt/boxdown/state \
    && install -d -m 0700 -o node -g node \
        /home/node/.claude /home/node/.codex

USER node
