# Flue Workflow Patterns

Common patterns and recipes for writing Flue workflows.

## Issue Triage

Fetch an issue, run autonomous reproduction, post a summary comment:

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

export const args = v.object({ issueNumber: v.number() });

export default async function triage(
  flue: FlueClient,
  { issueNumber }: v.InferOutput<typeof args>,
) {
  const issue = await flue.shell(`gh issue view ${issueNumber} --json title,body`);

  const diagnosis = await flue.skill('triage/reproduce.md', {
    args: { issueNumber, issue: JSON.parse(issue.stdout) },
    result: v.object({ reproducible: v.boolean() }),
  });

  const comment = await flue.prompt(
    `Write a triage summary for issue #${issueNumber}. Reproducible: ${diagnosis.reproducible}`,
    { result: v.string() },
  );

  await flue.shell(`gh issue comment ${issueNumber} --body-file -`, { stdin: comment });
}
```

## PR Review

Fetch a diff, run a code quality skill, post review comments:

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

export const args = v.object({ prNumber: v.number() });

export default async function review(flue: FlueClient, { prNumber }: v.InferOutput<typeof args>) {
  const diff = await flue.shell(`gh pr diff ${prNumber}`);

  const review = await flue.skill('review/code-quality.md', {
    args: { prNumber, diff: diff.stdout },
    result: v.object({
      approved: v.boolean(),
      comments: v.array(v.string()),
    }),
  });

  for (const comment of review.comments) {
    await flue.shell(`gh pr comment ${prNumber} --body ${JSON.stringify(comment)}`);
  }
}
```

## Automated Test Fix

Run tests, and if they fail, analyze failures and attempt a fix:

```typescript
import type { FlueClient } from '@flue/client';

export default async function testAndFix(flue: FlueClient) {
  const testResult = await flue.shell('npm test');

  if (testResult.exitCode !== 0) {
    const analysis = await flue.prompt(
      `Analyze these test failures and suggest fixes:\n${testResult.stderr}`,
      { result: v.string() },
    );

    await flue.skill('fix/test-failures.md', {
      args: { failures: testResult.stderr, analysis },
    });
  }
}
```

## Multi-Stage Pipeline

Chain skills together, passing results from one stage to the next:

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

export default async function pipeline(flue: FlueClient, { issueNumber }: { issueNumber: number }) {
  // Stage 1: Reproduce
  const reproduce = await flue.skill('triage/reproduce.md', {
    args: { issueNumber },
    result: v.object({ reproducible: v.boolean(), skipped: v.boolean() }),
  });

  if (!reproduce.reproducible || reproduce.skipped) return reproduce;

  // Stage 2: Diagnose
  const diagnose = await flue.skill('triage/diagnose.md', {
    args: { issueNumber },
    result: v.object({ confidence: v.picklist(['high', 'medium', 'low']) }),
  });

  // Stage 3: Fix (only if high confidence)
  if (diagnose.confidence === 'high') {
    const fix = await flue.skill('triage/fix.md', {
      args: { issueNumber },
      result: v.object({ fixed: v.boolean(), commitMessage: v.nullable(v.string()) }),
    });
    return { ...reproduce, ...diagnose, ...fix };
  }

  return { ...reproduce, ...diagnose, fixed: false };
}
```

## Troubleshooting

### Workflow Not Running

- Check GitHub Actions logs for errors
- Verify API keys are set in repository secrets
- Ensure workflow trigger conditions match (e.g., `on: issues: types: [opened]`)

### Shell Commands Failing

- Check command syntax and quoting
- Verify required tools are installed (gh, git, npm, etc.)
- Check exit codes: `result.exitCode`

### Skills Not Working

- Verify skill file exists in `.agents/skills/`
- Check skill markdown syntax and clarity
- Validate result schema matches expected output
- Review https://agentskills.io/specification for proper skill format

### Local Testing Issues

- Ensure OpenCode CLI is installed: `npx flue install`
- Check API keys are set in environment
- Verify OpenCode server is running: `opencode status`

## Best Practices

1. **Keep workflows focused** — One workflow per task or trigger
2. **Use skills for complexity** — Delegate multi-step tasks to autonomous agents
3. **Validate with schemas** — Always use Valibot schemas for type-safe results
4. **Test locally first** — Run workflows locally before deploying to CI
5. **Add error handling** — Check exit codes and handle failures gracefully
6. **Use proxies in production** — Always use sandbox mode for security-sensitive workflows
