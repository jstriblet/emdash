import { Markdown } from '@emdash/ui/react/components';
import { ReplicaLog } from '@emdash/wire/live';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import type { OrchestratorEntry, OrchestratorHealth, OrchestratorPendingAction } from '../api';
import { getOrchestratorClient } from '../api/browser/client';
import {
  createOrchestratedWorkSession,
  type OrchestratedWorkStage,
} from './orchestrated-work-request';
import { restoreOrchestratorConnection } from './orchestrator-auto-connect';
import {
  flushTerminalWrites,
  rawTerminalPromptExcerpt,
  selectWorkerConversation,
  terminalPromptExcerpt,
} from './worker-telemetry';

const REFRESH_INTERVAL_MS = 2_000;
const ARCHIVE_HANDOFF_TIMEOUT_MS = 15_000;
const DISPLAY_TURNS = 4;
const IS_DEVELOPMENT = import.meta.env.DEV;

export function shouldFollowOrcThread(submittedTurnInFlight: boolean, distanceFromBottom: number) {
  return submittedTurnInFlight || distanceFromBottom < 80;
}

export function escapeCancelAction(
  isWorking: boolean,
  confirmationVisible: boolean,
  hasQueuedFollowUp = false
): 'ignore' | 'confirm' | 'cancel' | 'send-queued' {
  if (!isWorking) return 'ignore';
  if (hasQueuedFollowUp) return 'send-queued';
  return confirmationVisible ? 'cancel' : 'confirm';
}

export function workingStatus(elapsedSeconds: number): string {
  return `Working (${elapsedSeconds}s • esc to interrupt)`;
}

async function readWorkerOutput(conversationId: string): Promise<string | undefined> {
  let output = '';
  const runtime = await getConversationsClient();
  const replica = new ReplicaLog(runtime.tui.output.handle({ conversationId }), {
    store: {
      reset(data) {
        output = data.text.slice(-64_000);
      },
      append(chunk) {
        output = `${output}${chunk}`.slice(-64_000);
      },
    },
  });
  try {
    await replica.ready;
    return rawTerminalPromptExcerpt(output);
  } finally {
    await replica.dispose();
  }
}

type OrcMachine = { id: string; name: string };

function entryMarker(entry: OrchestratorEntry): string {
  if (entry.role === 'user') return '›';
  if (entry.role === 'system') return '!';
  return '•';
}

type Activity = {
  id: string;
  kind: 'reasoning' | 'command' | 'file_change' | 'tool' | 'web_search' | 'plan';
  status: 'in_progress' | 'completed' | 'failed';
  title: string;
  detail: string;
};

function parseActivity(entry: OrchestratorEntry): Activity | undefined {
  if (entry.role !== 'activity') return undefined;
  try {
    const value: unknown = JSON.parse(entry.content);
    if (!value || typeof value !== 'object') return undefined;
    const activity = value as Partial<Activity>;
    if (
      typeof activity.id !== 'string' ||
      typeof activity.kind !== 'string' ||
      typeof activity.status !== 'string' ||
      typeof activity.title !== 'string'
    ) {
      return undefined;
    }
    return {
      ...activity,
      detail: typeof activity.detail === 'string' ? activity.detail : '',
    } as Activity;
  } catch {
    return undefined;
  }
}

function activityHeading(activity: Activity): string {
  if (activity.kind === 'command') {
    const command = activity.title.replace(/^\/bin\/bash -lc /, '').replace(/^"|"$/g, '');
    const displayCommand = command.replace(/\s*\n\s*/g, ' ');
    if (activity.status === 'in_progress') return `Running ${displayCommand}`;
    if (activity.status === 'failed') return `Command failed ${displayCommand}`;
    return `Ran ${displayCommand}`;
  }
  if (activity.kind === 'file_change') {
    return `${activity.status === 'in_progress' ? 'Editing' : 'Edited'} ${activity.title.replace(/^Changed /, '')}`;
  }
  if (activity.kind === 'web_search') {
    return `${activity.status === 'in_progress' ? 'Searching' : 'Searched'} ${activity.title}`;
  }
  return activity.title;
}

