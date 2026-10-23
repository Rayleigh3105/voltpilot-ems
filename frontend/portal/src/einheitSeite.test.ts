import { describe, expect, it } from 'vitest';
import type { AnlagensteuerungVerlauf, ErzeugerVorgabe } from './api';
import {
  alarmZeilen,
  begrenzungSatz,
  blockImBild,
  einheitAblesung,
  einheitBezugKennung,
  einheitHeute,
  einheitSeite,
  energieHeute,
  energieText,
  vorgabenZeilen,
} from './einheitSeite';
import { einheitStand, findeEinheit } from './erzeugungseinheit';
import { werteJe } from './anlagensteuerung';
import { anlagensteuerungIdOf, einheitAdresseOf, einheitGeraetId } from './geraetAdresse';
import type { Meldung } from './meldungenApi';
import { geraetSeiteHash, parseRoute } from './nav';
import {
  buettner,
  buettnerNv,
  buettnerWerte,
  ENTITY_GORE,
  GERAET_BUETTNER,
  GERAET_GORE,
  gore,
  goreNv,
  goreWerte,
  JETZT,
  werte,
} from './test/anlagensteuerungFixtures';

const NOW = new Date(JETZT);
const plain = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');
const einheit = (n: number) => gore().einheiten.find((e) => e.te_nr === n)!;

describe('Adresse der Einheit (GE-3): as-<Entität>~te-<n>', () => {
  it('ohne „/“ und eindeutig: hin und zurück, und der Parser der Seite trägt sie unverändert', () => {
    const id = einheitGeraetId(ENTITY_GORE, 2);
    expect(id).toBe(`as-${ENTITY_GORE}~te-2`);
    expect(einheitAdresseOf(id)).toEqual({ entityId: ENTITY_GORE, teNr: 2 });
    expect(einheitAdresseOf(`as-${ENTITY_GORE}~te-10`)).toEqual({ entityId: ENTITY_GORE, teNr: 10 });
    // `~` bleibt in encodeURIComponent stehen — die Adresse liest sich wie geschrieben.
    const hash = geraetSeiteHash('site-gore', 'edge-5mz8bdd', id);
    expect(hash).toBe(`#/anlage/site-gore/geraet/edge-5mz8bdd/as-${ENTITY_GORE}~te-2`);
    expect(parseRoute(hash)).toMatchObject({ sub: 'geraet', geraet: { ref: 'edge-5mz8bdd', geraetId: id } });
    expect(parseRoute(`${hash}?ansicht=technik`)).toMatchObject({ geraet: { geraetId: id } });
  });

  it('die Steuerung bleibt `as-<Entität>` — eine Einheit ist keine Steuerung, und Fremdes ist keine Einheit', () => {
    expect(anlagensteuerungIdOf(`as-${ENTITY_GORE}`)).toBe(ENTITY_GORE);
    expect(anlagensteuerungIdOf(einheitGeraetId(ENTITY_GORE, 1))).toBeNull();
    for (const fremd of [`as-${ENTITY_GORE}`, `as-${ENTITY_GORE}~te-0`, `as-${ENTITY_GORE}~te-11`, 'src-as-x~te-1', 'inverter', null]) {
      expect(einheitAdresseOf(fremd)).toBeNull();
    }
  });

  it('findeEinheit: nur eine eingetragene Nummer an der Steuerung der Entität', () => {
    const liste = { einrichtung: { moeglich: true, grund: null, boxen: [] }, steuerungen: [gore(), buettner()] };
    expect(findeEinheit(liste, ENTITY_GORE, 3)?.einheit.te_nr).toBe(3);
    expect(findeEinheit(liste, ENTITY_GORE, 4)).toBeNull();
    expect(findeEinheit(liste, 'fremd', 1)).toBeNull();
    expect(findeEinheit(null, ENTITY_GORE, 1)).toBeNull();
  });
});

