import { describe, expect, it } from 'vitest';
import type { EdgeReleaseSeite, EdgeUpdates, EdgeUpdatesRelease, FleetRow, UpdateFakten } from './adminEdgeUpdates';
import {
  KEIN_FILTER, aufgaben, boxZeile, boxZeilen, filterBoxen, filterZahlen, gruppen, kurzeVersion, lage,
  linienKarten, plattformen, tracker, uhr, wann, type Satz,
} from './geraeteUpdates';

/** Die fünf Zustände des Konzept-Boards (05.11.2026), mit denselben Boxen. */
const NOW = new Date('2026-11-05T16:50:00+01:00');
const vor = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const STD = 3600_000;
/** Das geschützte Leerzeichen vor Einheiten („4 Std."), wie `format.fmtRelative` es setzt. */
const NB = String.fromCharCode(160);
const text = (s: Satz | null) => (s ?? []).map((t) => (typeof t === 'string' ? t : t.mono)).join('');

const R: Record<string, EdgeUpdatesRelease> = {
  d107: { releaseSeq: 58, version: 'edge-2026.10.7', boxArt: 'docker', signed: true, signingKeyId: 'rel-2026-a',
    createdAt: '2026-10-28T10:00:00Z', targetCommit: null, notes: null, runningOnDevices: 3 },
  d110: { releaseSeq: 61, version: 'edge-2026.11.0', boxArt: 'docker', signed: true, signingKeyId: 'rel-2026-a',
    createdAt: '2026-11-05T08:12:00Z', targetCommit: null, notes: null, runningOnDevices: 0 },
  l110: { releaseSeq: 56, version: 'edge-light-2026.11.0', boxArt: 'light', signed: true, signingKeyId: 'rel-2026-a',
    createdAt: '2026-11-01T10:00:00Z', targetCommit: null, notes: null, runningOnDevices: 1 },
  l114: { releaseSeq: 60, version: 'edge-light-2026.11.4', boxArt: 'light', signed: true, signingKeyId: 'rel-2026-a',
    createdAt: '2026-11-05T14:43:00Z', targetCommit: null, notes: null, runningOnDevices: 1 },
};

const fakten = (o: {
  release: EdgeUpdatesRelease; am?: string; angenommen?: string; angenommenAm?: string | null;
  angenommenGrund?: string | null; bestaetigt?: string; bestaetigtAm?: string | null; schritt?: string | null;
  grund?: string | null;
}): UpdateFakten => ({
  angefragt: { release: o.release.version, releaseSeq: o.release.releaseSeq, am: o.am ?? vor(90 * MIN), von: 'alex' },
  angenommen: { stand: o.angenommen ?? 'ja', am: o.angenommenAm ?? null, grund: o.angenommenGrund ?? null },
  bestaetigt: { stand: o.bestaetigt ?? 'offen', am: o.bestaetigtAm ?? null, schritt: o.schritt ?? null, grund: o.grund ?? null },
});

let n = 0;
function box(name: string, linie: 'docker' | 'light', o: Partial<FleetRow>): FleetRow {
  n += 1;
  return {
    deviceId: `d${n}-${name}`, label: `edge-${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 7)}`,
    externalRef: `edge-${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 7)}`,
    siteId: `s${n}`, siteName: name, tenantId: 't1', tenantName: 'Ahrenberg GmbH',
    ist: null, soll: null, sollSeq: null, state: 'aktuell', reason: null, since: null, reportedAt: vor(8_000),
    rolloutId: null, boxArt: linie, linie, lastSeenAt: vor(8_000), stand: 'aktuell', stufe1: false,
    istRelease: null, releasesDahinter: null, istSeit: null, fakten: null,
    trust: { rootKeyIds: ['root-2026-a'], trustSetKeyIds: ['rel-2026-a'], trustSetGeneratedAt: null, trustSetError: null },
    ...o,
  };
}
const aktuell = (rel: EdgeUpdatesRelease) => ({
  ist: `${rel.version}-c39b18d9c2a4`, istRelease: rel.version, releasesDahinter: 0, stand: 'aktuell',
});

function lightRuhig(): FleetRow[] {
  return [
    box('VoltPilotGATE', 'light', { ...aktuell(R.l114), fakten: fakten({ release: R.l114, bestaetigt: 'ja', bestaetigtAm: vor(48 * STD) }) }),
    box('Zuhause', 'light', { ...aktuell(R.l114) }),
    box('Pilot Dirolf', 'light', { ...aktuell(R.l114) }),
  ];
}
const daten = (fleet: FleetRow[], releases = Object.values(R)): EdgeUpdates => ({
  fleet, releases, rollouts: [], journal: [],
  kpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
});

