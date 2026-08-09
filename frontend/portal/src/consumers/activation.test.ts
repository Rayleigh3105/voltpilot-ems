import { describe, expect, it } from 'vitest';
import {
  NOT_ACTIVATED_TEXT,
  activationBadge,
  conflictNote,
  saveButtonLabel,
} from './activation';

describe('activationBadge', () => {
  it('maps the three server-derived states onto honest words', () => {
    expect(activationBadge({ controlActivation: 'active' }))
      .toEqual({ text: 'Steuerung aktiv', tone: 'ok' });
    expect(activationBadge({ controlActivation: 'paused' }).tone).toBe('warn');
    expect(activationBadge({ controlActivation: 'paused' }).text).toMatch(/Pausiert/);
    expect(activationBadge({ controlActivation: 'not_activated' }))
      .toEqual({ text: NOT_ACTIVATED_TEXT, tone: 'off' });
  });
});

describe('conflictNote (V-5 before the click)', () => {
  const claim = [{ flowId: 'f-1', flowName: 'Wallbox-Sparregel' }];

  it('names the foreign automation on a non-active consumer', () => {
    const note = conflictNote(claim, 'not_activated');
    expect(note).toContain('Wallbox-Sparregel');
    expect(note).toContain('kann diese Regel nicht aktiviert werden');
  });

  it('never claims a conflict against the consumer\'s OWN active rule', () => {
    // While THIS consumer's policy is active, the one claim on the entity is
    // its own generated rule (the server allows at most one).
    expect(conflictNote(claim, 'active')).toBeNull();
  });

  it('claims nothing without evidence (no claims, failed fetch)', () => {
    expect(conflictNote([], 'not_activated')).toBeNull();
    expect(conflictNote(undefined, 'paused')).toBeNull();
  });
});

describe('saveButtonLabel', () => {
  it('is the Increment-1 wording unless the environment can really activate', () => {
    expect(saveButtonLabel(undefined)).toBe('Als Entwurf speichern');
    expect(saveButtonLabel(false)).toBe('Als Entwurf speichern');
    expect(saveButtonLabel(true)).toBe('Speichern & aktivieren');
  });
});
