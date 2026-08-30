import { describe, expect, it, vi } from 'vitest';
import {
  parseOrchestratedWorkRequest,
  projectPathCandidates,
  runStage,
} from './orchestrated-work-request';

describe('parseOrchestratedWorkRequest', () => {
  it('parses the documented conversational trigger', () => {
    expect(
      parseOrchestratedWorkRequest(
        'Create a work session in BookScape on the ThinkCenter to implement dark mode. Use Codex and verify the UI before completing it.'
      )
    ).toEqual({
      projectName: 'BookScape',
      hostName: 'ThinkCenter',
      goal: 'implement dark mode',
      agent: 'codex',
    });
  });

  it('does not intercept ordinary conversation', () => {
    expect(parseOrchestratedWorkRequest('How should we implement dark mode?')).toBeUndefined();
  });

  it('accepts the leading blockquote marker produced when a quoted example is pasted', () => {
    expect(
      parseOrchestratedWorkRequest(
        '> Create a work session in BookScape on the ThinkCenter to add a README note. Use Codex and verify the change before completing it.'
      )
    ).toMatchObject({
      projectName: 'BookScape',
      hostName: 'ThinkCenter',
      goal: 'add a README note',
      agent: 'codex',
    });
  });

  it('searches conventional repository roots with the requested and normalized names', () => {
    expect(projectPathCandidates('/home/jonathan', 'BookScape')).toContain(
      '/home/jonathan/src/bookscape'
    );
  });

  it('parses a request wrapped across multiple lines', () => {
    expect(
      parseOrchestratedWorkRequest(
        'Create a work session in BookScape on the ThinkCenter to add a README note. Use Codex and verify the change\n  before completing it.'
      )
    ).toMatchObject({
      projectName: 'BookScape',
      hostName: 'ThinkCenter',
      goal: 'add a README note',
      agent: 'codex',
    });
  });
});

describe('runStage', () => {
  it('reports the active stage and returns its result', async () => {
    const report = vi.fn();

    await expect(
      runStage('Locating the repository', Promise.resolve('/repo'), report)
    ).resolves.toBe('/repo');
    expect(report).toHaveBeenCalledWith('Locating the repository');
  });

  it('identifies a stage that times out', async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => {});
    const result = runStage('Connecting to the project host', pending, undefined, 1_000);
    const expectation = expect(result).rejects.toThrow(
      'Connecting to the project host timed out after 1 seconds'
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
    vi.useRealTimers();
  });

  it('adds the stage to an operation error', async () => {
    await expect(
      runStage('Loading the project', Promise.reject(new Error('runtime unavailable')))
    ).rejects.toThrow('Loading the project failed: runtime unavailable');
  });
});