describe('Alles gut', () => {
  const fleet = [
    box('Herzogau', 'docker', { ...aktuell(R.d107) }),
    box('Ahrenberg Werk 1', 'docker', { ...aktuell(R.d107) }),
    box('Ahrenberg Lager', 'docker', { ...aktuell(R.d107) }),
    ...lightRuhig(),
  ];
  const d = daten(fleet, [R.d107, R.l110, R.l114]);

  it('ein grüner Satz, zwei ruhige Linien, keine Liste „Braucht dich"', () => {
    expect(lage(d, NOW)).toEqual({
      ton: 'ok', icon: 'check', text: ['Alle 6 Boxen laufen auf dem neuesten Release ihrer Linie.'], link: null,
    });
    expect(aufgaben(d, NOW)).toEqual([]);
    const [docker, light] = linienKarten(d, NOW);
    expect(docker.neu?.release.version).toBe('edge-2026.10.7');
    expect(docker.aktion).toBe('aktuell');
    expect(docker.segmente).toEqual([{ art: 'ok', n: 3, wort: 'neuestes' }]);
    expect(docker.leiter).toEqual([
      { version: 'edge-2026.10.7', releaseSeq: 58, neuestes: true, wer: '3 Boxen', deviceIds: fleet.slice(0, 3).map((r) => r.deviceId) },
    ]);
    expect(docker.releases).toBe(1);
    expect(light.neu?.release.version).toBe('edge-light-2026.11.4');
    expect(light.releases).toBe(2);
  });

  it('eine bestätigte Anfrage zeigt ihre drei Schritte noch einen Tag, danach nur den Satz', () => {
    const gate = boxZeile(fleet[3], NOW);
    expect(gate.tracker).toBeNull();
    expect(text(gate.satz)).toBe('zuletzt bestätigt 03.11.');
    const frisch = boxZeile({ ...fleet[3], fakten: fakten({ release: R.l114, bestaetigt: 'ja', bestaetigtAm: vor(48 * MIN) }) }, NOW);
    expect(frisch.tracker?.map((t) => t.zustand)).toEqual(['fertig', 'fertig', 'fertig']);
    expect(text(frisch.satz)).toBe('bestätigt 16:02');
    expect(text(boxZeile(fleet[0], NOW).satz)).toBe('keine Anfrage');
    expect(text(boxZeile({ ...fleet[0], istSeit: '2026-10-28T11:00:00Z' }, NOW).satz)).toBe('läuft seit 28.10.');
  });

  it('die Docker-Box nennt ihre Geräte aus dem Bau, Edge Light seine Programme aus dem Portal', () => {
    expect(plattformen('docker', null)).toEqual([
      { text: 'PC · amd64', ton: 'normal' }, { text: 'Raspberry Pi · arm64', ton: 'normal' },
    ]);
    expect(plattformen('light', null)).toBeNull();
    const seite = { programme: [
      { arch: 'linux/mipsle', groesse: 10, empfangen: 10, fertig: true },
      { arch: 'linux/arm64', groesse: 10, empfangen: 4, fertig: false },
    ] } as EdgeReleaseSeite;
    expect(plattformen('light', seite)).toEqual([
      { text: 'Mango · mipsle ✓', ton: 'fertig' },
      { text: 'Raspberry Pi · arm64 · noch nicht im Portal', ton: 'fehlt' },
    ]);
    const karten = linienKarten(d, NOW, new Map([[60, seite]]));
    expect(karten[1].plattformen?.[0].text).toBe('Mango · mipsle ✓');
  });
});

