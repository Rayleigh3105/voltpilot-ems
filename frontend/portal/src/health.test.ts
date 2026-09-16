import { describe, expect, it } from 'vitest';
import {
  healthBadge,
  healthChecklist,
  sameHealthFacts,
  zustandView,
  type HealthInput,
} from './health';

function input(over: Partial<HealthInput>): HealthInput {
  return {
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    hasPlanToday: true,
    hasAnyPlan: true,
    controlState: 'healthy',
    batteryWithoutDevice: false,
    batteryLinked: true,
    ...over,
  };
}

function byKey(items: ReturnType<typeof healthChecklist>, key: string) {
  return items.find((i) => i.key === key)!;
}

describe('healthChecklist', () => {
  it('a fully healthy plant reads all-ok', () => {
    const items = healthChecklist(input({}));
    expect(items.map((i) => i.key)).toEqual(
      expect.arrayContaining(['device', 'plan', 'control', 'battery']),
    );
    expect(items.every((i) => i.state === 'ok')).toBe(true);
    expect(byKey(items, 'device').label).toBe('Gerät online');
  });

  it('a silent device warns and sorts to the top', () => {
    const items = healthChecklist(input({ onlineCount: 0, deviceCount: 1 }));
    expect(items[0].key).toBe('device');
    expect(items[0].state).toBe('warn');
  });

  it('shows the connected share for several boxes in every state', () => {
    expect(byKey(healthChecklist(input({ deviceCount: 2, onlineCount: 2 })), 'device')).toMatchObject({
      label: 'Boxen', state: 'ok', detail: '2 von 2 Boxen verbunden',
    });
    expect(byKey(healthChecklist(input({ deviceCount: 2, onlineCount: 1 })), 'device')).toMatchObject({
      label: 'Boxen', state: 'warn', detail: '1 von 2 Boxen verbunden',
    });
    expect(byKey(healthChecklist(input({ deviceCount: 2, onlineCount: 1, waitingCount: 1 })), 'device')).toMatchObject({
      label: 'Boxen', state: 'warn', detail: '1 von 2 Boxen verbunden',
    });
  });

  it('a battery without a device warns', () => {
    const items = healthChecklist(input({ batteryWithoutDevice: true, batteryLinked: false }));
    const b = byKey(items, 'battery');
    expect(b.state).toBe('warn');
    expect(b.detail).toContain('zugeordnet');
  });

  it('omits the battery row when there is no battery at all', () => {
    const items = healthChecklist(input({ batteryWithoutDevice: false, batteryLinked: false }));
    expect(items.find((i) => i.key === 'battery')).toBeUndefined();
  });

  it('omits the control row when there is no control signal', () => {
    const items = healthChecklist(input({ controlState: null }));
    expect(items.find((i) => i.key === 'control')).toBeUndefined();
  });

  it('a plan that is not current today warns; no plan at all is off', () => {
    expect(byKey(healthChecklist(input({ hasPlanToday: false, hasAnyPlan: true })), 'plan').state).toBe(
      'warn',
    );
    expect(byKey(healthChecklist(input({ hasPlanToday: false, hasAnyPlan: false })), 'plan').state).toBe(
      'off',
    );
  });

  it('maps a preparing control state to an honest off row', () => {
    const c = byKey(healthChecklist(input({ controlState: 'preparing' })), 'control');
    expect(c.state).toBe('off');
    expect(c.detail).toContain('vorbereitet');
  });
});

