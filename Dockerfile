# Stage 1: Install Claude Code CLI
FROM oven/bun:1 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    npm \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Stage 2: Runtime image
FROM oven/bun:1-slim

# Install git (needed for branch detection and version control)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy Claude Code from builder
COPY --from=builder /usr/local/bin/claude /usr/local/bin/claude
COPY --from=builder /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code

# Create non-root user
RUN groupadd -r agent && useradd -r -g agent -m -d /home/agent agent

# Set working directory
WORKDIR /workspace

# Ensure workspace is owned by agent user
RUN chown agent:agent /workspace

USER agent

ENTRYPOINT ["claude"]
