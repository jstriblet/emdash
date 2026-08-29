import { z } from 'zod';

export const orchestratorRoleSchema = z.enum([
  'user',
  'assistant',
  'assistant_progress',
  'activity',
  'system',
]);

export const orchestratorSurfaceSchema = z.enum(['terminal', 'imessage', 'emdash']);

export const orchestratorEntrySchema = z.object({
  id: z.number().int().positive(),
  ts: z.string(),
  surface: orchestratorSurfaceSchema,
  role: orchestratorRoleSchema,
  content: z.string(),
  turn_id: z.string().nullable().optional(),
});

export const orchestratorHealthSchema = z.object({
  status: z.literal('ok'),
  entries: z.number().int().nonnegative(),
  memories: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string().nullable(),
  directory: z.string().nullable().optional(),
  sandbox: z.string().nullable().optional(),
  busy: z.boolean(),
});

export const orchestratorThreadSchema = z.object({
  turns: z.array(orchestratorEntrySchema),
});

export const orchestratorReplySchema = z.object({
  entry_id: z.number().int().positive(),
  reply: z.string(),
  error: z.string().optional(),
});

export const orchestratorForkUpdateSchema = z.object({
  updated: z.boolean(),
  message: z.string(),
});

export type OrchestratorEntry = z.infer<typeof orchestratorEntrySchema>;
export type OrchestratorHealth = z.infer<typeof orchestratorHealthSchema>;
export type OrchestratorThread = z.infer<typeof orchestratorThreadSchema>;
export type OrchestratorReply = z.infer<typeof orchestratorReplySchema>;
export type OrchestratorForkUpdate = z.infer<typeof orchestratorForkUpdateSchema>;
