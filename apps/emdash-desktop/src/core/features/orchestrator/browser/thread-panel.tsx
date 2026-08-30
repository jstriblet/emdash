import { Markdown } from '@emdash/ui/react/components';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import type { OrchestratorEntry, OrchestratorHealth, OrchestratorWorkContract } from '../api';
import { getOrchestratorClient } from '../api/browser/client';

const REFRESH_INTERVAL_MS = 2_000;
const DISPLAY_TURNS = 4;
const IS_DEVELOPMENT = import.meta.env.DEV;

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
    const compact = command.split('\n')[0].slice(0, 82);
    if (activity.status === 'in_progress') return `Running ${compact}`;
    if (activity.status === 'failed') return `Command failed ${compact}`;
    return `Ran ${compact}`;
  }
  if (activity.kind === 'file_change') {
    return `${activity.status === 'in_progress' ? 'Editing' : 'Edited'} ${activity.title.replace(/^Changed /, '')}`;
  }
  if (activity.kind === 'web_search') {
    return `${activity.status === 'in_progress' ? 'Searching' : 'Searched'} ${activity.title}`;
  }
  return activity.title;
}

function activityDetail(detail: string): { hidden: number; lines: string[] } {
  const lines = detail.trim().split('\n').filter(Boolean);
  return { hidden: Math.max(0, lines.length - 8), lines: lines.slice(-8) };
}

