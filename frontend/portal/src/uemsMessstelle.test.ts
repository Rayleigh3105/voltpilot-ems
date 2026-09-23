import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import {
  BINDUNG_STATUS,
  FEHLER,
  FEHLT,
  GROESSEN_KATALOG,
  HERLEITUNGEN,
  HINWEISE,
  hoechstzuwachsJeKadenz,
  KANAL_EINHEITEN,
  KENNZEICHEN_MAX_ZEICHEN,
  KENNZEICHEN_MIN_ZEICHEN,
  KENNZEICHEN_MUSTER,
  KENNZEICHEN_PRAEFIX,
  KENNZEICHEN_STELLEN,
  LEBENSZYKLUS,
  MEDIEN,
  MEDIEN_WAEHLBAR,
  PASSUNG_GRUENDE,
  ANTEILE,
  ANTEIL_RICHTUNGEN,
  RUECKWIRKUNG_ARTEN,
  STELLUNGEN,
  STELLUNG_GRUENDE,
  VERGLEICH_ZWECKE,
  ATTRIBUT_KANAELE,
  ATTRIBUT_PRAEFIX,
  VORSCHLAG_FLUESSE,
  VORSCHLAG_GRUENDE,
  VORSCHLAG_HINWEISE,
  VORSCHLAG_LEER,
  VORSCHLAG_ROLLEN,
  beendenPruefen,
  bindungPruefen,
  groessePruefen,
  kennzeichenFormatGueltig,
  kennzeichenPruefen,
  kennzeichenVorschlag,
  lebenszyklus,
  passung,
  rueckwirkung,
  stellungPruefen,
  vorschlagsliste,
  wechselPruefen,
  kartenWechselPruefen,
  zeitstrahlAus,
  type Abschnitt,
  type Bindung,
  type BindungEingang,
  type BindungUrteil,
  type Groesse,
  type LebenszyklusEingang,
  type QuelleZeitraum,
  type Stand,
  type StellungEintrag,
  type VorschlagEingang,
  type VorschlagQuelle,
  type Vorschlagsliste,
} from './uemsMessstelle';
import { mitternacht } from './uemsOrtsbaum';
import { liefertDaten } from './uemsZustand';