describe('Update läuft', () => {
  const fleet = [
    box('Herzogau', 'docker', { ...aktuell(R.d110),
      fakten: fakten({ release: R.d110, angenommenAm: vor(80 * MIN), bestaetigt: 'ja', bestaetigtAm: vor(79 * MIN) }) }),
    box('Ahrenberg Werk 1', 'docker', { ist: 'edge-2026.10.7-c39b18d9c2a4', istRelease: 'edge-2026.10.7', releasesDahinter: 1,
      stand: 'laeuft', state: 'wendet_an',
      fakten: fakten({ release: R.d110, angenommenAm: vor(74 * MIN), bestaetigt: 'laeuft', schritt: 'wendet_an' }) }),
    box('Ahrenberg Lager', 'docker', { ist: 'edge-2026.10.7-c39b18d9c2a4', istRelease: 'edge-2026.10.7', releasesDahinter: 1,
      stand: 'laeuft', state: 'ausstehend', fakten: fakten({ release: R.d110, am: vor(74 * MIN), angenommen: 'offen' }) }),
    ...lightRuhig(),
  ];
  const d = daten(fleet);

  it('der Satz zählt angefragt und bestätigt getrennt; „Braucht dich" bleibt leer', () => {
    const l = lage(d, NOW);
    expect(l.ton).toBe('lauf');
    expect(text(l.text)).toBe('Ein Update läuft: edge-2026.11.0 an 3 Docker-Boxen · 1 bestätigt.');
    expect(l.link).toEqual({ label: 'Fortschritt', ziel: 'fortschritt' });
    expect(aufgaben(d, NOW)).toEqual([]);
    const [docker] = linienKarten(d, NOW);
    expect(docker.aktion).toBe('fortschritt');
    expect(docker.segmente).toEqual([{ art: 'ok', n: 1, wort: 'neuestes' }, { art: 'lauf', n: 2, wort: 'Update läuft' }]);
    expect(docker.leiter.map((s) => [s.version, s.wer, s.neuestes])).toEqual([
      ['edge-2026.11.0', 'Herzogau', true], ['edge-2026.10.7', '2 Boxen · Update läuft', false],
    ]);
  });

  it('jede Box sagt, wo sie steht: angefragt → angenommen → bestätigt', () => {
    const werk = boxZeile(fleet[1], NOW);
    expect(werk.tracker?.map((t) => t.zustand)).toEqual(['fertig', 'fertig', 'aktiv']);
    expect(text(werk.satz)).toBe('angenommen 15:36 · wendet an');
    expect(werk.urteil).toEqual({ ton: 'lauf', text: 'Update läuft' });
    const lager = boxZeile(fleet[2], NOW);
    expect(lager.tracker?.map((t) => t.zustand)).toEqual(['fertig', 'aktiv', 'leer']);
    expect(text(lager.satz)).toBe('angefragt 15:36 · Box hat noch nicht angenommen');
    expect(boxZeile(fleet[0], NOW).urteil).toEqual({ ton: 'ok', text: 'neuestes' });
  });
});

describe('Fehlgeschlagen', () => {
  const werk = box('Ahrenberg Werk 1', 'docker', {
    ist: 'edge-2026.10.7-c39b18d9c2a4', istRelease: 'edge-2026.10.7', releasesDahinter: 1, stand: 'fehler',
    state: 'zurueckgerollt',
    fakten: fakten({ release: R.d110, bestaetigt: 'zurueckgenommen', bestaetigtAm: vor(48 * MIN), grund: 'Node-RED startete nicht' }),
  });
  const fleet = [
    box('Herzogau', 'docker', { ...aktuell(R.d110) }), werk,
    box('Ahrenberg Lager', 'docker', { ...aktuell(R.d110) }), ...lightRuhig(),
  ];
  const d = daten(fleet);

  it('nennt Box, Grund und Folge in einem Satz - ohne Knopf „zurück"', () => {
    expect(text(lage(d, NOW).text)).toBe('1 Box braucht dich: Ahrenberg Werk 1 hat das Update zurückgenommen.');
    const [a] = aufgaben(d, NOW);
    expect(a.titel).toBe('Ahrenberg Werk 1: Update zurückgenommen');
    expect(text(a.text)).toBe('Die Box hat edge-2026.11.0 angenommen, der Selbsttest wurde nicht grün (Node-RED startete nicht).'
      + ' Sie läuft wieder auf edge-2026.10.7 und versucht es nicht von selbst noch einmal.');
    expect(a.knoepfe).toEqual(['box']);
    const z = boxZeile(werk, NOW);
    expect(z.tracker?.map((t) => [t.zustand, t.wort])).toEqual([
      ['fertig', 'angefragt'], ['fertig', 'angenommen'], ['fehler', 'zurückgenommen'],
    ]);
    expect(z.urteil).toEqual({ ton: 'fehler', text: 'zurückgenommen' });
    expect(text(z.satz)).toBe('zurückgenommen 16:02 · Node-RED startete nicht · läuft wieder 10.7');
    expect(z.brauchtDich).toBe(true);
  });

  it('die Linie kann wieder verteilen: die zurückgenommene Anfrage ist keine offene mehr', () => {
    const [docker] = linienKarten(d, NOW);
    expect(docker.segmente).toEqual([
      { art: 'ok', n: 2, wort: 'neuestes' }, { art: 'fehler', n: 1, wort: 'zurückgenommen' },
    ]);
    expect(docker.leiter[1].wer).toBe('Ahrenberg Werk 1 · zurückgenommen');
    expect(docker.verteilbar).toBe(1);
    expect(docker.aktion).toBe('verteilen');
  });
});

