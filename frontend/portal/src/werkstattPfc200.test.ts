import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRUEFUNGEN_PFC200 } from './werkstatt';
import {
  bildschirm,
  fortschritt,
  liesFreigabenPfc200,
  phasen,
  phasenFuer,
  schritteFuer,
  type LaufStand,
  type WerkstattAnsicht,
  type WerkstattDienst,
  type WerkstattLauf,
} from './werkstattBank';
import { fallSeite, jetzt, meistDauer, schrittListe, schrittTitel, softwareKarte, WAS } from './werkstattLauf';
import {
  FALL_BILDER_PFC200,
  FALL_CODES_PFC200,
  HANDGRIFF_FESTE_ADRESSE,
  HANDGRIFF_WERKSRESET,
  liesRegelPfc200,
  PFC_BILD,
  pfc200Zeile,
  PHASEN_PFC200,
  SCHRITT_TEXT_PFC200,
  SCHRITTE_PFC200,
  WAS_PFC200,
  WERKSRESET_FAELLE,
} from './werkstattPfc200';

const contracts = resolve(__dirname, '../../../docs/contracts');
/** Die Ansicht in jedem Zustand eines Laufs am PFC200, erzeugt aus dem Dienst selbst (TestAnsichtZustaendePFC200). */
const zustaende: Record<string, WerkstattAnsicht> = JSON.parse(readFileSync(resolve(contracts, 'werkstatt-ansicht-v1.zustaende-pfc200.json'), 'utf8'));
const vertrag = readFileSync(resolve(contracts, 'werkstatt-ansicht-v1.md'), 'utf8');
const T = Date.parse('2026-11-04T10:30:00Z');

const lauf = (name: string) => zustaende[name].lauf as LaufStand;
const dienst = (name: string, laeufe: WerkstattLauf[] = []): WerkstattDienst => ({
  ansicht: zustaende[name], gemeldetAm: '2026-11-04T10:29:00Z', dienstZeit: zustaende[name].zeit, alterSekunden: 3, aktuell: true, laeufe,
});