/**
 * Die Regeln der MESSSTELLE (UEMS AP-04 IP-1) gegen die EINE geteilte
 * Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../uems/MessstelleRegelnVectorsTest` fährt. Dazu: Datei und
 * Beispiele halten ihr Schema, die Konstanten stehen genau so in der Datei, und
 * jeder Fall, der sich auf das Referenzunternehmen beruft, übernimmt dessen
 * Werte unverändert.
 *
 * Wer eine Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei
 * Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const FIXTURES = resolve(V2, 'fixtures/messstelle');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const vectors: Json = lies(resolve(V2, 'messstelle-vectors.json'));
const schema: Json = lies(resolve(V2, 'messstelle.schema.json'));
const referenz: Json = lies(resolve(V2, 'uems-referenzunternehmen.json'));

const faelle = (familie: string): Json[] => vectors.cases[familie];
const beispiele = readdirSync(FIXTURES)
  .filter((n) => n.endsWith('.json'))
  .sort();
const gueltige = beispiele.filter((n) => n.includes('.valid.'));

// ------------------------------------------------------------------ Umwandler

const groesse = (g: Json): Groesse | null =>
  g === null ? null : { groesse: g.groesse, richtung: g.richtung, einheit: g.einheit, wertart: g.wertart };

const stand = (s: Json): Stand | null => (s === null ? null : { wert: s.wert, einheit: s.einheit });

const lebenszyklusEingang = (i: Json): LebenszyklusEingang => ({
  art: i.art,
  medium: i.medium,
  kennzeichen: i.kennzeichen,
  name: i.name,
  hauptgroesse: groesse(i.hauptgroesse),
  ortVorhanden: i.ort_vorhanden,
  formelVorhanden: i.formel_vorhanden,
  eingaengeEingerichtet: i.eingaenge_eingerichtet,
  angehalten: i.angehalten,
  archiviert: i.archiviert,
  fuehrendeQuelle: i.fuehrende_quelle.map((q: Json) => ({
    komponente: q.komponente,
    kanal: q.kanal,
    geraet: q.geraet,
    einbau: q.einbau,
    gueltigAb: q.gueltig_ab,
    gueltigBis: q.gueltig_bis,
  })),
  jetzt: i.jetzt,
});

const bindung = (b: Json): Bindung => ({
  rolle: b.rolle,
  groesse: b.groesse,
  richtung: b.richtung,
  komponente: b.komponente,
  kanal: b.kanal,
  geraet: b.geraet,
  einbau: b.einbau,
  kanalWertart: b.kanal_wertart,
  zweck: b.zweck,
  gueltigAb: b.gueltig_ab,
  gueltigBis: b.gueltig_bis,
});

const bindungEingang = (i: Json): BindungEingang => ({
  vorgang: i.vorgang,
  jetzt: i.jetzt,
  medium: i.messstelle.medium,
  messstelleBeginn: i.messstelle.beginn,
  ziel: groesse(i.ziel) as Groesse,
  bestehende: i.bestehende.map(bindung),
  neu: {
    rolle: i.neu.rolle,
    zweck: i.neu.zweck,
    komponente: i.neu.komponente,
    kanal: i.neu.kanal,
    geraet: i.neu.geraet,
    einbau: i.neu.einbau,
    kanalGroesse: i.neu.kanal_groesse,
    kanalRichtung: i.neu.kanal_richtung,
    kanalEinheit: i.neu.kanal_einheit,
    kanalWertart: i.neu.kanal_wertart,
    gueltigAb: i.neu.gueltig_ab,
    gueltigBis: i.neu.gueltig_bis,
    endstandVorgaenger: stand(i.neu.endstand_vorgaenger),
    anfangsstand: stand(i.neu.anfangsstand),
    // Fehlt das Feld, speist der Einbau bis auf Weiteres (der Stand vor IP-13).
    geraetBis: i.neu.geraet_bis ?? null,
    // Fehlen die Felder, ist es eine Bindung ohne Anteil (der Stand vor AP-08 IP-7).
    kanalDirection: i.neu.kanal_direction ?? null,
    anteil: i.neu.anteil ?? null,
  },
  kanalFuehrendAnderswo: i.kanal_fuehrend_anderswo.map((f: Json) => ({
    messstelle: f.messstelle,
    gueltigAb: f.gueltig_ab,
    gueltigBis: f.gueltig_bis,
    anteil: f.anteil ?? null,
  })),
});

const stellungEintrag = (e: Json): StellungEintrag => ({
  kennzeichen: e.kennzeichen,
  name: e.name,
  anlage: e.anlage,
  stellung: e.stellung,
  unterzaehlerVon: e.unterzaehler_von,
  richtung: e.richtung,
  komponente: e.komponente,
});

const quelle = (b: QuelleZeitraum) => ({ komponente: b.komponente, kanal: b.kanal, geraet: b.geraet, einbau: b.einbau });

const zeitstrahlAlsJson = (abschnitte: Abschnitt[]): Json =>
  abschnitte.map((a) => ({ von: a.von, bis: a.bis, quelle: a.quelle ? quelle(a.quelle) : null }));

const quelleZeitraum = (q: Json): QuelleZeitraum => ({
  komponente: q.komponente,
  kanal: q.kanal,
  geraet: q.geraet,
  einbau: q.einbau,
  gueltigAb: q.gueltig_ab,
  gueltigBis: q.gueltig_bis,
});
const quelleMitZeit = (b: Bindung) => ({ ...quelle(b), gueltig_ab: b.gueltigAb, gueltig_bis: b.gueltigBis });

const vorschlagEingang = (i: Json): VorschlagEingang => ({
  standort: i.standort,
  anlagen: i.anlagen,
  komponenten: i.komponenten.map((k: Json) => ({
    id: k.id,
    anlage: k.anlage,
    name: k.name,
    rolle: k.rolle,
    verlaufsbeginn: k.verlaufsbeginn,
    speisungAb: k.speisung_ab,
    messkanaele: k.messkanaele,
  })),
  zaehler: i.zaehler,
  belegt: i.belegt,
});

const vorschlagQuelleAlsJson = (q: VorschlagQuelle): Json => ({
  kanal: q.kanal,
  anzeigename: q.anzeigename,
  kanal_wertart: q.kanalWertart,
  herleitung: q.herleitung,
});

const vorschlagAlsJson = (l: Vorschlagsliste): Json => ({
  vorschlaege: l.vorschlaege.map((z) => ({
    kennzeichen: z.kennzeichen,
    name: z.name,
    anlage: z.anlage,
    komponente: z.komponente,
    hauptgroesse: z.hauptgroesse,
    quelle: vorschlagQuelleAlsJson(z.quelle),
    nebengroessen: z.nebengroessen.map((n) => ({ groesse: n.groesse, quelle: vorschlagQuelleAlsJson(n.quelle) })),
    stellung: z.stellung,
    unterzaehler_von: z.unterzaehlerVon
      ? {
          messstelle: z.unterzaehlerVon.messstelle,
          bestehend: z.unterzaehlerVon.bestehend,
          komponente: z.unterzaehlerVon.komponente,
          kanal: z.unterzaehlerVon.kanal,
        }
      : null,
    ort: z.ort,
    ab: z.ab,
    stellung_ab: z.stellungAb,
    hinweise: z.hinweise,
  })),
  ausgelassen: l.ausgelassen,
  leer: l.leer,
  text: l.text,
  zaehler: l.zaehler,
});

const urteilAlsJson = (u: BindungUrteil): Json => ({
  fehler: u.fehler,
  grund: u.grund,
  bestehend: u.bestehend ? quelleMitZeit(u.bestehend) : null,
  messstelle: u.messstelle,
  beendet: u.beendet ? { ...quelleMitZeit(u.beendet.bindung), endstand: u.beendet.endstand } : null,
  status: u.status,
  rueckwirkend: u.rueckwirkend,
  angekuendigt: u.angekuendigt,
  herleitung: u.herleitung,
  hinweise: u.hinweise,
  zeitstrahl: u.zeitstrahl ? zeitstrahlAlsJson(u.zeitstrahl) : null,
  ohne_geraet_ab: u.ohneGeraetAb,
});

// ------------------------------------------------------------------- Form

describe('Messstellen-Vertrag — Form', () => {
  it('die Vektor-Datei hält ihr Schema', () => {
    expect(schemaVerstoesse(vectors, schema, schema.$defs.vektorDatei)).toEqual([]);
  });

  it('trägt mindestens 12 Fälle (AP-04 §8 IP-1), jeder Name einmal', () => {
    const namen = Object.values(vectors.cases).flatMap((f) => (f as Json[]).map((c) => c.name));
    expect(namen.length).toBeGreaterThanOrEqual(12);
    expect(new Set(namen).size).toBe(namen.length);
  });

  it('hat mindestens zwei gültige und ein ungültiges Beispiel', () => {
    expect(gueltige.length).toBeGreaterThanOrEqual(2);
    expect(beispiele.filter((n) => n.includes('.invalid.')).length).toBeGreaterThanOrEqual(1);
  });

  it.each(beispiele)('%s hält das Schema — ein ungültiges bricht GENAU eine Regel', (datei) => {
    const verstoesse = schemaVerstoesse(lies(resolve(FIXTURES, datei)), schema);
    expect(verstoesse).toHaveLength(datei.includes('.invalid.') ? 1 : 0);
  });
});

describe('Messstellen-Vertrag — die Regeln stehen in der Datei', () => {
  it('Kennzeichen-Regel, Vokabular und Fehlertabelle in ihrer Reihenfolge', () => {
    expect(vectors.kennzeichen_regel).toEqual({
      praefix: KENNZEICHEN_PRAEFIX,
      stellen: KENNZEICHEN_STELLEN,
      muster: KENNZEICHEN_MUSTER,
      min_zeichen: KENNZEICHEN_MIN_ZEICHEN,
      max_zeichen: KENNZEICHEN_MAX_ZEICHEN,
    });
    expect(vectors.medien).toEqual([...MEDIEN]);
    expect(vectors.medien_waehlbar).toEqual([...MEDIEN_WAEHLBAR]);
    expect(vectors.lebenszyklus).toEqual([...LEBENSZYKLUS]);
    expect(vectors.fehlt).toEqual([...FEHLT]);
    expect(vectors.bindung_status).toEqual([...BINDUNG_STATUS]);
    expect(vectors.herleitungen).toEqual([...HERLEITUNGEN]);
    expect(vectors.vergleich_zwecke).toEqual([...VERGLEICH_ZWECKE]);
    expect(vectors.stellungen).toEqual([...STELLUNGEN]);
    expect(vectors.stellung_gruende).toEqual([...STELLUNG_GRUENDE]);
    expect(vectors.passung_gruende).toEqual([...PASSUNG_GRUENDE]);
    expect(vectors.anteile).toEqual([...ANTEILE]);
    expect(vectors.anteil_richtungen).toEqual(ANTEIL_RICHTUNGEN);
    expect(vectors.hinweise).toEqual([...HINWEISE]);
    expect(vectors.rueckwirkung_arten).toEqual([...RUECKWIRKUNG_ARTEN]);
    expect(vectors.vorschlag_fluesse).toEqual([...VORSCHLAG_FLUESSE]);
    expect(vectors.vorschlag_rollen).toEqual([...VORSCHLAG_ROLLEN]);
    expect(vectors.vorschlag_gruende).toEqual([...VORSCHLAG_GRUENDE]);
    expect(vectors.vorschlag_hinweise).toEqual([...VORSCHLAG_HINWEISE]);
    expect(vectors.vorschlag_leer).toEqual([...VORSCHLAG_LEER]);
    expect(vectors.attribut_kanaele).toEqual([...ATTRIBUT_KANAELE]);
    expect(vectors.attribut_praefix).toEqual(ATTRIBUT_PRAEFIX);
    expect(vectors.fehler).toEqual(
      FEHLER.map((f) => ({ code: f.code, status: f.status, geprueft_von: f.geprueftVon })),
    );
  });

  it('der Größen-Katalog und die umrechenbaren Einheiten', () => {
    expect(vectors.groessen_katalog).toEqual(
      GROESSEN_KATALOG.map((e) => ({
        groesse: e.groesse,
        medien: e.medien,
        einheit: e.einheit,
        richtungen: e.richtungen,
        wertarten: e.wertarten,
        quellen: e.quellen.map((q) => ({
          kanal_groesse: q.kanalGroesse,
          kanal_wertart: q.kanalWertart,
          nur_wertart: q.nurWertart,
        })),
        // Nur wo es sie gibt (AP-10 IP-4) — `toEqual` übergeht ein `undefined`-Feld.
        richtungen_nur_berechnet: e.richtungenNurBerechnet,
      })),
    );
    expect(Object.entries(vectors.kanal_einheiten)).toEqual(Object.entries(KANAL_EINHEITEN));
  });
});

// ---------------------------------------------------------- die Vektor-Fälle

describe('Messstellen-Vertrag — die Fälle', () => {
  it.each(faelle('kennzeichen_vorschlag'))('Vorschlag: $name', (c) => {
    expect(kennzeichenVorschlag(c.input.zaehler, c.input.belegt)).toEqual(c.expected);
  });

  it.each(faelle('kennzeichen_pruefen'))('Kennzeichen: $name', (c) => {
    expect(kennzeichenPruefen(c.input.kandidat, c.input.fuer_messstelle, c.input.vergeben)).toEqual(c.expected);
  });

  it.each(faelle('groesse'))('Größe: $name', (c) => {
    // `art` fehlt in den Fällen von vor AP-10 IP-4: dann urteilt die Regel ohne Art.
    expect(groessePruefen(c.input.medium, c.input.groesse, c.input.art)).toEqual(c.expected);
  });

  it.each(faelle('anschlussleistung'))('Anschlussleistung: $name', (c) => {
    const ist = hoechstzuwachsJeKadenz(c.input.anschlussleistung_kw, c.input.einheit, c.input.kadenz_s);
    const soll = c.expected.hoechstzuwachs_je_kadenz;
    if (soll === null) expect(ist).toBeNull();
    else expect(ist).toBeCloseTo(soll, 9);
  });

  it.each(faelle('lebenszyklus'))('Lebenszyklus: $name', (c) => {
    const r = lebenszyklus(lebenszyklusEingang(c.input));
    expect({
      lebenszyklus: r.lebenszyklus,
      eingerichtet: r.eingerichtet,
      fehlt: r.fehlt,
      quelle_vorhanden: r.quelleVorhanden,
    }).toEqual(c.expected);
  });

  it.each(faelle('passung'))('Passung: $name', (c) => {
    const k = c.input.kanal;
    expect(
      passung(
        c.input.medium,
        c.input.ziel,
        k.groesse,
        k.richtung,
        k.einheit,
        k.wertart,
        k.direction ?? null,
        c.input.anteil ?? null,
      ),
    ).toEqual(c.expected);
  });

  it.each(faelle('vorschlag'))('Vorschlag Bestand: $name', (c) => {
    expect(vorschlagAlsJson(vorschlagsliste(vorschlagEingang(c.input)))).toEqual(c.expected);
  });

  it.each(faelle('bindung'))('Quelle: $name', (c) => {
    expect(urteilAlsJson(bindungPruefen(bindungEingang(c.input)))).toEqual(c.expected);
  });

  it.each(faelle('beenden'))('Beenden: $name', (c) => {
    expect(
      beendenPruefen({
        jetzt: c.input.jetzt,
        bindung: bindung(c.input.bindung),
        gueltigBis: c.input.gueltig_bis,
        endstand: stand(c.input.endstand),
      }),
    ).toEqual(c.expected);
  });

  it.each(faelle('wechsel'))('Zählerwechsel: $name', (c) => {
    const a = c.input.alt;
    if (c.input.karten) {
      const k = c.input.karten;
      expect(kartenWechselPruefen(k.vorhanden, k.uebernommen, k.fuehrende_bindungen, k.ablesestaende)).toBe(c.expected.karten_fehler);
    }
    expect(
      wechselPruefen({
        jetzt: c.input.jetzt,
        alt: {
          geraet: a.geraet,
          einbau: a.einbau,
          eingebautAm: a.eingebaut_am,
          ausgebautAm: a.ausgebaut_am,
        },
        zeitpunkt: c.input.zeitpunkt,
      }),
    ).toEqual({
      fehler: c.expected.fehler,
      ohneGeraetAb: c.expected.ohne_geraet_ab,
      rueckwirkend: c.expected.rueckwirkend,
      angekuendigt: c.expected.angekuendigt,
    });
  });

  it.each(faelle('rueckwirkung'))('Rückwirkung: $name', (c) => {
    expect(rueckwirkung(c.input.jetzt, c.input.zeitpunkt)).toEqual(c.expected);
  });

  it.each(faelle('zeitstrahl'))('Zeitstrahl: $name', (c) => {
    expect({
      zeitstrahl: zeitstrahlAlsJson(zeitstrahlAus(c.input.beginn, c.input.fuehrende_quelle.map(quelleZeitraum))),
    }).toEqual(c.expected);
  });

  /**
   * Vergleichsquellen gibt es 0..n NEBENEINANDER (E3) — nur derselbe Messwert
   * nicht zweimal zur selben Zeit. Das Referenzunternehmen hat für keine Größe
   * zwei Vergleichs-Messwerte, deshalb prüfen beide Zwillinge diesen Zweig als
   * Einheit, mit neutralen Platzhaltern statt Ahrenberg-Kennzeichen.
   */
  it('zwei verschiedene Vergleichsquellen stehen nebeneinander', () => {
    const ab = '2026-10-20T10:15:00+02:00';
    const u = bindungPruefen({
      vorgang: 'binden',
      jetzt: ab,
      medium: 'Strom',
      messstelleBeginn: ab,
      ziel: { groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert' },
      bestehende: [
        {
          rolle: 'vergleich',
          groesse: 'Wirkleistung',
          richtung: 'Bezug',
          komponente: 'K-A',
          kanal: 'Leistung A',
          geraet: 'GR-A',
          einbau: 'GR-A',
          kanalWertart: 'gauge',
          zweck: 'Plausibilität',
          gueltigAb: ab,
          gueltigBis: null,
        },
      ],
      neu: {
        rolle: 'vergleich',
        zweck: 'Abrechnungszähler',
        komponente: 'K-B',
        kanal: 'Leistung B',
        geraet: 'GR-B',
        einbau: 'GR-B',
        kanalGroesse: 'Wirkleistung',
        kanalRichtung: 'Bezug',
        kanalEinheit: 'kW',
        kanalWertart: 'gauge',
        gueltigAb: ab,
        gueltigBis: null,
        endstandVorgaenger: null,
        anfangsstand: null,
        geraetBis: null,
      },
      kanalFuehrendAnderswo: [],
    });
    expect(u.fehler).toBeNull();
    expect(u.zeitstrahl).toBeNull();
  });

  /**
   * Zwei Hauptzähler DERSELBEN Richtung sind nie erlaubt — auch nicht am selben
   * Zähler. Im Referenzunternehmen liest keine zweite Messstelle einen Zähler in
   * derselben Richtung; beide Zwillinge prüfen den Zweig als Einheit.
   */
  it('zwei Hauptzähler gleicher Richtung — auch am selben Zähler — sind abgelehnt', () => {
    const bestehend: StellungEintrag = {
      kennzeichen: 'MS-A',
      name: 'Netzbezug A',
      anlage: 'AN-A',
      stellung: 'Hauptzähler',
      unterzaehlerVon: null,
      richtung: 'Bezug',
      komponente: 'K-A',
    };
    const u = stellungPruefen(
      { kennzeichen: 'MS-B', art: 'gemessen', medium: 'Strom', richtung: 'Bezug', komponente: 'K-A' },
      { anlage: 'AN-A', stellung: 'Hauptzähler', unterzaehlerVon: null },
      [bestehend],
    );
    expect(u.fehler).toBe('hauptzaehler_vorhanden');
    expect(u.bestehend).toEqual(bestehend);
  });

  it.each(faelle('stellung'))('Stellung: $name', (c) => {
    const m = c.input.messstelle;
    const s = c.input.stellung;
    const u = stellungPruefen(
      { kennzeichen: m.kennzeichen, art: m.art, medium: m.medium, richtung: m.richtung, komponente: m.komponente },
      s === null ? null : { anlage: s.anlage, stellung: s.stellung, unterzaehlerVon: s.unterzaehler_von },
      c.input.messstellen.map(stellungEintrag),
    );
    expect({
      fehler: u.fehler,
      grund: u.grund,
      bestehend: u.bestehend
        ? { kennzeichen: u.bestehend.kennzeichen, name: u.bestehend.name, anlage: u.bestehend.anlage }
        : null,
      kette: u.kette,
    }).toEqual(c.expected);
  });
});