describe('Box offline', () => {
  const lager = box('Ahrenberg Lager', 'docker', {
    ist: 'edge-2026.10.7-c39b18d9c2a4', istRelease: 'edge-2026.10.7', releasesDahinter: 1, stand: 'offline',
    state: 'offline_holt_nach', lastSeenAt: vor(3 * STD + 38 * MIN),
    fakten: fakten({ release: R.d110, am: vor(3 * STD), angenommen: 'wartet' }),
  });
  const fleet = [box('Herzogau', 'docker', { ...aktuell(R.d110) }), lager, ...lightRuhig()];
  const d = daten(fleet);

  it('die Anfrage wartet; was eine stumme Box zuletzt gemeldet hat, ist nicht aktuell', () => {
    expect(text(lage(d, NOW).text)).toBe(`1 Box ist seit 4${NB}Std. offline. Ihr Update wartet.`);
    const [a] = aufgaben(d, NOW);
    expect(a.titel).toBe(`Ahrenberg Lager ist seit 4${NB}Std. offline`);
    expect(text(a.text)).toBe('Letzte Meldung 13:12. Angefragt ist edge-2026.11.0; die Box holt es, sobald sie sich '
      + 'wieder meldet. Für das Update ist nichts zu tun.');
    expect(a.knoepfe).toEqual(['fernwartung', 'box']);
    const z = boxZeile(lager, NOW);
    expect(z.verbindung).toEqual({ zustand: 'offline', text: 'Meldet sich nicht', gesehen: `seit 4${NB}Std. · zuletzt 13:12` });
    expect(z.urteil).toEqual({ ton: 'off', text: 'Stand von 13:12' });
    expect(z.tracker?.map((t) => [t.zustand, t.wort])).toEqual([
      ['fertig', 'angefragt'], ['warten', 'wartet'], ['leer', 'bestätigt'],
    ]);
    expect(text(z.satz)).toBe('angefragt 13:50 · wartet, bis die Box online ist');
    const [docker] = linienKarten(d, NOW);
    expect(docker.segmente[1]).toEqual({ art: 'off', n: 1, wort: 'offline · Update wartet' });
    // Schon angefragt: kein zweites Verteilen für diese Box.
    expect(docker.verteilbar).toBe(0);
    expect(docker.aktion).toBe('nichts');
  });
});