describe('healthBadge - the ONE aggregated plant state (v3 M1)', () => {
  it('is green only when every KNOWN fact is healthy', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 },
      plan: { hasPlanToday: true, hasAnyPlan: true },
      controlState: 'healthy',
      battery: { withoutDevice: false, linked: true },
    });
    expect(badge).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null, findings: [] });
  });

  it('goes to WARNUNG while a device is silent, and names the finding', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 0, waitingCount: 0 },
      plan: { hasPlanToday: true, hasAnyPlan: true },
    });
    expect(badge.state).toBe('warnung');
    expect(badge.label).toBe('Warnung');
    expect(badge.detail).toBe('Gerät: meldet sich nicht');
  });

  it('a warning beats a hinweis (the worst finding wins)', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 0, waitingCount: 0 },
      plan: { hasPlanToday: false, hasAnyPlan: false },
      battery: { withoutDevice: true, linked: false },
    });
    expect(badge.state).toBe('warnung');
    expect(badge.detail).toBe('Gerät: meldet sich nicht');
  });

  it('a missing plan alone is a HINWEIS, not a warning', () => {
    const badge = healthBadge({ plan: { hasPlanToday: false, hasAnyPlan: false } });
    expect(badge.state).toBe('hinweis');
    expect(badge.label).toBe('Hinweis');
    expect(badge.detail).toBe('Fahrplan: noch keiner erstellt');
  });

  it('an unknown fact contributes NOTHING (never an invented finding)', () => {
    // Devices unknown -> no device row, even though a "0 devices" default
    // would otherwise read as "noch nicht verbunden".
    expect(healthBadge({ plan: { hasPlanToday: true, hasAnyPlan: true } }).state).toBe('ok');
    // Battery unknown -> no Speicher row.
    expect(healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } })).toEqual({
      state: 'ok',
      label: 'Alles in Ordnung',
      detail: null,
      findings: [],
    });
  });

  it('an empty / absent input is OK without an invented detail', () => {
    for (const arg of [{}, null, undefined] as const) {
      expect(healthBadge(arg)).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null, findings: [] });
    }
  });

  it('surfaces v2 Soll/Ist drift as a hinweis when it is known', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 },
      entityDrift: true,
    });
    expect(badge.state).toBe('hinweis');
    expect(badge.detail).toBe('Einstellungen: noch nicht auf dem Gerät');
    // Absent/false drift (an un-migrated plant) can never produce a finding.
    expect(healthBadge({ entityDrift: false }).state).toBe('ok');
    expect(healthBadge({ entityDrift: null }).detail).toBeNull();
  });

  it('reports a still-waiting device honestly', () => {
    const badge = healthBadge({ devices: { deviceCount: 1, onlineCount: 0, waitingCount: 1 } });
    expect(badge.state).toBe('warnung');
    expect(badge.detail).toBe('Gerät: wartet auf erste Daten');
  });

  it('reports a plant without any device as a hinweis', () => {
    const badge = healthBadge({ devices: { deviceCount: 0, onlineCount: 0, waitingCount: 0 } });
    expect(badge.state).toBe('hinweis');
    expect(badge.detail).toBe('Gerät: noch nicht verbunden');
  });
});

describe('the badge carries EVERY finding, not just the worst (portal-signal fix)', () => {
  it('lists all current findings, worst first, with detail === findings[0]', () => {
    const badge = healthBadge({
      devices: { deviceCount: 2, onlineCount: 1, waitingCount: 0 }, // stale -> warn
      plan: { hasPlanToday: false, hasAnyPlan: false }, // off
      controlState: 'pending', // off
      battery: { withoutDevice: true, linked: false }, // warn
      entityDrift: true, // off
    });
    expect(badge.state).toBe('warnung');
    // Warnings first, then the hints - so the popover reads worst-first too.
    expect(badge.findings.map((f) => f.text)).toEqual([
      'Boxen: 1 von 2 Boxen verbunden',
      'Speicher: keinem Gerät zugeordnet',
      'Fahrplan: noch keiner erstellt',
      'Steuerung: noch nicht freigegeben',
      'Einstellungen: noch nicht auf dem Gerät',
    ]);
    expect(badge.findings.every((f) => f.state === 'warn' || f.state === 'off')).toBe(true);
    // The header's visible cause is exactly the first row of the popover.
    expect(badge.detail).toBe(badge.findings[0].text);
  });

  it('has no findings when nothing is wrong or nothing was measured', () => {
    expect(healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } }).findings)
      .toEqual([]);
    expect(healthBadge(null).findings).toEqual([]);
  });

  it('never invents a finding for a fact the caller did not supply', () => {
    // Only device data (the pre-fix header input): the Steuerung/Fahrplan/
    // Speicher rows must NOT appear, even as healthy ones.
    const badge = healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } });
    expect(badge.findings).toEqual([]);
    expect(badge.state).toBe('ok');
  });
});