// ---------------------------------------------- die Zwillinge untereinander

describe('Messstellen-Vertrag — gegen die Nachbar-Verträge', () => {
  const ohneQuelle = faelle('lebenszyklus').filter((c) => c.input.art === 'gemessen' && !c.expected.quelle_vorhanden);

  it('es gibt gemessene Fälle ohne Quelle', () => expect(ohneQuelle.length).toBeGreaterThan(0));

  it.each(ohneQuelle)('$name: ohne geltende Quelle heißt es „Keine Datenquelle" (E8), nie 0', (c) => {
    const r = lebenszyklus(lebenszyklusEingang(c.input));
    expect(
      liefertDaten({ quelleVorhanden: r.quelleVorhanden, letzterGuterWert: null, jeEinWert: false, kadenzS: 60, jetzt: c.input.jetzt })
        .zustand,
    ).toBe('keine_datenquelle');
  });

  it.each(gueltige)('%s hält auch die Regeln, die das Schema nicht ausdrücken kann', (datei) => {
    const d = lies(resolve(FIXTURES, datei));
    expect(kennzeichenFormatGueltig(d.kennzeichen)).toBe(true);
    expect(groessePruefen(d.medium, d.hauptgroesse).fehler).toBeNull();
    for (const n of d.nebengroessen) expect(groessePruefen(d.medium, n).fehler).toBeNull();
    const r = lebenszyklus({
      art: d.art,
      medium: d.medium,
      kennzeichen: d.kennzeichen,
      name: d.name,
      hauptgroesse: groesse(d.hauptgroesse),
      ortVorhanden: d.orte.length > 0,
      formelVorhanden: false,
      eingaengeEingerichtet: false,
      angehalten: false,
      archiviert: false,
      fuehrendeQuelle: d.fuehrende_quelle.map((q: Json) => ({ ...q, gueltigAb: q.gueltig_ab, gueltigBis: q.gueltig_bis })),
      jetzt: referenz.unternehmen.momentaufnahme,
    });
    expect(r.lebenszyklus).toBe(d.lebenszyklus);
  });
});

