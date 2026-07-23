/**
 * Portal v3 M5 Part B. Since the v3 release turns flow activation ON in
 * production, every refusal string here is CUSTOMER copy - so the vectors also
 * pin that no internal component is named (Compiler / Sidecar / Gate / Flag).
 */
import { describe, expect, it } from 'vitest';
import {
  ROLLOUT_REASONS,
  deployedBadge,
  forkBanner,
  rolloutBusy,
  rolloutMessage,
  rolloutSteps,
} from './rollout';

describe('rolloutSteps', () => {
  it('walks prüfen → simulieren → ausrollen', () => {
    expect(rolloutSteps({ phase: 'idle' }).map((s) => s.state))
      .toEqual(['wartet', 'wartet', 'wartet']);
    expect(rolloutSteps({ phase: 'simulieren' }).map((s) => s.state))
      .toEqual(['fertig', 'laeuft', 'wartet']);
    expect(rolloutSteps({ phase: 'fertig' }).map((s) => s.state))
      .toEqual(['fertig', 'fertig', 'fertig']);
  });

  it('marks the failing step and skips the rest', () => {
    const steps = rolloutSteps({ phase: 'fehler', failedAt: 'simulieren' });
    expect(steps.map((s) => s.state)).toEqual(['fertig', 'fehler', 'uebersprungen']);
  });

  it('is busy exactly while a step runs', () => {
    expect(rolloutBusy({ phase: 'pruefen' })).toBe(true);
    expect(rolloutBusy({ phase: 'ausrollen' })).toBe(true);
    expect(rolloutBusy({ phase: 'fertig' })).toBe(false);
    expect(rolloutBusy({ phase: 'fehler' })).toBe(false);
  });
});

describe('rolloutMessage', () => {
  it('maps every backend refusal a customer can now hit', () => {
    for (const reason of ['compiler_unavailable', 'compiler_rejected',
      'gated_node_not_enabled', 'peakshaving_not_configured', 'activation_disabled']) {
      const text = rolloutMessage({ phase: 'fehler', failedAt: 'ausrollen', reason });
      expect(text).toBe(ROLLOUT_REASONS[reason]);
    }
  });

  it('never names an internal component in customer copy', () => {
    const forbidden = /compiler|sidecar|flowc|artefakt|artifact|flag|gate|broker|mqtt|api/i;
    for (const text of Object.values(ROLLOUT_REASONS)) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('lets a German server message win, and stays honest without one', () => {
    expect(rolloutMessage({ phase: 'fehler', reason: 'compiler_rejected', message: 'Serversatz.' }))
      .toBe('Serversatz.');
    expect(rolloutMessage({ phase: 'fehler', failedAt: 'pruefen' }))
      .toMatch(/noch nicht vollständig/);
    expect(rolloutMessage({ phase: 'fehler', failedAt: 'ausrollen', reason: 'was_neues' }))
      .toMatch(/bleibt unverändert/);
    expect(rolloutMessage({ phase: 'idle' })).toBeNull();
    expect(rolloutMessage({ phase: 'fertig' })).toMatch(/läuft jetzt auf dem Gerät/);
  });
});

describe('deployedBadge', () => {
  it('is green ONLY when the device confirmed exactly this version', () => {
    expect(deployedBadge({ activeVersion: 4, ackVersion: 4, ackState: 'active' }))
      .toEqual({ label: 'Läuft auf dem Gerät · v4', tone: 'ok', detail: null });
  });

  it('never claims a green state the device did not report', () => {
    const pending = deployedBadge({ activeVersion: 4, ackVersion: null, ackState: null });
    expect(pending.tone).toBe('off');
    expect(pending.label).toBe('Ausgerollt · v4');
    expect(pending.detail).toMatch(/noch nicht bestätigt/);

    const stale = deployedBadge({ activeVersion: 5, ackVersion: 4, ackState: 'active' });
    expect(stale.tone).toBe('off');
  });

  it('surfaces a device-side problem instead of hiding it', () => {
    expect(deployedBadge({ activeVersion: 4, ackVersion: 4, ackState: 'error', ackDetail: 'x' }))
      .toMatchObject({ tone: 'warn', detail: 'x' });
    expect(deployedBadge({ activeVersion: 4, ackVersion: 4, ackState: 'unsupported' }).label)
      .toMatch(/zu alt/);
  });

  it('says "noch nicht ausgerollt" when nothing runs', () => {
    expect(deployedBadge({ activeVersion: null })).toEqual({
      label: 'Noch nicht ausgerollt', tone: 'off', detail: null,
    });
  });
});

describe('forkBanner', () => {
  it('names the version the device keeps running', () => {
    expect(forkBanner({ activeVersion: 4, editingVersion: 5, dirty: false }))
      .toBe('Sie bearbeiten eine Kopie - das Gerät läuft weiter mit v4.');
    expect(forkBanner({ activeVersion: 4, editingVersion: 4, dirty: true }))
      .toMatch(/v4/);
  });

  it('is silent when nothing runs or the running version is shown untouched', () => {
    expect(forkBanner({ activeVersion: null, editingVersion: 1, dirty: true })).toBeNull();
    expect(forkBanner({ activeVersion: 4, editingVersion: 4, dirty: false })).toBeNull();
  });
});

/**
 * Audit E-9: the happy path showed the raw server string "Flow aktiviert
 * (Version 1)." - internal vocabulary plus a version number nobody asked for -
 * and showed it TWICE. The customer sentence now wins for `fertig`; a FAILURE
 * still prefers the server's precise cause.
 */
describe('rolloutMessage · audit E-9', () => {
  it('prefers the customer sentence over the server string on success', () => {
    expect(rolloutMessage({ phase: 'fertig', message: 'Flow aktiviert (Version 1).' }))
      .toBe('Ihre Automation läuft jetzt auf dem Gerät.');
    expect(rolloutMessage({ phase: 'fertig' }))
      .toBe('Ihre Automation läuft jetzt auf dem Gerät.');
    expect(rolloutMessage({ phase: 'fertig', message: 'Flow aktiviert (Version 1).' }))
      .not.toMatch(/Flow|Version/);
  });

  it('still passes a FAILURE cause through verbatim (E-7 feeds it in)', () => {
    const precise = 'Für das Jahr 2025 liegen nur 0 % der Börsenpreise vor.';
    expect(rolloutMessage({ phase: 'fehler', failedAt: 'simulieren', message: precise }))
      .toBe(precise);
    // ...and falls back to the generic sentence when no cause came back.
    expect(rolloutMessage({ phase: 'fehler', failedAt: 'simulieren' }))
      .toMatch(/Probelauf/);
  });
});