describe('PFC200: Phasen und Schritte', () => {
  it('die Schritte sind die des echten Laufs, in seiner Reihenfolge (Vektor aus dem Dienst)', () => {
    // Der fertige Lauf nennt jeden Schritt, den er gegangen ist: mit der Portal-API einloesen statt tunnel_adresse.
    const erledigt = lauf('fertig').erledigt;
    expect(SCHRITTE_PFC200.filter((s) => s !== 'tunnel_adresse')).toEqual(erledigt);
    for (const s of erledigt) expect(zustaende[`laeuft_${s}`], `Zustand laeuft_${s}`).toBeDefined();
    expect(schritteFuer('pfc200')).toBe(SCHRITTE_PFC200);
    expect(schritteFuer('mango')).not.toContain('zugaenge');
  });

  it('der Vertrag nennt dieselben Schritte', () => {
    const zeile = vertrag.split('\n').find((z) => z.startsWith('| `lauf.box_art`'))!;
    const genannt = [...zeile.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((s) => SCHRITTE_PFC200.includes(s) || s === 'tunnel_adresse');
    expect(new Set(genannt)).toEqual(new Set(SCHRITTE_PFC200));
  });

  it('jeder Schritt hat Titel und Satz; keine Phase und kein Schritt für SPS oder Firmware', () => {
    for (const s of SCHRITTE_PFC200) {
      expect(SCHRITT_TEXT_PFC200[s]?.titel, s).toBeTruthy();
      expect(SCHRITT_TEXT_PFC200[s]?.tut, s).toBeTruthy();
    }
    expect(PHASEN_PFC200.map((p) => p.titel)).toEqual(['Erkannt', 'Absichern', 'Software', 'Bei VoltPilot anmelden', 'Netze trennen und Probe', 'Abnahme']);
    const worte = [...PHASEN_PFC200.map((p) => `${p.id} ${p.titel}`), ...SCHRITTE_PFC200].join(' ').toLowerCase();
    expect(worte).not.toMatch(/sps|koppel|firmware|steuerung/);
    expect(schrittTitel('programm', 'pfc200')).toBe('Edge Industrie einspielen');
    expect(schrittTitel('programm', 'mango')).toBe('Edge Light einspielen');
    expect(schrittTitel('programm')).toBe('Edge Light einspielen');
  });

  it('die Phasen folgen dem Lauf: in jedem Zustand genau eine laufende, davor erledigt, danach offen', () => {
    for (const s of lauf('fertig').erledigt) {
      const ph = phasen(lauf(`laeuft_${s}`));
      const i = ph.findIndex((p) => p.zustand === 'lauf');
      expect(i, s).toBeGreaterThanOrEqual(0);
      expect(ph.slice(0, i).every((p) => p.zustand === 'ok'), s).toBe(true);
      expect(ph.slice(i + 1).every((p) => p.zustand === 'offen'), s).toBe(true);
      expect(phasenFuer('pfc200')[i].schritte, s).toContain(s);
    }
    expect(phasen(lauf('fertig')).every((p) => p.zustand === 'ok')).toBe(true);
    expect(phasen(lauf('angehalten_beim_neustart')).find((p) => p.zustand === 'warn')?.id).toBe('probe');
  });

  it('nennt keine erfundene Dauer: Restzeit und „meist“ erst mit gemessenen Läufen an einem PFC200', () => {
    const l = lauf('laeuft_netze');
    expect(meistDauer([], 'pfc200')).toEqual({});
    const ohne = fortschritt(l, meistDauer([], 'pfc200'));
    expect(ohne.restMinuten).toBeNull();
    expect(ohne.anteil).toBeCloseTo(10 / 15, 5);
    expect(jetzt(l, {}, T)!.meistSek).toBeNull();
    expect(jetzt(l, {}, T)).toMatchObject({ nummer: 11, von: 15, titel: 'Netze trennen, Firewall einschalten', danach: 'Neustart-Probe' });
    const offen = schrittListe(l, {}, T).flatMap((p) => p.schritte).filter((s) => s.zustand === 'offen');
    expect(offen.length).toBeGreaterThan(0);
    expect(offen.every((s) => s.dauer === null)).toBe(true);
    expect(schrittListe(l, {}, T).filter((p) => p.zustand === 'offen').every((p) => p.rechts === '')).toBe(true);

    // Ein früherer Lauf am PFC200 hat jeden Schritt gemessen; einer an der Mango zählt nicht mit.
    const gemessen = (boxArt: string, sek: number): WerkstattLauf => ({
      kennung: `k-${boxArt}`, freigabe: null, boxArt, zustand: 'fertig', schritt: null, titel: null, grund: null, beginn: '', ende: null, aktualisiertAm: '',
      stand: { ...lauf('fertig'), box_art: boxArt, belege: lauf('fertig').erledigt.map((s) => ({ schritt: s, dauer_s: sek, zeile: 'belegt' })) },
    });
    const meist = meistDauer([gemessen('pfc200', 60), gemessen('mango', 600)], 'pfc200');
    expect(meist.neustart).toBe(60);
    expect(fortschritt(l, meist).restMinuten).toBe(5);
    expect(jetzt(l, meist, T)!.meistSek).toBe(60);
    // Für die Mango bleibt die feste Schätzung, und die Messung am PFC200 ändert sie nicht.
    expect(meistDauer([gemessen('pfc200', 60)]).neustart).toBe(180);
  });

  it('die Abnahme hat zehn Prüfungen', () => {
    expect(PRUEFUNGEN_PFC200).toHaveLength(10);
    expect(SCHRITT_TEXT_PFC200.uebergabe.titel).toBe('Abnahme: zehn Prüfungen mit Beleg');
  });
});

describe('PFC200: Fälle', () => {
  it('der Vertrag nennt genau diese eigenen Codes, und jeder hat seinen Satz', () => {
    const ab = vertrag.indexOf('**Fälle eines Laufs am PFC200**');
    const codes = [...vertrag.slice(ab).matchAll(/^\| `(pfc_[a-z0-9_]+)` \|/gm)].map((m) => m[1]);
    expect([...codes].sort()).toEqual([...FALL_CODES_PFC200].sort());
    for (const c of FALL_CODES_PFC200) expect(WAS_PFC200[c], c).toBeTruthy();
    // Gemeinsame Codes ohne eigenen Satz für den PFC200 nennen keine Mango. Diese hier kennt nur ein Lauf an der Mango.
    const nurMango = new Set(['gl_passwort', 'halb_eigene', 'ssh_zu', 'abbild_abgelehnt', 'falsches_geraet', 'schon_edge_light', 'openwrt_fassung']);
    for (const [code, satz] of Object.entries(WAS)) {
      if (!WAS_PFC200[code] && !nurMango.has(code)) expect(satz, code).not.toMatch(/Mango/);
    }
    for (const satz of Object.values(WAS_PFC200)) expect(satz).not.toMatch(/Mango/);
  });

  it('jeder Zustand des Vektors mit einem Fall bekommt seine Seite, mit den Worten des Dienstes', () => {
    for (const [name, a] of Object.entries(zustaende)) {
      const l = a.lauf;
      if (!l?.fall) continue;
      const s = fallSeite({ code: l.fall, loesung: l.loesung, wo: 'lauf', ansicht: a, lauf: l });
      expect(s.geraet, name).toBe('pfc200');
      expect(s.titel, name).toBe(l.loesung!.titel);
      expect(s.schritte, name).toEqual(l.loesung!.schritte);
      expect(s.was, name).not.toMatch(/Mango/);
      expect(s.was, name).not.toBe('Der Dienst hat hier angehalten.');
    }
  });

  it('den Werksreset zeigt nur pfc_passwort; ein fremdes Gerät bekommt ihn nie', () => {
    expect([...WERKSRESET_FAELLE]).toEqual(['pfc_passwort']);
    for (const [code, bilder] of Object.entries(FALL_BILDER_PFC200)) {
      expect(bilder.includes('pfc-werksreset'), code).toBe(code === 'pfc_passwort');
    }
    const halb = zustaende.angehalten_pfc_passwort;
    const s = fallSeite({ code: halb.lauf!.fall, loesung: halb.lauf!.loesung, wo: 'lauf', ansicht: halb, lauf: halb.lauf! });
    expect(s.bilder).toEqual(['pfc-werksreset', 'pfc-adresse']);
    expect(s.art).toBe('hand');
    expect(s.was).toContain('Nur darum nennt die Werkstatt hier den Werksreset');
    expect(s.nach).toContain('neue Referenz');
    expect(s.live.map((p) => p.text)).toEqual(['Warten auf den Werksreset', 'PFC200 startet neu, dann die feste Adresse', 'Neuer Lauf beginnt von selbst']);

    const fremd = zustaende.angehalten_passwort_fremd;
    const f = fallSeite({ code: fremd.lauf!.fall, loesung: fremd.lauf!.loesung, wo: 'lauf', ansicht: fremd, lauf: fremd.lauf! });
    expect(f.art).toBe('seite');
    expect(f.bilder).toEqual([]);
    expect(f.selbst).toBe(false);
    expect(f.was).toContain('Einen Werksreset nennt die Werkstatt dann nie');
    expect(f.schritte.join(' ')).toContain('Nicht zurücksetzen');
  });

  it('wartet der Lauf auf einen Handgriff, ist das eine Fall-Seite mit Bild, ohne „zur Seite legen“', () => {
    for (const [name, code, bild] of [
      ['wartet_schalter_run', 'pfc_schalter_stop', 'pfc-run'],
      ['wartet_schalter_run_nach_neustart', 'pfc_schalter_stop', 'pfc-run'],
      ['wartet_kabel_x2', 'pfc_kabel_x1', 'pfc-x2'],
    ] as const) {
      const s = bildschirm({ dienst: dienst(name), gewaehlt: true, geraet: 'pfc200', erledigt: new Set() });
      expect(s.art, name).toBe('fall');
      if (s.art !== 'fall') continue;
      expect(s.seite.code, name).toBe(code);
      expect(s.seite.bilder, name).toEqual([bild]);
      expect(s.seite.art, name).toBe('hand');
      expect(s.seite.selbst, name).toBe(true);
      expect(s.seite.knoepfe, name).toEqual([]);
      expect(s.seite.live[0].zustand, name).toBe('lauf');
    }
  });

  it('angehalten: zur Seite legen gibt es; „Nochmal versuchen“ nur, wo der Dienst es erlaubt', () => {
    const a = zustaende.angehalten_beim_neustart;
    const s = fallSeite({ code: a.lauf!.fall, loesung: a.lauf!.loesung, wo: 'lauf', ansicht: a, lauf: a.lauf! });
    expect(s.knoepfe.map((k) => k.art)).toContain('zur-seite');
    expect(s.knoepfe.some((k) => k.art === 'nochmal')).toBe(a.lauf!.nochmal_moeglich === true);
    // Kein Knopf der Mango: Ein OpenWrt-Abbild gibt es für den PFC200 nicht.
    for (const z of Object.values(zustaende)) {
      if (!z.lauf?.fall) continue;
      const x = fallSeite({ code: z.lauf.fall, loesung: z.lauf.loesung, wo: 'lauf', ansicht: z, lauf: z.lauf });
      expect(x.knoepfe.some((k) => k.art === 'abbild')).toBe(false);
    }
  });

  it('jedes Bild hat seine Teilschritte; feste Adresse und Werksreset je drei', () => {
    expect(HANDGRIFF_FESTE_ADRESSE.map((s) => s.bild.schalter)).toEqual(['stop', 'stop', 'run']);
    expect(HANDGRIFF_FESTE_ADRESSE[1].bild).toMatchObject({ rst: true, sys: 'orange' });
    expect(HANDGRIFF_FESTE_ADRESSE[1].text).toContain('länger als 8 Sekunden');
    expect(HANDGRIFF_WERKSRESET.map((s) => s.bild.schalter)).toEqual(['run', 'reset', 'run']);
    expect(HANDGRIFF_WERKSRESET[2].bild.sys).toBe('rotgruen');
    for (const b of Object.values(PFC_BILD)) expect(b.schritte.length).toBeGreaterThan(0);
  });
});

describe('PFC200: an der Werkbank', () => {
  it('antwortet niemand, bleibt der Bildschirm beim Anschließen (dort steht der Handgriff „feste Adresse“)', () => {
    const s = bildschirm({ dienst: dienst('ohne_antwort'), gewaehlt: true, geraet: 'pfc200', erledigt: new Set() });
    expect(s).toMatchObject({ art: 'anschliessen', geraet: 'pfc200', kabel: true, meldetSich: false, freigegeben: true });
    // Die Lösung des Dienstes nennt ihn auch, für beide Geräte.
    expect(zustaende.ohne_antwort.anschluss_loesung!.schritte.join(' ')).toContain('länger als 8 Sekunden');
  });

  it('ohne Freigabe für den PFC200 sagt der Bildschirm, dass und warum er keinen einrichtet', () => {
    const a = { ...zustaende.ohne_antwort, freigabe_pfc200: { laufend: false, boxen: 0, grund: 'Im Register liegt keine signierte Edge-Industrie-Fassung.' } };
    const s = bildschirm({ dienst: { ...dienst('ohne_antwort'), ansicht: a }, gewaehlt: true, geraet: 'pfc200', erledigt: new Set() });
    expect(s).toMatchObject({ art: 'anschliessen', freigegeben: false, grund: 'Im Register liegt keine signierte Edge-Industrie-Fassung.' });
    // Ein Dienst, der keine PFC200 einrichtet, meldet keine Freigabe dafür.
    const ohne = { ...zustaende.ohne_antwort, freigabe_pfc200: undefined };
    const t = bildschirm({ dienst: { ...dienst('ohne_antwort'), ansicht: ohne }, gewaehlt: true, geraet: 'pfc200', erledigt: new Set() });
    expect(t).toMatchObject({ art: 'anschliessen', freigegeben: false, grund: 'Der Werkstatt-Dienst richtet hier keine PFC200 ein.' });
    // Die Mango daneben hängt nicht daran.
    const m = bildschirm({ dienst: { ...dienst('ohne_antwort'), ansicht: ohne }, gewaehlt: true, geraet: 'mango', erledigt: new Set() });
    expect(m).toMatchObject({ art: 'anschliessen', geraet: 'mango', freigegeben: true });
  });

  it('startet er noch, sagt die Seite das mit seinen Worten; ein Lauf zeigt immer sein eigenes Gerät', () => {
    const s = bildschirm({ dienst: dienst('startet'), gewaehlt: true, geraet: 'mango', erledigt: new Set() });
    expect(s.art).toBe('fall');
    if (s.art === 'fall') {
      expect(s.seite).toMatchObject({ code: 'startet', geraet: 'pfc200', art: 'warten', titel: 'Der PFC200 startet noch.' });
      expect(s.seite.live.map((p) => p.text)).toContain('PFC200 nimmt die Anmeldung an');
    }
    const l = bildschirm({ dienst: dienst('laeuft_programm'), gewaehlt: true, geraet: 'mango', erledigt: new Set() });
    expect(l).toMatchObject({ art: 'laeuft' });
    if (l.art === 'laeuft') expect(l.lauf.box_art).toBe('pfc200');
  });

  it('die Karte „Kommt auf diese Box“: Edge Industrie, die Firmware nur gelesen, kein OpenWrt', () => {
    const sw = softwareKarte(zustaende.laeuft_netze, lauf('laeuft_netze'))!;
    expect(sw).toMatchObject({ geraet: 'pfc200', freigabe: '2026-11-pfc200-1', kurz: ['Edge Industrie 2026.11.0'] });
    expect(sw.pakete.map((p) => p.id)).toEqual(['edge-industrie']);
    expect(sw.pakete[0]).toMatchObject({ fassung: '2026.11.0', pruef: '✓ läuft', vorher: 'kein VoltPilot' });
    expect(sw.firmware).toBe('WAGO 750-8212 · Firmware 03.10.08(22)');
    expect(softwareKarte(zustaende.laeuft_programm, lauf('laeuft_programm'))!.pakete[0].pruef).toBe('wird eingespielt');
    expect(softwareKarte(zustaende.fertig, lauf('fertig'))!.pakete[0].pruef).toBe('✓ update-bereit');
    // In ein halb eingerichtetes Gerät kam der Dienst nicht hinein: kein Firmware-Stand, die alte Referenz gestrichen.
    const halb = softwareKarte(zustaende.angehalten_pfc_passwort, lauf('angehalten_pfc_passwort'))!;
    expect(halb.firmware).toBeNull();
    expect(halb.pakete[0]).toMatchObject({ ersetzt: true, pruef: 'noch nicht drauf' });
    // Ein Lauf bleibt bei der Freigabe, unter der er begann.
    const eigene = softwareKarte(zustaende.laeuft_netze, lauf('laeuft_netze'), [], [{
      id: 'p1', kennung: '2026-11-pfc200-1', boxArt: 'pfc200', gueltigAb: '', gueltigBis: '', obergrenze: 5, openwrt: null,
      edgeLight: { fassung: 'edge-industrie-2026.10.9', quelle: 'https://x/', programmSha256: 'a', skripteSha256: 'b', wartungSha256: 'c' },
      notiz: null, erteiltAm: '', erteiltVon: 'Regel', beendetAm: null, beendetVon: null, zustand: 'laufend', grund: null,
    }])!;
    expect(eigene.kurz).toEqual(['Edge Industrie 2026.10.9']);
    // Die Mango behält ihre Karte.
    expect(softwareKarte({ ...zustaende.ohne_antwort, anschluss_geraet: undefined }, null)!.pakete.map((p) => p.id)).toEqual(['openwrt', 'edge-light']);
  });
});

describe('PFC200: Stand der Werkstatt', () => {
  const laeuft = { zustand: 'laeuft', grund: null, neueste: 'edge-industrie-2026.11.0', openwrt: null, releaseSeq: 21, freigabe: '2026-11-pfc200-1', heute: 1, tagesgrenze: 40,
    edgeLight: { fassung: 'edge-industrie-2026.11.0', quelle: 'https://x/', programmSha256: 'a', skripteSha256: 'b', wartungSha256: 'c' } };

  it('eine Zeile: was sie aufspielt, oder worauf sie wartet', () => {
    expect(pfc200Zeile(liesRegelPfc200(laeuft)!)).toEqual({ ton: 'ok', text: 'PFC200: Edge Industrie 2026.11.0' });
    expect(pfc200Zeile(liesRegelPfc200({ ...laeuft, zustand: 'wartet', edgeLight: null, grund: 'Im Register liegt keine signierte Edge-Industrie-Fassung.' })!))
      .toEqual({ ton: 'warn', text: 'PFC200 wartet: Im Register liegt keine signierte Edge-Industrie-Fassung.' });
    expect(pfc200Zeile(liesRegelPfc200({ ...laeuft, zustand: 'angehalten' })!).text).toContain('angehalten');
  });

  it('eine API vor dem Gerät pfc200 antwortet mit dem Stand der Mango: Der gilt nicht als Stand des PFC200', () => {
    const mango = { ...laeuft, openwrt: { fassung: '25.12.5' }, edgeLight: { fassung: 'edge-light-2026.11.3' } };
    expect(liesRegelPfc200(mango)).toBeNull();
    expect(liesRegelPfc200({ ...laeuft, edgeLight: { fassung: 'edge-light-2026.11.3' } })).toBeNull();
    expect(liesRegelPfc200(null)).toBeNull();
    expect(liesFreigabenPfc200([{ boxArt: 'mango', openwrt: { fassung: '25.12.5' } }, { boxArt: 'pfc200', openwrt: null, kennung: 'p' }])).toHaveLength(1);
    expect(liesFreigabenPfc200(undefined)).toEqual([]);
  });
});
