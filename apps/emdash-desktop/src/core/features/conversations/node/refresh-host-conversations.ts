import { isLocalHostRef, type HostRef } from '@emdash/core/primitives/host/api';
import {
  conversationRecordsSchema,
  conversationsContract,
} from '@emdash/core/runtimes/conversations/api';
import { createScope } from '@emdash/shared/concurrency';
import { remote, whenReady } from '@emdash/wire/state';
import type { AppDb } from '@core/services/app-db/node/db';
import type { ConversationsRuntimeBroker } from '../api/runtime-adapter';
import { throwConversationsRuntimeResolveError } from '../api/runtime-adapter';
import { applyConversationSnapshot } from './sync/apply-conversation-snapshot';

/** Pulls one authoritative host snapshot immediately so a newly external conversation can link. */
export async function refreshHostConversations(
  db: AppDb,
  runtimes: ConversationsRuntimeBroker,
  host: HostRef
): Promise<void> {
  const client = await runtimes.client(host);
  if (!client.success) throwConversationsRuntimeResolveError(client.error);

  const scope = createScope({ label: 'conversation-explicit-refresh' });
  try {
    const records = remote(conversationsContract.records, client.data.conversations.records, {
      scope,
    });
    const state = records(undefined).states.list;
    const snapshot = await whenReady(state, { scope });
    await applyConversationSnapshot({
      db,
      host: isLocalHostRef(host)
        ? { location: 'local', sshConnectionId: null }
        : { location: 'remote', sshConnectionId: host.id },
      records: conversationRecordsSchema.parse(snapshot.value ?? {}),
    });
  } finally {
    await scope.dispose();
  }
}
