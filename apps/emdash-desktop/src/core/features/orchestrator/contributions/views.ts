import { workbenchLayout } from '@core/primitives/layouts/api';
import { defineView } from '@core/primitives/views/api';
import { z } from 'zod';

export const orchestratorViewDef = defineView({
  id: 'orchestrator',
  params: z.object({}),
  layout: workbenchLayout,
  telemetryEvent: 'orchestrator_viewed',
});
