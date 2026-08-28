import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { defineViewRuntime } from '@core/primitives/views/react';
import { Fragment } from 'react';
import { orchestratorViewDef } from '../contributions/views';
import { ThreadPanel } from './thread-panel';

function OrchestratorTitlebar() {
  return <Titlebar leftSlot={<span className="px-2 text-sm font-medium">Thread</span>} />;
}

export const orchestratorViewRuntime = defineViewRuntime(orchestratorViewDef, {
  slots: { wrap: Fragment, titlebar: OrchestratorTitlebar, main: ThreadPanel },
});
