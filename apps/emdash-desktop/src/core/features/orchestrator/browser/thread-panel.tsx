import { Textarea } from '@emdash/ui/react/primitives';
import { Send, ServerOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { OrchestratorEntry, OrchestratorHealth } from '../api';
import { getOrchestratorClient } from '../api/browser/client';

const REFRESH_INTERVAL_MS = 2_000;

function entryLabel(entry: OrchestratorEntry): string {
  if (entry.role === 'user') return entry.surface === 'emdash' ? 'You' : `You · ${entry.surface}`;
  if (entry.role === 'system') return 'Orc · system';
  return 'Orc';
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
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border px-5 py-2 text-xs text-foreground-muted">
        <span>
          {health ? `${health.provider}${health.model ? ` · ${health.model}` : ''}` : 'Orc'}
        </span>
        <span>{sending || health?.busy ? 'Thinking…' : health ? 'Connected' : 'Disconnected'}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
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
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {entries.map((entry) => (
              <article key={entry.id} className={entry.role === 'user' ? 'ml-12' : 'mr-12'}>
                <div className="mb-1 flex items-center gap-2 text-xs text-foreground-passive">
                  <span>{entryLabel(entry)}</span>
                  <time dateTime={entry.ts}>{new Date(entry.ts).toLocaleString()}</time>
                </div>
                <div
                  className={
                    entry.role === 'user'
                      ? 'rounded-xl bg-background-2 px-4 py-3 whitespace-pre-wrap'
                      : 'px-1 py-2 whitespace-pre-wrap'
                  }
                >
                  {entry.content}
                </div>
              </article>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <form onSubmit={submit} className="border-t border-border p-4">
        {error && entries.length > 0 && (
          <p className="text-danger mx-auto mb-2 max-w-3xl text-xs">{error}</p>
        )}
        <div className="mx-auto flex max-w-3xl items-end gap-2">
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
            placeholder="Message Orc"
            disabled={sending}
            className="max-h-48 min-h-12 resize-none"
          />
          <button
            type="submit"
            aria-label="Send message"
            disabled={sending || !draft.trim()}
            className="bg-accent text-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-lg disabled:opacity-40"
          >
            <Send className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
