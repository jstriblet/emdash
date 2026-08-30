import { describe, expect, it } from 'vitest';
import { parseOrchestratedWorkRequest } from './orchestrated-work-request';

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
});