// -------------------------------------------------- das Referenzunternehmen

const refMessstelle = (kz: string): Json => referenz.messstellen.find((m: Json) => m.kennzeichen === kz);

const refOrte = (kz: string): string[] =>
  referenz.zuordnungen
    .filter((z: Json) => z.art === 'messstelle_ort' && z.von === kz)
    .map((z: Json) => `${z.nach}|${z.gueltig_ab}|${z.gueltig_bis}`);

const refEinbau = (einbau: string): Json =>
  referenz.geraete.flatMap((g: Json) => g.einbauten ?? []).find((e: Json) => e.kennzeichen === einbau) ?? {
    endstand_kwh: null,
    anfangsstand_kwh: null,
  };

/** Der Beginn einer Messstelle: Mitternacht des ersten Tages ihres ersten Orts, als Zeitpunkt am Standort (Schema `beginn`). */
const beginnAus = (orte: string[]): string => mitternacht(orte[0].split('|')[1], 'Europe/Berlin').iso;

/** Eine tagesgenaue Gültigkeit (Stellung, Ort): `gueltig_bis` ist der LETZTE Tag, einschließlich. */
const giltAm = (o: Json, tag: string): boolean => o.gueltig_ab <= tag && (o.gueltig_bis === null || tag <= o.gueltig_bis);

