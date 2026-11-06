import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  blockerLever,
  boxArtLabel,
  canRollOut,
  crossoverHint,
  crossoverState,
  eventLabel,
  freshnessLabel,
  isLoud,
  kpiText,
  kpiTone,
  kpiUnknownNote,
  loudBanner,
  releaseBoxArt,
  releaseSperre,
  signatureLabel,
  sortFleet,
  stateLabel,
  trustSetSpread,
  stufe1,
  vertrauenGekreuzt,
  visibleJournal,
  zuweisbareReleases,
  geraetZeile,
  loaderLabel,
  type DeviceTrust,
  type EdgeUpdatesRelease,
  type FleetRow,
  type JournalEntry,
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
      'zurueckgestellt', 'unbekannt', 'zurueckgezogen',
    ]) {
      expect(stateLabel(s).label).not.toBe('unbekannt: ' + s);
    }
    // Geräte & Updates G2: eine zurückgezogene Anfrage ist ruhig und hält nichts offen.
    expect(stateLabel('zurueckgezogen')).toEqual({ label: 'zurückgezogen', tone: 'off', cls: 'calm' });
    expect(isLoud('zurueckgezogen')).toBe(false);
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
    expect(blockerLever('platte')).toContain('Platz');
    expect(blockerLever('kette')).toContain('Signaturkette');
  });

  it('schickt bei einer anderen Box-Art zum passenden Release, nicht zur Signatur', () => {
    // Die Sperre `backend` meldet eine Box, die ein gültig signiertes Release
    // einer anderen Box-Art bekommen hat (Edge Light auf der Docker-Box oder
    // umgekehrt). Das ist kein Vorfall: der Hebel ist ein Release der eigenen
    // Box-Art - nicht die Signaturkette und nicht der Anti-Rollback-Boden.
    const lever = blockerLever('backend')!;
    expect(lever).toContain('Box-Art');
    expect(lever).toContain('Edge Light');
    expect(lever).not.toContain('Signatur');
    expect(blockerLever('politik')).not.toContain('Box-Art');
  });

  it('schickt zu einem ENTFALLENEN Tor nicht auf den alten Handgriff', () => {
    // Eine Box mit älterem Image meldet die Wörter noch - der Hebel darf aber
    // nicht auf einen Weg zeigen, den es nicht mehr gibt (Prüfstand-Nachweis,
    // Freigabe am Gerät). Er sagt stattdessen, dass genau dieses Update ihn
    // wegräumt.
    for (const legacy of ['neutralzeit', 'neutralzeit_zu_kurz', 'interlock',
      'kern_still', 'freigabe_release']) {
      const lever = blockerLever(legacy)!;
      expect(lever).toContain('gibt es nicht mehr');
      expect(lever).not.toContain('VP_OTA_NEUTRAL_VERIFIED');
    }
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
    // Je Linie (S0): aktuell heißt auf dem neuesten Release der EIGENEN Linie.
    expect(kpiText({ ...kpi, inRollout: 0, failed: 0 }, [
      { boxArt: 'docker', newestRelease: 'edge-2026.10.7', newestReleaseSeq: 58, devices: 3, known: 3, upToDate: 3 },
      { boxArt: 'light', newestRelease: 'edge-light-2026.11.4', newestReleaseSeq: 60, devices: 3, known: 2, upToDate: 1 },
    ])).toBe('4/5 aktuell');
  });

  it('tönt rot vor gelb vor ruhig', () => {
    expect(kpiTone({ ...kpi, failed: 1 })).toBe('warn');
    expect(kpiTone(kpi)).toBe('busy');
    expect(kpiTone({ ...kpi, inRollout: 0 })).toBe('ok');
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

// ── Beobachten: Frische ────────────────────────────────────────────────────

describe('Bezugszeit', () => {
  it('nennt die Bezugszeit in Worten', () => {
    const t = 1_000_000_000_000;
    expect(freshnessLabel(t, t + 2_000)).toBe('Stand: gerade eben');
    expect(freshnessLabel(t, t + 12_000)).toContain('12');
    expect(freshnessLabel(t, t + 120_000)).toContain('2');
    // Eine Zukunft rechnet nie negativ.
    expect(freshnessLabel(t, t - 5_000)).toBe('Stand: gerade eben');
  });

  it('nennt eine fehlgeschlagene Aktualisierung statt eines wachsenden Alters (§5.2)', () => {
    const t = new Date('2026-11-06T14:02:00Z').getTime();
    expect(freshnessLabel(t, t + 120_000, true)).toContain('Aktualisierung schlägt fehl');
    expect(freshnessLabel(t, t + 120_000, true)).toContain('Stand');
    // Die Uhrzeit ist absolut (die Bezugszeit des letzten Erfolgs), nie ein Alter.
    expect(freshnessLabel(t, t + 120_000, true)).not.toMatch(/vor \d/);
  });
});

describe('Box-Art: Docker-Box und Edge Light (Edge Light Stufe 2, A3)', () => {
  const pilotTrust: DeviceTrust = {
    rootKeyIds: ['root-2026-a'], trustSetKeyIds: [], trustSetGeneratedAt: null,
    trustSetError: 'Das Vertrauens-Set oder seine Signatur fehlt.',
  };
  /** Nachgerüstet: Wurzel UND geprüftes Vertrauens-Set (Stufe 2). */
  const stufe2Trust: DeviceTrust = {
    rootKeyIds: ['root-2026-a'], trustSetKeyIds: ['rel-2026-a'],
    trustSetGeneratedAt: '2026-11-04T10:00:00Z', trustSetError: null,
  };
  const rel = (over: Partial<EdgeUpdatesRelease>): EdgeUpdatesRelease => ({
    releaseSeq: 40, version: 'edge-2026.10.0', targetCommit: null, notes: null, signed: true,
    signingKeyId: 'rel-2026-a', createdAt: '2026-10-01T08:00:00Z', runningOnDevices: 0, ...over,
  });

  it('übersetzt die Box-Art und lässt Unbekanntes unbekannt', () => {
    expect(boxArtLabel('docker').label).toBe('Docker-Box');
    expect(boxArtLabel('light').label).toBe('Edge Light');
    expect(boxArtLabel(null).label).toBe('Box-Art unbekannt');
    expect(boxArtLabel(undefined).art).toBeNull();
    // Ein Wort, das dieser Portal-Stand nicht kennt, wird NICHT zur Docker-Box.
    expect(boxArtLabel('ostree').label).toBe('Box-Art unbekannt');
  });

  it('nimmt ein Release ohne Kennzeichnung als Docker-Release (wie die API)', () => {
    expect(releaseBoxArt(rel({}))).toBe('docker');
    expect(releaseBoxArt(rel({ boxArt: 'light' }))).toBe('light');
  });

  it('sperrt mit denselben Sätzen wie BoxArt.sperrgrund in der API', () => {
    // Wortgleich mit BoxArtTest.assignmentRule - die beiden laufen nicht auseinander.
    expect(releaseSperre(rel({}), 'light', stufe2Trust)).toBe(
      'Release für die Docker-Box – diese Box ist eine Edge Light.');
    expect(releaseSperre(rel({ boxArt: 'light' }), 'docker', stufe2Trust))
      .toBe('Release für Edge Light – diese Box ist eine Docker-Box.');
    expect(releaseSperre(rel({ boxArt: 'light' }), null, stufe2Trust)).toBe(
      'Release für Edge Light – die Box-Art dieses Geräts ist unbekannt. Ein '
      + 'Edge-Light-Release geht nur an eine Box, die sich als Edge Light gemeldet hat.');
    expect(releaseSperre(rel({}), 'docker', stufe2Trust)).toBeNull();
    expect(releaseSperre(rel({}), null, null)).toBeNull();
    expect(releaseSperre(rel({ boxArt: 'light' }), 'light', stufe2Trust)).toBeNull();
  });

  it('sperrt ein Edge-Light-Release für eine Box mit Stufe 1 (S0, wie BoxArtTest.stufe1Sperre)', () => {
    const satz = 'Release für Edge Light – diese Box hat Stufe 1 und nimmt keine Updates aus dem '
      + 'Portal an (kein geprüftes Vertrauens-Set). Einmal über den Wartungstunnel nachrüsten, '
      + 'danach kommt jede Fassung über das Portal.';
    expect(releaseSperre(rel({ boxArt: 'light' }), 'light', pilotTrust)).toBe(satz);
    expect(releaseSperre(rel({ boxArt: 'light' }), 'light', null)).toBe(satz);
    // Die Docker-Box hat ihren eigenen Crossover; Stufe 1 ist eine Edge-Light-Regel.
    expect(releaseSperre(rel({}), 'docker', pilotTrust)).toBeNull();
    expect(vertrauenGekreuzt(stufe2Trust)).toBe(true);
    expect(vertrauenGekreuzt(pilotTrust)).toBe(false);
    expect(vertrauenGekreuzt(undefined)).toBe(false);
  });

  it('zeigt Edge Light ohne Vertrauens-Set RUHIG als „Updates von Hand", nie als Fehler', () => {
    const got = crossoverState(pilotTrust, 'light');
    expect(got.state).toBe('von_hand');
    expect(got.tone).toBe('off');
    expect(got.label).toBe('Updates von Hand (Edge Light, Stufe 1)');
    expect(got.detail).toContain('Wartungstunnel');
    // Auch ganz ohne Vertrauens-Block: die Bauart sagt genug.
    expect(crossoverState(null, 'light').state).toBe('von_hand');
    // Die Docker-Box behält ihre laute Regel.
    expect(crossoverState(pilotTrust, 'docker').state).toBe('fehler');
    expect(crossoverState(pilotTrust).state).toBe('fehler');
    // Mit Stufe 2 (geprüftes Set) gilt dieselbe Regel wie für Docker.
    expect(crossoverState({ ...pilotTrust, trustSetKeyIds: ['rel-2026-a'] }, 'light').state)
      .toBe('gekreuzt');
  });

  it('zählt Edge Light im Hinweis getrennt und nicht als Fehler', () => {
    const hint = crossoverHint([
      row({ deviceId: '1', trust: pilotTrust, boxArt: 'light' }),
      row({ deviceId: '2', trust: pilotTrust, boxArt: 'docker' }),
    ]);
    expect(hint).toContain('1 Gerät hat kein gültiges Vertrauens-Set');
    expect(hint).toContain('1 Edge-Light-Box bekommt Updates von Hand (Stufe 1)');
  });

  it('bietet je Gerät nur passende Releases an und nennt den Rest', () => {
    const docker = rel({});
    const light = rel({ releaseSeq: 41, version: 'edge-2026.10.1', boxArt: 'light' });
    const unsigned = rel({ releaseSeq: 39, signed: false });

    const mango = zuweisbareReleases([docker, unsigned], 'light', stufe2Trust);
    expect(mango.passend).toEqual([]);
    expect(mango.signiert).toBe(1);
    expect(mango.hinweis).toBe('Das signierte Release passt nicht zu dieser Box. '
      + 'Release für die Docker-Box – diese Box ist eine Edge Light.');

    const box = zuweisbareReleases([light, docker], 'docker', null);
    expect(box.passend.map((r) => r.releaseSeq)).toEqual([40]);
    expect(box.hinweis).toBe('1 weiteres signiertes Release ist hier nicht zuweisbar: '
      + 'Release für Edge Light – diese Box ist eine Docker-Box.');

    expect(zuweisbareReleases([docker], null, null).hinweis).toBeNull();
    expect(zuweisbareReleases([light, docker], null, null).passend.map((r) => r.releaseSeq))
      .toEqual([40]);

    // Nachgerüstet bekommt die Mango ihr Edge-Light-Release angeboten.
    expect(zuweisbareReleases([light, docker], 'light', stufe2Trust).passend
      .map((r) => r.releaseSeq)).toEqual([41]);
  });

  it('G8: ein Loader, der nur die Flash-Fassung startet, ist Stufe 1 - auch mit gekreuztem Vertrauen (wie BoxArtTest.stufe1AmLoader)', () => {
    const light = rel({ releaseSeq: 41, version: 'edge-light-2026.11.4', boxArt: 'light' });
    expect(releaseSperre(light, 'light', stufe2Trust, 'flash')).toBe(
      'Release für Edge Light – diese Box hat Stufe 1: ihr Loader startet immer die Fassung aus dem '
      + 'Flash und kennt keine Updates. Einmal über den Wartungstunnel nachrüsten, danach kommt jede '
      + 'Fassung über das Portal.');
    expect(releaseSperre(light, 'light', stufe2Trust, 'update')).toBeNull();
    expect(releaseSperre(light, 'light', stufe2Trust), 'nicht gemeldet: das Vertrauen entscheidet').toBeNull();
    expect(releaseSperre(rel({}), 'docker', stufe2Trust, 'flash')).toBeNull();
    expect(stufe1('light', stufe2Trust, 'flash')).toBe(true);
    expect(stufe1('light', stufe2Trust, 'update')).toBe(false);
    expect(stufe1('light', pilotTrust, null)).toBe(true);
    expect(stufe1('docker', pilotTrust, 'flash')).toBe(false);
    const cross = crossoverState(stufe2Trust, 'light', 'flash');
    expect(cross.state).toBe('von_hand');
    expect(cross.detail).toContain('Loader');
    expect(crossoverState(stufe2Trust, 'light', 'update').state).toBe('gekreuzt');
    expect(zuweisbareReleases([light], 'light', stufe2Trust, 'flash').hinweis)
      .toContain('ihr Loader startet immer die Fassung aus dem Flash');
  });

  it('G8: nennt das Gerät, wie die Box es meldet - nie geraten', () => {
    expect(geraetZeile({ geraetModell: 'Raspberry Pi 4 Model B Rev 1.4', geraetArch: 'arm64' }))
      .toBe('Raspberry Pi 4 Model B Rev 1.4 · arm64');
    expect(geraetZeile({ geraetModell: null, geraetArch: 'amd64' })).toBe('amd64');
    expect(geraetZeile({})).toBe('Gerät nicht gemeldet');
    expect(loaderLabel('update')).toBe('kennt Updates (Stufe 2)');
    expect(loaderLabel('flash')).toBe('startet nur die Fassung aus dem Flash (Stufe 1)');
    expect(loaderLabel(null)).toBeNull();
    expect(loaderLabel('uboot')).toBeNull();
  });

  it('nennt bei einer Box mit Stufe 1 den Weg zum Nachrüsten, auch neben anderen Gründen', () => {
    const docker = rel({ releaseSeq: 42, version: 'edge-2026.11.0' });
    const light = rel({ releaseSeq: 41, version: 'edge-light-2026.11.4', boxArt: 'light' });
    // Das jüngere Docker-Release steht vorn - der Satz zur Stufe 1 gewinnt trotzdem.
    const zuhause = zuweisbareReleases([docker, light], 'light', pilotTrust);
    expect(zuhause.passend).toEqual([]);
    expect(zuhause.hinweis).toBe('Keines der 2 signierten Releases passt zu dieser Box. '
      + 'Release für Edge Light – diese Box hat Stufe 1 und nimmt keine Updates aus dem Portal '
      + 'an (kein geprüftes Vertrauens-Set). Einmal über den Wartungstunnel nachrüsten, danach '
      + 'kommt jede Fassung über das Portal.');
  });

});