describe('einheitStand — Zustand je Einheit', () => {
  it('liest Ist und Zustand nur mit Gültigkeitsbit; die Bezeichnung ist der Name', () => {
    const w = goreWerte();
    const s1 = einheitStand(einheit(1), w, NOW);
    expect([s1.name, plain(s1.unter), s1.istW, s1.sollW, s1.zustandWort, s1.ton]).toEqual([
      'WR Dach Nord', 'Growatt MAX 125KTL3-X · 125 kW', 52800, 53000, 'läuft begrenzt', 'ok',
    ]);
    expect(plain(s1.zustandZeit)).toBe('vor 5 Sek.');
    const s3 = einheitStand(einheit(3), w, NOW);
    expect([s3.name, plain(s3.unter), s3.istW, s3.sollW, s3.zustand, s3.zustandWort, s3.ton]).toEqual([
      'Wechselrichter 3', '125 kW', null, 53000, null, 'Werte ungültig', 'warn',
    ]);
  });

  it('ohne Lesung „noch keine Daten“, ohne Antwort „unbekannt“, veraltet „meldet sich gerade nicht“', () => {
    expect(einheitStand(einheit(2), werte(GERAET_GORE, {}), NOW)).toMatchObject({ zustandWort: 'noch keine Daten', ton: 'off', istW: null });
    expect(einheitStand(einheit(2), null, NOW)).toMatchObject({ zustandWort: 'unbekannt', ton: 'off' });
    const spaeter = new Date(NOW.getTime() + 10 * 60_000);
    const s = einheitStand(einheit(2), goreWerte(), spaeter);
    expect([s.zustandWort, s.ton, plain(s.zustandZeit)]).toEqual(['meldet sich gerade nicht', 'warn', 'zuletzt vor 10 Min.']);
  });
});

