import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  blockerLever,
  canRollOut,
  candidates,
  crossoverHint,
  crossoverState,
  eventLabel,
  freshnessLabel,
  isLoud,
  kpiText,
  kpiTone,
  kpiUnknownNote,
  loudBanner,
  progressBackbone,
  restingLine,
  rolloutDeviceName,
  rolloutStateLabel,
  signatureLabel,
  sortFleet,
  startSummary,
  stateLabel,
  trustSetSpread,
  visibleJournal,
  type DeviceTrust,
  type EdgeUpdates,
  type EdgeUpdatesRelease,
  type FleetRow,
  type JournalEntry,
  type Rollout,
  type RolloutDevice,
} from './adminEdgeUpdates';

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  deviceId: over.deviceId ?? 'd1',
  label: 'edge-a1',
  externalRef: 'edge-a1',
  siteId: 's1',
  siteName: over.siteName ?? 'Pilsting',
  tenantId: 't1',
  tenantName: over.tenantName ?? 'Kunde A',
  ist: 'edge-2026.07.2',
  soll: 'edge-2026.08.0',
  sollSeq: 12,
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
    const unknown = { label: 'unbekannt', tone: 'off', cls: 'calm' };
    expect(stateLabel('teleporting')).toEqual(unknown);
    expect(stateLabel(null)).toEqual(unknown);
    expect(stateLabel(undefined)).toEqual(unknown);
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

describe('Vier-Klassen-Grammatik', () => {
  it('trennt „läuft von selbst" von „blockiert" von einem Vorfall', () => {
    // Die frühere fünfte Klasse „action" („SIE sind dran") ist mit dem
    // Ein-Schritt-Umbau ENTFALLEN: niemand ist mehr dran, das Gerät wendet
    // selbst an.
    expect(stateLabel('ausstehend').cls).toBe('busy');
    expect(stateLabel('blockiert').cls).toBe('blocked');
    expect(stateLabel('fehlgeschlagen').cls).toBe('incident');
    // Und sie sind wirklich VERSCHIEDEN - eine Klasse, die zweimal vorkommt,
    // wäre keine Unterscheidung.
    const seen = new Set(['ausstehend', 'blockiert', 'fehlgeschlagen']
      .map((s) => stateLabel(s).cls));
    expect(seen.size).toBe(3);
  });

  it('kennt das Wort „wartet auf Anwendung" nicht mehr', () => {
    // Es beschrieb den Zustand „verifiziert, wartet auf einen Menschen am
    // Gerät" - den es seit dem Umbau gar nicht mehr gibt. Ein Server, der es
    // noch sendet, wird zu „unbekannt", nie zu „aktuell".
    expect(stateLabel('wartet_auf_anwendung').label).toBe('unbekannt');
  });

  it('lässt ruhig ruhig und laut laut', () => {
    for (const s of ['aktuell', 'bestaetigt', 'offline_holt_nach', 'unbekannt']) {
      expect(stateLabel(s).cls).toBe('calm');
    }
    for (const s of ['fehlgeschlagen', 'zurueckgerollt', 'im_update_verstummt']) {
      expect(stateLabel(s).cls).toBe('incident');
    }
    // Ein Politik-Halt steht in derselben Klasse wie eine Sperre: kein Vorfall,
    // aber auch kein Fortschritt.
    expect(stateLabel('zurueckgestellt').cls).toBe('blocked');
  });

  it('sortiert Aufmerksamkeit zuerst - Vorfall vor Sperre vor Lauf vor Ruhe', () => {
    const sorted = sortFleet([
      row({ deviceId: 'a', state: 'bestaetigt' }),
      row({ deviceId: 'b', state: 'wendet_an' }),
      row({ deviceId: 'c', state: 'fehlgeschlagen' }),
      row({ deviceId: 'd', state: 'ausstehend' }),
      row({ deviceId: 'e', state: 'blockiert' }),
    ]).map((r) => r.deviceId);
    expect(sorted).toEqual(['c', 'e', 'b', 'd', 'a']);
  });
});

