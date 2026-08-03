# OwnBase service image: long-running `opencode serve` worker.
# Built on the Base via `podman build` from a shallow clone — no build args.
#
# Pin OPENCODE_VERSION when cutting a release. Multi-arch via TARGETARCH.

FROM debian:bookworm-slim

ARG OPENCODE_VERSION=1.18.11
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    HOME=/home/opencode \
    PATH=/usr/local/go/bin:/home/opencode/go/bin:/home/opencode/.local/bin:/usr/local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client ripgrep \
      python3 python3-pip python3-venv \
      build-essential \
      jq unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (NodeSource)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Go 1.23
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) GOARCH=amd64 ;; \
      arm64) GOARCH=arm64 ;; \
      *) GOARCH=amd64 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go1.23.6.linux-${GOARCH}.tar.gz" \
      | tar -C /usr/local -xz

# OpenCode CLI (official release tarball; not the npm stub)
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) OC_ARCH=x64 ;; \
      arm64) OC_ARCH=arm64 ;; \
      *) OC_ARCH=x64 ;; \
    esac; \
    curl -fsSL \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OC_ARCH}.tar.gz" \
      | tar -C /usr/local/bin -xz; \
    chmod +x /usr/local/bin/opencode; \
    opencode --version

# Non-root user. OwnBase mounts named volumes empty; Podman copies up the
# ownership of the mount-point directory from the image on first create.
RUN useradd --create-home --uid 1000 --shell /bin/bash opencode \
    && mkdir -p \
         /home/opencode/.local/share/opencode \
         /home/opencode/.config/opencode \
         /home/opencode/.ssh \
         /workspaces \
    && chown -R opencode:opencode /home/opencode /workspaces

COPY --chown=opencode:opencode opencode.json /home/opencode/.config/opencode/opencode.json
COPY --chown=opencode:opencode entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

USER opencode
WORKDIR /workspaces

EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