describe('einheitSeite — Kopf, Jetzt, Gerät & Verbindung', () => {
  const seite = (n: number) =>
    einheitSeite({
      siteId: 'site-gore', ref: 'edge-5mz8bdd', steuerung: gore(), einheit: einheit(n), werte: goreWerte(), nv: goreNv(),
      boxName: 'edge-5mz8bdd', now: NOW,
    });

  it('Wechselrichter 2: Ist groß, Soll und „folgt“, die Begrenzung der ganzen Anlage', () => {
    const v = seite(2);
    expect(v.kopf).toEqual({
      titel: 'Wechselrichter 2',
      typ: 'PV-Wechselrichter',
      modell: 'Growatt MAX 125KTL3-X · 125 kW',
      zustand: { wort: 'läuft begrenzt', ton: 'ok', detail: 'vor 5\u00a0Sek.' },
    });
    expect(v.ist).toBe('53,1');
    expect(v.satz).toBe('Läuft begrenzt.');
    expect(v.zeilen.map(plain)).toEqual(['Soll 53,0 kW · folgt', 'Begrenzung der Anlage: —']);
    expect(v.wort).toBe('Wechselrichter');
  });

  it('Gerät & Verbindung: Typ, Nennleistung, MaStR, Zählerstand, „Gelesen über“ mit Weg zur Steuerung, Block im Bild', () => {
    const z = (n: number) => seite(n).details.map((d) => [d.label, plain(d.wert), plain(d.detail ?? '')]);
    expect(z(1)).toEqual([
      ['Art', 'PV-Wechselrichter', ''],
      ['Typ', 'Growatt MAX 125KTL3-X', ''],
      ['Nennleistung', '125 kW', ''],
      ['MaStR', 'SEE912345678901', ''],
      ['Zählerstand Erzeugung', '—', 'noch keine Daten'],
      ['Gelesen über', 'Anlagensteuerung Gore', 'VoltPilot-Box edge-5mz8bdd'],
      ['Im Bild', 'Einheit 1 · Register 38–47', 'Wechselrichter 1'],
    ]);
    expect(seite(1).details.find((d) => d.label === 'Gelesen über')?.href).toBe(
      `#/anlage/site-gore/geraet/edge-5mz8bdd/as-${ENTITY_GORE}`,
    );
    // WR 2: der Typ aus den Stammdaten weicht vom Bild ab — der Hinweis nennt es; WR 3: Nennleistung laut Steuerung.
    expect(z(2)[1]).toEqual(['Typ', 'Growatt MAX 125KTL3-X', 'Die Steuerung nennt „Growatt MAX 125KTL3 X“.']);
    expect(z(3)[2]).toEqual(['Nennleistung', '125 kW', 'laut Steuerung']);
    expect(z(3)[3]).toEqual(['MaStR', 'nicht eingetragen', '']);
  });

  it('WR 3 ohne Gültigkeitsbit: keine große Zahl (nie ein großes „—“), der Satz sagt warum', () => {
    const v = seite(3);
    expect(v.ist).toBeNull();
    expect([v.satz, v.satzTon]).toEqual(['Die Steuerung meldet die Werte von diesem Wechselrichter gerade als ungültig.', 'warn']);
  });

  it('Büttner Motor 1: Direktvermarkter-Bereitschaft und Zählerstand; „läuft“ ohne Begrenzungssatz', () => {
    const w = werte(GERAET_BUETTNER, {
      ...Object.fromEntries(buettnerWerte().werte.map((x) => [x.point_key, { ...x }])),
      'erzeuger.te[1].t_e': 1873455.6,
    });
    const v = einheitSeite({
      siteId: 'site-b', ref: 'edge-b', steuerung: buettner(), einheit: buettner().einheiten[0], werte: w, nv: buettnerNv(),
      boxName: null, now: NOW,
    });
    expect([v.kopf.titel, v.kopf.typ, v.satz]).toEqual(['Motor 1', 'BHKW-Motor', 'Läuft.']);
    expect(v.zeilen.map(plain)).toContain('Vom Direktvermarkter abgerufen');
    expect(v.details.find((d) => d.label === 'Zählerstand Erzeugung')?.wert.replace(/ /g, ' ')).toBe('1.873.456 kWh');
    expect(v.details.find((d) => d.label === 'Gelesen über')?.detail).toBeNull();
  });

  it('der Begrenzungssatz liest `quelle_p` nur mit `s_bits` Bit 0 und nennt die Vorgabe', () => {
    const je = (q: number, extra: Record<string, number> = {}) =>
      werteJe(werte(GERAET_GORE, { 'erzeuger.wirkung.s_bits': 0b11, 'erzeuger.wirkung.quelle_p': q, 'erzeuger.wirkung.p_grenze_w': 0, ...extra }));
    expect(plain(begrenzungSatz(je(1, { 'erzeuger.nb.n_p_prozent': 60 })))).toBe('der Netzbetreiber begrenzt die Anlage auf 60 %');
    expect(plain(begrenzungSatz(je(3)))).toBe('die Anlage regelt am Netzpunkt auf 0,0 kW');
    expect(begrenzungSatz(je(0))).toBe('keine Vorgabe begrenzt die Anlage');
    expect(begrenzungSatz(werteJe(werte(GERAET_GORE, { 'erzeuger.wirkung.s_bits': 0, 'erzeuger.wirkung.quelle_p': 1 })))).toBeNull();
    const w = werte(GERAET_GORE, {
      ...Object.fromEntries(goreWerte().werte.map((x) => [x.point_key, { ...x }])),
      'erzeuger.wirkung.quelle_p': { wert: 1, text: 'Netzbetreiber' },
    });
    const v = einheitSeite({ siteId: 's', ref: 'r', steuerung: gore(), einheit: einheit(1), werte: w, nv: goreNv(), boxName: null, now: NOW });
    expect(plain(v.satz)).toBe('Läuft begrenzt — der Netzbetreiber begrenzt die Anlage auf 60 %.');
    expect(plain(v.zeilen[1])).toBe('Begrenzung der Anlage: Netzbetreiber');
  });

  it('der Block im Bild folgt der Basisadresse der Fassung; ohne Fassung nur die Nummer', () => {
    const s = gore();
    expect(blockImBild({ ...s, fassung: { ...s.fassung!, basisadresse: 100 } }, 2)).toBe('Einheit 2 · Register 148–157');
    expect(blockImBild({ ...s, fassung: null }, 2)).toBe('Einheit 2');
  });
});

