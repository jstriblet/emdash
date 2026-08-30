import { useCallback, useEffect, useState } from 'react';
import type { OrchestratorWorkContract } from '../api';
import { getOrchestratorClient } from '../api/browser/client';

const REFRESH_INTERVAL_MS = 2_000;

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function stateColor(state: OrchestratorWorkContract['state']): string {
  if (state === 'completed') return 'text-[#8fbf8f]';
  if (state === 'failed' || state === 'blocked') return 'text-[#c98279]';
  if (state === 'working' || state === 'verifying') return 'text-[#d8cdbd]';
  return 'text-[#817d77]';
}

export function WorkersPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const [contracts, setContracts] = useState<OrchestratorWorkContract[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const result = await (await getOrchestratorClient()).workContracts(undefined);
      setContracts(
        [...result.workContracts]
          .filter((contract) => contract.executions.length > 0)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
      );
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load workers');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-l border-[#383633] bg-[#0d0f11] py-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Open workers panel"
          className="text-[#817d77] hover:text-[#e8e4dd]"
        >
          ‹
        </button>
        <span className="mt-4 text-[10px] tracking-[0.18em] text-[#625f5b] uppercase [writing-mode:vertical-rl]">
          workers {contracts.filter((contract) => contract.state !== 'completed').length}
        </span>
      </aside>
    );
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-[#383633] bg-[#0d0f11] font-mono text-[#d2cdc5]">
      <div className="flex h-10 items-center justify-between border-b border-[#383633] px-3">
        <span className="text-[11px] tracking-[0.14em] text-[#817d77] uppercase">Workers</span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse workers panel"
          className="text-[#817d77] hover:text-[#e8e4dd]"
        >
          ›
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p className="mb-3 text-xs text-[#c98279]">! {error}</p>}
        {!error && contracts.length === 0 && (
          <p className="text-xs leading-5 text-[#625f5b]">No server-owned work sessions yet.</p>
        )}
        <div className="space-y-3">
          {contracts.map((contract) => {
            const execution = contract.executions.at(-1);
            if (!execution) return null;
            return (
              <section key={contract.task_id} className="border border-[#383633] bg-[#111417] p-3">
                <div className="mb-2 flex items-center justify-between gap-2 text-[10px] uppercase">
                  <span className={stateColor(contract.state)}>● {contract.state}</span>
                  <span className="text-[#625f5b]">{execution.agent}</span>
                </div>
                <p className="line-clamp-3 text-xs leading-5 text-[#d2cdc5]">
                  {contract.contract.goal}
                </p>
                <dl className="mt-3 grid grid-cols-[3.25rem_minmax(0,1fr)] gap-y-1 text-[10px] leading-4">
                  <dt className="text-[#625f5b]">host</dt>
                  <dd className="truncate">{execution.host_id}</dd>
                  <dt className="text-[#625f5b]">repo</dt>
                  <dd className="truncate" title={execution.project_id}>
                    {shortPath(execution.project_id)}
                  </dd>
                  <dt className="text-[#625f5b]">branch</dt>
                  <dd className="truncate" title={execution.worktree_path ?? undefined}>
                    {execution.worktree_path ? shortPath(execution.worktree_path) : 'provisioning'}
                  </dd>
                </dl>
                <div className="mt-3 flex gap-1" aria-label="Acceptance checks">
                  {contract.checks.map((check) => (
                    <span
                      key={check.check_id}
                      title={`${check.check_id}: ${check.status}`}
                      className={`h-1 flex-1 ${
                        check.status === 'passed' || check.status === 'waived'
                          ? 'bg-[#6f956f]'
                          : check.status === 'failed' || check.status === 'blocked'
                            ? 'bg-[#9f625b]'
                            : 'bg-[#494641]'
                      }`}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
