import { defineContract, fallible } from '@emdash/wire/rpc';
import { z } from 'zod';
import { automationRunSchema } from '#runtimes/automations/api';

const launchInput = z.object({
  executionId: z.string().min(1),
  repositoryPath: z.string().startsWith('/'),
  worktreeRoot: z.string().startsWith('/'),
  baseBranch: z.string().min(1).default('main'),
  baseRemote: z.string().min(1).default('origin'),
  goal: z.string().min(1),
  provider: z.enum(['codex', 'claude']).default('codex'),
  model: z.string().min(1).nullable().default(null),
});

const executionInput = z.object({ executionId: z.string().min(1) });
const orchestrationError = z.object({ type: z.literal('operation-failed'), message: z.string() });

export const workspaceOrchestrationContract = defineContract({
  launch: fallible({ input: launchInput, data: automationRunSchema, error: orchestrationError }),
  get: fallible({
    input: executionInput,
    data: automationRunSchema.nullable(),
    error: orchestrationError,
  }),
  cancel: fallible({ input: executionInput, data: z.void(), error: orchestrationError }),
});

export type WorkspaceOrchestrationContract = typeof workspaceOrchestrationContract;
