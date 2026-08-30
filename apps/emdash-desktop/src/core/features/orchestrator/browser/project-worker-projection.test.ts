import { describe, expect, it } from 'vitest';
import { selectProjectionMachineId } from './project-worker-projection';

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
