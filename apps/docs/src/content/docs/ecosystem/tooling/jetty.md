---
title: Jetty
description: Grade Flue workflow output and compare results across versions with Jetty.
lastReviewedAt: 2026-07-09
---

## Quickstart

Install the [Jetty TypeScript SDK](https://www.npmjs.com/package/@jetty/sdk) in an existing Flue project:

```sh
pnpm add @jetty/sdk
```

Jetty does not use a `flue add` blueprint. Follow Jetty's [Flue integration guide](https://docs.jetty.io/docs/agent-integrations/flue) to create and deploy a grading runbook, then call the SDK from a workflow.

## Overview

Jetty can grade output produced during a Flue workflow run and store the grading task as a trajectory. Labels on that trajectory can record the score, pass/fail result, evaluated configuration, and other dimensions that you want to compare across versions.

The following Node.js workflow prompts its agent, sends the response to a separately configured Jetty grader, and returns the grade with its Jetty trajectory ID:

```ts title="src/workflows/evaluate-triage.ts"
import { defineWorkflow } from '@flue/runtime';
import { gradeWithJetty, JettyClient } from '@jetty/sdk';
import * as v from 'valibot';
import triageAgent from '../agents/triage.ts';

interface TriageGrade {
  total: number;
  pass: boolean;
}

const jetty = new JettyClient();

export default defineWorkflow({
  agent: triageAgent,
  input: v.object({ ticket: v.string() }),
  output: v.object({
    grade: v.object({ total: v.number(), pass: v.boolean() }),
    trajectoryId: v.string(),
  }),

  async run({ harness, input }) {
    const session = await harness.session();
    const response = await session.prompt(input.ticket);

    const { grade, trajectoryId } = await gradeWithJetty<TriageGrade>(
      jetty,
      process.env.JETTY_COLLECTION!,
      process.env.JETTY_GRADE_TASK!,
      {
        files: [
          {
            filename: 'case.json',
            data: JSON.stringify({ ticket: input.ticket, response: response.text }),
          },
        ],
        useTrialKeys: process.env.JETTY_USE_TRIAL_KEYS === 'true',
        labels: (result) => ({
          'eval.grade': String(result.total),
          'eval.pass': String(result.pass),
        }),
      },
    );

    return { grade, trajectoryId };
  },
});
```

The grading runbook must produce the `grade.json` file expected by `gradeWithJetty(...)`. Keep the grader separate from the agent being evaluated so that changing the agent does not silently change its rubric.

## Configure

| Variable               | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `JETTY_API_TOKEN`      | **Required** - Authenticates the Jetty SDK. The SDK can also read `~/.config/jetty/token`. |
| `JETTY_COLLECTION`     | **Required** - Identifies the collection that owns the grading task.                       |
| `JETTY_GRADE_TASK`     | **Required** - Identifies the deployed grading task.                                       |
| `JETTY_USE_TRIAL_KEYS` | **Optional** - Set to `true` to use Jetty's trial model keys for the grading task.         |

The Flue agent still needs the model-provider credentials configured by the application. Jetty credentials configure the separate grading operation.

`@jetty/sdk` requires Node.js. Use this workflow with Flue's Node target.

## Protect sensitive content

Jetty trajectories can persist the files, step inputs, and outputs used for grading. Redact credentials, personal information, and other sensitive content before sending agent output to Jetty. Use Jetty's secret parameters for credentials needed by the grading runbook rather than including them in persisted initialization parameters or uploaded files.

Review Jetty's retention, access, privacy, and compliance controls before grading production content.

## Verify

Deploy the grading runbook following Jetty's integration guide, configure the required environment variables, and invoke the workflow:

```sh
pnpm exec flue run evaluate-triage --input '{"ticket":"Summarize this support request."}'
```

Confirm that the workflow returns the expected grade and trajectory ID, then inspect the trajectory in Jetty to verify its labels and captured content.

## Next steps

See [Evals](/docs/guide/evals/) for choosing cases, deterministic assertions, and model-based judges. Flue's [Vitest Evals integration](/docs/ecosystem/tooling/vitest-evals/) provides an alternative for running assertions and judges through Vitest, while Jetty stores each grading task as a comparable trajectory.
