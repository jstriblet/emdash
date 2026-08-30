type WorkerConversation = {
  id: string;
  sessionId?: string;
  providerId: string;
  agentStatus?: string | null;
  lastInteractedAt?: string | null;
};

const STATUS_PRIORITY: Record<string, number> = {
  'awaiting-input': 5,
  error: 4,
  working: 3,
  completed: 2,
  idle: 1,
};

export function selectWorkerConversation(
  conversations: WorkerConversation[]
): WorkerConversation | undefined {
  return [...conversations].sort((left, right) => {
    const statusDifference =
      (STATUS_PRIORITY[right.agentStatus ?? 'idle'] ?? 0) -
      (STATUS_PRIORITY[left.agentStatus ?? 'idle'] ?? 0);
    if (statusDifference !== 0) return statusDifference;
    return (right.lastInteractedAt ?? '').localeCompare(left.lastInteractedAt ?? '');
  })[0];
}

type TerminalBuffer = {
  length: number;
  getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
};

export function terminalPromptExcerpt(
  buffer: TerminalBuffer | undefined,
  lineLimit = 16
): string | undefined {
  if (!buffer) return undefined;
  const lines: string[] = [];
  const firstLine = Math.max(0, buffer.length - lineLimit);
  for (let index = firstLine; index < buffer.length; index++) {
    const line = buffer.getLine(index)?.translateToString(true).trimEnd();
    if (line) lines.push(line);
  }
  const excerpt = redactSecrets(lines.join('\n')).slice(-4_000).trim();
  return excerpt || undefined;
}
import { redactSecrets } from '@emdash/shared/logger';