export function ThreadPanel() {
  const [entries, setEntries] = useState<OrchestratorEntry[]>([]);
  const [health, setHealth] = useState<OrchestratorHealth>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [updatingFork, setUpdatingFork] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string>();
  const [installingMacApp, setInstallingMacApp] = useState(false);
  const [machines, setMachines] = useState<OrcMachine[]>([]);
  const [workContracts, setWorkContracts] = useState<OrchestratorWorkContract[]>([]);
  const [showContracts, setShowContracts] = useState(false);
  const [showContractForm, setShowContractForm] = useState(false);
  const [contractGoal, setContractGoal] = useState('');
  const [contractProcedure, setContractProcedure] = useState('');
  const [contractExpected, setContractExpected] = useState('');
  const [changingContract, setChangingContract] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const shouldFollowThreadRef = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);
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

  const refresh = useCallback(async () => {
    try {
      const client = await getOrchestratorClient();
      const [nextHealth, thread, contracts] = await Promise.all([
        client.health(),
        client.thread({ limit: 200 }),
        client.workContracts(undefined),
      ]);
      setHealth(nextHealth);
      setEntries(thread.turns);
      setWorkContracts(contracts.workContracts);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect to Orc');
    }
  }, []);

  useEffect(() => {
    void getMachinesClient()
      .then((client) => client.getMachines(undefined))
      .then((saved) => setMachines(saved.map(({ id, name }) => ({ id, name }))))
      .catch(() => setMachines([]));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (shouldFollowThreadRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    shouldFollowThreadRef.current = true;
    setSending(true);
    setDraft('');
    setError(undefined);
    try {
      const client = await getOrchestratorClient();
      await client.send({ text });
      await refresh();
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : 'Message failed');
    } finally {
      setSending(false);
    }
  }

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

  async function createWorkContract(event: FormEvent) {
    event.preventDefault();
    const goal = contractGoal.trim();
    const procedure = contractProcedure.trim();
    const expected = contractExpected.trim();
    if (!goal || !procedure || !expected || changingContract) return;
    setChangingContract(true);
    setError(undefined);
    try {
      const client = await getOrchestratorClient();
      await client.createWorkContract({
        version: '1',
        goal,
        non_goals: [],
        constraints: [],
        deliverables: [{ id: 'D1', description: goal }],
        acceptance_checks: [
          {
            id: 'A1',
            description: 'Verify the desired result',
            procedure,
            expected,
            required: true,
          },
        ],
        definition_of_done: `D1 is delivered and A1 confirms: ${expected}`,
        escalation_conditions: [],
      });
      setContractGoal('');
      setContractProcedure('');
      setContractExpected('');
      setShowContractForm(false);
      setShowContracts(true);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create work contract');
    } finally {
      setChangingContract(false);
    }
  }

  async function recordContractEvidence(contract: OrchestratorWorkContract) {
    const check = contract.checks.find(({ status }) => status !== 'passed' && status !== 'waived');
    const definition = contract.contract.acceptance_checks.find(({ id }) => id === check?.check_id);
    if (!check || !definition || changingContract) return;
    setChangingContract(true);
    try {
      await (await getOrchestratorClient()).updateWorkContract({
        contractId: contract.task_id,
        update: {
          version: '1',
          event_id: crypto.randomUUID(),
          contract_revision: contract.revision,
          sender: 'emdash-user',
          recipient: 'orc',
          message_type: 'verification',
          state: 'verifying',
          summary: `${check.check_id} manually verified in Emdash`,
          affected_ids: [check.check_id],
          evidence: [],
          blockers: [],
          assumptions: [],
          risks: [],
          authority_needed: [],
          check_results: [
            {
              check_id: check.check_id,
              status: 'passed',
              evidence: [
                {
                  kind: 'test',
                  reference: definition.procedure,
                  summary: `Manually confirmed: ${definition.expected}`,
                },
              ],
            },
          ],
        },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record evidence');
    } finally {
      setChangingContract(false);
    }
  }

  async function completeWorkContract(contract: OrchestratorWorkContract) {
    if (changingContract) return;
    setChangingContract(true);
    try {
      await (await getOrchestratorClient()).updateWorkContract({
        contractId: contract.task_id,
        update: {
          version: '1',
          event_id: crypto.randomUUID(),
          contract_revision: contract.revision,
          sender: 'orc',
          recipient: 'emdash-user',
          message_type: 'completion',
          state: 'completed',
          summary: 'All required Work Contract checks have evidence',
          affected_ids: [
            ...contract.contract.deliverables.map(({ id }) => id),
            ...contract.contract.acceptance_checks.map(({ id }) => id),
          ],
          evidence: [],
          blockers: [],
          assumptions: [],
          risks: [],
          authority_needed: [],
          check_results: [],
        },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Completion was rejected');
    } finally {
      setChangingContract(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111417] font-mono text-[#e8e4dd]">
      <div
        ref={scrollViewportRef}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          shouldFollowThreadRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
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
            <section
              className="sticky top-0 z-10 mb-8 border-y border-[#383633] bg-[#111417]/95 py-3 backdrop-blur"
              aria-label="Work Contracts"
            >
              <div
                className={
                  showContracts
                    ? 'mb-2 flex items-center justify-between'
                    : 'flex items-center justify-between'
                }
              >
                <button
                  type="button"
                  onClick={() => setShowContracts((visible) => !visible)}
                  className="flex items-center gap-2 text-[#8f8a83] hover:text-[#e8e4dd]"
                  aria-expanded={showContracts}
                >
                  <span aria-hidden="true">{showContracts ? '▾' : '▸'}</span>
                  <span>work contracts</span>
                  <span className="text-[#625f5b]">{workContracts.length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowContracts(true);
                    setShowContractForm((visible) => !visible);
                  }}
                  className="text-[#b6b0a7] hover:text-[#e8e4dd]"
                >
                  {showContractForm ? 'cancel' : '+ new'}
                </button>
              </div>
              {showContracts && showContractForm && (
                <form onSubmit={createWorkContract} className="mb-4 grid gap-2 border-l border-[#59554f] pl-3">
                  <input
                    aria-label="Desired outcome"
                    value={contractGoal}
                    onChange={(event) => setContractGoal(event.target.value)}
                    placeholder="desired outcome"
                    className="bg-transparent text-[#e8e4dd] outline-none placeholder:text-[#625f5b]"
                  />
                  <input
                    aria-label="Verification procedure"
                    value={contractProcedure}
                    onChange={(event) => setContractProcedure(event.target.value)}
                    placeholder="test command or inspection procedure"
                    className="bg-transparent text-[#e8e4dd] outline-none placeholder:text-[#625f5b]"
                  />
                  <input
                    aria-label="Expected result"
                    value={contractExpected}
                    onChange={(event) => setContractExpected(event.target.value)}
                    placeholder="expected result"
                    className="bg-transparent text-[#e8e4dd] outline-none placeholder:text-[#625f5b]"
                  />
                  <button
                    type="submit"
                    disabled={changingContract}
                    className="w-fit text-[#d8cdbd] hover:text-white disabled:opacity-50"
                  >
                    create contract
                  </button>
                </form>
              )}
              {showContracts && workContracts.length === 0 ? (
                <p className="text-[#625f5b]">no contracts yet</p>
              ) : showContracts ? (
                <div className="grid gap-3">
                  {workContracts.slice(-5).reverse().map((contract) => {
                    const incomplete = contract.checks.filter(
                      ({ status }) => status !== 'passed' && status !== 'waived'
                    );
                    return (
                      <div key={contract.task_id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
                        <span className="text-[#88837c]">◇</span>
                        <div>
                          <div className="text-[#d2cdc5]">{contract.contract.goal}</div>
                          <div className="text-xs text-[#706b64]">
                            {contract.state} · {contract.checks.length - incomplete.length}/
                            {contract.checks.length} checks
                          </div>
                          {contract.state !== 'completed' && (
                            <div className="mt-1 flex gap-3 text-xs">
                              {incomplete.length > 0 && (
                                <button
                                  type="button"
                                  disabled={changingContract}
                                  onClick={() => void recordContractEvidence(contract)}
                                  className="text-[#b6b0a7] hover:text-[#e8e4dd] disabled:opacity-50"
                                >
                                  record {incomplete[0].check_id} evidence
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={changingContract}
                                onClick={() => void completeWorkContract(contract)}
                                className="text-[#b6b0a7] hover:text-[#e8e4dd] disabled:opacity-50"
                              >
                                complete
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
            {visibleEntries.map((entry) => {
              const activity = parseActivity(entry);
              if (activity) {
                const isWorking = activity.status === 'in_progress';
                const detail = activityDetail(activity.detail);
                return (
                  <div
                    key={entry.id}
                    className="mb-4 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2"
                  >
                    <span className={isWorking ? 'animate-pulse text-[#d8cdbd]' : 'text-[#88837c]'}>
                      •
                    </span>
                    <div className="min-w-0 text-[#b6b0a7]">
                      <div className={activity.status === 'failed' ? 'text-[#c98279]' : ''}>
                        {activityHeading(activity)}
                      </div>
                      {detail.lines.length > 0 && (
                        <div className="mt-1 text-xs leading-5 text-[#7d7871]">
                          {detail.hidden > 0 && (
                            <div className="pl-4">… {detail.hidden} lines hidden</div>
                          )}
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
            {(sending || health?.busy) && (
              <div className="mb-6 grid animate-pulse grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 text-[#88837c]">
                <span>•</span>
                <span>Working…</span>
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
            placeholder="Ask Orc to do anything"
            disabled={sending || !health}
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
