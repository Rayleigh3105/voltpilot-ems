import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  advanceMode,
  bakeLine,
  blockerLever,
  canRollOut,
  crossoverHint,
  crossoverState,
  eventLabel,
  freshnessLabel,
  frozenFraming,
  handelnItems,
  isLoud,
  kpiText,
  kpiTone,
  kpiUnknownNote,
  loudBanner,
  progressBackbone,
  promoteHint,
  restingLine,
  rolloutStateLabel,
  signatureLabel,
  sortFleet,
  stateLabel,
  trustSetSpread,
  visibleJournal,
  waveDeviceName,
  waveRowView,
  type ActiveRollout,
  type DeviceTrust,
  type EdgeUpdates,
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
  it('trennt „läuft von selbst" von „SIE sind dran" von „blockiert"', () => {
    // DER Fehler, für den diese Klasse existiert: bis hierher trugen alle drei
    // dasselbe busy-blaue „ausstehend".
    expect(stateLabel('ausstehend').cls).toBe('busy');
    expect(stateLabel('wartet_auf_anwendung').cls).toBe('action');
    expect(stateLabel('blockiert').cls).toBe('blocked');
    // Und sie sind wirklich VERSCHIEDEN - eine Klasse, die zweimal vorkommt,
    // wäre keine Unterscheidung.
    const seen = new Set(['ausstehend', 'wartet_auf_anwendung', 'blockiert']
      .map((s) => stateLabel(s).cls));
    expect(seen.size).toBe(3);
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

  it('sortiert „Sie sind dran" direkt hinter die Vorfälle', () => {
    const sorted = sortFleet([
      row({ deviceId: 'a', state: 'bestaetigt' }),
      row({ deviceId: 'b', state: 'wartet_auf_anwendung' }),
      row({ deviceId: 'c', state: 'fehlgeschlagen' }),
      row({ deviceId: 'd', state: 'ausstehend' }),
      row({ deviceId: 'e', state: 'blockiert' }),
    ]).map((r) => r.deviceId);
    expect(sorted).toEqual(['c', 'b', 'e', 'd', 'a']);
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

// ── Beobachten: Namen, Handeln, Fortschritt, Frische ───────────────────────

const waveDev = (over: Partial<WaveDevice> = {}): WaveDevice => ({
  deviceId: 'd1', label: 'edge-a1', siteName: 'Pilsting', tenantName: 'Kunde A',
  state: 'bestaetigt', reason: null, since: null,
  bakeRemainingMinutes: null, bakeCycle: null, bakeReason: null, ...over,
});

const rolloutOf = (over: Partial<ActiveRollout> = {}): ActiveRollout => ({
  id: 'r1', releaseVersion: 'edge-2026.08.1', releaseSeq: 14, channel: 'canary',
  state: 'active', currentWave: 1, waveCount: 2, haltedReason: null, createdBy: 'admin',
  createdAt: '2026-08-05T09:12:00Z', canPromote: false, promoteBlockedReason: null,
  waves: [], ...over,
});

const updates = (over: Partial<EdgeUpdates> = {}): EdgeUpdates => ({
  releases: [], activeRollout: null, fleet: [], journal: [],
  kpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
  ...over,
});

describe('Namen in der Wellen-Liste', () => {
  it('rendert NIE eine UUID', () => {
    // Reibung R2: nach einem Unclaim fiel die Zeile auf `id.toString()` zurück
    // und stand als nackte Kennung zwischen Klarnamen.
    const uuid = 'cdba2ee8-91f3-4c1a-9d3e-000000000001';
    const got = waveDeviceName(waveDev({
      deviceId: uuid, label: null, siteName: null, removed: true,
    }));
    expect(got.name).not.toContain('91f3');
    expect(got.name).toContain('Entferntes Gerät');
    expect(got.removed).toBe(true);
  });

  it('nimmt den Schnappschuss, wenn das Gerät weg ist - und sagt es', () => {
    const got = waveDeviceName(waveDev({ siteName: 'Pilsting', removed: true }));
    expect(got.name).toBe('Pilsting (entfernt)');
    expect(got.removed).toBe(true);
  });

  it('nennt ein lebendes Gerät schlicht beim Namen', () => {
    expect(waveDeviceName(waveDev())).toEqual({ name: 'Pilsting', removed: false });
  });
});

describe('„Sie sind dran"', () => {
  it('bündelt Welle-freigeben und Anwenden-am-Gerät mit Weg', () => {
    const items = handelnItems(updates({
      activeRollout: rolloutOf({
        canPromote: true,
        waves: [
          { index: 1, name: 'Canary', released: true, confirmed: true,
            devices: [waveDev({ bakeCycle: 'erfuellt', bakeRemainingMinutes: 0 })] },
          { index: 2, name: 'Flotte', released: false, confirmed: false, devices: [] },
        ],
      }),
      fleet: [row({ deviceId: 'x', siteName: 'Auernheim', state: 'wartet_auf_anwendung' })],
    }));
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe('wave');
    expect(items[0].title).toContain('Welle 2 „Flotte"');
    expect(items[0].detail).toContain('Steuerzyklus ✓');
    expect(items[1].kind).toBe('apply');
    expect(items[1].title).toContain('Auernheim');
    // Ohne den WEG ist „Sie sind dran" nur ein Vorwurf.
    expect(items[1].how).toContain('8484');
    expect(items[1].deviceId).toBe('x');
  });

  it('belegt die Freigabe NUR an bestätigten Geräten', () => {
    // Sonst stünde „Steuerzyklus offen" als Beleg unter dem Satz „das
    // Bake-Kriterium ist erfüllt" - ein sichtbarer Selbstwiderspruch.
    const items = handelnItems(updates({
      activeRollout: rolloutOf({
        canPromote: true,
        waves: [{
          index: 1, name: 'Canary', released: true, confirmed: false,
          devices: [
            waveDev({ deviceId: 'ok', siteName: 'Pilsting', state: 'bestaetigt',
              bakeCycle: 'erfuellt', bakeRemainingMinutes: 0 }),
            waveDev({ deviceId: 'offen', siteName: 'Mienbach', state: 'blockiert',
              bakeCycle: 'offen', bakeRemainingMinutes: 900 }),
          ],
        }],
      }),
    }));
    expect(items[0].detail).toContain('Pilsting');
    expect(items[0].detail).not.toContain('Mienbach');
    expect(items[0].detail).not.toContain('offen');
    expect(items[0].detail).toContain('Bake-Kriterium ist erfüllt');
  });

  it('fasst eine große Welle zusammen, statt zehn gleiche Halbsätze zu ketten', () => {
    const devices = Array.from({ length: 5 }, (_, i) => waveDev({
      deviceId: `d${i}`, siteName: `Anlage ${i}`, state: 'bestaetigt',
      bakeCycle: 'erfuellt', bakeRemainingMinutes: 0,
    }));
    const items = handelnItems(updates({
      activeRollout: rolloutOf({
        canPromote: true,
        waves: [{ index: 1, name: 'Canary', released: true, confirmed: true, devices }],
      }),
    }));
    expect(items[0].detail).toContain('und 3 weitere');
    expect(items[0].detail).toContain('Anlage 0');
    expect(items[0].detail).not.toContain('Anlage 4');
  });

  it('behauptet ohne einen einzigen Beleg nur den Server-Satz', () => {
    const items = handelnItems(updates({
      activeRollout: rolloutOf({
        canPromote: true,
        waves: [{
          index: 1, name: 'Canary', released: true, confirmed: true,
          // Bestätigt, aber ohne Bake-Urteil (Welle war nie freigegeben).
          devices: [waveDev({ state: 'bestaetigt', bakeCycle: null })],
        }],
      }),
    }));
    expect(items[0].detail).toBe('Das Bake-Kriterium der laufenden Welle ist erfüllt.');
  });

  it('ist LEER, solange nichts ansteht - nie ein Dauerbanner', () => {
    expect(handelnItems(updates())).toEqual([]);
    expect(handelnItems(updates({
      activeRollout: rolloutOf({ canPromote: false }),
      fleet: [row({ state: 'ausstehend' }), row({ deviceId: 'z', state: 'bestaetigt' })],
    }))).toEqual([]);
    expect(handelnItems(null)).toEqual([]);
  });

  it('zählt eine blockierte Box NICHT als wartende Handlung', () => {
    // Dort wartet niemand auf den Admin: die Box DARF gar nicht anwenden.
    expect(handelnItems(updates({
      fleet: [row({ state: 'blockiert', blocker: 'neutralzeit' })],
    }))).toEqual([]);
  });
});

describe('Fortschritts-Rückgrat', () => {
  const board = (states: string[]) => updates({
    activeRollout: rolloutOf({
      waves: [{
        index: 1, name: 'Canary', released: true, confirmed: false,
        devices: states.map((_, i) => waveDev({ deviceId: `d${i}` })),
      }],
    }),
    fleet: states.map((s, i) => row({ deviceId: `d${i}`, state: s })),
  });

  it('zählt je Klasse und hält offline AUS dem Nenner', () => {
    const view = progressBackbone(board([
      'bestaetigt', 'bestaetigt', 'wendet_an', 'wartet_auf_anwendung', 'blockiert',
      'offline_holt_nach',
    ]))!;
    // Fünf erreichbare Geräte - das offline-Gerät steht daneben, nie im Nenner.
    expect(view.total).toBe(5);
    expect(view.segments.find((s) => s.cls === 'calm')?.count).toBe(2);
    expect(view.segments.find((s) => s.cls === 'busy')?.count).toBe(1);
    expect(view.segments.find((s) => s.cls === 'action')?.count).toBe(1);
    expect(view.segments.find((s) => s.cls === 'blocked')?.count).toBe(1);
    expect(view.asideNote).toContain('1 offline');
    expect(view.asideNote).toContain('zählt nicht in die Quote');
  });

  it('nennt Geräte ohne Meldung getrennt, statt sie als Rückstand zu zählen', () => {
    const view = progressBackbone(board(['bestaetigt', 'unbekannt']))!;
    expect(view.total).toBe(1);
    expect(view.asideNote).toContain('1 ohne Meldung');
  });

  it('folgt der LIVE-Wahrheit, nicht dem eingefrorenen Zustand der Zeile', () => {
    const view = progressBackbone(updates({
      activeRollout: rolloutOf({
        state: 'halted',
        waves: [{
          index: 1, name: 'Canary', released: true, confirmed: false,
          devices: [waveDev({ deviceId: 'd1', state: 'fehlgeschlagen' })],
        }],
      }),
      fleet: [row({ deviceId: 'd1', state: 'bestaetigt' })],
    }))!;
    expect(view.segments.find((s) => s.cls === 'calm')?.count).toBe(1);
    expect(view.segments.find((s) => s.cls === 'incident')).toBeUndefined();
  });

  it('gibt es ohne Rollout gar nicht', () => {
    expect(progressBackbone(updates())).toBeNull();
  });
});

describe('Abschlussbild', () => {
  it('rahmt einen eingefrorenen Rollout und ordnet die Geschichte unter', () => {
    const framing = frozenFraming(rolloutOf({ state: 'halted' }))!;
    expect(framing.frozen).toBe(true);
    expect(framing.headline).toContain('eingefroren');
    expect(framing.note).toContain('HEUTIGEN');
  });

  it('lässt einen laufenden Rollout ungerahmt', () => {
    expect(frozenFraming(rolloutOf({ state: 'active' }))).toBeNull();
    expect(frozenFraming(null)).toBeNull();
  });

  it('führt mit LIVE und macht die Historie zur Fußnote - aber nur bei Abweichung', () => {
    const dev = waveDev({ deviceId: 'd1', state: 'fehlgeschlagen' });
    const differs = waveRowView(dev, [row({ deviceId: 'd1', state: 'bestaetigt' })], true);
    expect(differs.state).toBe('bestaetigt');
    expect(differs.historyNote).toContain('fehlgeschlagen');

    // Eine Fußnote, die dasselbe wiederholt, ist Rauschen.
    const same = waveRowView(dev, [row({ deviceId: 'd1', state: 'fehlgeschlagen' })], true);
    expect(same.historyNote).toBeNull();

    // Und in einem LAUFENDEN Rollout gibt es keine Geschichte zu erzählen.
    expect(waveRowView(dev, [row({ deviceId: 'd1', state: 'bestaetigt' })], false).historyNote)
      .toBeNull();
  });

  it('behält die eingefrorene Zeile, wenn das Gerät nicht mehr in der Flotte steht', () => {
    const view = waveRowView(waveDev({ deviceId: 'weg', state: 'bestaetigt' }), [], true);
    expect(view.state).toBe('bestaetigt');
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
    expect(line).toContain('Kein Rollout aktiv');
  });

  it('behauptet ohne Register keinen Maßstab', () => {
    const line = restingLine(updates({
      kpi: { known: 2, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
    }))!;
    expect(line).toContain('Kein Release im Register');
  });

  it('schweigt, solange ein Rollout läuft', () => {
    expect(restingLine(updates({ activeRollout: rolloutOf() }))).toBeNull();
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

describe('Puls-Signal „Sie sind dran"', () => {
  it('nennt wartende Handlungen auf der Landing-Seite', () => {
    expect(kpiText({ known: 5, upToDate: 4, unknown: 0, inRollout: 2, failed: 0,
      waitingForAdmin: 1, newestRelease: 'edge-2026.08.1' }))
      .toContain('1 Aktion wartet auf Sie');
    expect(kpiTone({ known: 5, upToDate: 4, unknown: 0, inRollout: 0, failed: 0,
      waitingForAdmin: 1, newestRelease: null })).toBe('busy');
  });

  it('behauptet ohne das Feld (älteres Backend) nichts', () => {
    const text = kpiText({ known: 5, upToDate: 5, unknown: 0, inRollout: 0, failed: 0,
      newestRelease: 'edge-2026.08.1' });
    expect(text).not.toContain('wartet auf Sie');
    expect(text).toBe('5/5 aktuell');
  });
});
