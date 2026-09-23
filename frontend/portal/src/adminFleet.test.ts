import { describe, expect, it } from 'vitest';
import type { ControlStatus, CurtailmentStatus } from './api';
import type { AdminFleetSite } from './admin/fleetApi';
import {
  controlMatrixInputs,
  controlMatrixRows,
  edgeStand,
  fleetBoxGroups,
  fleetPulse,
  fleetRows,
  releaseIsRunning,
  sollRelease,
  sourceHealth,
} from './adminFleet';

const NOW = new Date('2026-08-03T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/**
 * Eine Zeile, wie sie der EINE Flotten-Endpunkt liefert. Die Pflege-Punkte sind
 * server-abgeleitet - dieses Modul rendert sie, es leitet sie nicht ab.
 */
function site(over: Partial<AdminFleetSite> = {}): AdminFleetSite {
  return {
    siteId: 's1',
    siteName: 'Anlage A',
    tenantId: 't1',
    tenantName: 'Demo C&I',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    tarifArt: 'fest',
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: ago(10_000),
    lastPlanGeneratedAt: ago(7 * 60_000),
    hasStorage: false,
    batteryWithoutDevice: false,
    sources: null,
    edge: null,
    update: null,
    control: null,
    curtailment: null,
    kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: 'x' },
    forecast: [],
    pflege: [],
    ...over,
  };
}

