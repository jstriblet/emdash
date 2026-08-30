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
