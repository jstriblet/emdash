import { Fragment } from 'react';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { defineViewRuntime } from '@core/primitives/views/react';
import { orchestratorViewDef } from '../contributions/views';
import { ThreadPanel } from './thread-panel';

function OrchestratorTitlebar() {
  return <Titlebar leftSlot={<span className="px-2 text-sm font-medium">Orc</span>} />;
}

function OrchestratorView() {
  return (
    <div className="h-full min-h-0 min-w-0">
      <ThreadPanel />
    </div>
  );
}

export const orchestratorViewRuntime = defineViewRuntime(orchestratorViewDef, {
  slots: { wrap: Fragment, titlebar: OrchestratorTitlebar, main: OrchestratorView },
});
