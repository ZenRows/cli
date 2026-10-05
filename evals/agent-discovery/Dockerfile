# A deliberately empty environment. The value of this image is what it lacks:
# no agent config, no plugins, no MCP servers, no instruction files, no vendor
# CLIs. Anything the agent knows here, it learned from the arm under test.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

RUN useradd -m -s /bin/bash probe
USER probe
WORKDIR /work
ENV DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1

COPY --chown=probe:probe run.sh /usr/local/bin/run.sh
ENTRYPOINT ["/bin/bash", "/usr/local/bin/run.sh"]
