import { Textarea } from '@emdash/ui/react/primitives';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { OrchestratorEntry, OrchestratorHealth } from '../api';
import { getOrchestratorClient } from '../api/browser/client';

const REFRESH_INTERVAL_MS = 2_000;

function entryMarker(entry: OrchestratorEntry): string {
  if (entry.role === 'user') return '›';
  if (entry.role === 'system') return '!';
  return '•';
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
              <pre
                className="text-[#d8cdbd]"
                aria-hidden="true"
              >{`╭────────────────────────────────────────╮
│  ORC                                   │
│  persistent intelligence harness       │
╰────────────────────────────────────────╯`}</pre>
              <div className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] pl-2">
                <span className="text-[#6f6c67]">model</span>
                <span>
                  {health ? `${health.provider}${health.model ? ` / ${health.model}` : ''}` : '—'}
                </span>
                <span className="text-[#6f6c67]">thread</span>
                <span>
                  {health ? `${health.entries} turns · ${health.memories} memories` : 'connecting'}
                </span>
              </div>
              <p className="mt-3 pl-2 text-[#6f6c67]">
                Type a task below. Enter sends · Shift+Enter adds a line
              </p>
            </div>
            {entries.map((entry) => (
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
                <div
                  className={`min-w-0 whitespace-pre-wrap ${
                    entry.role === 'user' ? 'font-semibold text-[#f1eee8]' : ''
                  }`}
                >
                  {entry.content}
                  {entry.role === 'user' && entry.surface !== 'emdash' && (
                    <span className="ml-2 font-normal text-[#625f5b]">[{entry.surface}]</span>
                  )}
                </div>
              </article>
            ))}
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
        <div className="mx-auto flex max-w-[920px] items-start gap-2 border border-[#59554f] bg-[#171a1d] px-3 py-2 focus-within:border-[#d8cdbd]">
          <span className="pt-2 text-[#d8cdbd]" aria-hidden="true">
            ›
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
            placeholder="Ask Orc to do anything"
            disabled={sending}
            className="max-h-48 min-h-10 flex-1 resize-none border-0 bg-transparent px-0 font-mono text-[13px] leading-6 text-[#e8e4dd] shadow-none placeholder:text-[#625f5b] focus-visible:ring-0"
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
