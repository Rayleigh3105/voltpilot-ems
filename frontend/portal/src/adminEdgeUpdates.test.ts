import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  advanceMode,
  bakeLine,
  canRollOut,
  crossoverHint,
  crossoverState,
  eventLabel,
  isLoud,
  kpiText,
  kpiTone,
  kpiUnknownNote,
  loudBanner,
  promoteHint,
  rolloutStateLabel,
  signatureLabel,
  sortFleet,
  stateLabel,
  trustSetSpread,
  visibleJournal,
  type ActiveRollout,
  type DeviceTrust,
  type EdgeUpdatesRelease,
  type FleetRow,
  type JournalEntry,
  type WaveDevice,
} from './adminEdgeUpdates';

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  deviceId: over.deviceId ?? 'd1',
  label: 'edge-a1',
  siteId: 's1',
  siteName: over.siteName ?? 'Pilsting',
  tenantId: 't1',
  tenantName: over.tenantName ?? 'Kunde A',
  ist: 'edge-2026.07.2',
  soll: 'edge-2026.08.0',
  sollSeq: 12,
  channel: 'stable',
  pinned: false,
  state: 'ausstehend',
  reason: null,
  since: null,
  reportedAt: null,
  rolloutId: null,
  ...over,
});

describe('Zustands-Vokabular', () => {
  it('kennt jeden Zustand der Maschine (§7.2)', () => {
    for (const s of [
      'aktuell', 'ausstehend', 'laedt', 'wendet_an', 'selbsttest', 'bestaetigt',
      'zurueckgerollt', 'offline_holt_nach', 'im_update_verstummt', 'fehlgeschlagen',
      'zurueckgestellt', 'unbekannt',
    ]) {
      expect(stateLabel(s).label).not.toBe('unbekannt: ' + s);
    }
    expect(stateLabel('bestaetigt').tone).toBe('ok');
    expect(stateLabel('fehlgeschlagen').tone).toBe('warn');
    // „offline" ist NIE ein Warnton - hinter NAT ist es der Normalfall.
    expect(stateLabel('offline_holt_nach').tone).toBe('off');
    // Und ein Politik-Halt ist kein Vorfall.
    expect(stateLabel('zurueckgestellt').tone).toBe('off');
  });

  it('macht aus einem UNBEKANNTEN Zustand nie „aktuell"', () => {
    // Ein Server, der neuer ist als dieses Portal, darf keine falsche
    // Behauptung erzeugen - „unbekannt" ist die ehrliche Antwort.
    expect(stateLabel('teleporting')).toEqual({ label: 'unbekannt', tone: 'off' });
    expect(stateLabel(null)).toEqual({ label: 'unbekannt', tone: 'off' });
    expect(stateLabel(undefined)).toEqual({ label: 'unbekannt', tone: 'off' });
  });

  it('ist laut nur bei echten Vorfällen', () => {
    expect(isLoud('fehlgeschlagen')).toBe(true);
    expect(isLoud('zurueckgerollt')).toBe(true);
    expect(isLoud('im_update_verstummt')).toBe(true);
    expect(isLoud('offline_holt_nach')).toBe(false);
    expect(isLoud('zurueckgestellt')).toBe(false);
    expect(isLoud('unbekannt')).toBe(false);
  });
});

describe('Banner', () => {
  it('nennt die betroffenen Anlagen - ein Alarm ohne Adresse ist Lärm', () => {
    const text = loudBanner([
      row({ deviceId: 'a', siteName: 'Pilsting', state: 'fehlgeschlagen' }),
      row({ deviceId: 'b', siteName: 'Auernheim', state: 'zurueckgerollt' }),
      row({ deviceId: 'c', state: 'bestaetigt' }),
    ]);
    expect(text).toContain('Pilsting');
    expect(text).toContain('Auernheim');
    expect(text).toContain('2 Geräte');
  });

  it('schweigt, wenn nichts laut ist (auch bei offline)', () => {
    expect(loudBanner([row({ state: 'offline_holt_nach' }), row({ state: 'bestaetigt' })]))
      .toBeNull();
    expect(loudBanner([])).toBeNull();
  });
});