describe('Stufe 1 (Stand vom 05.11.)', () => {
  const zuhause = box('Zuhause', 'light', {
    ist: 'edge-light-2026.11.0-1a2b3c4d5e6f', istRelease: 'edge-light-2026.11.0', releasesDahinter: 1, stand: 'hand',
    stufe1: true, state: 'fehlgeschlagen',
    trust: { rootKeyIds: ['root-2026-a'], trustSetKeyIds: [], trustSetGeneratedAt: null, trustSetError: 'Vertrauens-Set fehlt' },
    fakten: fakten({ release: R.l114, angenommen: 'abgelehnt', angenommenGrund: 'Vertrauens-Set fehlt' }),
  });
  const dirolf = box('Pilot Dirolf', 'light', {
    ist: 'edge-light-g2ccd99197', istRelease: null, releasesDahinter: null, stand: 'hand', stufe1: true, loader: 'flash',
    geraetModell: 'GL.iNet GL-MT300N-V2', geraetArch: 'mipsle',
  });
  const gate = box('VoltPilotGATE', 'light', { ...aktuell(R.l114) });
  const fleet = [box('Herzogau', 'docker', { ...aktuell(R.d107) }), gate, zuhause, dirolf];
  const d = daten(fleet, [R.d107, R.l110, R.l114]);
  d.lines = [
    { boxArt: 'docker', newestRelease: 'edge-2026.10.7', newestReleaseSeq: 58, devices: 1, known: 1, upToDate: 1, releases: 48,
      versions: [{ version: 'edge-2026.10.7', releaseSeq: 58, devices: [fleet[0].deviceId] }] },
    { boxArt: 'light', newestRelease: 'edge-light-2026.11.4', newestReleaseSeq: 60, devices: 3, known: 3, upToDate: 1, releases: 5,
      versions: [
        { version: 'edge-light-2026.11.4', releaseSeq: 60, devices: [gate.deviceId] },
        { version: 'edge-light-2026.11.0', releaseSeq: 56, devices: [zuhause.deviceId] },
        { version: 'edge-light-g2ccd99197', releaseSeq: null, devices: [dirolf.deviceId] },
      ] },
  ];

  it('nur von Hand, mit eigenem Wort und dem Weg zum Nachrüsten - kein Fehler', () => {
    const l = lage(d, NOW);
    expect(l).toMatchObject({ ton: 'hand', icon: 'hand', link: { label: 'Ansehen', ziel: 'braucht' } });
    expect(text(l.text)).toBe('2 Edge-Light-Boxen nehmen keine Updates aus dem Portal an (Stufe 1).');
    const [a] = aufgaben(d, NOW);
    expect(a.titel).toBe('Pilot Dirolf und Zuhause: nur von Hand (Stufe 1)');
    expect(text(a.text)).toBe('Ihr Startprogramm oder ihr Vertrauens-Set lässt keine Updates aus dem Portal zu.'
      + ' Einmal nachrüsten (ca. 1 Min. Unterbrechung), danach kommt jede Fassung über das Portal.'
      + ' Die Anfrage 11.4 an Zuhause hat die Box abgelehnt: Vertrauens-Set fehlt.');
    expect(a.deviceIds).toEqual([dirolf.deviceId, zuhause.deviceId]);
    expect(a.knoepfe).toEqual(['nachruesten']);
  });

  it('die Linien-Karte: Leiter aus der API, „Nachrüsten" statt „Verteilen"', () => {
    const [docker, light] = linienKarten(d, NOW);
    expect(docker.releases).toBe(48);
    expect(light.segmente).toEqual([
      { art: 'ok', n: 1, wort: 'neuestes' }, { art: 'hand', n: 2, wort: 'nur von Hand (Stufe 1)' },
    ]);
    expect(light.leiter.map((s) => s.wer)).toEqual(['VoltPilotGATE', 'Zuhause · Stufe 1', 'Pilot Dirolf · Stufe 1']);
    expect(light.verteilbar).toBe(0);
    expect(light.aktion).toBe('nachruesten');
    expect(light.stufe1).toEqual([dirolf.deviceId, zuhause.deviceId]);
  });

  it('die Zeilen: Badge „nur von Hand", abgelehnt als zweiter Schritt, ein fremder Stand ist nie „älter"', () => {
    const z = boxZeile(zuhause, NOW);
    expect(z.updateBadge).toEqual({ ton: 'hand', text: 'nur von Hand · Stufe 1' });
    expect(z.tracker?.map((t) => [t.zustand, t.wort])).toEqual([
      ['fertig', 'angefragt'], ['fehler', 'abgelehnt'], ['leer', 'bestätigt'],
    ]);
    expect(text(z.satz)).toBe('Anfrage 11.4 abgelehnt: Vertrauens-Set fehlt');
    expect(z.urteil).toEqual({ ton: 'off', text: '1 Release älter' });
    const zd = boxZeile(dirolf, NOW);
    expect(zd.urteil).toEqual({ ton: 'off', text: 'nicht im Register' });
    expect(zd.aelter).toBe(false);
    expect(zd.geraet).toBe('GL.iNet GL-MT300N-V2 · mipsle');
    expect(text(zd.satz)).toBe('keine Anfrage');
  });

  it('Filter: Linie, Status, Suche - und Gruppen je Linie', () => {
    const zeilen = boxZeilen(d, NOW);
    expect(zeilen.slice(0, 2).map((z) => z.name)).toEqual(['Pilot Dirolf', 'Zuhause']);
    expect(filterZahlen(zeilen, 'alle')).toEqual({
      linien: [{ wert: 'alle', label: 'Alle', n: 4 }, { wert: 'docker', label: 'Docker-Box', n: 1 }, { wert: 'light', label: 'Edge Light', n: 3 }],
      status: [{ wert: 'braucht', label: 'Braucht dich', n: 2 }, { wert: 'aelter', label: 'Älter', n: 1 }, { wert: 'offline', label: 'Offline', n: 0 }],
    });
    expect(filterZahlen(zeilen, 'docker').status[0].n).toBe(0);
    expect(filterBoxen(zeilen, { ...KEIN_FILTER, status: 'braucht' }).map((z) => z.name)).toEqual(['Pilot Dirolf', 'Zuhause']);
    expect(filterBoxen(zeilen, { ...KEIN_FILTER, suche: 'mipsle' }).map((z) => z.name)).toEqual(['Pilot Dirolf']);
    expect(filterBoxen(zeilen, { ...KEIN_FILTER, linie: 'docker' }).map((z) => z.name)).toEqual(['Herzogau']);
    expect(gruppen(zeilen).map((g) => [g.titel, g.zeilen.length])).toEqual([['Docker-Box', 1], ['Edge Light', 3]]);
  });
});