export function activityDetail(
  detail: string,
  expanded = false
): { hidden: number; lines: string[] } {
  const lines = detail.trim().split('\n').filter(Boolean);
  if (expanded || lines.length <= 5) return { hidden: 0, lines };
  return {
    hidden: lines.length - 4,
    lines: [lines[0], ...lines.slice(-3)],
  };
}

export function ThreadPanel({ backgroundRuntime = false }: { backgroundRuntime?: boolean } = {}) {
  const { navigate } = useNavigate();
  const [entries, setEntries] = useState<OrchestratorEntry[]>([]);
  const [health, setHealth] = useState<OrchestratorHealth>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [queuedFollowUps, setQueuedFollowUps] = useState<string[]>([]);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(new Set());
  const [workingElapsedSeconds, setWorkingElapsedSeconds] = useState(0);
  const [cancelConfirmationVisible, setCancelConfirmationVisible] = useState(false);
  const [workStage, setWorkStage] = useState<OrchestratedWorkStage>();
  const [connecting, setConnecting] = useState(false);
  const [updatingFork, setUpdatingFork] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string>();
  const [installingMacApp, setInstallingMacApp] = useState(false);
  const [machines, setMachines] = useState<OrcMachine[]>([]);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const shouldFollowThreadRef = useRef(true);
  const submittedTurnInFlightRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const activeMcpActionIdsRef = useRef(new Set<string>());
  const actionInFlightRef = useRef(false);
  const cancelConfirmationTimerRef = useRef<number | undefined>(undefined);
  const activeSendRef = useRef<Promise<unknown> | undefined>(undefined);
  const queuedFollowUpsRef = useRef<string[]>([]);
  const messageLoopRunningRef = useRef(false);
  const isOrcWorking = sending || Boolean(health?.busy);
  const visibleEntries = useMemo(() => {
    const recentTurnIds: string[] = [];
    for (const entry of [...entries].reverse()) {
      if (entry.turn_id && !recentTurnIds.includes(entry.turn_id)) {
        recentTurnIds.push(entry.turn_id);
        if (recentTurnIds.length === DISPLAY_TURNS) break;
      }
    }
    const selected = new Set(recentTurnIds);
    const coherentEntries = recentTurnIds.length
      ? entries.filter((entry) => entry.turn_id && selected.has(entry.turn_id))
      : entries.slice(-12);
    const latestActivity = new Map<string, number>();
    const progressTurns = new Set<string>();
    coherentEntries.forEach((entry) => {
      const activity = parseActivity(entry);
      if (activity) latestActivity.set(`${entry.turn_id ?? 'legacy'}:${activity.id}`, entry.id);
      if (entry.role === 'assistant_progress' && entry.turn_id) progressTurns.add(entry.turn_id);
    });
    return coherentEntries.filter((entry) => {
      const activity = parseActivity(entry);
      if (activity) {
        return latestActivity.get(`${entry.turn_id ?? 'legacy'}:${activity.id}`) === entry.id;
      }
      return !(entry.role === 'assistant' && entry.turn_id && progressTurns.has(entry.turn_id));
    });
  }, [entries]);

  useEffect(() => {
    const toggleToolTranscripts = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.key.toLowerCase() === 't')) return;
      const activityIds = visibleEntries
        .filter((entry) => parseActivity(entry)?.detail)
        .map((entry) => entry.id.toString());
      if (activityIds.length === 0) return;
      event.preventDefault();
      setExpandedActivityIds((current) =>
        activityIds.some((id) => current.has(id)) ? new Set() : new Set(activityIds)
      );
    };
    window.addEventListener('keydown', toggleToolTranscripts);
    return () => window.removeEventListener('keydown', toggleToolTranscripts);
  }, [visibleEntries]);

  const refresh = useCallback(async () => {
    try {
      const client = await getOrchestratorClient();
      const [nextHealth, thread] = await Promise.all([
        client.health(),
        client.thread({ limit: 200 }),
      ]);
      setHealth(nextHealth);
      setEntries(thread.turns);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect to Orc');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await (await getMachinesClient()).getMachines(undefined);
        if (cancelled) return;
        setMachines(saved.map(({ id, name }) => ({ id, name })));
        const client = await getOrchestratorClient();
        if (cancelled) return;
        if (saved.length > 0) {
          setConnecting(true);
          try {
            const reconnected = await restoreOrchestratorConnection(client, saved);
            if (reconnected && !cancelled) await refresh();
          } finally {
            if (!cancelled) setConnecting(false);
          }
        }
      } catch (cause) {
        if (cancelled) return;
        setMachines([]);
        setError(cause instanceof Error ? cause.message : 'Unable to reconnect to Orc');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const executeMcpAction = useCallback(
    async (action: OrchestratorPendingAction) => {
      if (activeMcpActionIdsRef.current.has(action.action_id)) return;
      activeMcpActionIdsRef.current.add(action.action_id);
      setSending(true);
      setError(undefined);
      try {
        const client = await getOrchestratorClient();
        if (action.kind === 'archive_worker') {
          const manager = getTaskManagerStore(action.project_id);
          if (!manager) throw new Error('Worker task manager is not available');
          await Promise.race([
            manager.archiveTask(action.emdash_task_id),
            new Promise<void>((resolve) => window.setTimeout(resolve, ARCHIVE_HANDOFF_TIMEOUT_MS)),
          ]);
          await client.completeAction({ actionId: action.action_id });
          await refresh();
          return;
        }
        if (action.kind === 'restart_worker') {
          const manager = getConversationsForTask(action.emdash_task_id);
          const session = manager?.sessions.get(action.conversation_id);
          const conversation = manager?.conversations.get(action.conversation_id)?.data;
          if (!manager || !session || !conversation) {
            throw new Error('Worker conversation is not available');
          }
          await manager.deleteConversation(action.conversation_id);
          const replacement = await manager.createConversation({
            id: crypto.randomUUID(),
            projectId: conversation.projectId,
            taskId: conversation.taskId,
            provider: conversation.providerId,
            title: conversation.title,
            autoApprove: conversation.autoApprove,
            model: conversation.model,
            type: conversation.type,
            isInitialConversation: conversation.isInitialConversation ?? undefined,
            initialPrompt: action.goal,
          });
          const taskView = getTaskComposition(conversation.projectId, conversation.taskId);
          taskView?.paneLayout.open(
            replacement.type === 'acp' ? 'acp-chat' : 'conversation',
            { conversationId: replacement.id },
            { preview: false }
          );
          taskView?.setFocusedRegion('main');
          await client.completeAction({ actionId: action.action_id });
          await refresh();
          return;
        }
        if (action.kind === 'send_worker_input') {
          const conversationsClient = await getConversationsClient();
          await conversationsClient.tui.sendInput({
            conversationId: action.conversation_id,
            data: action.input,
          });
          await client.completeAction({ actionId: action.action_id });
          await refresh();
          return;
        }
        await createOrchestratedWorkSession(
          {
            projectName: action.project_name,
            hostName: action.host_name,
            goal: action.goal,
            agent: action.agent,
          },
          navigate,
          async (stage, status, detail) => {
            if (status === 'started') setWorkStage(stage);
            await client.reportActionProgress({
              actionId: action.action_id,
              stage,
              status,
              detail,
            });
          }
        );
        await client.completeAction({ actionId: action.action_id });
        await refresh();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'MCP action failed';
        setError(detail);
        try {
          await (
            await getOrchestratorClient()
          ).reportActionProgress({
            actionId: action.action_id,
            stage:
              action.kind === 'send_worker_input'
                ? 'Sending worker input'
                : action.kind === 'archive_worker'
                  ? 'Archiving completed worker'
                  : 'Creating work session',
            status: 'failed',
            detail,
          });
        } catch {
          // Preserve the original action error when reporting it also fails.
        }
      } finally {
        activeMcpActionIdsRef.current.delete(action.action_id);
        setSending(false);
        setWorkStage(undefined);
      }
    },
    [navigate, refresh]
  );

  useEffect(() => {
    if (!backgroundRuntime) return;
    let cancelled = false;
    const poll = async () => {
      if (actionInFlightRef.current) return;
      try {
        const { action } = await (await getOrchestratorClient()).claimAction(undefined);
        if (!cancelled && action) {
          actionInFlightRef.current = true;
          void executeMcpAction(action).finally(() => {
            actionInFlightRef.current = false;
          });
        }
      } catch {
        // Connection errors are already represented by the Thread panel health state.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [backgroundRuntime, executeMcpAction]);

  useEffect(() => {
    if (!backgroundRuntime) return;
    let cancelled = false;
    const publishWorkerTelemetry = async () => {
      try {
        const client = await getOrchestratorClient();
        const { workContracts } = await client.workContracts(undefined);
        const executions = workContracts.flatMap((contract) => contract.executions);
        await Promise.allSettled(
          executions.map(async (execution) => {
            if (cancelled) return;
            const conversationManager = getConversationsForTask(execution.emdash_task_id);
            const conversations = [...(conversationManager?.conversations.values() ?? [])].map(
              (store) => ({ ...store.data, agentStatus: store.status })
            );
            const conversation = selectWorkerConversation(conversations);
            const liveConversation = conversation
              ? conversationManager?.conversations.get(conversation.id)
              : undefined;
            const session = conversation
              ? conversationManager?.sessions.get(conversation.id)
              : undefined;
            let promptExcerpt: string | undefined;
            try {
              if (session && !session.pty) await session.connect();
              await flushTerminalWrites(session?.pty?.terminal);
              promptExcerpt = terminalPromptExcerpt(session?.pty?.terminal.buffer.active);
              if (!promptExcerpt && conversation) {
                promptExcerpt = await readWorkerOutput(conversation.id);
              }
            } catch (cause) {
              promptExcerpt = `Unable to read worker terminal: ${cause instanceof Error ? cause.message : String(cause)}`;
            }
            const telemetry = {
              executionId: execution.execution_id,
              emdashTaskId: execution.emdash_task_id,
              projectId: execution.project_id,
              conversationId: conversation?.id,
              sessionId: conversation?.sessionId,
              provider: conversation?.providerId ?? execution.agent,
              status:
                liveConversation?.status ??
                conversation?.agentStatus ??
                (conversationManager ? 'idle' : 'session-unavailable'),
              notificationType: liveConversation?.lastNotificationType,
              promptExcerpt,
              observedAt: new Date().toISOString(),
            };
            try {
              await client.reportWorkerTelemetry(telemetry);
            } catch {
              await client.reportActionProgress({
                actionId: execution.execution_id,
                stage: 'Worker telemetry',
                status: 'completed',
                detail: JSON.stringify({
                  emdash_task_id: telemetry.emdashTaskId,
                  project_id: telemetry.projectId,
                  conversation_id: telemetry.conversationId,
                  session_id: telemetry.sessionId,
                  provider: telemetry.provider,
                  status: telemetry.status,
                  notification_type: telemetry.notificationType,
                  prompt_excerpt: telemetry.promptExcerpt,
                  observed_at: telemetry.observedAt,
                }),
              });
            }
          })
        );
      } catch {
        // The regular health poll owns connection error presentation.
      }
    };
    void publishWorkerTelemetry();
    const timer = window.setInterval(() => void publishWorkerTelemetry(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [backgroundRuntime]);

  useLayoutEffect(() => {
    if (!shouldFollowThreadRef.current) return;
    const viewport = scrollViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [entries, sending, workStage]);

  const replaceQueuedFollowUps = useCallback((messages: string[]) => {
    queuedFollowUpsRef.current = messages;
    setQueuedFollowUps(messages);
  }, []);

  const runMessageLoop = useCallback(
    async (initialText: string) => {
      if (messageLoopRunningRef.current) {
        replaceQueuedFollowUps([...queuedFollowUpsRef.current, initialText]);
        return;
      }
      messageLoopRunningRef.current = true;
      let currentText: string | undefined = initialText;
      submittedTurnInFlightRef.current = true;
      shouldFollowThreadRef.current = true;
      setSending(true);
      setWorkStage(undefined);
      setError(undefined);
      try {
        const client = await getOrchestratorClient();
        while (currentText) {
          const activeSend = client.send({ text: currentText });
          activeSendRef.current = activeSend;
          await activeSend;
          if (activeSendRef.current === activeSend) activeSendRef.current = undefined;
          await refresh();
          const [next, ...remaining] = queuedFollowUpsRef.current;
          replaceQueuedFollowUps(remaining);
          currentText = next;
        }
      } catch (cause) {
        if (currentText) replaceQueuedFollowUps([currentText, ...queuedFollowUpsRef.current]);
        setError(cause instanceof Error ? cause.message : 'Message failed');
      } finally {
        activeSendRef.current = undefined;
        messageLoopRunningRef.current = false;
        submittedTurnInFlightRef.current = false;
        setSending(false);
        setWorkStage(undefined);
      }
    },
    [refresh, replaceQueuedFollowUps]
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    submittedTurnInFlightRef.current = true;
    shouldFollowThreadRef.current = true;
    setDraft('');
    setError(undefined);
    if (isOrcWorking || messageLoopRunningRef.current) {
      replaceQueuedFollowUps([...queuedFollowUpsRef.current, text]);
      return;
    }
    await runMessageLoop(text);
  }

  async function interrupt(preserveWorkingState = false) {
    if (cancelConfirmationTimerRef.current !== undefined) {
      window.clearTimeout(cancelConfirmationTimerRef.current);
      cancelConfirmationTimerRef.current = undefined;
    }
    setCancelConfirmationVisible(false);
    try {
      await (await getOrchestratorClient()).interrupt(undefined);
      if (!preserveWorkingState) {
        submittedTurnInFlightRef.current = false;
        setSending(false);
        setWorkStage(undefined);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to stop Orc');
    }
  }

  useEffect(() => {
    if (!isOrcWorking) {
      setCancelConfirmationVisible(false);
      return;
    }
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      event.preventDefault();
      const action = escapeCancelAction(
        isOrcWorking,
        cancelConfirmationVisible,
        queuedFollowUpsRef.current.length > 0
      );
      if (action === 'send-queued') {
        void interrupt(true);
        return;
      }
      if (action === 'confirm') {
        setCancelConfirmationVisible(true);
        if (cancelConfirmationTimerRef.current !== undefined) {
          window.clearTimeout(cancelConfirmationTimerRef.current);
        }
        cancelConfirmationTimerRef.current = window.setTimeout(() => {
          setCancelConfirmationVisible(false);
          cancelConfirmationTimerRef.current = undefined;
        }, 3_000);
      } else if (action === 'cancel') {
        void interrupt();
      }
    };
    window.addEventListener('keydown', stopOnEscape);
    return () => window.removeEventListener('keydown', stopOnEscape);
  });

  useEffect(() => {
    if (health?.busy || messageLoopRunningRef.current || queuedFollowUpsRef.current.length === 0) {
      return;
    }
    const [next, ...remaining] = queuedFollowUpsRef.current;
    replaceQueuedFollowUps(remaining);
    if (next) void runMessageLoop(next);
  }, [health?.busy, replaceQueuedFollowUps, runMessageLoop]);

  useEffect(() => {
    if (!isOrcWorking) {
      setWorkingElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setWorkingElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setWorkingElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [isOrcWorking]);

  async function connect(connectionId: string) {
    setConnecting(true);
    setError(undefined);
    try {
      const client = await getOrchestratorClient();
      await client.connect({ connectionId });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect to Orc');
    } finally {
      setConnecting(false);
    }
  }

  async function updateFork() {
    setUpdatingFork(true);
    setUpdateNotice(undefined);
    try {
      const result = await (await getOrchestratorClient()).updateFork(undefined);
      setUpdateNotice(result.message.split('\n').at(-1));
    } catch (cause) {
      setUpdateNotice(cause instanceof Error ? cause.message : 'Unable to update the fork');
    } finally {
      setUpdatingFork(false);
    }
  }

  async function installMacApp() {
    setInstallingMacApp(true);
    setUpdateNotice(undefined);
    try {
      const result = await (await getOrchestratorClient()).installMacApp(undefined);
      setUpdateNotice(result.message);
    } catch (cause) {
      setUpdateNotice(cause instanceof Error ? cause.message : 'Unable to build the Mac app');
    } finally {
      setInstallingMacApp(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111417] font-mono text-[#e8e4dd]">
      <div
        ref={scrollViewportRef}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          const distanceFromBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
          shouldFollowThreadRef.current = shouldFollowOrcThread(
            submittedTurnInFlightRef.current,
            distanceFromBottom
          );
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-5 text-[13px] leading-6 sm:px-8"
      >
        {error && entries.length === 0 ? (
          <div className="text-[#817d77]">
            <p>
              <span className="text-[#d8cdbd]">!</span> unable to start Orc
            </p>
            <p className="pl-4">{error}</p>
            {machines.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-2 pl-4">
                {machines.map((machine) => (
                  <button
                    key={machine.id}
                    type="button"
                    disabled={connecting}
                    onClick={() => void connect(machine.id)}
                    className="border border-[#706b64] px-3 py-1.5 text-[#e8e4dd] hover:bg-[#24272a] disabled:cursor-wait disabled:opacity-50"
                  >
                    {connecting ? 'Connecting…' : `Connect to Orc on ${machine.name}`}
                  </button>
                ))}
              </div>
            )}
            {machines.length === 0 && (
              <p className="mt-2 pl-4">Add the Orc host under Settings → Machines.</p>
            )}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[920px]">
            <div className="mb-8 text-[#a6a19a]" aria-label="Orc session information">
              <div className="w-full max-w-[34rem] border border-[#59554f] px-4 py-3">
                <div className="mb-3 text-base font-semibold text-[#e8e4dd]">&gt;_ ORC</div>
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)]">
                  <span className="text-[#6f6c67]">model:</span>
                  <span>
                    {health ? `${health.provider}${health.model ? ` / ${health.model}` : ''}` : '—'}
                  </span>
                  <span className="text-[#6f6c67]">directory:</span>
                  <span className="truncate">{health?.directory ?? 'connecting'}</span>
                </div>
              </div>
              <p className="mt-3 pl-2 text-[#6f6c67]">
                Tip: type /help for commands and shortcuts.
              </p>
            </div>
            {visibleEntries.map((entry) => {
              const activity = parseActivity(entry);
              if (activity) {
                const isWorking = activity.status === 'in_progress';
                const activityKey = entry.id.toString();
                const expanded = expandedActivityIds.has(activityKey);
                const detail = activityDetail(activity.detail, expanded);
                return (
                  <div
                    key={entry.id}
                    className="mb-4 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2"
                  >
                    <span className={isWorking ? 'animate-pulse text-[#d8cdbd]' : 'text-[#88837c]'}>
                      •
                    </span>
                    <div className="min-w-0 text-[#b6b0a7]">
                      <div
                        className={`break-words whitespace-pre-wrap ${
                          activity.status === 'failed' ? 'text-[#c98279]' : ''
                        }`}
                      >
                        {activityHeading(activity)}
                      </div>
                      {detail.lines.length > 0 && (
                        <div className="mt-1 text-xs leading-5 text-[#7d7871]">
                          {detail.lines.map((line, index) => (
                            <div key={`${entry.id}:${index}`} className="flex min-w-0">
                              <span className="w-4 shrink-0 text-[#5f5b56]">
                                {index === 0 ? '└' : ' '}
                              </span>
                              <span className="min-w-0 break-words whitespace-pre-wrap">
                                {line}
                              </span>
                            </div>
                          ))}
                          {(detail.hidden > 0 || expanded) && activity.detail.trim() && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedActivityIds((current) => {
                                  const next = new Set(current);
                                  if (expanded) next.delete(activityKey);
                                  else next.add(activityKey);
                                  return next;
                                })
                              }
                              className="mt-1 pl-4 text-left text-[#817d77] hover:text-[#b6b0a7]"
                            >
                              {expanded
                                ? 'Collapse transcript (ctrl + t)'
                                : `… +${detail.hidden} lines (ctrl + t to view transcript)`}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              return (
                <article
                  key={entry.id}
                  className={`mb-6 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 ${
                    entry.role === 'system' ? 'text-[#817d77]' : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={entry.role === 'user' ? 'text-[#d8cdbd]' : 'text-[#88837c]'}
                  >
                    {entryMarker(entry)}
                  </span>
                  <div className="min-w-0">
                    {entry.role === 'user' ? (
                      <div className="font-semibold whitespace-pre-wrap text-[#f1eee8]">
                        {entry.content}
                      </div>
                    ) : (
                      <Markdown
                        content={entry.content}
                        variant="compact"
                        className="max-w-none text-[#d2cdc5] [&_pre]:border [&_pre]:border-[#383633] [&_pre]:bg-[#0d0f11]"
                      />
                    )}
                  </div>
                </article>
              );
            })}
            {isOrcWorking && (
              <div className="mb-6 grid animate-pulse grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 text-[#88837c]">
                <span>•</span>
                <span>
                  {workStage
                    ? `${workStage} (${workingElapsedSeconds}s • esc to interrupt)`
                    : workingStatus(workingElapsedSeconds)}
                </span>
              </div>
            )}
            {queuedFollowUps.length > 0 && (
              <div className="mb-6 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 text-[#88837c]">
                <span>•</span>
                <div>
                  <div>
                    Messages to be submitted after this turn (press esc to interrupt and send
                    immediately)
                  </div>
                  {queuedFollowUps.map((message, index) => (
                    <div key={`${index}:${message}`} className="mt-1 pl-2 text-[#b6b0a7]">
                      ↳ {message}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {cancelConfirmationVisible && (
              <div
                role="status"
                className="mb-6 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 text-[#d8cdbd]"
              >
                <span>!</span>
                <span>Press Esc again to stop Orc</span>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <form onSubmit={submit} className="bg-[#111417] px-5 pb-4 sm:px-8">
        {updateNotice && (
          <p className="mx-auto mb-2 max-w-[920px] text-xs text-[#817d77]">{updateNotice}</p>
        )}
        {error && entries.length > 0 && (
          <p className="mx-auto mb-2 max-w-[920px] text-xs text-[#c98279]">! {error}</p>
        )}
        <div className="mx-auto flex max-w-[920px] items-start gap-2 border-t border-[#383633] px-1 pt-2">
          <span className="pt-2 text-[#d8cdbd]" aria-hidden="true">
            ›
          </span>
          <textarea
            aria-label="Message Orc"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={isOrcWorking ? 'Send a follow-up to Orc' : 'Ask Orc to do anything'}
            disabled={!health}
            rows={1}
            className="max-h-48 min-h-8 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 font-mono text-[13px] leading-5 text-[#e8e4dd] outline-none placeholder:text-[#625f5b] disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <div className="mx-auto mt-1 flex max-w-[920px] justify-between px-1 text-[11px] text-[#625f5b]">
          {IS_DEVELOPMENT ? (
            <span className="flex gap-4">
              <button
                type="button"
                onClick={() => void updateFork()}
                disabled={updatingFork}
                className="hover:text-[#b6b0a7] disabled:cursor-wait"
              >
                {updatingFork ? 'updating fork…' : 'update fork'}
              </button>
              <button
                type="button"
                onClick={() => void installMacApp()}
                disabled={installingMacApp}
                className="hover:text-[#b6b0a7] disabled:cursor-wait"
              >
                {installingMacApp ? 'starting build…' : 'install mac app'}
              </button>
            </span>
          ) : (
            <span>Emdash Orc</span>
          )}
          <span>
            {health ? `${health.provider}${health.model ? `/${health.model}` : ''}` : 'offline'}
          </span>
        </div>
      </form>
    </div>
  );
}