describe('Puls-Kennzahl', () => {
  const kpi = { known: 4, upToDate: 3, unknown: 0, inRollout: 2, failed: 0, newestRelease: 'x' };

  it('zählt über die ERREICHBARE Menge', () => {
    // Ein Gerät ohne Meldung steht weder im Zähler noch im Nenner - aus einer
    // Wissenslücke darf keine schlechte Quote werden.
    expect(kpiText({ ...kpi, unknown: 9 })).toContain('3/4 aktuell');
    expect(kpiUnknownNote({ ...kpi, unknown: 9 })).toContain('9 Geräte');
    expect(kpiUnknownNote({ ...kpi, unknown: 9 })).toContain('nicht veraltet');
    expect(kpiUnknownNote(kpi)).toBeNull();
  });

  it('nennt Rollout und Fehlschläge nur, wenn es sie gibt', () => {
    expect(kpiText(kpi)).toBe('3/4 aktuell · 2 im Rollout');
    expect(kpiText({ ...kpi, inRollout: 0, failed: 0 })).toBe('3/4 aktuell');
    expect(kpiText({ ...kpi, failed: 1 })).toContain('1 fehlgeschlagen');
  });

  it('tönt rot vor gelb vor ruhig', () => {
    expect(kpiTone({ ...kpi, failed: 1 })).toBe('warn');
    expect(kpiTone(kpi)).toBe('busy');
    expect(kpiTone({ ...kpi, inRollout: 0 })).toBe('ok');
  });
});

describe('Rollout', () => {
  const rollout = (over: Partial<ActiveRollout> = {}): ActiveRollout => ({
    id: 'r1', releaseVersion: 'edge-2026.08.0', releaseSeq: 12, channel: 'stable',
    state: 'active', currentWave: 1, waveCount: 2, haltedReason: null, createdBy: 'admin',
    createdAt: '2026-08-05T08:00:00Z', canPromote: false,
    promoteBlockedReason: 'Noch 21 Std. gesunder Betrieb bis zur Freigabe.',
    waves: [], ...over,
  });

  it('sagt WARUM die nächste Welle gesperrt ist', () => {
    // Ein deaktivierter Knopf ohne Begründung ist eine Sackgasse.
    expect(promoteHint(rollout())).toContain('21 Std.');
    expect(promoteHint(rollout({ canPromote: true }))).toBeNull();
    expect(promoteHint(null)).toBeNull();
  });

  it('erfindet keinen Grund, wenn der Server keinen liefert', () => {
    const hint = promoteHint(rollout({ promoteBlockedReason: null }));
    expect(hint).toBeTruthy();
    expect(hint).not.toContain('Std.');
  });

  it('benennt jeden Rollout-Zustand', () => {
    expect(rolloutStateLabel('active').tone).toBe('busy');
    expect(rolloutStateLabel('paused').tone).toBe('off');
    expect(rolloutStateLabel('halted').tone).toBe('warn');
    expect(rolloutStateLabel('done').tone).toBe('ok');
    expect(rolloutStateLabel('irgendwas').label).toBe('unbekannt');
  });
});

describe('Bake-Zeile', () => {
  const dev = (over: Partial<WaveDevice> = {}): WaveDevice => ({
    deviceId: 'd', label: 'edge', siteName: 'Pilsting', tenantName: 'A',
    state: 'bestaetigt', reason: null, since: null,
    bakeRemainingMinutes: 0, bakeCycle: 'erfuellt', bakeReason: null, ...over,
  });

  it('sagt beide Hälften', () => {
    expect(bakeLine(dev())).toBe('24 Std. gesund ✓ · Steuerzyklus ✓');
    expect(bakeLine(dev({ bakeRemainingMinutes: 125 }))).toContain('noch 2 Std. 5 Min.');
  });

  it('nennt einen NICHT PRÜFBAREN Steuerzyklus beim Namen', () => {
    // Auf einer Anlage, auf der VoltPilot nicht steuert, gibt es diesen Beleg
    // strukturell nicht - das wird GESAGT, nie als erfüllt unterstellt.
    expect(bakeLine(dev({ bakeCycle: 'nicht_pruefbar' }))).toContain('nicht prüfbar');
    expect(bakeLine(dev({ bakeCycle: 'offen' }))).toContain('offen');
  });

  it('schweigt ohne Bake-Urteil (Welle noch nicht freigegeben)', () => {
    expect(bakeLine(dev({ bakeCycle: null, bakeRemainingMinutes: null }))).toBeNull();
  });
});