/** Ein Kalendertag als Zeitpunkt MITTEN in ihm (12:00 UTC liegt immer im Berliner Tag). */
const mittag = (tag: string): number => Date.parse(`${tag}T12:00:00Z`);

/**
 * Der Horizont einer Fortschreibung: das letzte Ereignis der Zeitachse OHNE fachfremde Zeilen. Seit Fassung
 * 1.5 sind das Zeilen der `gemeinsame_steuerung`, seit 1.6 auch Zeilen der `energetische_bewertung`, seit 1.8
 * Zeilen der `bezugsbasis`; alle drei sagen über Messstellen-Quellen nichts (Fall unten). Dieselbe Regel steht in MessstelleRegelnVectorsTest.
 */
const horizontZeilen: Json[] = referenz.zeitachse.filter(
  (z: Json) => z.gemeinsame_steuerung == null && z.energetische_bewertung == null && z.bezugsbasis == null,
);
const letztesEreignis = Math.max(...horizontZeilen.map((z: Json) => Date.parse(z.zeitpunkt)));

const gilt = (o: Json, t: number): boolean =>
  Date.parse(o.gueltig_ab) <= t && (o.gueltig_bis === null || t < Date.parse(o.gueltig_bis));

const refKomponenteAm = (m: Json, t: number): string | null =>
  m.fuehrende_quelle.filter((q: Json) => gilt(q, t)).map((q: Json) => q.komponente).pop() ?? null;

