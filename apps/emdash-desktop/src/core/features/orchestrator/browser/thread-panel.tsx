import { Textarea } from '@emdash/ui/react/primitives';
import { ServerOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { OrchestratorEntry, OrchestratorHealth } from '../api';
import { getOrchestratorClient } from '../api/browser/client';

const REFRESH_INTERVAL_MS = 2_000;

function entryLabel(entry: OrchestratorEntry): string {
  if (entry.role === 'user') return entry.surface === 'emdash' ? 'you' : `you · ${entry.surface}`;
  if (entry.role === 'system') return 'system';
  return 'orc';
}

function entryMarker(entry: OrchestratorEntry): string {
  if (entry.role === 'user') return '❯';
  if (entry.role === 'system') return '!';
  return '●';
}

export function ThreadPanel() {
  const [entries, setEntries] = useState<OrchestratorEntry[]>([]);
  const [health, setHealth] = useState<OrchestratorHealth>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const client = await getOrchestratorClient();
      const [nextHealth, thread] = await Promise.all([
        client.health(),
        client.thread({ limit: 200 }),
      ]);
      setHealth(nextHealth);
      setEntries(thread.turns.filter((entry) => entry.role !== 'assistant_progress'));
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
    <div className="flex h-full min-h-0 flex-col bg-background font-mono text-foreground">
      <div className="flex items-center justify-between border-b border-border px-6 py-3 text-xs">
        <div className="flex items-baseline gap-3">
          <span className="font-semibold tracking-[0.18em] text-[#d8cdbd]">ORC</span>
          <span className="text-foreground-passive">
            {health
              ? `${health.provider}${health.model ? `/${health.model}` : ''} · ${health.entries} turns · ${health.memories} memories`
              : 'harness'}
          </span>
        </div>
        <span className="flex items-center gap-2 text-foreground-muted">
          <span
            className={`size-1.5 rounded-full ${health ? 'bg-[#a8b59a]' : 'bg-foreground-passive'}`}
          />
          {sending || health?.busy ? 'working' : health ? 'ready' : 'offline'}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        {error && entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-foreground-muted">
            <ServerOff className="size-8" strokeWidth={1.5} />
            <div>
              <p className="font-medium text-foreground">Orc is unavailable</p>
              <p className="mt-1 max-w-md text-xs">{error}</p>
              <p className="mt-2 max-w-md text-xs">
                Set EMDASH_ORCHESTRATOR_URL when Orc is not available at 127.0.0.1:8790.
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col">
            {entries.map((entry) => (
              <article
                key={entry.id}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 border-b border-border/50 py-5 last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className={entry.role === 'user' ? 'text-[#d8cdbd]' : 'text-foreground-muted'}
                >
                  {entryMarker(entry)}
                </span>
                <div className="min-w-0">
                  <div className="mb-3 flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium text-foreground-muted">{entryLabel(entry)}</span>
                    <time className="text-foreground-passive" dateTime={entry.ts}>
                      {new Date(entry.ts).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <div className="font-sans leading-7 whitespace-pre-wrap text-foreground">
                    {entry.content}
                  </div>
                </div>
              </article>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <form onSubmit={submit} className="border-t border-border bg-background px-7 py-4">
        {error && entries.length > 0 && (
          <p className="text-danger mx-auto mb-2 max-w-3xl text-xs">{error}</p>
        )}
        <div className="mx-auto flex max-w-4xl items-start gap-3 border border-border bg-background-1 px-3 py-2 focus-within:border-foreground-passive">
          <span className="pt-2 font-semibold text-[#d8cdbd]" aria-hidden="true">
            ❯
          </span>
          <Textarea
            aria-label="Message Orc"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Give Orc a task…"
            disabled={sending}
            className="max-h-48 min-h-10 flex-1 resize-none border-0 bg-transparent px-0 font-sans shadow-none focus-visible:ring-0"
          />
          <button
            type="submit"
            aria-label="Send message"
            disabled={sending || !draft.trim()}
            className="mt-1 flex h-8 shrink-0 items-center gap-1.5 border border-border px-2 text-xs text-foreground-muted hover:border-foreground-passive hover:text-foreground disabled:opacity-40"
          >
            run <span className="text-foreground-passive">↵</span>
          </button>
        </div>
      </form>
    </div>
  );
}