describe('fleetRows', () => {
  it('reads one row per site across ALL tenants', () => {
    const rows = fleetRows(
      [
        site(),
        site({ siteId: 's2', siteName: 'Anlage B', tenantId: 't2', tenantName: 'Nordwind' }),
      ],
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenantName).sort()).toEqual(['Demo C&I', 'Nordwind']);
  });

  it('groups one independent row per box below its site', () => {
    const groups = fleetBoxGroups(
      [site({
        boxes: [
          {
            deviceId: 'd2', externalRef: 'VP-BOX-0002', name: 'Nebenbox', fuehrtAnlage: false,
            lastSeenAt: ago(10 * 60_000), edge: { coreVersion: 'edge-2026.08.0', paletteVersion: null, reportedAt: ago(60_000) }, update: null,
          },
          {
            deviceId: 'd1', externalRef: 'VP-BOX-0001', name: 'Leitbox', fuehrtAnlage: true,
            lastSeenAt: ago(20_000), edge: null,
            update: { version: 'edge-2026.09.0', backend: 'compose', current: null, target: null, state: 'idle', reason: null, lastKnownGood: null, reportedAt: ago(20_000) },
          },
        ],
      })],
      NOW,
      [
        { releaseSeq: 2, version: 'edge-2026.09.0' },
        { releaseSeq: 1, version: 'edge-2026.08.0' },
      ],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].boxes.map((box) => box.name)).toEqual(['Leitbox', 'Nebenbox']);
    expect(groups[0].boxes[0]).toMatchObject({
      roleText: 'Führende Box', connectionText: 'Verbunden', lastSeenText: 'vor 20 Sek.',
    });
    expect(groups[0].boxes[1]).toMatchObject({
      roleText: 'Weitere Box', connectionText: 'Meldet sich nicht',
    });
    expect(groups[0].boxes[0].software.text).toBe('edge-2026.09.0 ✓');
    expect(groups[0].boxes[0].capabilities.map((capability) => capability.name)).toEqual([
      'Rückmeldung je Datenquelle',
    ]);
    expect(groups[0].boxes[0].capabilities.every((capability) => capability.status === 'fehlt')).toBe(true);
  });

  it('uses each box report even when its version is unknown to the table', () => {
    const groups = fleetBoxGroups([site({ boxes: [
      { deviceId: 'new', externalRef: 'VP-new', name: null, fuehrtAnlage: true,
        lastSeenAt: ago(1000), edge: null, update: null, supports: ['data_sources', 'future_feature'] },
      { deviceId: 'old', externalRef: 'VP-old', name: null, fuehrtAnlage: false,
        lastSeenAt: ago(1000), edge: null, update: null },
    ] })], NOW, []);
    expect(groups[0].boxes.find((b) => b.deviceId === 'new')?.capabilities.map((c) => c.status)).toEqual(['vorhanden']);
    expect(groups[0].boxes.find((b) => b.deviceId === 'old')?.capabilities.map((c) => c.status)).toEqual(['fehlt']);
  });

  it('sorts attention first - a silent device beats a healthy plant', () => {
    const rows = fleetRows(
      [
        site({ siteId: 'ok', siteName: 'Gesund' }),
        site({
          siteId: 'still',
          siteName: 'Still',
          worstStatus: 'stale',
          onlineCount: 0,
          lastSeenAt: ago(3 * 3600_000),
        }),
        site({ siteId: 'planalt', siteName: 'Planalt', lastPlanGeneratedAt: ago(5 * 3600_000) }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.siteName)).toEqual(['Still', 'Planalt', 'Gesund']);
  });

  it('states a missing measurement as a gap, never as a zero', () => {
    const [row] = fleetRows(
      [site({ deviceCount: 0, onlineCount: 0, lastSeenAt: null, lastPlanGeneratedAt: null })],
      NOW,
    );
    expect(row.liveText).toBe('—');
    expect(row.deviceText).toBe('kein Gerät');
    expect(row.planText).toBe('kein aktueller Plan');
    // Nichts gemeldet -> unbekannt, nie "0 gesund".
    expect(row.sources).toBeNull();
    expect(row.edge.text).toBe('unbekannt');
  });

  it('a healthy row still SAYS so instead of leaving an empty cell', () => {
    const [row] = fleetRows([site()], NOW);
    expect(row.signals.map((s) => s.id)).toEqual(['ok']);
    expect(row.signals[0].label).toBe('Alles in Ordnung');
    expect(row.pflege).toEqual([]);
  });

  it('renders the SERVER-derived Pflege findings as chips, reason and all', () => {
    const [row] = fleetRows(
      [
        site({
          pflege: [
            { code: 'tarif-fehlt', label: 'Stromtarif fehlt', detail: null },
            {
              code: 'kwp-unplausibel',
              label: 'kWp unplausibel',
              detail: 'Gemessene PV-Spitze 420,0 kW über 30,0 kWp installiert.',
            },
          ],
        }),
      ],
      NOW,
    );
    expect(row.pflege.map((p) => p.code)).toEqual(['tarif-fehlt', 'kwp-unplausibel']);
    const chips = row.signals.map((s) => s.label);
    expect(chips).toContain('Stromtarif fehlt');
    expect(chips).toContain('kWp unplausibel');
    // Die Begründung reist am Chip mit - ein Signal ohne Grund wäre nur Alarm.
    expect(row.signals.find((s) => s.id === 'pflege-kwp-unplausibel')?.title).toContain('420,0 kW');
    expect(row.signals.find((s) => s.id === 'pflege-tarif-fehlt')?.title).toBeUndefined();
  });

  it('carries the B4 verdicts through untouched (they are the server’s truth)', () => {
    const [row] = fleetRows(
      [
        site({
          kwp: {
            configuredKwp: 30,
            observedPeakKw: 420,
            buckets: 2000,
            verdict: 'zu_hoch',
            reason: 'Gemessene PV-Spitze 420,0 kW über 30,0 kWp installiert.',
          },
          forecast: [
            { kind: 'load', nmaePct: 60, days: 14, fleetMedianPct: 13, outlier: true, reason: 'r' },
          ],
        }),
      ],
      NOW,
    );
    expect(row.kwp.verdict).toBe('zu_hoch');
    expect(row.forecast[0].outlier).toBe(true);
  });

  /**
   * Der „Edge veraltet"-Chip darf NUR aus dem Register kommen - und er trägt
   * seinen Grund, damit eine rote Zeile sagen kann, WORAUFHIN sie rot ist.
   */
  it('raises the outdated signal ONLY from the release register, with its reason', () => {
    const reported = {
      version: 'edge-2026.07.2',
      backend: 'compose',
      current: 'edge-2026.07.2',
      target: null,
      state: 'idle',
      reason: null,
      lastKnownGood: null,
      reportedAt: ago(15_000),
    };
    const register = [
      { releaseSeq: 12, version: 'edge-2026.08.0' },
      { releaseSeq: 11, version: 'edge-2026.07.2' },
    ];

    const [withRegister] = fleetRows([site({ update: reported })], NOW, register);
    const chip = withRegister.signals.find((s) => s.id === 'edge-alt');
    expect(chip?.label).toBe('Edge veraltet');
    expect(chip?.title).toContain('edge-2026.08.0');
    expect(withRegister.edge.outdated).toBe(true);

    // Ohne Register (leer ODER weggelassen - ein älteres Backend) gibt es
    // keinen Maßstab, also auch kein Signal.
    expect(fleetRows([site({ update: reported })], NOW, [])[0].signals.map((s) => s.id))
      .not.toContain('edge-alt');
    expect(fleetRows([site({ update: reported })], NOW)[0].signals.map((s) => s.id))
      .not.toContain('edge-alt');
  });
});