describe('Heute — Ist je Viertelstunde, Soll in der Ablesung, Energie aus t_e', () => {
  const kurve = (point_key: string, einheit: 'W' | 'kWh', eimer: [string, number, number, number][]) => ({
    point_key,
    abschnitt: 'te[*]',
    feld: point_key.split('.')[2],
    te_nr: 2,
    einheit,
    eimer: eimer.map(([start, min, max, last]) => ({ start, avg: (min + max) / 2, min, max, last, n: 3 })),
  });
  const verlauf = (kurven: AnlagensteuerungVerlauf['kurven']): AnlagensteuerungVerlauf => ({
    geraet_id: GERAET_GORE, entity_id: ENTITY_GORE, range: 'day', from: '2026-10-20T22:00:00Z', to: '2026-10-21T22:00:00Z',
    bucket_minutes: 15, kurven,
  });

  it('Energie heute = letzte minus erste Lesung des Tages; erste Lesung später als die erste Viertelstunde → „seit“', () => {
    const v = verlauf([
      kurve('erzeuger.te[2].t_e', 'kWh', [
        ['2026-10-21T05:15:00Z', 471500, 471500.4, 471500.4],
        ['2026-10-21T09:00:00Z', 471700, 471720, 471720],
        ['2026-10-21T11:45:00Z', 471800, 471812.3, 471812.3],
      ]),
    ]);
    const e = energieHeute(v, 2);
    expect(e.kwh).toBeCloseTo(312.3, 5);
    expect(e.seit).toMatch(/^\d{2}:\d{2}$/);
    expect(plain(energieText(e))).toMatch(/^312 kWh seit \d{2}:\d{2}$/);
    const abMitternacht = energieHeute(verlauf([kurve('erzeuger.te[2].t_e', 'kWh', [['2026-10-20T22:00:00Z', 10, 10, 10], ['2026-10-21T10:00:00Z', 20, 30, 30]])]), 2);
    expect([abMitternacht.kwh, abMitternacht.seit]).toEqual([20, null]);
  });

  it('ein Rücksprung des Zählers macht die Energie unbekannt, nie geschätzt; ohne Kurve oder Lesung sagt sie warum', () => {
    const zurueck = energieHeute(verlauf([kurve('erzeuger.te[2].t_e', 'kWh', [['2026-10-20T22:00:00Z', 500, 500, 500], ['2026-10-21T08:00:00Z', 3, 8, 8]])]), 2);
    expect(zurueck).toEqual({ kwh: null, seit: null, grund: 'Der Zählerstand ist heute zurückgesprungen.' });
    expect(energieText(zurueck)).toBe('—');
    const imEimer = energieHeute(verlauf([kurve('erzeuger.te[2].t_e', 'kWh', [['2026-10-20T22:00:00Z', 3, 500, 4]])]), 2);
    expect(imEimer.kwh).toBeNull();
    expect(energieHeute(verlauf([]), 2).grund).toBe('Die Steuerung meldet keinen Zählerstand.');
    expect(energieHeute(verlauf([kurve('erzeuger.te[2].t_e', 'kWh', [])]), 2).grund).toBe('Heute noch kein Zählerstand gelesen.');
  });

  it('der Streifen zeigt Ist in kW je Viertelstunde; die Ablesung nennt Soll daneben', () => {
    const v = verlauf([
      kurve('erzeuger.te[2].t_p_ist_w', 'W', [['2026-10-21T10:00:00Z', 41000, 41400, 41200]]),
      kurve('erzeuger.te[2].t_p_soll_w', 'W', [['2026-10-21T10:00:00Z', 53000, 53000, 53000]]),
    ]);
    const h = einheitHeute(v, GERAET_GORE, 2, Date.parse('2026-10-21T12:00:00Z'));
    expect(h.view.punkte).toHaveLength(96);
    const p = h.view.punkte.find((x) => x.value != null)!;
    expect(p.value).toBeCloseTo(41.2, 5);
    expect(plain(einheitAblesung(p, h.soll))).toMatch(/^\d{2}:\d{2} · Ist 41,2 kW · Soll 53,0 kW$/);
    expect(h.energie.grund).toBe('Die Steuerung meldet keinen Zählerstand.');
  });
});

