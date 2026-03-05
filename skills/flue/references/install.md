# Flue Installation Guide

Complete guide for installing Flue and creating your first workflow.

## Prerequisites

- Node.js 18+ (22 recommended)
- npm, pnpm, or bun
- An Anthropic API key (or other LLM provider key)

## Step 1: Install Packages

Install Flue packages as dev dependencies:

```bash
npm install -D @flue/client @flue/cli
```

Or with pnpm:

```bash
pnpm add -D @flue/client @flue/cli
```

Or with bun:

```bash
bun add -d @flue/client @flue/cli
```

## Step 2: Create Your First Workflow

Create the workflows directory:

```bash
mkdir -p .flue/workflows
```

Copy the hello-flue example workflow from `${CLAUDE_SKILL_ROOT}/assets/hello-flue.ts` to `.flue/workflows/hello-flue.ts`.

This creates a simple workflow that prints a greeting when run.

## Step 3: Test Locally

The CLI auto-installs OpenCode if it isn't already on `PATH`. To install it explicitly:

```bash
npx flue install
```

Set your API key in the environment:

```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

Run the workflow:

```bash
npx flue run .flue/workflows/hello-flue.ts
```

You should see output from the OpenCode agent executing the workflow.

### Passing Arguments

Workflows can accept arguments via `--args`:

```bash
npx flue run .flue/workflows/hello-flue.ts --args '{"name": "World"}'
```

### Selecting Models

Use `--model` to specify which LLM to use:

```bash
npx flue run .flue/workflows/hello-flue.ts --model anthropic/claude-sonnet-4-20250514
```

Or configure the model in `opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

## Step 4: Deploy to GitHub Actions

### Create GitHub Actions Workflow

Copy the GitHub Actions workflow from `${CLAUDE_SKILL_ROOT}/assets/hello-flue.yml` to `.github/workflows/hello-flue.yml`.

This creates a workflow that runs on `workflow_dispatch` so you can trigger it manually from the GitHub UI.

### Add API Key Secret

1. Go to your repository on GitHub
2. Navigate to **Settings > Secrets and variables > Actions**
3. Click **New repository secret**
4. Name: `ANTHROPIC_API_KEY`
5. Value: Your Anthropic API key
6. Click **Add secret**

### Commit and Push

```bash
git add .flue/workflows/hello-flue.ts .github/workflows/hello-flue.yml
git commit -m "Add Flue hello-flue workflow"
git push
```

### Run the Workflow

1. Go to **Actions** tab in your GitHub repository
2. Select **Hello Flue** workflow
3. Click **Run workflow**
4. Wait for the job to complete
5. Check the logs to see the output

## Step 5: Create Real Workflows

Now that Flue is set up, you can create more complex workflows:

### Example: Issue Triage

Create `.flue/workflows/issue-triage.ts`:

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

export const args = v.object({
  issueNumber: v.number(),
});

export default async function triage(
  flue: FlueClient,
  { issueNumber }: v.InferOutput<typeof args>,
) {
  // Fetch issue details
  const result = await flue.shell(`gh issue view ${issueNumber} --json title,body`);
  const issue = JSON.parse(result.stdout);

  // Analyze with AI
  const analysis = await flue.prompt(
    `Analyze this GitHub issue and categorize it (bug/feature/question):\n\nTitle: ${issue.title}\n\nBody: ${issue.body}`,
    { result: v.string() },
  );

  // Post comment
  await flue.shell(
    `gh issue comment ${issueNumber} --body ${JSON.stringify(`Triage result: ${analysis}`)}`,
  );
}
```

Create `.github/workflows/issue-triage.yml`:

```yaml
name: Issue Triage

on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Run triage
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx flue run .flue/workflows/issue-triage.ts \
            --args '{"issueNumber": ${{ github.event.issue.number }}}' \
            --model anthropic/claude-sonnet-4-20250514
```

## Next Steps

- **Add skills**: Create `.agents/skills/<name>.md` files for complex autonomous tasks (see https://agentskills.io/specification)
- **Add sandbox**: Read `references/add-sandbox.md` for secure isolation setup
- **Explore examples**: Check the Flue repository for more workflow examples
- **Customize triggers**: Modify GitHub Actions `on:` to trigger on different events

## Troubleshooting

### "opencode: command not found"

Install OpenCode via the Flue CLI:

```bash
npx flue install
```

### "API key not set"

Set the environment variable for your provider:

```bash
export ANTHROPIC_API_KEY=your_key
# or
export OPENAI_API_KEY=your_key
```

### "Cannot find module '@flue/client'"

Install the Flue packages:

```bash
npm install -D @flue/client @flue/cli
```

### Workflow not triggering on GitHub

- Check the `on:` trigger in your GitHub Actions workflow
- Verify permissions are set correctly in the workflow
- Check GitHub Actions logs for errors

### GitHub CLI not authenticated

In GitHub Actions, `GITHUB_TOKEN` is provided automatically. Locally:

```bash
gh auth login
```
