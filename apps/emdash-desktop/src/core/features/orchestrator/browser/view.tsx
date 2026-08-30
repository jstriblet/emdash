import { Fragment } from 'react';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { defineViewRuntime } from '@core/primitives/views/react';
import { orchestratorViewDef } from '../contributions/views';
import { ThreadPanel } from './thread-panel';
import { WorkersPanel } from './workers-panel';

function OrchestratorTitlebar() {
  return <Titlebar leftSlot={<span className="px-2 text-sm font-medium">Thread</span>} />;
}

function OrchestratorView() {
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div className="min-w-0 flex-1">
        <ThreadPanel />
      </div>
      <WorkersPanel />
    </div>
  );
}

export const orchestratorViewRuntime = defineViewRuntime(orchestratorViewDef, {
  slots: { wrap: Fragment, titlebar: OrchestratorTitlebar, main: OrchestratorView },
});