describe('sameHealthFacts - unknown never equals measured', () => {
  it('is true for value-equal facts', () => {
    expect(
      sameHealthFacts(
        { plan: { hasPlanToday: true, hasAnyPlan: true }, controlState: 'healthy', battery: null },
        { plan: { hasPlanToday: true, hasAnyPlan: true }, controlState: 'healthy', battery: null },
      ),
    ).toBe(true);
  });

  it('separates absent from measured', () => {
    expect(sameHealthFacts({ battery: null }, { battery: { withoutDevice: false, linked: false } }))
      .toBe(false);
    expect(sameHealthFacts({ controlState: null }, { controlState: 'off' })).toBe(false);
    expect(sameHealthFacts({ plan: null }, { plan: { hasPlanToday: false, hasAnyPlan: false } }))
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Die Zustand-Fläche (vp-cockpit-unten-ux-n3 PR 3, D5/D6)
// ---------------------------------------------------------------------------

describe('zustandView — leise wenn gesund, laut nur mit Befund', () => {
  const allOk = healthChecklist({
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    hasPlanToday: true,
    hasAnyPlan: true,
    controlState: 'healthy',
    batteryWithoutDevice: false,
    batteryLinked: true,
  });

  it('grün: EIN Satz, der genau die gemessenen Bereiche aufzählt', () => {
    const v = zustandView(allOk)!;
    expect(v.state).toBe('ok');
    expect(v.line).toBe(
      'Alles in Ordnung — Gerät, Fahrplan, Steuerung und Speicher arbeiten zusammen.',
    );
    expect(v.findings).toEqual([]);
    expect(v.toneWord).toBeNull();
  });

  it('grün mit Teilmenge: der Satz behauptet nie Gesundheit über Ungemessenes', () => {
    // Ohne Steuerungs-Signal und ohne Batterie lässt die Checkliste die
    // Zeilen weg — der Satz erbt das.
    const partial = healthChecklist({
      deviceCount: 1,
      onlineCount: 1,
      waitingCount: 0,
      hasPlanToday: true,
      hasAnyPlan: true,
      controlState: null,
      batteryWithoutDevice: false,
      batteryLinked: false,
    });
    expect(zustandView(partial)!.line).toBe(
      'Alles in Ordnung — Gerät und Fahrplan arbeiten zusammen.',
    );
  });

  it('grün mit mehreren Boxen nennt den verbundenen Anteil ohne Aufklappen', () => {
    const multi = healthChecklist({
      deviceCount: 2,
      onlineCount: 2,
      waitingCount: 0,
      hasPlanToday: true,
      hasAnyPlan: true,
      controlState: null,
      batteryWithoutDevice: false,
      batteryLinked: false,
    });
    expect(zustandView(multi)!.line).toBe(
      'Alles in Ordnung — 2 von 2 Boxen verbunden; Fahrplan läuft.',
    );
  });

  it('explodiert bei einer WARNUNG: Befund warn-zuerst, mit Text und Hebel', () => {
    const items = healthChecklist({
      deviceCount: 1,
      onlineCount: 0,
      waitingCount: 0,
      hasPlanToday: true,
      hasAnyPlan: true,
      controlState: 'healthy',
      batteryWithoutDevice: false,
      batteryLinked: true,
    });
    const v = zustandView(items)!;
    expect(v.state).toBe('befund');
    expect(v.toneWord).toBe('Warnung');
    expect(v.findings[0]).toEqual({
      key: 'device',
      state: 'warn',
      text: 'Gerät: meldet sich nicht',
      lever: { sub: 'modell', label: 'Komponenten' },
    });
    // Die gesunden Reste kollabieren zu einer Zeile.
    expect(v.okSummary).toBe('Fahrplan, Steuerung und Speicher: in Ordnung.');
  });

  it('explodiert auch bei einem OFF-Befund (D5) — aber als Hinweis, nicht als Warnung', () => {
    const items = healthChecklist({
      deviceCount: 1,
      onlineCount: 1,
      waitingCount: 0,
      hasPlanToday: true,
      hasAnyPlan: true,
      controlState: 'pending', // → off „noch nicht freigegeben"
      batteryWithoutDevice: false,
      batteryLinked: true,
    });
    const v = zustandView(items)!;
    expect(v.state).toBe('befund');
    expect(v.toneWord).toBe('Hinweis');
    expect(v.findings).toEqual([
      {
        key: 'control',
        state: 'off',
        text: 'Steuerung: noch nicht freigegeben',
        lever: { sub: 'steuerung', label: 'Steuerung' },
      },
    ]);
  });

  it('warn-zuerst bleibt auch gemischt erhalten (die Checklisten-Sortierung)', () => {
    const items = healthChecklist({
      deviceCount: 1,
      onlineCount: 0,
      waitingCount: 0,
      hasPlanToday: false,
      hasAnyPlan: false, // → off „noch keiner erstellt"
      controlState: null,
      batteryWithoutDevice: true, // → warn
      batteryLinked: false,
    });
    const v = zustandView(items)!;
    expect(v.findings.map((f) => f.state)).toEqual(['warn', 'warn', 'off']);
    expect(v.findings.map((f) => f.lever.sub)).toEqual(['modell', 'technik', 'fahrplan']);
    expect(v.okSummary).toBeNull();
    expect(v.toneWord).toBe('Warnung');
  });

  it('ohne einen einzigen gemessenen Fakt gibt es keine Fläche', () => {
    expect(zustandView([])).toBeNull();
  });
});