describe('Hebel einer Sperre', () => {
  it('nennt den Hebel zum maschinenlesbaren Namen', () => {
    expect(blockerLever('neutralzeit')).toContain('VP_OTA_NEUTRAL_VERIFIED');
    expect(blockerLever('platte')).toContain('Platz');
  });

  it('erfindet KEINEN Hebel zu einem unbekannten Namen', () => {
    // Der Grund des Geräts steht ohnehin daneben; ein geratener Hebel wäre
    // eine Anweisung ins Leere.
    expect(blockerLever('mondphase')).toBeNull();
    expect(blockerLever(null)).toBeNull();
    expect(blockerLever(undefined)).toBeNull();
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

describe('Aktualisierung', () => {
  it('benennt jeden Zustand einer Aktualisierung', () => {
    expect(rolloutStateLabel('active').tone).toBe('busy');
    expect(rolloutStateLabel('done').tone).toBe('ok');
    // Die Zustände der Wellen-Ära (paused/halted) gibt es nicht mehr - und ein
    // Wort, das dieser Stand nicht kennt, wird NIE zu „läuft".
    expect(rolloutStateLabel('paused').label).toBe('unbekannt');
    expect(rolloutStateLabel('irgendwas').label).toBe('unbekannt');
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

// ── Beobachten: Namen, Fortschritt, Frische ────────────────────────────────

const rolloutDev = (over: Partial<RolloutDevice> = {}): RolloutDevice => ({
  deviceId: 'd1', label: 'edge-a1', siteName: 'Pilsting', tenantName: 'Kunde A',
  state: 'bestaetigt', reason: null, since: null, ...over,
});

const rolloutOf = (over: Partial<Rollout> = {}): Rollout => ({
  id: 'r1', releaseVersion: 'edge-2026.08.1', releaseSeq: 14,
  state: 'active', createdBy: 'admin', createdAt: '2026-08-05T09:12:00Z',
  total: 0, confirmed: 0, failed: 0, devices: [], ...over,
});

const updates = (over: Partial<EdgeUpdates> = {}): EdgeUpdates => ({
  releases: [], rollouts: [], fleet: [], journal: [],
  kpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
  ...over,
});

describe('Namen in der Geräte-Liste', () => {
  it('rendert NIE eine UUID', () => {
    const got = rolloutDeviceName(rolloutDev({
      deviceId: '7a1f0c2e-1111-2222-3333-444455556666', siteName: null, label: null,
    }));
    expect(got.name).not.toContain('7a1f0c2e-1111');
    expect(got.name).toContain('Entferntes Gerät');
    expect(got.removed).toBe(true);
  });

  it('nimmt den Schnappschuss, wenn das Gerät weg ist - und sagt es', () => {
    const got = rolloutDeviceName(rolloutDev({ siteName: 'Pilsting', removed: true }));
    expect(got.name).toBe('Pilsting (entfernt)');
    expect(got.removed).toBe(true);
  });

  it('nennt ein lebendes Gerät schlicht beim Namen', () => {
    expect(rolloutDeviceName(rolloutDev())).toEqual({ name: 'Pilsting', removed: false });
  });
});

describe('Fortschritts-Rückgrat', () => {
  const board = (states: string[]) => ({
    rollout: rolloutOf({ devices: states.map((_, i) => rolloutDev({ deviceId: `d${i}` })) }),
    fleet: states.map((s, i) => row({ deviceId: `d${i}`, state: s })),
  });

  it('zählt je Klasse und hält offline AUS dem Nenner', () => {
    const b = board(['bestaetigt', 'bestaetigt', 'wendet_an', 'blockiert', 'offline_holt_nach']);
    const view = progressBackbone(b.rollout, b.fleet)!;
    // Vier erreichbare Geräte - das offline-Gerät steht daneben, nie im Nenner.
    expect(view.total).toBe(4);
    expect(view.segments.find((s) => s.cls === 'calm')?.count).toBe(2);
    expect(view.segments.find((s) => s.cls === 'busy')?.count).toBe(1);
    expect(view.segments.find((s) => s.cls === 'blocked')?.count).toBe(1);
    expect(view.asideNote).toContain('1 offline');
    expect(view.asideNote).toContain('zählt nicht in die Quote');
  });

  it('nennt Geräte ohne Meldung getrennt, statt sie als Rückstand zu zählen', () => {
    const b = board(['bestaetigt', 'unbekannt']);
    const view = progressBackbone(b.rollout, b.fleet)!;
    expect(view.total).toBe(1);
    expect(view.asideNote).toContain('1 ohne Meldung');
  });

  it('folgt der LIVE-Wahrheit, nicht dem eingefrorenen Zustand der Zeile', () => {
    const view = progressBackbone(
      rolloutOf({ devices: [rolloutDev({ deviceId: 'd1', state: 'fehlgeschlagen' })] }),
      [row({ deviceId: 'd1', state: 'bestaetigt' })],
    )!;
    expect(view.segments.find((s) => s.cls === 'calm')?.count).toBe(1);
    expect(view.segments.find((s) => s.cls === 'incident')).toBeUndefined();
  });

  it('gibt es ohne Aktualisierung gar nicht', () => {
    expect(progressBackbone(null, [])).toBeNull();
  });
});

describe('Ruhezustand + Bezugszeit', () => {
  it('sagt in EINEM Satz, wie die Flotte steht', () => {
    const line = restingLine(updates({
      kpi: { known: 4, upToDate: 4, unknown: 1, inRollout: 0, failed: 0,
        newestRelease: 'edge-2026.08.1' },
    }))!;
    expect(line).toContain('4/4 Geräte auf edge-2026.08.1');
    // „unbekannt" ist NIE „veraltet" - auch nicht in der Kurzform.
    expect(line).toContain('unbekannt, nicht veraltet');
    expect(line).toContain('Gerade wird nichts aktualisiert');
  });

  it('behauptet ohne Register keinen Maßstab', () => {
    const line = restingLine(updates({
      kpi: { known: 2, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
    }))!;
    expect(line).toContain('Kein Release im Register');
  });

  it('schweigt, solange eine Aktualisierung läuft', () => {
    expect(restingLine(updates({ rollouts: [rolloutOf()] }))).toBeNull();
  });

  it('nennt die Bezugszeit in Worten', () => {
    const t = 1_000_000_000_000;
    expect(freshnessLabel(t, t + 2_000)).toBe('Stand: gerade eben');
    expect(freshnessLabel(t, t + 12_000)).toContain('12');
    expect(freshnessLabel(t, t + 120_000)).toContain('2');
    // Eine Zukunft rechnet nie negativ.
    expect(freshnessLabel(t, t - 5_000)).toBe('Stand: gerade eben');
  });
});

describe('Aktualisieren: Geräte-Auswahl + Zusammenfassung', () => {
  it('zeigt je Gerät den ZUSTAND und nennt, was dagegen spricht - als HINWEIS', () => {
    // Seit dem Ein-Schritt-Umbau gibt es keine Vorbedingung mehr: der Einwand
    // erklärt, er sperrt nicht. Ein „festgenagelt" gibt es gar nicht mehr.
    const list = candidates([
      row({ deviceId: 'a', siteName: 'A', state: 'bestaetigt' }),
      row({ deviceId: 'b', siteName: 'B', state: 'offline_holt_nach' }),
      row({ deviceId: 'c', siteName: 'C', state: 'unbekannt' }),
    ]);
    const byName = new Map(list.map((c) => [c.name, c]));
    expect(byName.get('A')!.caveat).toBeNull();
    expect(byName.get('B')!.caveat).toContain('nachgeholt');
    expect(byName.get('C')!.caveat).toContain('noch keinen Stand');
    // JEDES Gerät bleibt wählbar - die Liste kennt keine Sperre.
    expect(list).toHaveLength(3);
  });

  it('nennt einen offenen Crossover als Einwand - dort wirkt kein Release', () => {
    const list = candidates([row({
      deviceId: 'a', siteName: 'A', state: 'bestaetigt',
      trust: { rootKeyIds: [], trustSetKeyIds: [], trustSetGeneratedAt: null,
        trustSetError: 'kein Anker' },
    })]);
    expect(list[0].caveat).toContain('Vertrauen');
  });

  it('sagt vor dem Klick, was passiert - INKLUSIVE dessen, was nicht sofort passiert', () => {
    const lines = startSummary(['a', 'd'], [
      row({ deviceId: 'a', siteName: 'Pilsting' }),
      row({ deviceId: 'b', siteName: 'B' }),
      row({ deviceId: 'd', siteName: 'D', state: 'offline_holt_nach' }),
    ]);
    const text = lines.join(' ');
    expect(text).toContain('2 Geräte');
    expect(text).toContain('SOFORT');
    expect(text).toContain('aktualisieren sich selbst');
    // Das sieht später wie ein Fehler aus, wenn es hier nicht angekündigt wurde.
    expect(text).toContain('nachgeholt');
    // Der Satz, der den ganzen Umbau trägt.
    expect(text).toContain('niemand muss an ein Gerät');
  });

  it('behauptet ohne Auswahl gar nichts', () => {
    expect(startSummary([], [row()])).toEqual([]);
  });
});