describe('fleetPulse', () => {
  it('counts what the rows say, nothing else', () => {
    const rows = fleetRows(
      [
        site({ siteId: 'a', worstStatus: 'stale', onlineCount: 0, lastSeenAt: ago(3 * 3600_000) }),
        site({ siteId: 'b', lastPlanGeneratedAt: ago(5 * 3600_000) }),
        site({ siteId: 'c', deviceCount: 1, onlineCount: 0, waitingCount: 1, worstStatus: 'waiting' }),
        site({
          siteId: 'd',
          pflege: [{ code: 'tarif-fehlt', label: 'Stromtarif fehlt', detail: null }],
        }),
      ],
      NOW,
    );
    const p = fleetPulse(rows);
    expect(p.sites).toBe(4);
    expect(p.gestoert).toBe(1);
    expect(p.planAlt).toBe(1);
    expect(p.wartet).toBe(1);
    expect(p.pflegeOffen).toBe(1);
  });
});

describe('sourceHealth', () => {
  it('no report at all is "unknown", never "0 healthy"', () => {
    expect(sourceHealth(null)).toBeNull();
    expect(sourceHealth({ total: 0, ok: 0, stale: 0, never: 0 })).toBeNull();
  });

  it('a stale source turns the cell amber and is counted', () => {
    const h = sourceHealth({ total: 3, ok: 2, stale: 1, never: 0 })!;
    expect(h.text).toBe('2/3 liefern');
    expect(h.tone).toBe('warn');
    expect(h.stale).toBe(1);
  });

  it('a never-delivering source is off, not a warning', () => {
    expect(sourceHealth({ total: 2, ok: 1, stale: 0, never: 1 })!.tone).toBe('off');
    expect(sourceHealth({ total: 2, ok: 2, stale: 0, never: 0 })!.tone).toBe('ok');
  });
});

/**
 * Der Edge-Stand als SOLL-GEGEN-IST (OTA Stufe 0).
 *
 * Der Vorgänger verglich den gemeldeten Stand gegen das FLOTTEN-MAXIMUM und
 * ordnete Versionen als Zahlenblöcke - gestempelt werden aber 12-stellige
 * Hex-SHAs, worauf das eine Zufallsordnung ist. Diese Fälle nageln die neue
 * Ordnung UND die drei Zustände fest, die ausdrücklich KEIN „veraltet" sind.
 */