describe('Journal', () => {
  const e = (over: Partial<JournalEntry>): JournalEntry => ({
    id: 1, at: '2026-08-05T08:00:00Z', actor: 'admin', event: 'rollout_created',
    rolloutId: 'r', deviceId: null, detail: null, ...over,
  });

  it('nennt den Wächter „automatisch", nie wie einen Menschen', () => {
    expect(actorLabel('system')).toBe('automatisch');
    expect(actorLabel('7a1f-admin')).toBe('7a1f-admin');
  });

  it('übersetzt bekannte Ereignisse und lässt unbekannte stehen', () => {
    expect(eventLabel('rollout_auto_halted')).toContain('AUTOMATISCH');
    expect(eventLabel('irgendwas_neues')).toBe('irgendwas_neues');
  });

  it('blendet das Zustands-Protokoll aus - AUSSER wenn es laut ist', () => {
    const shown = visibleJournal([
      e({ id: 1, event: 'rollout_created' }),
      e({ id: 2, event: 'device_state', detail: 'bestaetigt' }),
      e({ id: 3, event: 'device_state', detail: 'fehlgeschlagen - Pull fehlgeschlagen' }),
    ]);
    expect(shown.map((x) => x.id)).toEqual([1, 3]);
  });
});

describe('Sortierung + Register', () => {
  it('sortiert Aufmerksamkeit zuerst, dann Mandant/Anlage', () => {
    const sorted = sortFleet([
      row({ deviceId: '1', state: 'bestaetigt', tenantName: 'A', siteName: 'A1' }),
      row({ deviceId: '2', state: 'fehlgeschlagen' }),
      row({ deviceId: '3', state: 'wendet_an' }),
      row({ deviceId: '4', state: 'offline_holt_nach' }),
    ]);
    expect(sorted.map((r) => r.deviceId)).toEqual(['2', '3', '4', '1']);
  });

  it('lässt nur SIGNIERTE Releases ausrollen', () => {
    const rel = (signed: boolean): EdgeUpdatesRelease => ({
      releaseSeq: 12, version: 'edge-2026.08.0', targetCommit: 'abc', notes: null,
      signed, signingKeyId: signed ? 'rel-2026-a' : null,
      createdAt: '2026-08-05T08:00:00Z', runningOnDevices: 0,
    });
    expect(canRollOut(rel(true))).toBe(true);
    expect(canRollOut(rel(false))).toBe(false);
    expect(signatureLabel(rel(true)).label).toContain('rel-2026-a');
    expect(signatureLabel(rel(false))).toEqual({ label: 'nicht signiert', tone: 'off' });
  });
});

// ── OTA Stufe 4 „Politur" ──────────────────────────────────────────────────

const rollout = (over: Partial<ActiveRollout> = {}): ActiveRollout => ({
  id: 'r1',
  releaseVersion: 'edge-2026.08.0',
  releaseSeq: 12,
  channel: 'stable',
  state: 'active',
  currentWave: 1,
  waveCount: 3,
  haltedReason: null,
  createdBy: 'admin',
  createdAt: '2026-08-05T08:00:00Z',
  canPromote: false,
  promoteBlockedReason: 'Noch 4 Std. gesunder Betrieb bis zur Freigabe.',
  waves: [],
  ...over,
});

describe('Wellen-Automatik (Stufe 4)', () => {
  it('benennt den Modus, in dem ein Rollout läuft', () => {
    expect(advanceMode(rollout({ autoAdvance: true, advanceNote: 'Automatischer Vorschub: …' })))
      .toEqual({
        label: 'Automatischer Wellen-Vorschub',
        tone: 'busy',
        note: 'Automatischer Vorschub: …',
      });
    expect(advanceMode(rollout({ advanceNote: 'Hand-Vorschub: …' })))
      .toEqual({ label: 'Wellen von Hand', tone: 'off', note: 'Hand-Vorschub: …' });
  });

  it('ist ohne Rollout still und behauptet ohne Server-Satz nichts', () => {
    expect(advanceMode(null)).toBeNull();
    // Ein ÄLTERER Server kennt die Felder nicht: dann gibt es das Etikett
    // „von Hand" (die Vorgabe) und KEINE Behauptung über das, was folgt.
    const alt = advanceMode(rollout({ autoAdvance: undefined, advanceNote: undefined }));
    expect(alt?.label).toBe('Wellen von Hand');
    expect(alt?.note).toBeNull();
  });

  it('färbt die Automatik nicht als Warnung - sie ist eine gewählte Betriebsart', () => {
    expect(advanceMode(rollout({ autoAdvance: true }))?.tone).not.toBe('warn');
  });
});