describe('Aktivität — Vorgaben dieser Einheit und der ganzen Anlage, Alarme je Einheit', () => {
  const vorgabe = (o: Partial<ErzeugerVorgabe>): ErzeugerVorgabe => ({
    id: 'v', geraet_id: GERAET_GORE, te_nr: null, einheit_name: null, urheber: 'netzbetreiber', art: 'p_begrenzung',
    beginn: '2026-10-21T08:58:00Z', beginn_genau: true, ende: null, ende_genau: false, gesehen_bis: JETZT, dauer_s: 3600,
    vorgabe_prozent: 60, vorgabe_w: null, ist_mittel_w: null, verfuegbar_mittel_w: null, energie_kwh: null, methode: null,
    wert_eur: null, kanal: null, bindung: null, unvollstaendig: false, neustart: false, zaehler_beginn: null,
    zaehler_ende: null, gruende: [], ...o,
  });

  it('nimmt die Vorgaben mit dieser TE-Nr. und die der ganzen Anlage, jüngste zuerst — nie die einer anderen Einheit', () => {
    const z = vorgabenZeilen(
      [
        vorgabe({ id: 'anlage' }),
        vorgabe({ id: 'te2', te_nr: 2, urheber: 'direktvermarkter', art: 'nicht_bereit', gruende: ['Wartung'], beginn: '2026-10-21T10:00:00Z', ende: '2026-10-21T10:30:00Z' }),
        vorgabe({ id: 'te3', te_nr: 3 }),
        vorgabe({ id: 'fremd', geraet_id: 'andere' }),
      ],
      GERAET_GORE,
      2,
      NOW,
    );
    expect(z.map((x) => [x.key, plain(x.titel), x.sub, x.laeuft])).toEqual([
      ['v:te2', 'Direktvermarkter · nicht bereit: Wartung', null, false],
      ['v:anlage', 'Netzbetreiber · begrenzt auf 60 %', 'gilt für die ganze Anlage · läuft', true],
    ]);
    expect(z[1].wann).toMatch(/^ab \d{2}:\d{2}$/);
  });

  it('Alarme nur mit der Kennung dieser Einheit, offene zuerst', () => {
    const m = (o: Partial<Meldung>): Meldung => ({
      id: 'm', kennzeichen: 'M-1', wertart: 'erzeuger.fernsteuerung_nicht_bereit', schwere: 'warnung', anlageId: 'site-gore',
      anlageName: 'Gore', standortId: null, ausgeloestAm: '2026-10-21T09:00:00Z', zustand: 'aktiv', wiederNormalAm: null,
      gesehenVon: null, gesehenAm: null, erledigtAm: null, bezugKennung: einheitBezugKennung(GERAET_GORE, 2), ...o,
    });
    const z = alarmZeilen(
      [
        m({ id: 'alt', ausgeloestAm: '2026-10-20T09:00:00Z', wiederNormalAm: '2026-10-20T10:00:00Z', zustand: 'erledigt' }),
        m({ id: 'offen' }),
        m({ id: 'te1', bezugKennung: einheitBezugKennung(GERAET_GORE, 1) }),
        m({ id: 'anlage', bezugKennung: `anlage:site-gore` }),
      ],
      GERAET_GORE,
      2,
      NOW,
    );
    expect(z.map((x) => [x.key, x.laeuft, x.sub])).toEqual([
      ['m:offen', true, null],
      ['m:alt', false, 'wieder normal'],
    ]);
    expect(z[0].titel).toMatch(/^Warnung · /);
    expect(einheitBezugKennung(GERAET_GORE, 2)).toBe(`einheit:${GERAET_GORE};te=2`);
  });
});