describe('edgeStand', () => {
  const edge = (core: string | null) => ({
    coreVersion: core,
    paletteVersion: '0.3.0',
    reportedAt: ago(60_000),
  });
  const update = (version: string | null) => ({
    version,
    backend: 'compose',
    current: version,
    target: null,
    state: 'idle',
    reason: null,
    lastKnownGood: null,
    reportedAt: ago(15_000),
  });
  // Das Register, wie der Endpunkt es liefert: neueste zuerst.
  const REGISTER = [
    { releaseSeq: 12, version: 'edge-2026.08.0' },
    { releaseSeq: 11, version: 'edge-2026.07.2' },
  ];

  it('a device that never reported is UNKNOWN, never outdated', () => {
    const stand = edgeStand(null, null, REGISTER);
    expect(stand.status).toBe('unbekannt');
    expect(stand.text).toBe('unbekannt');
    expect(stand.outdated).toBe(false);
    expect(stand.tone).toBe('off');
    expect(stand.title).toContain('noch keinen Software-Stand gemeldet');
    // Auch ein flows-Block ohne Kernversion behauptet kein Alter.
    expect(edgeStand(edge(null), null, REGISTER).status).toBe('unbekannt');
  });

  it('reads the version from the OTA block even without any flows block', () => {
    // Das Loch, das Stufe 0 schließt: ein Gerät ohne ausgerollte Automation
    // baut den flows-Block nie, meldet seine Version aber top-level.
    const stand = edgeStand(null, update('edge-2026.07.2'), REGISTER);
    expect(stand.coreVersion).toBe('edge-2026.07.2');
    expect(stand.status).toBe('veraltet');
  });

  it('shows the Soll with a check when the reported version IS the newest', () => {
    const stand = edgeStand(edge('edge-2026.08.0'), null, REGISTER);
    expect(stand.status).toBe('aktuell');
    expect(stand.text).toBe('edge-2026.08.0 ✓');
    expect(stand.tone).toBe('ok');
    expect(stand.outdated).toBe(false);
  });

  it('shows Ist → Soll when the register places the version BEHIND', () => {
    const stand = edgeStand(edge('edge-2026.07.2'), null, REGISTER);
    expect(stand.text).toBe('edge-2026.07.2 → edge-2026.08.0');
    expect(stand.tone).toBe('warn');
    expect(stand.outdated).toBe(true);
    expect(stand.title).toContain('edge-2026.08.0');
  });

  it('orders by releaseSeq, NEVER by the version string', () => {
    // Genau der Fall, an dem der Zahlenblock-Vergleich scheiterte: nackte
    // Commit-SHAs im Register. parseInt("665d59b8…") = 665 gegen
    // parseInt("3bf8c038…") = 3 hätte hier „veraltet" behauptet.
    const shaRegister = [
      { releaseSeq: 2, version: '3bf8c0380000' },
      { releaseSeq: 1, version: '665d59b80000' },
    ];
    expect(edgeStand(edge('3bf8c0380000'), null, shaRegister).status).toBe('aktuell');
    expect(edgeStand(edge('665d59b80000'), null, shaRegister).status).toBe('veraltet');
  });

  it('matches a TAG BUILD stamp against the bare tag in the register', () => {
    // edge-images stempelt bei einem Tag-Lauf `<tag>-<kurzsha>`, das Register
    // trägt den nackten Tag. Die frühere strikte Gleichheit las damit JEDES
    // erfolgreich angewandte Tag-Release als „nicht registriert".
    const stand = edgeStand(null, update('edge-2026.08.0-9b3743959025'), REGISTER);
    expect(stand.status).toBe('aktuell');
    expect(stand.text).toBe('edge-2026.08.0 ✓');
    expect(stand.tone).toBe('ok');
    expect(stand.outdated).toBe(false);
    // Die rohe Stempelung geht nicht verloren.
    expect(stand.coreVersion).toBe('edge-2026.08.0-9b3743959025');
    expect(stand.title).toContain('edge-2026.08.0-9b3743959025');
  });

  it('places a stamped OLDER tag behind the register, unchanged', () => {
    const stand = edgeStand(null, update('edge-2026.07.2-665d59b80000'), REGISTER);
    expect(stand.status).toBe('veraltet');
    expect(stand.text).toBe('edge-2026.07.2 → edge-2026.08.0');
    expect(stand.tone).toBe('warn');
    expect(stand.outdated).toBe(true);
  });

  it('a SHA-only build still belongs to no release - the prefix rule is not a suffix rule', () => {
    // Ein Bestandsbau trägt eine nackte SHA. Er darf nicht plötzlich als
    // aktuell gelten, nur weil die Zuordnung lockerer wurde.
    expect(edgeStand(null, update('9b3743959025'), REGISTER).status).toBe('nicht_registriert');
    // Und ein Tag, der bloß mit dem Register-Eintrag ANFÄNGT, ist ein anderer
    // Tag - getrennt wird am Bindestrich, nicht am Zeichen.
    expect(edgeStand(null, update('edge-2026.08.01'), REGISTER).status).toBe('nicht_registriert');
  });

  it('releaseIsRunning is the house prefix rule, both refusals included', () => {
    expect(releaseIsRunning('edge-2026.08.0', 'edge-2026.08.0')).toBe(true);
    expect(releaseIsRunning('edge-2026.08.0', 'edge-2026.08.0-9b3743959025')).toBe(true);
    // Führende/nachlaufende Leerzeichen sind kein anderer Stand.
    expect(releaseIsRunning('edge-2026.08.0', '  edge-2026.08.0 ')).toBe(true);
    expect(releaseIsRunning('edge-2026.08.0', 'edge-2026.08.01')).toBe(false);
    expect(releaseIsRunning('edge-2026.08.0', '9b3743959025')).toBe(false);
    expect(releaseIsRunning('edge-2026.08.0', '')).toBe(false);
    expect(releaseIsRunning('', 'edge-2026.08.0')).toBe(false);
  });

  it('a version the register does not know is NOT registered - and NOT outdated', () => {
    const stand = edgeStand(edge('665d59b80000'), null, REGISTER);
    expect(stand.status).toBe('nicht_registriert');
    expect(stand.text).toBe('665d59b80000 · nicht registriert');
    expect(stand.outdated).toBe(false);
    // Kein Warnton: das ist eine Lücke im Register, keine Alters-Aussage.
    expect(stand.tone).toBe('off');
    expect(stand.title).toContain('nicht im Release-Register');
  });

  it('without a register nothing is claimed at all', () => {
    const stand = edgeStand(edge('edge-2026.07.2'), null, []);
    expect(stand.status).toBe('kein_massstab');
    expect(stand.text).toBe('edge-2026.07.2');
    expect(stand.outdated).toBe(false);
    expect(stand.title).toContain('Kein Release im Register');
  });

  it('sollRelease picks the highest releaseSeq, null on an empty register', () => {
    expect(sollRelease([])).toBeNull();
    // Auch wenn die Liste unsortiert ankäme.
    expect(sollRelease([REGISTER[1], REGISTER[0]])?.version).toBe('edge-2026.08.0');
  });

  it('the OTA version WINS over the flows-carried one (same value, two paths)', () => {
    const stand = edgeStand(edge('edge-2026.07.2'), update('edge-2026.08.0'), REGISTER);
    expect(stand.coreVersion).toBe('edge-2026.08.0');
    expect(stand.status).toBe('aktuell');
    // Die Palette-Version reist weiter im flows-Block.
    expect(stand.paletteVersion).toBe('0.3.0');
  });
});