/** Die führenden Quellen (oder mit `feld` die Vergleichsquellen) der Haupt- oder Nebengröße mit dieser Größe und Richtung. */
const refQuellenDerGroesse = (
  m: Json,
  g: Json,
  feld: 'fuehrende_quelle' | 'vergleichsquellen' = 'fuehrende_quelle',
): Json[] | null => {
  const passt = (n: Json) =>
    n.groesse === g.groesse &&
    n.richtung === g.richtung &&
    (g.einheit === undefined || n.einheit === g.einheit) &&
    (g.wertart === undefined || n.wertart === g.wertart);
  if (passt(m.hauptgroesse)) return m[feld];
  return m.nebengroessen.find(passt)?.[feld] ?? null;
};

/** Eine Quelle steht so im Referenzunternehmen — oder ist noch offen (Stand VOR dem Eintrag) — oder eine Fortschreibung. */
const pruefeQuelle = (q: Json, liste: Json[], fortschreibung: boolean): void => {
  const r = liste.find(
    (x) =>
      x.komponente === q.komponente &&
      x.kanal === q.kanal &&
      x.geraet === q.geraet &&
      x.einbau === q.einbau &&
      x.gueltig_ab === q.gueltig_ab &&
      (q.kanal_wertart === undefined || x.kanal_wertart === q.kanal_wertart) &&
      (q.zweck == null || x.zweck === q.zweck),
  );
  expect(r, `Quelle ${q.einbau} ab ${q.gueltig_ab} steht so im Referenzunternehmen`).toBeDefined();
  const erlaubt =
    (q.gueltig_bis === null && r.gueltig_bis !== null) ||
    q.gueltig_bis === r.gueltig_bis ||
    (fortschreibung && r.gueltig_bis === null && Date.parse(q.gueltig_bis) > letztesEreignis);
  expect(erlaubt, `Ende ${q.gueltig_bis} gegen ${r.gueltig_bis}`).toBe(true);
};

