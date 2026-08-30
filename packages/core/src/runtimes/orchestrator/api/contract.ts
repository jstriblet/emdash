import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import {
  orchestratorHealthSchema,
  orchestratorForkUpdateSchema,
  orchestratorReplySchema,
  orchestratorWorkContractInputSchema,
  orchestratorWorkContractSchema,
  orchestratorWorkContractUpdateInputSchema,
  orchestratorThreadSchema,
} from './schemas';

export const orchestratorDomain = 'orchestrator' as const;

export const orchestratorContract = defineContract({
  connect: procedure({
    input: z.object({ connectionId: z.string().min(1) }),
    output: orchestratorHealthSchema,
  }),
  updateFork: procedure({ input: z.void(), output: orchestratorForkUpdateSchema }),
  installMacApp: procedure({ input: z.void(), output: orchestratorForkUpdateSchema }),
  health: procedure({ input: z.void(), output: orchestratorHealthSchema }),
  thread: procedure({
    input: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
    output: orchestratorThreadSchema,
  }),
  send: procedure({
    input: z.object({ text: z.string().trim().min(1) }),
    output: orchestratorReplySchema,
  }),
  workContracts: procedure({
    input: z.void(),
    output: z.object({ workContracts: z.array(orchestratorWorkContractSchema) }),
  }),
  createWorkContract: procedure({
    input: orchestratorWorkContractInputSchema,
    output: orchestratorWorkContractSchema,
  }),
  updateWorkContract: procedure({
    input: z.object({ contractId: z.string(), update: orchestratorWorkContractUpdateInputSchema }),
    output: orchestratorWorkContractSchema,
  }),
});

export type OrchestratorContract = typeof orchestratorContract;
