FROM node:22-slim

# Install common tools for agent sandboxes
RUN apt-get update && apt-get install -y \
    git curl wget \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Keep container alive
CMD ["sleep", "infinity"]
