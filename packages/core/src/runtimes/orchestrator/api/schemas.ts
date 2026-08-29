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
});

export const orchestratorHealthSchema = z.object({
  status: z.literal('ok'),
  entries: z.number().int().nonnegative(),
  memories: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string().nullable(),
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

export type OrchestratorEntry = z.infer<typeof orchestratorEntrySchema>;
export type OrchestratorHealth = z.infer<typeof orchestratorHealthSchema>;
export type OrchestratorThread = z.infer<typeof orchestratorThreadSchema>;
export type OrchestratorReply = z.infer<typeof orchestratorReplySchema>;
