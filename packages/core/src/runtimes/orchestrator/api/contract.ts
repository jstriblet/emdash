import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import {
  orchestratorHealthSchema,
  orchestratorReplySchema,
  orchestratorThreadSchema,
} from './schemas';

export const orchestratorDomain = 'orchestrator' as const;

export const orchestratorContract = defineContract({
  health: procedure({ input: z.void(), output: orchestratorHealthSchema }),
  thread: procedure({
    input: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
    output: orchestratorThreadSchema,
  }),
  send: procedure({
    input: z.object({ text: z.string().trim().min(1) }),
    output: orchestratorReplySchema,
  }),
});

export type OrchestratorContract = typeof orchestratorContract;
