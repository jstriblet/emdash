import { Markdown } from '@emdash/ui/react/components';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { OrchestratorEntry, OrchestratorHealth } from '../api';
import { getOrchestratorClient } from '../api/browser/client';

const REFRESH_INTERVAL_MS = 2_000;
const DISPLAY_TURNS = 4;

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
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111417] font-mono text-[#e8e4dd]">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 text-[13px] leading-6 sm:px-8">
        {error && entries.length === 0 ? (
          <div className="text-[#817d77]">
            <p>
              <span className="text-[#d8cdbd]">!</span> unable to start Orc
            </p>
            <p className="pl-4">{error}</p>
            <p className="mt-2 pl-4">
              set EMDASH_ORCHESTRATOR_URL if Orc is not listening on 127.0.0.1:8790
            </p>
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
                        <div className="mt-1 overflow-x-auto text-xs leading-5 text-[#706c66]">
                          {detail.hidden > 0 && (
                            <div className="pl-4">… {detail.hidden} lines hidden</div>
                          )}
                          {detail.lines.map((line, index) => (
                            <div key={`${entry.id}:${index}`} className="flex min-w-max">
                              <span className="w-4 shrink-0">{index === 0 ? '└' : ' '}</span>
                              <span className="whitespace-pre">{line}</span>
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
          <span>{sending || health?.busy ? 'esc to interrupt' : '? for shortcuts'}</span>
          <span>
            {health ? `${health.provider}${health.model ? `/${health.model}` : ''}` : 'offline'}
          </span>
        </div>
      </form>
    </div>
  );
}
