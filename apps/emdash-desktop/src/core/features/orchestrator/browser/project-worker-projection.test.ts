import { describe, expect, it } from 'vitest';
import {
  selectProjectionMachineId,
  shouldAdoptHostConversation,
} from './project-worker-projection';

describe('selectProjectionMachineId', () => {
  const machines = [
    {
      id: 'connection-by-ip',
      name: '192.168.1.195',
      host: '192.168.1.195',
      sshConfigAlias: null,
    },
  ];

  it('reuses a sibling project connection when the logical host name differs', () => {
    const projects = [
      {
        data: {
          type: 'ssh',
          path: '/home/striblet/src/bookscape',
          connectionId: 'connection-by-ip',
        },
      },
    ];

    expect(
      selectProjectionMachineId(machines, projects, '/home/striblet/src/emdash', 'thinkcenter')
    ).toBe('connection-by-ip');
  });

  it('prefers an exact machine identity when one exists', () => {
    expect(
      selectProjectionMachineId(
        [
          ...machines,
          { id: 'thinkcenter', name: 'ThinkCenter', host: 'server', sshConfigAlias: null },
        ],
        [],
        '/home/striblet/src/emdash',
        'thinkcenter'
      )
    ).toBe('thinkcenter');
  });
});

describe('shouldAdoptHostConversation', () => {
  it('re-adopts a conversation when a server restart invalidates the local projection', () => {
    expect(shouldAdoptHostConversation(true, false)).toBe(true);
  });

  it('does not re-adopt a conversation that remains hydrated', () => {
    expect(shouldAdoptHostConversation(true, true)).toBe(false);
  });
});
