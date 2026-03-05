# Add Sandbox Isolation to Flue Workflows

Complete guide for adding secure sandbox isolation to Flue workflows using Docker containers and credential proxying.

## What is Sandbox Mode?

Sandbox mode runs the OpenCode agent inside a Docker container for security isolation. The agent can still run shell commands, edit files, and use tools — but it can't access the host runner's environment or secrets.

**Benefits:**

- **Security** — Agent can't exfiltrate secrets from the runner
- **Credential proxying** — API keys injected per-request through policy-gated proxies
- **Reproducibility** — Consistent container image vs. runner environment drift

**How it works:**

1. The sandbox container runs the OpenCode server
2. Your workflow code runs on the host (outside the sandbox)
3. When calling `flue.shell()`, `flue.prompt()`, or `flue.skill()`, commands execute inside the sandbox
4. Proxies intercept API calls and inject credentials without exposing them to the sandbox

## Step 1: Create Sandbox Image

Create `.flue/sandbox/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl wget git jq \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Install OpenCode CLI (the agent runtime)
RUN curl -fsSL https://opencode.ai/install | bash \
    && cp /root/.opencode/bin/opencode /usr/local/bin/opencode

# Install GitHub CLI
RUN (type -p wget >/dev/null || (apt-get update && apt-get install wget -y)) \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && wget -nv -O /tmp/gh.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && cat /tmp/gh.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install gh -y \
    && rm -rf /var/lib/apt/lists/*

# Allow git operations in any directory
RUN git config --system --add safe.directory '*'

# Expose OpenCode server port
EXPOSE 48765

# Start OpenCode server
CMD ["opencode", "serve", "--port", "48765", "--hostname", "0.0.0.0"]
```

**Customization tips:**

- Add other CLI tools your workflows need (e.g., `docker`, `kubectl`, `terraform`)
- Install language runtimes (Python, Ruby, etc.) if needed
- Add your own custom scripts or binaries

## Step 2: Build and Publish Sandbox Image

Create `.github/workflows/sandbox-image.yml`:

```yaml
name: Build Sandbox Image

on:
  push:
    branches: [main]
    paths: ['.flue/sandbox/**']
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        run: |
          IMAGE=ghcr.io/${{ github.repository }}/flue-sandbox
          IMAGE_LOWER=${IMAGE,,}
          docker build -t $IMAGE_LOWER:latest -f .flue/sandbox/Dockerfile .
          docker push $IMAGE_LOWER:latest
```

**Commit and push to trigger the build:**

```bash
git add .flue/sandbox/Dockerfile .github/workflows/sandbox-image.yml
git commit -m "Add Flue sandbox container image"
git push
```

The workflow will build and push your image to GitHub Container Registry (GHCR). Check the Actions tab to monitor progress.

## Step 3: Add Proxies to Workflow

Proxies declare which external services the sandbox can access and what operations are allowed.

Update your workflow file (e.g., `.flue/workflows/hello-flue.ts`) to add proxy declarations:

```typescript
import type { FlueClient } from '@flue/client';
import { anthropic, github, githubBody } from '@flue/client/proxies';
import * as v from 'valibot';

// Add proxy declarations
export const proxies = {
  // Allow AI model access
  anthropic: anthropic(),

  // Allow GitHub read access + specific write operations
  github: github({
    policy: {
      base: 'allow-read',
      allow: [
        // Allow GraphQL queries
        { method: 'POST', path: '/graphql', body: githubBody.graphql() },
        // Allow git clone/fetch/push over HTTP
        { method: 'GET', path: '/*/info/refs' },
        { method: 'POST', path: '/*/git-upload-pack' },
        { method: 'POST', path: '/*/git-receive-pack' },
        // Allow posting issue comments (limit 5)
        { method: 'POST', path: '/repos/*/issues/*/comments', limit: 5 },
      ],
    },
  }),
};

export default async function workflow(flue: FlueClient, args: any) {
  // Your workflow logic remains unchanged
  // All flue.shell(), flue.prompt(), and flue.skill() calls work the same
}
```

### Built-in Proxy Presets

Flue includes presets for popular services:

| Preset         | Import                 | Description                    |
| -------------- | ---------------------- | ------------------------------ |
| `anthropic()`  | `@flue/client/proxies` | Anthropic API access           |
| `github(opts)` | `@flue/client/proxies` | GitHub API with policy control |

### GitHub Proxy Policies

The `github()` proxy supports granular access control:

```typescript
github({
  policy: {
    // Base policy: 'allow-read', 'allow-all', or 'deny-all'
    base: 'allow-read',

    // Additional allow rules
    allow: [
      { method: 'POST', path: '/repos/*/issues/*/comments', limit: 10 },
      { method: 'PATCH', path: '/repos/*/issues/*' },
    ],

    // Deny rules (override allows)
    deny: [{ method: 'DELETE', path: '/**' }],
  },
});
```

**Policy bases:**

- `'allow-read'` — GET and HEAD requests only (default)
- `'allow-all'` — All methods and paths
- `'deny-all'` — Deny everything (use with explicit `allow` rules)

**Rule options:**

- `method` — HTTP method (GET, POST, PATCH, PUT, DELETE)
- `path` — URL path pattern (supports `*` wildcards)
- `limit` — Max number of requests (optional)
- `body` — Body validation (e.g., `githubBody.graphql()`)

