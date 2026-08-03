# OwnBase service image: public harness that places sessions on opencode workers.
# Built on the Base via podman build from a shallow clone — no build args.

FROM oven/bun:1.2-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash harness \
    && mkdir -p /app \
    && chown -R harness:harness /app

WORKDIR /app
COPY --chown=harness:harness package.json ./
RUN bun install
COPY --chown=harness:harness . .

USER harness
ENV PORT=8080 \
    HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["bun", "run", "src/index.ts"]