describe('Grenzen', () => {
  it('ohne Uhr vom Server ist die Verbindung unbekannt - nie „noch nie gemeldet"', () => {
    const r = box('Alt', 'docker', { lastSeenAt: undefined });
    expect(boxZeile(r, NOW).verbindung).toEqual({ zustand: 'unbekannt', text: 'Verbindung unbekannt', gesehen: null });
    expect(boxZeile({ ...r, lastSeenAt: null }, NOW).verbindung.zustand).toBe('nie');
  });

  it('ohne Linien-Stand (älterer Server) steht die Box „ohne Stand", nie als neuestes', () => {
    const r = box('Alt', 'docker', { stand: undefined, ist: 'edge-2026.10.7-c39b18d9c2a4' });
    const [docker] = linienKarten(daten([r], [R.d107]), NOW);
    expect(docker.segmente).toEqual([{ art: 'leer', n: 1, wort: 'ohne Stand' }]);
    expect(docker.aktion).toBe('nichts');
  });

  it('eine Box unbekannter Art steht in keiner Linie, aber in der Liste', () => {
    const r = box('Neubau', 'docker', { boxArt: null, linie: null, stand: 'unbekannt', lastSeenAt: null });
    const d = daten([r], [R.d107]);
    expect(linienKarten(d, NOW)[0].gesamt).toBe(0);
    const zeilen = boxZeilen(d, NOW);
    expect(gruppen(zeilen).map((g) => g.titel)).toEqual(['Box-Art unbekannt']);
    expect(filterZahlen(zeilen, 'alle').linien.at(-1)).toEqual({ wert: 'unbekannt', label: 'Box-Art unbekannt', n: 1 });
    expect(text(lage(d, NOW).text)).toBe('0 von 1 Box laufen auf dem neuesten Release ihrer Linie; die übrigen haben keinen bewertbaren Stand.');
  });

  it('eine leere Flotte und eine Linie ohne Release', () => {
    expect(text(lage(daten([]), NOW).text)).toBe('Noch keine Box registriert.');
    expect(linienKarten(daten([], []), NOW)).toEqual([]);
  });

  it('Zeiten: heute, gestern, dieses Jahr, früher', () => {
    expect(wann('2026-11-05T14:43:00Z', NOW)).toBe('heute, 15:43');
    expect(wann('2026-11-04T08:12:00Z', NOW)).toBe('gestern, 09:12');
    expect(wann('2026-10-28T10:00:00Z', NOW)).toBe('28.10.2026');
    expect(uhr('2026-11-04T08:12:00Z', NOW)).toBe('gestern 09:12');
    expect(uhr('2026-10-28T10:00:00Z', NOW)).toBe('28.10. 11:00');
    expect(uhr('2025-10-28T10:00:00Z', NOW)).toBe('28.10.2025');
    expect(kurzeVersion('edge-light-2026.11.4')).toBe('11.4');
    expect(kurzeVersion('edge-light-g2ccd99197')).toBe('edge-light-g2ccd99197');
  });

  it('die drei Schritte kennen jedes Wort der API, ein fremdes bleibt leer', () => {
    const f = fakten({ release: R.d110, angenommen: 'zurueckgestellt', bestaetigt: 'irgendwas' });
    expect(tracker(f).map((t) => [t.zustand, t.wort])).toEqual([
      ['fertig', 'angefragt'], ['warten', 'zurückgestellt'], ['leer', 'bestätigt'],
    ]);
    expect(tracker(fakten({ release: R.d110, bestaetigt: 'verstummt' }))[2]).toEqual(
      { schritt: 'bestaetigt', zustand: 'fehler', wort: 'verstummt' });
  });
});