## Step 4: Update GitHub Actions Workflow

Update your GitHub Actions workflow to use the sandbox image.

**Before (no sandbox):**

```yaml
- name: Run workflow
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    npx flue run .flue/workflows/hello-flue.ts \
      --model anthropic/claude-sonnet-4-20250514
```

**After (with sandbox):**

```yaml
- name: Log in to GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- name: Pull sandbox image
  env:
    IMAGE: ghcr.io/${{ github.repository }}/flue-sandbox
  run: |
    IMAGE_LOWER=${IMAGE,,}
    docker pull $IMAGE_LOWER:latest

- name: Run workflow
  env:
    IMAGE: ghcr.io/${{ github.repository }}/flue-sandbox
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    IMAGE_LOWER=${IMAGE,,}
    npx flue run .flue/workflows/hello-flue.ts \
      --sandbox $IMAGE_LOWER:latest \
      --model anthropic/claude-sonnet-4-20250514
```

**Complete example** (`.github/workflows/hello-flue-sandbox.yml`):

```yaml
name: Hello Flue (Sandbox)

on:
  workflow_dispatch:

env:
  IMAGE: ghcr.io/${{ github.repository }}/flue-sandbox

jobs:
  hello:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      packages: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: npm ci

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Pull sandbox image
        run: |
          IMAGE_LOWER=${IMAGE,,}
          docker pull $IMAGE_LOWER:latest

      - name: Run workflow
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          IMAGE_LOWER=${IMAGE,,}
          npx flue run .flue/workflows/hello-flue.ts \
            --sandbox $IMAGE_LOWER:latest \
            --model anthropic/claude-sonnet-4-20250514
```

## Step 5: Test Locally (Optional)

You can test sandbox mode locally if you have Docker installed:

```bash
# Build the image locally
docker build -t flue-sandbox:latest -f .flue/sandbox/Dockerfile .

# Run with sandbox
export ANTHROPIC_API_KEY=your_key
npx flue run .flue/workflows/hello-flue.ts --sandbox flue-sandbox:latest
```

## Step 6: Verify Sandbox Isolation

After deploying, verify that the sandbox is working correctly:

1. **Check logs** — Confirm OpenCode starts inside the container
2. **Test proxies** — Verify API calls are proxied (check for HMAC tokens in logs)
3. **Test isolation** — Ensure the agent can't access host secrets directly

Add verification to your GitHub Actions workflow:

```yaml
- name: Verify sandbox image
  run: |
    IMAGE_LOWER=${IMAGE,,}
    docker run --rm $IMAGE_LOWER:latest sh -c '
      echo "node=$(node -v) pnpm=$(pnpm -v) gh=$(gh --version | head -1)"
      echo "opencode=$(which opencode) version=$(opencode --version)"
      echo "git-safe-dir=$(git config --system --get-all safe.directory)"
    '
```

## Troubleshooting

### Image fails to build

- Check Dockerfile syntax
- Verify base image is available (`node:22-bookworm-slim`)
- Check package URLs and installation commands
- Review build logs in GitHub Actions

### Container won't start

- Verify OpenCode is installed: `which opencode`
- Check OpenCode version: `opencode --version`
- Ensure port 48765 is exposed
- Check CMD starts OpenCode server correctly

### Proxy authentication fails

- Verify `proxies` export in workflow file
- Check API keys are set in repository secrets
- Ensure proxy policy allows the operation
- Review proxy logs for denied requests

### Agent can't run commands

- Verify required tools are installed in the image (gh, git, npm, etc.)
- Check git safe.directory config: `git config --system --get-all safe.directory`
- Ensure file permissions are correct in the container

### Local testing fails

- Install Docker and ensure it's running
- Build the image locally first
- Set environment variables before running
- Check Docker logs: `docker logs <container_id>`

## Best Practices

1. **Keep images minimal** — Only install what you need
2. **Pin versions** — Use specific versions for reproducibility
3. **Test locally** — Build and test images before pushing
4. **Use strict policies** — Start with `deny-all` and allow only what's needed
5. **Limit operations** — Use `limit` on write operations
6. **Monitor logs** — Review proxy logs for unexpected API calls
7. **Update regularly** — Keep base images and tools updated

## Advanced: Private Registries

To use a private registry instead of GHCR:

```yaml
- name: Log in to private registry
  uses: docker/login-action@v3
  with:
    registry: registry.example.com
    username: ${{ secrets.REGISTRY_USER }}
    password: ${{ secrets.REGISTRY_PASSWORD }}

- name: Pull sandbox image
  run: docker pull registry.example.com/my-org/flue-sandbox:latest

- name: Run workflow
  run: |
    npx flue run .flue/workflows/workflow.ts \
      --sandbox registry.example.com/my-org/flue-sandbox:latest
```

## Advanced: Multi-Architecture Images

Build for multiple architectures (amd64, arm64):

```yaml
- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v3

- name: Build and push multi-arch
  uses: docker/build-push-action@v5
  with:
    context: .
    file: .flue/sandbox/Dockerfile
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ghcr.io/${{ github.repository }}/flue-sandbox:latest
```

## Next Steps

- **Refine proxy policies** — Add specific allow/deny rules for your use case
- **Monitor usage** — Track proxy request counts and patterns
- **Add more tools** — Customize the Dockerfile with additional CLI tools
- **Optimize image size** — Use multi-stage builds to reduce image size