/** Der Zeitstrahl ist GENAU der des Referenzunternehmens — Quelle für Quelle, ohne Lücke. */
const pruefeZeitstrahlWieReferenz = (zeitstrahl: Json[], referenzQuellen: Json[]): void => {
  const schluessel = (q: Json, ab: string, bis: string | null) => `${q.komponente}|${q.kanal}|${q.geraet}|${q.einbau}|${ab}|${bis}`;
  expect(zeitstrahl.map((a) => (a.quelle === null ? 'LÜCKE' : schluessel(a.quelle, a.von, a.bis)))).toEqual(
    referenzQuellen.map((q) => schluessel(q, q.gueltig_ab, q.gueltig_bis)),
  );
};

const ohneStand = (qs: Json[]) => qs.map(({ anfangsstand: _a, endstand: _e, ...rest }) => rest);

describe('Messstellen-Vertrag — übernimmt das Referenzunternehmen', () => {
  it('die fachfremden Zeilen nennen keine Messstelle, Datenquelle oder Bezugsgröße der Vektoren', () => {
    // Die Ausnahme vom Horizont ist durch die Daten begründet; sagt eine solche Zeile doch etwas über eine Quelle,
    // bricht dieser Fall — dann gehört die Zeile in den Horizont.
    const kz = /\b(?:MS|DQ|BZ)-[0-9]+\b/g;
    const benutzt = new Set(JSON.stringify(vectors).match(kz) ?? []);
    expect(benutzt.size).toBeGreaterThan(0);
    const ausgenommen = (referenz.zeitachse as Json[]).filter(
      (z) => z.gemeinsame_steuerung != null || z.energetische_bewertung != null || z.bezugsbasis != null,
    );
    expect(ausgenommen.length).toBeGreaterThan(0);
    const fehler = ausgenommen.flatMap((z) =>
      ((z.ereignis as string).match(kz) ?? []).filter((k) => benutzt.has(k)).map((k) => `${z.zeitpunkt} nennt ${k}`),
    );
    expect(fehler).toEqual([]);
  });

  it.each(gueltige)('%s ist die Messstelle des Referenzunternehmens, Feld für Feld', (datei) => {
    const d = lies(resolve(FIXTURES, datei));
    const m = refMessstelle(d.kennzeichen);
    expect(m).toBeDefined();
    for (const feld of ['name', 'art', 'medium', 'kadenz_s']) expect(d[feld]).toEqual(m[feld]);
    expect(groesse(d.hauptgroesse)).toEqual(groesse(m.hauptgroesse));
    expect(ohneStand(d.fuehrende_quelle)).toEqual(m.fuehrende_quelle);
    for (const q of d.fuehrende_quelle) {
      const e = refEinbau(q.einbau);
      expect(q.endstand === null ? null : q.endstand.wert).toEqual(e.endstand_kwh);
      expect(q.anfangsstand === null ? null : q.anfangsstand.wert).toEqual(e.anfangsstand_kwh);
      for (const s of [q.endstand, q.anfangsstand]) if (s !== null) expect(s.einheit).toBe('kWh');
    }
    expect(d.nebengroessen.map((n: Json) => [groesse(n), ohneStand(n.fuehrende_quelle), n.vergleichsquellen])).toEqual(
      m.nebengroessen.map((n: Json) => [groesse(n), n.fuehrende_quelle, n.vergleichsquellen]),
    );
    expect(d.vergleichsquellen).toEqual(m.vergleichsquellen);
    expect(d.elektrische_stellung).toEqual(m.elektrische_stellung);
    expect(d.orte.map((o: Json) => `${o.kennzeichen}|${o.gueltig_ab}|${o.gueltig_bis}`)).toEqual(refOrte(d.kennzeichen));
    expect(d.orte[d.orte.length - 1].ort_art).toBe(m.ort.art);
  });

  it.each(faelle('lebenszyklus').filter((c) => c.referenz))('Lebenszyklus $name', (c) => {
    const m = refMessstelle(c.referenz);
    expect([c.input.kennzeichen, c.input.name, c.input.art, c.input.medium]).toEqual([m.kennzeichen, m.name, m.art, m.medium]);
    expect(groesse(c.input.hauptgroesse)).toEqual(groesse(m.hauptgroesse));
    expect(c.input.ort_vorhanden).toBe(refOrte(m.kennzeichen).length > 0);
    for (const q of c.input.fuehrende_quelle) pruefeQuelle(q, m.fuehrende_quelle, Boolean(c.fortschreibung));
  });

  it.each(faelle('bindung').filter((c) => c.referenz))('Quelle $name', (c) => {
    const m = refMessstelle(c.referenz);
    expect([c.input.messstelle.kennzeichen, c.input.messstelle.medium]).toEqual([m.kennzeichen, m.medium]);
    expect(c.input.messstelle.beginn).toBe(beginnAus(refOrte(m.kennzeichen)));
    const ziel = refQuellenDerGroesse(m, c.input.ziel);
    expect(ziel, 'die Zielgröße ist eine Größe der Messstelle').not.toBeNull();
    for (const b of c.input.bestehende) {
      const feld = b.rolle === 'vergleich' ? 'vergleichsquellen' : 'fuehrende_quelle';
      const liste = refQuellenDerGroesse(m, { groesse: b.groesse, richtung: b.richtung }, feld);
      expect(liste).not.toBeNull();
      pruefeQuelle(b, liste as Json[], Boolean(c.fortschreibung));
    }
    // Ein erlaubter Vergleichs-Eintrag an einer Messstelle der Datei ist der der Datei —
    // es sei denn, der Fall nennt ihn ausdrücklich als Annahme.
    if (c.input.neu.rolle === 'vergleich' && c.expected.fehler === null && !c.annahme) {
      pruefeQuelle(c.input.neu, refQuellenDerGroesse(m, c.input.ziel, 'vergleichsquellen') as Json[], false);
    }
    if (c.ergebnis_wie_referenz) pruefeZeitstrahlWieReferenz(c.expected.zeitstrahl, ziel as Json[]);
  });

  // Beenden: die Quelle steht so im Referenzunternehmen; mit ergebnis_wie_referenz endet sie
  // genau dort, wo sie dort endet.
  it.each(faelle('beenden').filter((c) => c.referenz))('Beenden $name', (c) => {
    const m = refMessstelle(c.referenz);
    const b = c.input.bindung;
    const feld = b.rolle === 'vergleich' ? 'vergleichsquellen' : 'fuehrende_quelle';
    const liste = refQuellenDerGroesse(m, { groesse: b.groesse, richtung: b.richtung }, feld);
    expect(liste).not.toBeNull();
    pruefeQuelle(b, liste as Json[], Boolean(c.fortschreibung));
    if (c.ergebnis_wie_referenz) pruefeQuelle({ ...b, gueltig_bis: c.input.gueltig_bis }, liste as Json[], false);
  });

  it.each(faelle('zeitstrahl').filter((c) => c.referenz))('Zeitstrahl $name', (c) => {
    const m = refMessstelle(c.referenz);
    expect(c.input.beginn).toBe(beginnAus(refOrte(m.kennzeichen)));
    for (const q of c.input.fuehrende_quelle) pruefeQuelle(q, m.fuehrende_quelle, Boolean(c.fortschreibung));
    if (c.ergebnis_wie_referenz) pruefeZeitstrahlWieReferenz(c.expected.zeitstrahl, m.fuehrende_quelle);
  });

  it.each(faelle('stellung'))('Stellung $name: jede Zeile ist die Stellung des Referenzunternehmens am Stichtag', (c) => {
    const tag = mittag(c.stichtag);
    const m = c.input.messstelle;
    const rm = refMessstelle(m.kennzeichen);
    expect([m.art, m.medium, m.richtung, m.komponente]).toEqual([
      rm.art,
      rm.medium,
      rm.hauptgroesse.richtung,
      refKomponenteAm(rm, tag),
    ]);
    for (const e of c.input.messstellen) {
      const r = refMessstelle(e.kennzeichen);
      const st = r.elektrische_stellung.filter((s: Json) => giltAm(s, c.stichtag)).pop();
      expect(st, `${e.kennzeichen} hat am Stichtag eine Stellung`).toBeDefined();
      expect(stellungEintrag(e)).toEqual({
        kennzeichen: r.kennzeichen,
        name: r.name,
        anlage: st.anlage,
        stellung: st.stellung,
        unterzaehlerVon: st.unterzaehler_von,
        richtung: r.hauptgroesse.richtung,
        komponente: refKomponenteAm(r, tag),
      });
    }
  });

  it.each(faelle('kennzeichen_pruefen'))('Kennzeichen $name: die Namen sind die des Referenzunternehmens', (c) => {
    for (const v of c.input.vergeben) {
      const r = refMessstelle(v.messstelle);
      if (r) expect(v.name).toBe(r.name);
    }
  });
});