describe('TOFU-Abschluss (Stufe 4)', () => {
  const trust = (over: Partial<DeviceTrust> = {}): DeviceTrust => ({
    rootKeyIds: ['root-2026-a'],
    trustSetKeyIds: ['rel-2026-a'],
    trustSetGeneratedAt: '2026-09-01T10:00:00Z',
    trustSetError: null,
    ...over,
  });

  it('nennt ein gekreuztes Gerät gekreuzt - mit Wurzel und Set-Stand', () => {
    const got = crossoverState(trust());
    expect(got.state).toBe('gekreuzt');
    expect(got.tone).toBe('ok');
    expect(got.detail).toContain('root-2026-a');
    expect(got.detail).toContain('01.09.2026');
  });

  it('rendert ABWESENHEIT nie als Befund - ein älterer Stand ist „unbekannt"', () => {
    for (const t of [null, undefined]) {
      const got = crossoverState(t);
      expect(got.state).toBe('unbekannt');
      expect(got.tone).toBe('off');
      // Nie „nicht gekreuzt", nie ein Warnton: wir wissen es schlicht nicht.
      expect(got.label).toBe('unbekannt');
      expect(got.detail).not.toContain('Crossover offen');
    }
  });

  it('nennt ein schlüsselloses Image als OFFENE Aufgabe, nicht als Fehler', () => {
    const got = crossoverState(trust({ rootKeyIds: [], trustSetKeyIds: [] }));
    expect(got.state).toBe('offen');
    expect(got.tone).toBe('off');
    expect(got.detail).toContain('Crossover');
  });

  it('ist nur dort laut, wo es ein Vorfall ist: Wurzel da, Set abgelehnt', () => {
    const got = crossoverState(trust({ trustSetKeyIds: [], trustSetError: 'nicht root-signiert' }));
    expect(got.state).toBe('fehler');
    expect(got.tone).toBe('warn');
    expect(got.detail).toContain('nicht root-signiert');
  });

  it('zählt für den Hinweis nur BELEGT offene und nennt Unbekanntes getrennt', () => {
    const hint = crossoverHint([
      row({ deviceId: '1', trust: trust() }),
      row({ deviceId: '2', trust: trust({ rootKeyIds: [], trustSetKeyIds: [] }) }),
      row({ deviceId: '3', trust: trust({ rootKeyIds: [], trustSetKeyIds: [] }) }),
      row({ deviceId: '4' }),
    ]);
    expect(hint).toContain('Crossover offen: 2 Geräte');
    expect(hint).toContain('1 Gerät meldet seinen Vertrauensanker nicht');
  });

  it('schweigt, wenn die ganze Flotte gekreuzt ist', () => {
    expect(crossoverHint([row({ deviceId: '1', trust: trust() })])).toBeNull();
    expect(crossoverHint([])).toBeNull();
  });

  it('zeigt für den Rotations-Drill, welche Sets die Flotte fährt', () => {
    const spread = trustSetSpread([
      row({ deviceId: '1', trust: trust({ trustSetGeneratedAt: '2026-09-01T10:00:00Z' }) }),
      row({ deviceId: '2', trust: trust({ trustSetGeneratedAt: '2026-08-01T10:00:00Z' }) }),
      row({ deviceId: '3', trust: trust({ trustSetGeneratedAt: '2026-09-01T10:00:00Z' }) }),
      // Ohne Set gibt es nichts einzuordnen - es taucht hier nicht auf.
      row({ deviceId: '4', trust: trust({ rootKeyIds: [], trustSetKeyIds: [] }) }),
      row({ deviceId: '5' }),
    ]);
    expect(spread).toEqual([
      { stamp: '2026-09-01T10:00:00Z', devices: 2 },
      { stamp: '2026-08-01T10:00:00Z', devices: 1 },
    ]);
  });
});