describe('controlMatrixInputs', () => {
  it('takes only the storage plants - and keeps a plant WITHOUT any proof', () => {
    const inputs = controlMatrixInputs([
      site({ siteId: 'pv', hasStorage: false }),
      site({ siteId: 'batt', hasStorage: true }),
    ]);
    expect(inputs.map((i) => i.siteId)).toEqual(['batt']);
    expect(inputs[0].control).toBeNull();
    expect(inputs[0].curtailment).toBeNull();
  });
});

describe('controlMatrixRows (B2 - die Pilsting-Sicht)', () => {
  const control = (over: Partial<ControlStatus> = {}): ControlStatus =>
    ({
      deviceId: 'd1',
      commandedKw: -4,
      confirmedKw: -4,
      allMatch: true,
      controlEnabled: true,
      certified: true,
      mismatchRoles: null,
      slotStart: null,
      checkedAt: ago(41_000),
      executionMode: 'trim',
      ...over,
    }) as ControlStatus;

  const curtail = (over: Partial<CurtailmentStatus> = {}): CurtailmentStatus =>
    ({
      deviceId: 'd1',
      units: 2,
      certifiedUnits: 2,
      controlEnabled: true,
      active: true,
      appliedCapKw: 12.5,
      allMatch: true,
      possibleOverride: false,
      checkedAt: ago(41_000),
      ...over,
    }) as CurtailmentStatus;

  const input = (over: Partial<Parameters<typeof controlMatrixRows>[0][0]> = {}) => ({
    siteId: 's1',
    siteName: 'PV-Park Pilsting',
    tenantId: 't1',
    tenantName: 'Energiehof P.',
    control: control(),
    curtailment: curtail(),
    ...over,
  });

  it('puts "0 von 2 Wechselrichtern freigegeben" front and centre', () => {
    const [row] = controlMatrixRows(
      [input({ curtailment: curtail({ certifiedUnits: 0, active: false }) })],
      NOW,
    );
    expect(row.curtail.text).toBe('0 von 2 Wechselrichtern freigegeben');
    expect(row.curtail.tone).toBe('warn');
  });

  it('a confirmed limit is the only shape that reads as executed', () => {
    const [row] = controlMatrixRows([input()], NOW);
    expect(row.curtail.tone).toBe('ok');
    expect(row.curtail.detail).toContain('bestätigt');
    expect(row.battery.tone).toBe('ok');
    expect(row.executionText).toBe('Solar-Überschuss');
  });

  it('a possible override is a warning, not a confirmation', () => {
    const [row] = controlMatrixRows([input({ curtailment: curtail({ possibleOverride: true }) })], NOW);
    expect(row.curtail.tone).toBe('warn');
    expect(row.curtail.detail).toContain('übersteuert');
  });

  it('says "kein Abregel-Aktor" instead of inventing a release count', () => {
    const [row] = controlMatrixRows([input({ curtailment: null })], NOW);
    expect(row.curtail.text).toBe('kein Abregel-Aktor');
    expect(row.curtail.tone).toBe('off');
  });

  it('an aged proof confirms NOTHING - it says the proof is old', () => {
    const old = ago(22 * 60_000);
    const [row] = controlMatrixRows(
      [
        input({
          control: control({ checkedAt: old }),
          curtailment: curtail({ checkedAt: old }),
        }),
      ],
      NOW,
    );
    expect(row.belegStale).toBe(true);
    expect(row.battery.tone).toBe('off');
    expect(row.curtail.tone).toBe('off');
  });

  it('a site without any proof stays in the table and says so', () => {
    const [row] = controlMatrixRows([input({ control: null, curtailment: null })], NOW);
    expect(row.battery.text).toBe('kein Beleg');
    expect(row.belegText).toBe('kein Beleg');
    expect(row.executionText).toBe('—');
  });

  it('names the kill-switch and the missing certification apart', () => {
    expect(
      controlMatrixRows([input({ control: control({ controlEnabled: false }) })], NOW)[0].battery.text,
    ).toBe('Steuerung aus');
    expect(
      controlMatrixRows([input({ control: control({ certified: false }) })], NOW)[0].battery.text,
    ).toBe('nicht zertifiziert');
  });

  it('sorts the plants that need somebody to the top', () => {
    const rows = controlMatrixRows(
      [
        input({ siteId: 'ok', siteName: 'Gesund' }),
        input({
          siteId: 'bad',
          siteName: 'Ungefreigegeben',
          curtailment: curtail({ certifiedUnits: 0, active: false }),
        }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.siteName)).toEqual(['Ungefreigegeben', 'Gesund']);
  });
});
