import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { lokalerTag, mitternacht, plusTage, rueckwirkung } from './uemsOrtsbaum';
import { bisZeitpunkt } from './rechte';
import { monatsvergleich } from './uemsBewertung';

/**
 * Der Vertrag des UEMS-Referenzunternehmens „Kunststoffwerk Ahrenberg GmbH“
 * (AP-00 §8 IP-2) — der TS-Zwilling zu
 * `services/api .../uems/UemsReferenzunternehmenVectorsTest`.
 *
 * Beide Seiten fahren DIESELBE Datei
 * `docs/contracts/v2/uems-referenzunternehmen.json` mit DENSELBEN Invarianten;
 * hier steht kein abgeschriebener Wert. Wer die Beispielwelt ändert, ändert die
 * Datei — und beide Zwillinge sagen sofort, wenn sie dabei in sich widersprüchlich
 * wird.
 */
const WURZEL = resolve(process.cwd(), '../../docs/contracts/v2');
const daten = JSON.parse(
  readFileSync(resolve(WURZEL, 'uems-referenzunternehmen.json'), 'utf8'),
) as Record<string, any>;
const schema = JSON.parse(
  readFileSync(resolve(WURZEL, 'uems-referenzunternehmen.schema.json'), 'utf8'),
) as Record<string, any>;

/** Ende einer offenen Gültigkeit — „bis auf Weiteres“. */
const OFFEN = Date.parse('9999-12-31T00:00:00+00:00');

const zeit = (s: string): number => Date.parse(s);
const jetzt = zeit(daten.unternehmen.momentaufnahme);

/** Die Zuordnungs-Arten, die tagesgenau gelten (AP-02 E9); alle anderen gelten auf die Minute. */
const TAGESGENAU = new Set(['ort_eltern', 'anlage_standort', 'messstelle_ort']);
/** Das Unternehmen als Ort (Ortsbaum-Vertrag, `regeln.unternehmen_kennzeichen`). */
const UNTERNEHMEN = 'U';
/** Das Abzeichen eines rückwirkenden Eintrags, wo immer die Datei es nennt. */
const ABZEICHEN = /rückwirkend \([0-9]+ Tage?\)/g;

// Tagesgenau: `gueltig_ab` ist ein Tag, `gueltig_bis` der LETZTE gültige Tag (einschließlich).
// Tage im Format JJJJ-MM-TT vergleichen sich als Text; umgerechnet wird nichts — „zur
// Momentaufnahme“ heißt für einen Tag: an deren Kalendertag in der Zeitzone des Unternehmens.
const ZONE: string = daten.unternehmen.zeitzone;
const heute = lokalerTag(daten.unternehmen.momentaufnahme, ZONE);
const OFFENER_TAG = '9999-12-31';
const letzterTag = (o: any): string => o.gueltig_bis ?? OFFENER_TAG;
const giltAm = (o: any, tag: string): boolean => o.gueltig_ab <= tag && tag <= letzterTag(o);

/** Paare tagesgenauer Gültigkeiten, die sich einen Tag teilen. */
const ueberlappungenTage = (objekte: any[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < objekte.length; i += 1) {
    for (let j = i + 1; j < objekte.length; j += 1) {
      const a = objekte[i];
      const b = objekte[j];
      if (a.gueltig_ab <= letzterTag(b) && b.gueltig_ab <= letzterTag(a)) {
        out.push(`${a.gueltig_ab}…${a.gueltig_bis} ∩ ${b.gueltig_ab}…${b.gueltig_bis}`);
      }
    }
  }
  return out;
};

/** Der erste Tag in [von, bis], an dem keine der Gültigkeiten gilt — null, wenn sie ihn durchgehend decken. */
const ersterFehlenderTag = (gueltigkeiten: any[], von: string, bis: string): string | null => {
  let t = von;
  for (;;) {
    const deckt = gueltigkeiten.find((g) => giltAm(g, t));
    if (deckt === undefined) return t;
    const ende = letzterTag(deckt);
    if (ende >= bis) return null;
    t = plusTage(ende, 1);
  }
};

const ende = (o: any): number => (o.gueltig_bis ? zeit(o.gueltig_bis) : OFFEN);
const gilt = (o: any, t: number): boolean => zeit(o.gueltig_ab) <= t && t < ende(o);
const laeuft = (o: any, t: number, abFeld: string, bisFeld: string): boolean =>
  zeit(o[abFeld]) <= t && t < (o[bisFeld] ? zeit(o[bisFeld]) : OFFEN);

/** Paare von Gültigkeiten, deren Zeiträume sich überschneiden. */
const ueberlappungen = (objekte: any[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < objekte.length; i += 1) {
    for (let j = i + 1; j < objekte.length; j += 1) {
      const a = objekte[i];
      const b = objekte[j];
      if (zeit(a.gueltig_ab) < ende(b) && zeit(b.gueltig_ab) < ende(a)) {
        out.push(`${a.gueltig_ab}…${a.gueltig_bis} ∩ ${b.gueltig_ab}…${b.gueltig_bis}`);
      }
    }
  }
  return out;
};

const alleQuellen = (m: any): any[] => [
  ...m.fuehrende_quelle,
  ...m.nebengroessen.flatMap((n: any) => n.fuehrende_quelle),
];

const alleVergleichsquellen = (m: any): any[] => [
  ...m.vergleichsquellen,
  ...m.nebengroessen.flatMap((n: any) => n.vergleichsquellen),
];

const zuordnungen = (art: string): Map<string, any[]> => {
  const out = new Map<string, any[]>();
  for (const z of daten.zuordnungen as any[]) {
    if (z.art !== art) continue;
    const liste = out.get(z.von) ?? [];
    liste.push(z);
    out.set(z.von, liste);
  }
  return out;
};

/** Gattung je Kennzeichen — der Beweis, dass jedes Kennzeichen nur einmal vorkommt. */
const register = (): { reg: Map<string, string>; doppelt: string[] } => {
  const reg = new Map<string, string>();
  const doppelt: string[] = [];
  const merke = (gattung: string, kz: string) => {
    const alt = reg.get(kz);
    if (alt) doppelt.push(`${kz} kommt in ${alt} UND ${gattung} vor`);
    reg.set(kz, gattung);
  };
  merke('unternehmen', daten.unternehmen.kennzeichen);
  for (const s of [
    'standorte', 'gebaeude', 'bereiche', 'prozesse', 'kostenstellen', 'netzanschluesse',
    'anlagen', 'boxen', 'datenquellen', 'geraete', 'komponenten', 'messstellen', 'bezugsgroessen', 'kennzahlen',
    'gemeinsame_steuerungen', 'energieeinsaetze', 'messbedarfe',
  ]) {
    for (const o of daten[s] as any[]) merke(s, o.kennzeichen);
  }
  for (const p of daten.personen as any[]) merke('personen', p.kuerzel);
  for (const g of daten.geraete as any[]) {
    for (const e of g.einbauten as any[]) {
      if (e.kennzeichen !== g.kennzeichen) merke('einbauten', e.kennzeichen);
    }
  }
  return { reg, doppelt };
};

/** Alle Verweise der Datei: Beschreibung, Ziel-Kennzeichen und die erlaubten Gattungen. */
const verweise = (): Array<[string, string, string[]]> => {
  const out: Array<[string, string, string[]]> = [];
  const ORT = ['bereiche', 'gebaeude', 'standorte'];
  for (const g of daten.gebaeude as any[]) out.push([`${g.kennzeichen}.standort`, g.standort, ['standorte']]);
  for (const b of daten.bereiche as any[]) out.push([`${b.kennzeichen}.eltern`, b.eltern, ['gebaeude', 'standorte']]);
  for (const n of daten.netzanschluesse as any[]) out.push([`${n.kennzeichen}.standort`, n.standort, ['standorte']]);
  for (const a of daten.anlagen as any[]) {
    out.push([`${a.kennzeichen}.standort`, a.standort, ['standorte']]);
    out.push([`${a.kennzeichen}.netzanschluss`, a.netzanschluss, ['netzanschluesse']]);
    for (const g of a.versorgt_gebaeude as string[]) out.push([`${a.kennzeichen}.versorgt_gebaeude`, g, ['gebaeude']]);
  }
  for (const b of daten.boxen as any[]) {
    out.push([`${b.kennzeichen}.heimat_anlage`, b.heimat_anlage, ['anlagen']]);
    if (b.fuehrend_fuer) out.push([`${b.kennzeichen}.fuehrend_fuer`, b.fuehrend_fuer, ['anlagen']]);
    if (b.ort) out.push([`${b.kennzeichen}.ort`, b.ort, ORT]);
    if (b.vorgaenger) out.push([`${b.kennzeichen}.vorgaenger`, b.vorgaenger, ['boxen']]);
  }
  for (const q of daten.datenquellen as any[]) out.push([`${q.kennzeichen}.anlage`, q.anlage, ['anlagen']]);
  for (const g of daten.geraete as any[]) out.push([`${g.kennzeichen}.datenquelle`, g.datenquelle, ['datenquellen']]);
  for (const k of daten.komponenten as any[]) {
    out.push([`${k.kennzeichen}.anlage`, k.anlage, ['anlagen']]);
    out.push([`${k.kennzeichen}.geraet`, k.geraet, ['geraete']]);
    if (k.ort) out.push([`${k.kennzeichen}.ort`, k.ort, ORT]);
  }
  for (const m of daten.messstellen as any[]) {
    if (m.ort.kennzeichen) {
      out.push([`${m.kennzeichen}.ort`, m.ort.kennzeichen, ['standorte', 'gebaeude', 'bereiche', 'unternehmen']]);
    }
    for (const p of m.prozesse as string[]) out.push([`${m.kennzeichen}.prozess`, p, ['prozesse']]);
    for (const k of m.kostenstellen_anteile as any[]) {
      out.push([`${m.kennzeichen}.kostenstelle`, k.kostenstelle, ['kostenstellen']]);
    }
    for (const st of m.elektrische_stellung as any[]) {
      out.push([`${m.kennzeichen}.stellung.anlage`, st.anlage, ['anlagen']]);
      if (st.unterzaehler_von) {
        out.push([`${m.kennzeichen}.unterzaehler_von`, st.unterzaehler_von, ['messstellen']]);
      }
    }
    if (m.geplante_elektrische_stellung) {
      out.push([`${m.kennzeichen}.geplante_stellung.anlage`, m.geplante_elektrische_stellung.anlage, ['anlagen']]);
      out.push([`${m.kennzeichen}.geplante_stellung.unterzaehler_von`, m.geplante_elektrische_stellung.unterzaehler_von, ['messstellen']]);
    }
    for (const q of alleQuellen(m)) {
      out.push([`${m.kennzeichen}.quelle.komponente`, q.komponente, ['komponenten']]);
      out.push([`${m.kennzeichen}.quelle.geraet`, q.geraet, ['geraete']]);
    }
    for (const q of alleVergleichsquellen(m)) {
      out.push([`${m.kennzeichen}.vergleich.komponente`, q.komponente, ['komponenten']]);
      out.push([`${m.kennzeichen}.vergleich.geraet`, q.geraet, ['geraete']]);
      for (const t of q.toleranz_fassungen ?? []) {
        out.push([`${m.kennzeichen}.vergleich.toleranz.person`, t.person, ['personen']]);
      }
    }
    // Fassung 1.2 (AP-09 W5): wer abgelesen hat, ist eine Person dieser Datei.
    for (const a of (m.ablesungen ?? []) as any[]) {
      out.push([`${m.kennzeichen}.ablesung.abgelesen_von`, a.abgelesen_von, ['personen']]);
    }
  }
  for (const p of daten.personen as any[]) {
    for (const s of p.standorte as string[]) out.push([`${p.kuerzel}.standort`, s, ['standorte']]);
    if (p.unterstuetzung) {
      out.push([`${p.kuerzel}.gewaehrt_von`, p.unterstuetzung.gewaehrt_von, ['personen']]);
    }
  }
  for (const u of daten.bewertung_umfang.fassungen as any[]) {
    for (const s of u.standorte as string[]) out.push(['bewertung_umfang.standort', s, ['standorte']]);
    out.push(['bewertung_umfang.person', u.person, ['personen']]);
  }
  for (const e of daten.energieeinsaetze as any[]) {
    out.push([`${e.kennzeichen}.prozess`, e.prozess, ['prozesse']]);
    out.push([`${e.kennzeichen}.verantwortlich`, e.verantwortlich, ['personen']]);
    for (const m of e.messstellen as string[]) out.push([`${e.kennzeichen}.messstelle`, m, ['messstellen']]);
    for (const i of e.einflussgroessen as any[]) {
      if (i.bezugsgroesse) out.push([`${e.kennzeichen}.einflussgroesse`, i.bezugsgroesse, ['bezugsgroessen']]);
    }
  }
  for (const k of daten.bewertung_kriterien as any[]) out.push(['bewertung_kriterien.person', k.person, ['personen']]);
  for (const e of daten.einstufungen as any[]) {
    out.push(['einstufung.einsatz', e.einsatz, ['energieeinsaetze']]);
    for (const f of e.fassungen as any[]) {
      out.push(['einstufung.person', f.person, ['personen']]);
      for (const i of f.herkunft.eingaenge as any[]) out.push(['einstufung.herkunft.eingang', i.objekt, ['messstellen']]);
    }
  }
  for (const b of daten.messbedarfe as any[]) {
    out.push(['messbedarf.einsatz', b.einsatz, ['energieeinsaetze']]);
    out.push(['messbedarf.ort', b.ort, ['bereiche', 'gebaeude', 'standorte']]);
    if (b.messstelle) out.push(['messbedarf.messstelle', b.messstelle, ['messstellen']]);
    out.push(['messbedarf.person', b.person, ['personen']]);
  }
  for (const a of daten.messmittel_angaben as any[]) {
    const gattung = a.ziel_art === 'geraet' ? 'geraete' : a.ziel_art === 'einbau' ? 'einbauten' : 'komponenten';
    out.push(['messmittel.ziel', a.ziel, [gattung]]);
    out.push(['messmittel.person', a.person, ['personen']]);
    if (a.beleg) out.push(['messmittel.beleg.person', a.beleg.person, ['personen']]);
  }
  for (const b of daten.bezugsgroessen as any[]) {
    if (b.geltung_art === 'prozess' && b.geltung) {
      out.push([`${b.kennzeichen}.geltung`, b.geltung, ['prozesse']]);
    }
    // Fassung 1.3 (AP-11 E13): die Gebäude-Stückzahlen BZ-6 und BZ-7.
    if (b.geltung_art === 'gebaeude' && b.geltung) out.push([`${b.kennzeichen}.geltung`, b.geltung, ['gebaeude']]);
    // Fassung 1.2 (AP-09 E1/W5): eine Bezugsgröße kann an einer Messstelle hängen.
    if (b.messstelle) out.push([`${b.kennzeichen}.messstelle`, b.messstelle, ['messstellen']]);
  }
  // Fassung 1.3 (AP-11 E13): eine Kennzahl verweist NUR über Kennzeichen — auf ihre Menge, ihre
  // Bezugsgröße (beim Stammdatum mit dem Gebäude), ihre Paare, ihr Geltungsobjekt und die Person.
  const GELTUNG: Record<string, string> = {
    unternehmen: 'unternehmen', standort: 'standorte', gebaeude: 'gebaeude', bereich: 'bereiche',
    prozess: 'prozesse', kostenstelle: 'kostenstellen', messstelle: 'messstellen',
  };
  for (const k of daten.kennzahlen as any[]) {
    out.push([`${k.kennzeichen}.geltung`, k.geltung, [GELTUNG[k.geltung_art]]]);
    out.push([`${k.kennzeichen}.verantwortlich`, k.verantwortlich, ['personen']]);
    if (k.zaehler) out.push([`${k.kennzeichen}.zaehler`, k.zaehler, ['messstellen']]);
    if (k.nenner) out.push([`${k.kennzeichen}.nenner`, k.nenner, ['bezugsgroessen']]);
    if (k.nenner_ort) out.push([`${k.kennzeichen}.nenner_ort`, k.nenner_ort, ['gebaeude']]);
    for (const p of (k.paare ?? []) as string[]) out.push([`${k.kennzeichen}.paar`, p, ['kennzahlen']]);
  }
  // Welcher Elternknoten wem erlaubt ist, prüft „hängt jeden Ort zeitgültig an seinen Elternknoten“.
  // Fassung 1.5 (AP-15 E8): Grenzen, gemeinsame Steuerung und Geräte-Rückfälle verweisen nur über Kennzeichen.
  for (const g of daten.netzanschluss_grenzen as any[]) out.push(['grenze.netzanschluss', g.netzanschluss, ['netzanschluesse']]);
  for (const v of daten.gemeinsame_steuerungen as any[]) {
    out.push([`${v.kennzeichen}.anlage`, v.anlage, ['anlagen']]);
    out.push([`${v.kennzeichen}.netzanschluss`, v.netzanschluss, ['netzanschluesse']]);
    for (const m of v.mitglieder as any[]) {
      out.push([`${v.kennzeichen}.mitglied`, m.box, ['boxen']]);
      out.push([`${v.kennzeichen}.messpunkt`, m.messpunkt, ['datenquellen']]);
    }
  }
  for (const r of daten.geraete_rueckfaelle as any[]) out.push(['rueckfall.komponente', r.komponente, ['komponenten']]);
  for (const z of daten.zeitachse as any[]) {
    if (z.gemeinsame_steuerung != null) out.push(['zeitachse.gemeinsame_steuerung', z.gemeinsame_steuerung, ['gemeinsame_steuerungen']]);
  }
  const VON: Record<string, string[]> = {
    ort_eltern: ['standorte', 'gebaeude', 'bereiche'],
    anlage_standort: ['anlagen'],
    messstelle_ort: ['messstellen'],
    datenquelle_box: ['datenquellen'],
  };
  const NACH: Record<string, string[]> = {
    ort_eltern: ['standorte', 'gebaeude'],
    anlage_standort: ['standorte'],
    messstelle_ort: ['standorte', 'gebaeude', 'bereiche', 'unternehmen'],
    datenquelle_box: ['boxen'],
  };
  for (const z of daten.zuordnungen as any[]) {
    out.push([`${z.art}.von`, z.von, VON[z.art]]);
    if (z.nach !== null) out.push([`${z.art}.nach`, z.nach, NACH[z.art]]);
  }
  return out;
};

describe('UEMS-Referenzunternehmen — Form', () => {
  it('hält ihr eigenes Schema', () => {
    expect(schemaVerstoesse(daten, schema)).toEqual([]);
  });

  it('hat den Umfang, den AP-00 §4.4 zusagt', () => {
    expect(daten.standorte).toHaveLength(2);
    expect(daten.gebaeude).toHaveLength(5);
    expect(daten.bereiche).toHaveLength(7);
    expect(daten.prozesse).toHaveLength(7);
    expect(daten.netzanschluesse).toHaveLength(3);
    expect(daten.anlagen).toHaveLength(3);
    // Fassung 1.5 (AP-15 E8): DQ-8 … DQ-10 mit GR-11 … GR-18 an Box Verwaltung.
    expect(daten.datenquellen).toHaveLength(10);
    expect(daten.geraete).toHaveLength(19);
    expect(daten.messstellen).toHaveLength(23);
    // Fassung 1.3 (AP-11 E13): BZ-6 und BZ-7 als Gebäude-Stückzahlen, fünf Kennzahlen.
    expect(daten.bezugsgroessen).toHaveLength(7);
    expect(daten.kennzahlen).toHaveLength(5);
    // Fassung 1.5 (AP-15 E8): eine gemeinsame Steuerung mit Grenzen an NA-1, die Abnahmefälle R1 … R22.
    expect(daten.netzanschluss_grenzen).toHaveLength(1);
    expect(daten.gemeinsame_steuerungen).toHaveLength(1);
    expect(daten.abnahmefaelle_ap15.faelle).toHaveLength(22);

    // Boxen, Komponenten und Kostenstellen tragen auch Objekte, die erst NACH
    // der Momentaufnahme entstehen (Nachfolger-Box E-2′, Energiekarte EK-7, die
    // Aufteilung der Kostenstelle 9000). AP-00 §4.4 zählt den Stand zur
    // Momentaufnahme.
    expect(
      (daten.boxen as any[]).filter((b) => laeuft(b, jetzt, 'in_betrieb_ab', 'ausgebaut_am')),
    ).toHaveLength(3);
    expect(
      (daten.komponenten as any[]).filter((k) => laeuft(k, jetzt, 'in_betrieb_ab', 'in_betrieb_bis')),
    ).toHaveLength(15);
    expect((daten.kostenstellen as any[]).filter((k) => giltAm(k, heute))).toHaveLength(5);

    const nachArt = (a: string) => (daten.messstellen as any[]).filter((m) => m.art === a).length;
    expect(nachArt('gemessen')).toBe(18);
    // Fassung 1.2 (AP-10 E19): MS-22 „Lindach nicht zugeordnet“ ist der Rest der
    // Bilanz von AN-3 — ohne ihn hätte Lindach eine unsichtbare Bilanzdifferenz.
    expect(nachArt('berechnet')).toBe(5);
  });
});

describe('UEMS-Referenzunternehmen — Kennzeichen', () => {
  it('vergibt jedes Kennzeichen nur einmal', () => {
    const { reg, doppelt } = register();
    expect(doppelt).toEqual([]);
    expect(reg.size).toBeGreaterThan(0);
  });

  it('lässt keinen Verweis ins Leere zeigen', () => {
    const { reg } = register();
    const fehler = verweise()
      .filter(([, ziel, gattungen]) => !reg.has(ziel) || !gattungen.includes(reg.get(ziel)!))
      .map(([was, ziel]) => `${was} -> ${ziel} (${reg.get(ziel) ?? 'unbekannt'})`);
    expect(fehler).toEqual([]);
    expect(verweise().length).toBeGreaterThan(0);
  });
});

describe('UEMS-Referenzunternehmen — Invarianten des Fachmodells', () => {
  /**
   * AP-00 §4.5 Regel 1, verfeinert durch AP-04 E1: Bezug und Abgabe sind zwei
   * Messstellen desselben physischen Zählers (MS-01/MS-02 an AN-1). Deshalb
   * gilt: je Anlage und Richtung genau ein Hauptzähler, und alle Hauptzähler
   * einer Anlage hängen an derselben Komponente.
   */
  it('führt je Anlage und Richtung genau einen Hauptzähler', () => {
    const haupt = new Map<string, any[]>();
    for (const m of daten.messstellen as any[]) {
      for (const st of m.elektrische_stellung as any[]) {
        if (st.stellung !== 'Hauptzähler' || !giltAm(st, heute)) continue;
        haupt.set(st.anlage, [...(haupt.get(st.anlage) ?? []), m]);
      }
    }
    for (const a of daten.anlagen as any[]) {
      const ms = haupt.get(a.kennzeichen) ?? [];
      expect(ms.length, `${a.kennzeichen}: Hauptzähler`).toBeGreaterThan(0);
      const richtungen = ms.map((m) => m.hauptgroesse.richtung);
      expect(new Set(richtungen).size, `${a.kennzeichen}: doppelte Richtung`).toBe(richtungen.length);
      const komponenten = new Set(
        ms.flatMap((m) => m.fuehrende_quelle.filter((q: any) => gilt(q, jetzt)).map((q: any) => q.komponente)),
      );
      expect(komponenten.size, `${a.kennzeichen}: EIN physischer Hauptzähler`).toBeLessThan(2);
    }
  });

  it('lässt die Kostenstellen-Anteile je Tag auf 100 % aufgehen', () => {
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      const stichtage = new Set<string>((m.kostenstellen_anteile as any[]).map((k) => k.gueltig_ab));
      for (const t of stichtage) {
        const summe = (m.kostenstellen_anteile as any[])
          .filter((k) => giltAm(k, t))
          .reduce((s, k) => s + k.anteil_prozent, 0);
        if (summe !== 100) fehler.push(`${m.kennzeichen} @ ${t}: ${summe} %`);
      }
    }
    expect(fehler).toEqual([]);
  });

  /**
   * AP-00 §4.5 Regel 2: eine GEMESSENE Messstelle hat je Zeitpunkt genau einen
   * Ort. Eine BERECHNETE hat höchstens einen — MS-20 „Prozess Spritzguss
   * gesamt“ läuft über zwei Gebäude und trägt deshalb keinen (AP-00 §4.4 selbst).
   */
  it('gibt jeder Messstelle genau einen Ort', () => {
    const orte = zuordnungen('messstelle_ort');
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      const zs = orte.get(m.kennzeichen) ?? [];
      if (ueberlappungenTage(zs).length) fehler.push(`${m.kennzeichen}: Ort-Zeiträume überlappen`);
      const stichtag = zs.some((z) => giltAm(z, heute)) || zs.length === 0
        ? heute
        : [...zs.map((z) => z.gueltig_ab as string)].sort()[0];
      const jetztGueltig = zs.filter((z) => giltAm(z, stichtag));
      const erwartet = m.art === 'gemessen' ? 1 : jetztGueltig.length;
      if (jetztGueltig.length !== erwartet || jetztGueltig.length > 1) {
        fehler.push(`${m.kennzeichen}: ${jetztGueltig.length} Orte zur Momentaufnahme`);
      }
      if (jetztGueltig.length === 0) {
        if (m.ort.art !== 'keiner') fehler.push(`${m.kennzeichen}: Ort ohne Zuordnung behauptet`);
      } else if (jetztGueltig[0].nach !== m.ort.kennzeichen) {
        fehler.push(`${m.kennzeichen}: Ort-Feld ${m.ort.kennzeichen} ≠ Zuordnung ${jetztGueltig[0].nach}`);
      }
    }
    expect(fehler).toEqual([]);
  });

  it('bindet je Größe und Zeitpunkt höchstens eine führende Quelle', () => {
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      const gruppen: Array<[string, any[]]> = [
        ['Hauptgröße', m.fuehrende_quelle],
        ...(m.nebengroessen as any[]).map(
          (n) => [`Nebengröße ${n.groesse}`, n.fuehrende_quelle] as [string, any[]],
        ),
      ];
      for (const [name, qs] of gruppen) {
        if (ueberlappungen(qs).length) fehler.push(`${m.kennzeichen} ${name}: zwei Quellen gleichzeitig`);
      }
    }
    expect(fehler).toEqual([]);
  });

  /**
   * AP-04 E3 / §4.3: Vergleichsquellen gibt es beliebig viele — aber nicht
   * DENSELBEN Messwert zweimal zur selben Zeit, und nie denselben Messwert zugleich
   * als führende Quelle derselben Größe. Der Zweck ist Pflicht (Schema).
   */
  it('lässt Vergleichsquellen nie überlappen und nie zugleich führen', () => {
    const fehler: string[] = [];
    const derselbe = (a: any, b: any) => a.komponente === b.komponente && a.kanal === b.kanal;
    for (const m of daten.messstellen as any[]) {
      const gruppen: Array<[string, any]> = [
        ['Hauptgröße', m],
        ...(m.nebengroessen as any[]).map((n): [string, any] => [`Nebengröße ${n.groesse}`, n]),
      ];
      for (const [name, g] of gruppen) {
        for (const v of g.vergleichsquellen as any[]) {
          if (ueberlappungen((g.vergleichsquellen as any[]).filter((x) => derselbe(x, v))).length) {
            fehler.push(`${m.kennzeichen} ${name}: derselbe Messwert zweimal`);
          }
          for (const f of (g.fuehrende_quelle as any[]).filter((x) => derselbe(x, v))) {
            if (ueberlappungen([f, v]).length) fehler.push(`${m.kennzeichen} ${name}: zugleich führend und Vergleich`);
          }
        }
      }
    }
    expect(fehler).toEqual([]);
    expect((daten.messstellen as any[]).flatMap(alleVergleichsquellen).length).toBeGreaterThan(0);
  });

  /**
   * AP-06 E1: je Datenquelle und Zeitpunkt genau eine zuständige Box — die
   * Zeiträume stoßen auf die Minute aneinander, ohne Lücke und ohne
   * Überlappung, und der letzte bleibt offen.
   */
  it('gibt jeder Datenquelle je Zeitpunkt genau eine zuständige Box', () => {
    const nachQuelle = zuordnungen('datenquelle_box');
    const fehler: string[] = [];
    for (const q of daten.datenquellen as any[]) {
      const zs = [...(nachQuelle.get(q.kennzeichen) ?? [])].sort(
        (a, b) => zeit(a.gueltig_ab) - zeit(b.gueltig_ab),
      );
      if (!zs.length) {
        fehler.push(`${q.kennzeichen}: keine zuständige Box`);
        continue;
      }
      for (let i = 0; i < zs.length - 1; i += 1) {
        if (ende(zs[i]) !== zeit(zs[i + 1].gueltig_ab)) {
          fehler.push(`${q.kennzeichen}: Lücke oder Überlappung der Zuständigkeit`);
        }
      }
      if (ende(zs[zs.length - 1]) !== OFFEN) {
        fehler.push(`${q.kennzeichen}: die letzte Zuständigkeit endet ohne Nachfolger`);
      }
    }
    expect(fehler).toEqual([]);
  });

  it('gibt jeder Anlage genau eine führende Box', () => {
    for (const a of daten.anlagen as any[]) {
      const fuehrend = (daten.boxen as any[]).filter(
        (b) => b.fuehrend_fuer === a.kennzeichen && laeuft(b, jetzt, 'in_betrieb_ab', 'ausgebaut_am'),
      );
      expect(fuehrend.map((b) => b.kennzeichen), `${a.kennzeichen}`).toHaveLength(1);
    }
  });

  /** AP-04 E12: „Unterzähler von“ verweist auf eine Messstelle DERSELBEN Anlage. */
  it('hält den elektrischen Baum in einer Anlage und ohne Selbstbezug', () => {
    const ms = new Map((daten.messstellen as any[]).map((m) => [m.kennzeichen, m]));
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      for (const st of m.elektrische_stellung as any[]) {
        if (st.stellung !== 'Unterzähler') {
          if (st.unterzaehler_von) fehler.push(`${m.kennzeichen}: „Unterzähler von“ ohne die Stellung`);
          continue;
        }
        if (!st.unterzaehler_von) {
          fehler.push(`${m.kennzeichen}: Stellung „Unterzähler“ ohne übergeordnete Messstelle`);
          continue;
        }
        if (st.unterzaehler_von === m.kennzeichen) {
          fehler.push(`${m.kennzeichen}: Unterzähler von sich selbst`);
          continue;
        }
        const ab: string = st.gueltig_ab;
        const gleicheAnlage = (ms.get(st.unterzaehler_von).elektrische_stellung as any[]).some(
          (e) => giltAm(e, ab) && e.anlage === st.anlage,
        );
        if (!gleicheAnlage) {
          fehler.push(`${m.kennzeichen} · ${st.anlage}: ${st.unterzaehler_von} ist zu dieser Zeit eine andere Anlage`);
        }
      }
    }
    expect(fehler).toEqual([]);
  });

  it('nennt in jeder Quellenbindung das Gerät und den Einbau, die wirklich dazugehören', () => {
    const komp = new Map((daten.komponenten as any[]).map((k) => [k.kennzeichen, k]));
    const einbauten = new Map(
      (daten.geraete as any[]).map((g) => [g.kennzeichen, new Set((g.einbauten as any[]).map((e) => e.kennzeichen))]),
    );
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      for (const q of [...alleQuellen(m), ...alleVergleichsquellen(m)]) {
        if (komp.get(q.komponente).geraet !== q.geraet) {
          fehler.push(`${m.kennzeichen}: ${q.komponente} hängt an ${komp.get(q.komponente).geraet}, nicht an ${q.geraet}`);
        }
        if (!einbauten.get(q.geraet)!.has(q.einbau)) {
          fehler.push(`${m.kennzeichen}: Einbau ${q.einbau} gehört nicht zu ${q.geraet}`);
        }
      }
    }
    expect(fehler).toEqual([]);
  });

  it('führt die Zeitachse chronologisch', () => {
    const zp = (daten.zeitachse as any[]).map((z) => zeit(z.zeitpunkt));
    expect(zp).toEqual([...zp].sort((a, b) => a - b));
    expect(zp.length).toBeGreaterThan(0);
  });

  it('lässt keine Zuordnungs-Zeiträume überlappen', () => {
    const nachSchluessel = new Map<string, any[]>();
    for (const z of daten.zuordnungen as any[]) {
      const s = `${z.art} · ${z.von}`;
      nachSchluessel.set(s, [...(nachSchluessel.get(s) ?? []), z]);
    }
    const fehler: string[] = [];
    for (const [name, zs] of nachSchluessel) {
      if ((TAGESGENAU.has(zs[0].art) ? ueberlappungenTage(zs) : ueberlappungen(zs)).length) fehler.push(name);
    }
    // Auch die Gültigkeiten, die AN einem Objekt hängen, überlappen nie.
    for (const o of [...(daten.standorte as any[]), ...(daten.gebaeude as any[])]) {
      if (ueberlappungenTage(o.bezugsflaechen).length) fehler.push(`Flächen ${o.kennzeichen}`);
    }
    for (const g of daten.geraete as any[]) {
      if (ueberlappungen(g.einbauten).length) fehler.push(`Einbauten ${g.kennzeichen}`);
    }
    for (const k of daten.komponenten as any[]) {
      if (ueberlappungen(k.wandler).length) fehler.push(`Wandler ${k.kennzeichen}`);
    }
    for (const m of daten.messstellen as any[]) {
      if (ueberlappungenTage(m.elektrische_stellung).length) fehler.push(`Stellung ${m.kennzeichen}`);
    }
    expect(fehler).toEqual([]);
  });

  /**
   * Eine Änderung beendet die alte Gültigkeit und beginnt eine neue (AP-00 §4.5
   * Regel 4) — ohne Loch und ohne doppelten Tag: tagesgenau beginnt die neue am
   * Tag NACH dem letzten der alten, auf die Minute ist Ende der alten = Beginn
   * der neuen. Und ein Tag „bis“ liegt nie vor seinem „ab“.
   */
  it('lässt jeden Wechsel anstoßen — am Folgetag oder auf die Minute', () => {
    const tage = new Map<string, any[]>();
    const minuten = new Map<string, any[]>();
    const dazu = (ziel: Map<string, any[]>, name: string, o: any) => ziel.set(name, [...(ziel.get(name) ?? []), o]);
    for (const z of daten.zuordnungen as any[]) {
      dazu(TAGESGENAU.has(z.art) ? tage : minuten, `${z.art} · ${z.von}`, z);
    }
    for (const o of [...(daten.standorte as any[]), ...(daten.gebaeude as any[])]) {
      tage.set(`Flächen ${o.kennzeichen}`, o.bezugsflaechen);
    }
    for (const m of daten.messstellen as any[]) {
      tage.set(`Stellung ${m.kennzeichen}`, m.elektrische_stellung);
      minuten.set(`Quelle ${m.kennzeichen}`, m.fuehrende_quelle);
      for (const n of m.nebengroessen as any[]) minuten.set(`Quelle ${m.kennzeichen} · ${n.groesse}`, n.fuehrende_quelle);
    }
    for (const g of daten.geraete as any[]) minuten.set(`Einbauten ${g.kennzeichen}`, g.einbauten);
    for (const k of daten.komponenten as any[]) minuten.set(`Wandler ${k.kennzeichen}`, k.wandler);

    const fehler: string[] = [];
    for (const [name, kette] of tage) {
      for (const o of kette) if (letzterTag(o) < o.gueltig_ab) fehler.push(`${name}: „bis“ ${o.gueltig_bis} vor „ab“ ${o.gueltig_ab}`);
      const s = [...kette].sort((a, b) => (a.gueltig_ab < b.gueltig_ab ? -1 : 1));
      for (let i = 0; i < s.length - 1; i += 1) {
        if (plusTage(letzterTag(s[i]), 1) !== s[i + 1].gueltig_ab) fehler.push(`${name}: ${s[i].gueltig_bis} → ${s[i + 1].gueltig_ab}`);
      }
    }
    for (const [name, kette] of minuten) {
      const s = [...kette].sort((a, b) => zeit(a.gueltig_ab) - zeit(b.gueltig_ab));
      for (let i = 0; i < s.length - 1; i += 1) {
        if (ende(s[i]) !== zeit(s[i + 1].gueltig_ab)) fehler.push(`${name}: ${s[i].gueltig_bis} → ${s[i + 1].gueltig_ab}`);
      }
    }
    expect(fehler).toEqual([]);
  });

  /**
   * Ortsbaum-Vertrag Regel 1 (`ziel_gab_es_noch_nicht`): eine tagesgenaue
   * Zuordnung hängt an jedem ihrer Tage an einem Ort, den es an diesem Tag gibt.
   * Ein Ort besteht, solange seine `ort_eltern`-Zuordnungen laufen; das
   * Unternehmen (U) besteht, seit es Kunde ist.
   */
  it('lässt keine Zuordnung vor ihrem Ziel beginnen', () => {
    const bestehen = zuordnungen('ort_eltern');
    const unternehmenSeit = lokalerTag(daten.unternehmen.kunde_seit, ZONE);
    const fehler: string[] = [];
    let geprueft = 0;
    for (const z of daten.zuordnungen as any[]) {
      if (!TAGESGENAU.has(z.art) || z.nach === null) continue;
      geprueft += 1;
      const name = `${z.art} · ${z.von} → ${z.nach} ab ${z.gueltig_ab}`;
      if (z.nach === UNTERNEHMEN) {
        if (z.gueltig_ab < unternehmenSeit) fehler.push(`${name}: vor dem Unternehmen`);
        continue;
      }
      const fehlt = ersterFehlenderTag(bestehen.get(z.nach) ?? [], z.gueltig_ab, letzterTag(z));
      if (fehlt !== null) fehler.push(`${name}: am ${fehlt} gab es ${z.nach} noch nicht`);
    }
    expect(fehler).toEqual([]);
    expect(geprueft).toBeGreaterThan(0);
  });

  /**
   * AP-02 E2: ein rückwirkender Eintrag ist erlaubt — aber sichtbar. Wer
   * `eingetragen_am` trägt, liegt vor diesem Tag und trägt GENAU das Abzeichen,
   * das der Ortsbaum-Vertrag bildet (Tage = Eintragstag − gilt ab,
   * `a3-anbau-14-tage-nicht-15`). Die Zeitachse nennt kein anderes.
   */
  it('gibt jedem rückwirkenden Eintrag das Abzeichen des Ortsbaum-Vertrags', () => {
    const eintraege: Array<[string, any]> = [
      ...(daten.zuordnungen as any[])
        .filter((z) => TAGESGENAU.has(z.art))
        .map((z): [string, any] => [`${z.art} · ${z.von} ab ${z.gueltig_ab}`, z]),
      ...[...(daten.standorte as any[]), ...(daten.gebaeude as any[])].flatMap((o) =>
        (o.bezugsflaechen as any[]).map((f): [string, any] => [`Fläche ${o.kennzeichen} ab ${f.gueltig_ab}`, f]),
      ),
    ];
    const abzeichen = new Set<string>();
    const fehler: string[] = [];
    for (const [name, e] of eintraege) {
      if (e.eingetragen_am === undefined && e.abzeichen === undefined) continue;
      abzeichen.add(e.abzeichen);
      if (!e.eingetragen_am || !e.abzeichen) {
        fehler.push(`${name}: Eintragstag und Abzeichen gehören zusammen`);
        continue;
      }
      const r = rueckwirkung({
        eingetragenUm: mitternacht(e.eingetragen_am, ZONE).iso,
        giltAb: e.gueltig_ab,
        giltBis: e.gueltig_bis,
        zeitzone: ZONE,
      });
      if (r.art !== 'rueckwirkend') fehler.push(`${name}: nicht rückwirkend (${r.art})`);
      if (r.abzeichen !== e.abzeichen) fehler.push(`${name}: „${e.abzeichen}“ statt „${r.abzeichen}“`);
    }
    for (const z of daten.zeitachse as any[]) {
      for (const treffer of (z.ereignis as string).match(ABZEICHEN) ?? []) {
        if (!abzeichen.has(treffer)) fehler.push(`Zeitachse ${z.zeitpunkt}: „${treffer}“ steht an keinem Eintrag`);
      }
    }
    expect(fehler).toEqual([]);
    expect(abzeichen.size).toBeGreaterThan(0);
  });

  /**
   * Jeder Ort hängt zeitgültig an seinem Elternknoten (Art `ort_eltern`) — ein
   * Gebäude an einem Standort, ein Bereich an einem Gebäude oder direkt am
   * Standort, ein Standort an keinem (sein Bestehen). Die festen Felder
   * `gebaeude[].standort` und `bereiche[].eltern` sind der Stand zur Momentaufnahme.
   */
  it('hängt jeden Ort zeitgültig an seinen Elternknoten', () => {
    const bestehen = zuordnungen('ort_eltern');
    const standorte = (daten.standorte as any[]).map((o) => o.kennzeichen as string);
    const gebaeude = (daten.gebaeude as any[]).map((o) => o.kennzeichen as string);
    const orte: Array<[string, string | null, string[]]> = [
      ...standorte.map((kz): [string, string | null, string[]] => [kz, null, []]),
      ...(daten.gebaeude as any[]).map((g): [string, string | null, string[]] => [g.kennzeichen, g.standort, standorte]),
      ...(daten.bereiche as any[]).map((b): [string, string | null, string[]] => [
        b.kennzeichen,
        b.eltern,
        [...gebaeude, ...standorte],
      ]),
    ];
    const fehler: string[] = [];
    for (const [ort, elternJetzt, erlaubt] of orte) {
      const zs = bestehen.get(ort) ?? [];
      if (!zs.length) fehler.push(`${ort}: ohne Zuordnung an einen Elternknoten`);
      for (const z of zs) {
        if (erlaubt.length === 0 ? z.nach !== null : !erlaubt.includes(z.nach)) fehler.push(`${ort} → ${z.nach} ist nicht erlaubt`);
      }
      const jetztGueltig = zs.filter((z) => giltAm(z, heute));
      if (jetztGueltig.length !== 1) fehler.push(`${ort}: ${jetztGueltig.length} Zuordnungen zur Momentaufnahme`);
      else if (jetztGueltig[0].nach !== elternJetzt) fehler.push(`${ort}: festes Feld ${elternJetzt} ≠ Zuordnung ${jetztGueltig[0].nach}`);
    }
    expect(fehler).toEqual([]);
  });

  /**
   * AP-03 E6/A4 (Entscheid firstmate 11.09.2026): das Enddatum einer Unterstützung ist ein
   * Kalendertag und gilt einschließlich; nur ein Notfall-Zugriff (E8) endet auf die Minute, genau
   * 24 h nach seinem Beginn. Die Zeitachse nennt den Ablauf zu dem Zeitpunkt, den der
   * Rechte-Vertrag daraus bildet (`bisZeitpunkt`).
   */
  it('lässt jede Unterstützung mit ihrem Enddatum enden', () => {
    const zeitachse = new Set((daten.zeitachse as any[]).map((z) => zeit(z.zeitpunkt)));
    const fehler: string[] = [];
    const unterstuetzer = (daten.personen as any[]).filter((p) => p.art === 'unterstuetzer');
    for (const p of unterstuetzer) {
      if (p.gueltig_bis === null) {
        fehler.push(`${p.kuerzel}: eine Unterstützung hat immer ein Ende (E6)`);
        continue;
      }
      if (String(p.unterstuetzung?.art ?? '').startsWith('Notfall')) {
        if (zeit(p.gueltig_bis) !== zeit(p.seit) + 24 * 3600 * 1000) fehler.push(`${p.kuerzel}: Notfall nicht genau 24 h`);
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(p.gueltig_bis)) {
        fehler.push(`${p.kuerzel}: Enddatum ${p.gueltig_bis} ist kein Kalendertag`);
      }
      const ablauf = zeit(bisZeitpunkt(p.gueltig_bis) as string);
      if (!zeitachse.has(ablauf)) fehler.push(`${p.kuerzel}: die Zeitachse nennt den Ablauf ${bisZeitpunkt(p.gueltig_bis)} nicht`);
    }
    expect(fehler).toEqual([]);
    expect(unterstuetzer.length).toBeGreaterThan(0);
  });

  /**
   * Ehrlichkeit der Zahlen: eine Messstelle ohne führende Quelle behauptet
   * keine Kadenz in Sekunden, und eine berechnete nennt ihre Formel.
   */
  it('behauptet keine Kadenz ohne Quelle und keine Rechnung ohne Formel', () => {
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      const hatQuelle = m.fuehrende_quelle.length > 0;
      const hatKadenz = m.kadenz_s != null;
      if (!hatQuelle && hatKadenz) fehler.push(`${m.kennzeichen}: Kadenz ohne führende Quelle`);
      if (hatQuelle && !hatKadenz) fehler.push(`${m.kennzeichen}: führende Quelle ohne Kadenz`);
      if (m.art === 'berechnet' && !m.formel) fehler.push(`${m.kennzeichen}: berechnet ohne Formel`);
    }
    expect(fehler).toEqual([]);
  });
});

describe('UEMS-Referenzunternehmen — Fassung 1.2', () => {
  const messstelle = (kz: string): any =>
    (daten.messstellen as any[]).find((m) => m.kennzeichen === kz);

  /**
   * AP-10 E19: jede BERECHNETE Messstelle nennt ihren Formel-Typ aus dem
   * geschlossenen Vokabular von `messstelle-formel.md` §0, jede gemessene nennt
   * keinen. Der Typ entscheidet die Richtungsregel — er darf nicht fehlen und
   * nicht geraten werden.
   */
  it('nennt je berechneter Messstelle ihren Formel-Typ', () => {
    const vokabular = new Set(['gewichtete_summe', 'rest', 'saldo']);
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      const berechnet = m.art === 'berechnet';
      if (berechnet && m.formel_typ == null) fehler.push(`${m.kennzeichen}: berechnet ohne formel_typ`);
      else if (berechnet && !vokabular.has(m.formel_typ)) {
        fehler.push(`${m.kennzeichen}: formel_typ außerhalb des Vokabulars: ${m.formel_typ}`);
      } else if (!berechnet && m.formel_typ != null) {
        fehler.push(`${m.kennzeichen}: gemessen, trägt aber einen formel_typ`);
      }
    }
    expect(fehler).toEqual([]);
  });

  /**
   * AP-10 §4 (E1/E3): jede berechnete Messstelle rechnet aus den Beispielwerten
   * ihrer EIGENEN Eingänge genau ihren eigenen Beispielwert. Das ist der Nachweis
   * der Berichtigung W10: MS-09 ist 54 580 kWh, weil ihre Formel aus ihren
   * Eingängen 54 580 ergibt — die 52 600 der Fassung 1.1 folgten aus keiner
   * Rechnung. Der Speicher geht mit ZWEI Anteilen ein (Laden als Abfluss,
   * Entladen als Zufluss), nie als Saldo (E4).
   */
  it.each([
    ['MS-09', [['MS-01', 1, 'oktober_2026_kwh'], ['MS-03', 1, 'oktober_2026_kwh'],
      ['MS-04', 1, 'oktober_2026_entladen_kwh'], ['MS-02', -1, 'oktober_2026_kwh'],
      ['MS-04', -1, 'oktober_2026_laden_kwh'], ['MS-05', -1, 'oktober_2026_kwh'],
      ['MS-06', -1, 'oktober_2026_kwh'], ['MS-07', -1, 'oktober_2026_kwh'],
      ['MS-08', -1, 'oktober_2026_kwh']]],
    ['MS-15', [['MS-10', 1, 'oktober_2026_kwh'], ['MS-11', -1, 'oktober_2026_kwh'],
      ['MS-12', -1, 'oktober_2026_kwh'], ['MS-13', -1, 'oktober_2026_kwh'],
      ['MS-14', -1, 'oktober_2026_kwh']]],
    ['MS-19', [['MS-01', 1, 'oktober_2026_kwh'], ['MS-10', 1, 'oktober_2026_kwh'],
      ['MS-16', 1, 'oktober_2026_kwh']]],
    ['MS-20', [['MS-06', 1, 'oktober_2026_kwh'], ['MS-11', 1, 'oktober_2026_kwh'],
      ['MS-07', 0.7, 'oktober_2026_kwh']]],
    ['MS-22', [['MS-16', 1, 'oktober_2026_kwh'], ['MS-17', -1, 'oktober_2026_kwh'],
      ['MS-18', -1, 'oktober_2026_kwh']]],
  ] as [string, [string, number, string][]][])(
    'rechnet %s aus den Beispielwerten seiner eigenen Eingänge',
    (kz, summanden) => {
      let summe = 0;
      for (const [quelle, faktor, feld] of summanden) {
        const wert = messstelle(quelle).beispielwerte[feld];
        // „keine Werte“ ist nie 0 — ein fehlender Eingang wäre kein Summand.
        expect(wert, `${kz}: Eingang ${quelle}.${feld}`).not.toBeNull();
        expect(wert, `${kz}: Eingang ${quelle}.${feld}`).not.toBeUndefined();
        summe += faktor * wert;
      }
      expect(Math.round(summe * 1e6) / 1e6).toBe(messstelle(kz).beispielwerte.oktober_2026_kwh);
    },
  );

  /**
   * Die PLAN-ABNAHME des Captains (AP-10 F1), an der Datei nachgerechnet:
   * 100 kWh am Hauptzähler, 60 und 30 kWh an den beiden Unterzählern — also
   * 100 kWh Gesamtverbrauch des Systems und 10 kWh Bilanzdifferenz.
   */
  it('rechnet die Plan-Abnahme des Werks Lindach am 18.10.2026', () => {
    const tag = (kz: string): number => messstelle(kz).beispielwerte.tag_2026_10_18_kwh;
    expect(tag('MS-16') - tag('MS-17') - tag('MS-18')).toBe(tag('MS-22'));
    expect(tag('MS-16')).toBe(tag('MS-17') + tag('MS-18') + tag('MS-22'));
    expect(messstelle('MS-22').hauptgroesse.richtung).toBe('Bezug');
    expect(messstelle('MS-22').ort.art).toBe('keiner');
    expect(messstelle('MS-22').fuehrende_quelle).toEqual([]);

    expect(messstelle('MS-16').elektrische_stellung[0].stellung).toBe('Hauptzähler');
    for (const kz of ['MS-17', 'MS-18']) {
      expect(messstelle(kz).elektrische_stellung[0].stellung).toBe('Unterzähler');
      expect(messstelle(kz).elektrische_stellung[0].unterzaehler_von).toBe('MS-16');
    }
  });

  /**
   * AP-10 W8: ein Kostenstellen-Anteil gilt nie über das Bestehen seiner
   * Kostenstelle hinaus. Läuft die Kostenstelle aus, endet der Anteil mit ihr —
   * danach ist die Messstelle ehrlich „nicht verteilt“, nie still umgehängt.
   */
  it('lässt keinen Anteil länger gelten als seine Kostenstelle', () => {
    const kostenstellen = new Map<string, any>(
      (daten.kostenstellen as any[]).map((k) => [k.kennzeichen, k]),
    );
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      for (const a of m.kostenstellen_anteile as any[]) {
        const k = kostenstellen.get(a.kostenstelle);
        if (!k) {
          fehler.push(`${m.kennzeichen}: Kostenstelle ${a.kostenstelle} fehlt`);
          continue;
        }
        if (a.gueltig_ab < k.gueltig_ab) {
          fehler.push(`${m.kennzeichen} -> ${a.kostenstelle}: beginnt vor der Kostenstelle`);
        }
        if (letzterTag(a) > letzterTag(k)) {
          fehler.push(`${m.kennzeichen} -> ${a.kostenstelle}: gilt länger als die Kostenstelle`);
        }
      }
    }
    expect(fehler).toEqual([]);
  });

  /**
   * AP-09 W5: eine Ablesung ist ein STAND zu einem Zeitpunkt. Die Stände steigen
   * (ein Rücksprung wäre ein Zählerwechsel, nie eine negative Menge), die ERSTE
   * Ablesung schließt keinen Zeitraum und trägt deshalb keine Monatszuordnung, und
   * ein zugeordneter Monat wird von seinem Ablesezeitraum tatsächlich berührt —
   * zwischen zwei Ablesungen wird nichts interpoliert.
   */
  it('führt die Ablesungen als lückenlose Kette von Ständen', () => {
    const fehler: string[] = [];
    let geprueft = 0;
    for (const m of daten.messstellen as any[]) {
      const ablesungen = (m.ablesungen ?? []) as any[];
      if (ablesungen.length === 0) continue;
      geprueft += 1;
      if (m.fuehrende_quelle.length > 0) {
        fehler.push(`${m.kennzeichen}: eine abgelesene Messstelle hat keinen Kanal`);
      }
      ablesungen.forEach((a, i) => {
        if (a.einheit !== m.hauptgroesse.einheit) {
          fehler.push(`${m.kennzeichen}: die Ablesung misst nicht die Hauptgröße`);
        }
        if (i === 0) {
          if (a.zuordnung_monat !== null) {
            fehler.push(`${m.kennzeichen}: die erste Ablesung ordnet keinen Monat zu`);
          }
          return;
        }
        const vor = ablesungen[i - 1];
        if (zeit(a.zeitpunkt) <= zeit(vor.zeitpunkt)) {
          fehler.push(`${m.kennzeichen}: die Ablesungen stehen nicht in der Reihenfolge ihrer Zeitpunkte`);
        }
        if (a.stand < vor.stand) {
          fehler.push(`${m.kennzeichen}: ein kleinerer Stand ist ein Zählerwechsel, nie eine negative Menge`);
        }
        if (a.zuordnung_monat != null) {
          const von = lokalerTag(vor.zeitpunkt, ZONE).slice(0, 7);
          const bis = lokalerTag(a.zeitpunkt, ZONE).slice(0, 7);
          if (a.zuordnung_monat < von || a.zuordnung_monat > bis) {
            fehler.push(`${m.kennzeichen}: der Monat ${a.zuordnung_monat} liegt außerhalb des Ablesezeitraums`);
          }
        }
      });
    }
    expect(fehler).toEqual([]);
    expect(geprueft).toBeGreaterThan(0);
  });

  /**
   * AP-09 E1/E4/E7 (W5): die Kennungen einer Bezugsgröße stehen im GESCHLOSSENEN
   * Vokabular des Bezugsdaten-Vertrags, nicht in einer eigenen Schreibweise. Der
   * freie Text der Fassung 1.1 („kg Granulat“) bleibt daneben stehen; der Stoff
   * wandert nicht in die Einheit. Und eine Größe, die an einer Messstelle hängt,
   * nennt genau eine — keine andere trägt das Feld.
   */
  it('nutzt je Bezugsgröße das geschlossene Vokabular des Bezugsdaten-Vertrags', () => {
    const vertrag = JSON.parse(
      readFileSync(resolve(WURZEL, 'bezugsdaten-vectors.json'), 'utf8'),
    ) as Record<string, any>;
    const einheiten = new Set<string>(Object.values(vertrag.einheiten as Record<string, string[]>).flat());
    const perioden = new Set<string>(vertrag.vokabulare.periode_art);
    const wertarten = new Set<string>(vertrag.vokabulare.wertart);
    // Die Fassung 1.1 kennt zusätzlich „ort“ für eine Größe, die an vielen Orten
    // hängt (BZ-4 Bezugsfläche) — sie bleibt unverändert gültig.
    const geltungsarten = new Set<string>([...(vertrag.vokabulare.geltung_art as string[]), 'ort']);

    const fehler: string[] = [];
    for (const b of daten.bezugsgroessen as any[]) {
      if (b.einheit_code == null) fehler.push(`${b.kennzeichen}: ohne einheit_code`);
      else if (!einheiten.has(b.einheit_code)) {
        fehler.push(`${b.kennzeichen}: einheit_code außerhalb des Vokabulars: ${b.einheit_code}`);
      } else if (!String(b.einheit).startsWith(b.einheit_code)) {
        fehler.push(`${b.kennzeichen}: einheit_code passt nicht zum Text „${b.einheit}“`);
      }
      if (b.periode_code != null && !perioden.has(b.periode_code)) {
        fehler.push(`${b.kennzeichen}: periode_code außerhalb des Vokabulars: ${b.periode_code}`);
      }
      if (b.wertart == null || !wertarten.has(b.wertart)) {
        fehler.push(`${b.kennzeichen}: wertart fehlt oder steht außerhalb des Vokabulars`);
      }
      // Ein Stammdatum gilt zeitlich; es hat keine Periode, und ein Periodenwert
      // hat immer eine — „null“ heißt hier „keine“, nie „unbekannt“.
      if ((b.wertart === 'stammdatum') === (b.periode_code != null)) {
        fehler.push(`${b.kennzeichen}: Wertart und periode_code passen nicht zusammen`);
      }
      if (!geltungsarten.has(b.geltung_art)) {
        fehler.push(`${b.kennzeichen}: geltung_art außerhalb des Vokabulars: ${b.geltung_art}`);
      }
      if ((b.geltung_art === 'messstelle') !== (b.messstelle != null)) {
        fehler.push(`${b.kennzeichen}: das Feld \`messstelle\` gehört genau zur geltung_art „messstelle“`);
      }
    }
    expect(fehler).toEqual([]);
  });
});

/** So viele Zeilen hatte `_comment` in Fassung 1.3 — Fassung 1.4 hängt nur an. */
const KOMMENTAR_ZEILEN_1_3 = 80;

/**
 * Nimmt GENAU die Zusätze der Fassung 1.4 heraus (AP-12 IP-2) — die Blöcke `korrekturen` und
 * `berichte`, die vier Zeilen der Zeitachse aus AP-12, die Herkunft `fassung_1_4` und die angehängten
 * Kommentarzeilen — und setzt Fassung und Stand auf 1.3 zurück.
 */
const ohneFassung14 = (d: Record<string, any>): void => {
  expect(d.version).toBe('1.4');
  d.version = '1.3';
  d.stand = '2026-09-14';
  expect(d._comment.length).toBeGreaterThan(KOMMENTAR_ZEILEN_1_3);
  d._comment = d._comment.slice(0, KOMMENTAR_ZEILEN_1_3);
  expect(d._herkunft.fassung_1_4).toBeDefined();
  delete d._herkunft.fassung_1_4;
  expect(d.korrekturen).toBeDefined();
  delete d.korrekturen;
  expect(d.berichte).toBeDefined();
  delete d.berichte;
  const zeilen = d.zeitachse.length;
  d.zeitachse = d.zeitachse.filter((z: any) => !z.herkunft.startsWith('AP-12'));
  expect(zeilen - d.zeitachse.length).toBe(4);
};

/** So viele Zeilen hatte `_comment` in Fassung 1.4 — Fassung 1.5 hängt nur an. */
const KOMMENTAR_ZEILEN_1_4 = 89;
/** Die Datenquellen, die Fassung 1.5 der Box Verwaltung gibt (AP-15 E8). */
const QUELLEN_1_5 = new Set(['DQ-8', 'DQ-9', 'DQ-10']);

/**
 * Nimmt GENAU die Zusätze der Fassung 1.5 heraus (AP-15 IP-1) — Box E-4/E-4′, DQ-8 … DQ-10 mit ihren Geräten,
 * Komponenten und Zuständigkeiten, die Blöcke `netzanschluss_grenzen`, `gemeinsame_steuerungen`,
 * `geraete_rueckfaelle` und `abnahmefaelle_ap15`, die sechs Zeilen der Zeitachse aus AP-15, die Herkunft
 * `fassung_1_5` und die angehängten Kommentarzeilen — und setzt Fassung und Stand auf 1.4 zurück.
 */
const ohneFassung15 = (d: Record<string, any>): void => {
  expect(d.version).toBe('1.5');
  d.version = '1.4';
  d.stand = '2026-09-15';
  expect(d._comment.length).toBeGreaterThan(KOMMENTAR_ZEILEN_1_4);
  d._comment = d._comment.slice(0, KOMMENTAR_ZEILEN_1_4);
  expect(d._herkunft.fassung_1_5).toBeDefined();
  delete d._herkunft.fassung_1_5;
  for (const block of ['netzanschluss_grenzen', 'gemeinsame_steuerungen', 'geraete_rueckfaelle', 'abnahmefaelle_ap15']) {
    expect(d[block], block).toBeDefined();
    delete d[block];
  }
  const geraete = new Set(
    (d.geraete as any[]).filter((g) => QUELLEN_1_5.has(g.datenquelle)).map((g) => g.kennzeichen as string),
  );
  const entferne = (liste: string, weg: (o: any) => boolean, erwartet: number) => {
    const vorher = d[liste].length;
    d[liste] = d[liste].filter((o: any) => !weg(o));
    expect(vorher - d[liste].length, liste).toBe(erwartet);
  };
  entferne('boxen', (b) => ['E-4', 'E-4′'].includes(b.kennzeichen), 2);
  entferne('datenquellen', (q) => QUELLEN_1_5.has(q.kennzeichen), 3);
  entferne('geraete', (g) => geraete.has(g.kennzeichen), 8);
  entferne('komponenten', (k) => geraete.has(k.geraet), 8);
  entferne('zuordnungen', (z) => QUELLEN_1_5.has(z.von), 6);
  entferne('zeitachse', (z) => z.gemeinsame_steuerung != null, 6);
};

/** Nimmt GENAU die Zusätze der Fassung 1.6 heraus (AP-16 IP-1, E11). */
const ohneFassung16 = (d: Record<string, any>): void => {
  expect(d.version).toBe('1.6');
  d.version = '1.5';
  d.stand = '2026-09-21';
  d.beschreibung = d.beschreibung.replace(', erweitert um energetische Bewertung und Messplanung', '');
  expect(d._comment.length).toBeGreaterThan(111);
  d._comment = d._comment.slice(0, 111);
  expect(d._herkunft.fassung_1_6).toBeDefined();
  delete d._herkunft.fassung_1_6;
  for (const block of ['bewertung_umfang', 'energieeinsaetze', 'bewertung_kriterien', 'einstufungen', 'messbedarfe', 'messmittel_angaben', 'abnahmefaelle_ap16']) {
    expect(d[block], block).toBeDefined();
    delete d[block];
  }
  const entferne = (liste: string, weg: (o: any) => boolean, erwartet: number) => {
    const vorher = d[liste].length;
    d[liste] = d[liste].filter((o: any) => !weg(o));
    expect(vorher - d[liste].length, liste).toBe(erwartet);
  };
  entferne('prozesse', (p) => p.kennzeichen === 'P-7', 1);
  entferne('geraete', (g) => g.kennzeichen === 'GR-19', 1);
  entferne('komponenten', (k) => k.kennzeichen === 'K-15', 1);
  entferne('messstellen', (m) => m.kennzeichen === 'MS-23', 1);
  entferne('zuordnungen', (z) => z.von === 'MS-23', 1);
  entferne('berichte', (b) => b.kennung.startsWith('BW-'), 2);
  entferne('zeitachse', (z) => z.herkunft.startsWith('AP-16'), 11);
  const dq3 = d.datenquellen.find((q: any) => q.kennzeichen === 'DQ-3');
  dq3.geraete_ids = [1, 2, 3, 4];
  dq3.weg = 'Modbus TCP 192.168.10.31:502, Geräte-IDs 1–4';
  dq3.kanaele = 8;
  dq3.hinweis = 'Multi-Zähler-Gateway in der Unterverteilung Halle 1 — vier Zähler hinter EINER Adresse';
  const ms01 = d.messstellen.find((m: any) => m.kennzeichen === 'MS-01');
  expect(ms01.nebengroessen[0].vergleichsquellen[0].toleranz_fassungen).toBeDefined();
  delete ms01.nebengroessen[0].vergleichsquellen[0].toleranz_fassungen;
};

/** So viele Zeilen hatte `_comment` in Fassung 1.6 — Fassung 1.7 hängt nur an. */
const KOMMENTAR_ZEILEN_1_6 = 118;
const ZEITACHSE_K1_1_6 = 'als Vergleichsquelle der Wirkleistung, Zweck';
const ZEITACHSE_K1_1_7 = 'als Vergleichsquelle der Wirkleistung und — aus der Leistung integriert — der Wirkenergie Bezug, Zweck';

/** Nimmt GENAU die Zusätze der Fassung 1.7 heraus (K-1 auch an der Hauptgröße, Toleranz dort, R9; Befund aus PR 1104). */
const ohneFassung17 = (d: Record<string, any>): void => {
  expect(d.version).toBe('1.7');
  d.version = '1.6';
  d.stand = '2026-09-22';
  expect(d._comment.length).toBeGreaterThan(KOMMENTAR_ZEILEN_1_6);
  d._comment = d._comment.slice(0, KOMMENTAR_ZEILEN_1_6);
  expect(d._herkunft.fassung_1_7).toBeDefined();
  delete d._herkunft.fassung_1_7;
  const ms01 = d.messstellen.find((m: any) => m.kennzeichen === 'MS-01');
  expect(ms01.vergleichsquellen.map((q: any) => q.komponente)).toEqual(['K-1']);
  const [k1] = ms01.vergleichsquellen;
  expect(k1.herleitung).toBe('integration');
  ms01.vergleichsquellen = [];
  const [neben] = ms01.nebengroessen[0].vergleichsquellen;
  const { herleitung: _h, toleranz_fassungen: toleranz, ...ohne } = k1;
  expect(neben).toEqual(ohne);
  neben.toleranz_fassungen = toleranz;
  const zeile = d.zeitachse.filter((z: any) => z.ereignis.includes(ZEITACHSE_K1_1_7));
  expect(zeile).toHaveLength(1);
  zeile[0].ereignis = zeile[0].ereignis.replace(ZEITACHSE_K1_1_7, ZEITACHSE_K1_1_6);
  const ap16 = d.abnahmefaelle_ap16;
  ap16.quelle = ap16.quelle.replace('R7, R8, R9, R12', 'R7, R8, R12');
  const vorher = ap16.faelle.length;
  ap16.faelle = ap16.faelle.filter((f: any) => f.fall !== 'R9');
  expect(vorher - ap16.faelle.length).toBe(1);
};

describe('UEMS-Referenzunternehmen — Fassung 1.3 (AP-11 E13)', () => {
  /** Der Fingerabdruck der Fassung 1.2, kanonisch geschrieben, aus origin/uems vor AP-11 IP-2 — derselbe wie im Java-Zwilling. */
  const FASSUNG_1_2_SHA256 = '33d0893e68193b0503b2dfcd6903e1f5743fb53f6ff49019a52221c0d73d25bd';
  /** So viele Zeilen hatte `_comment` in Fassung 1.2 — Fassung 1.3 hängt nur an. */
  const KOMMENTAR_ZEILEN_1_2 = 64;

  /** Kanonisch: Schlüssel sortiert, kein Leerraum, Zahlen in ihrer kürzesten Schreibweise („46“, nie „46.0“). */
  const kanonisch = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`;
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(x);
  };

  /**
   * Diff-Test: nimmt man GENAU die Zusätze der Fassung 1.3 heraus und setzt Fassung und Stand
   * zurück, ist die Datei Zeichen für Zeichen die Fassung 1.2 — kein Feld hat seinen Wert geändert.
   */
  it('ist ohne ihre Zusätze Zeichen für Zeichen die Fassung 1.2', () => {
    const d = structuredClone(daten) as Record<string, any>;
    ohneFassung17(d);
    ohneFassung16(d);
    ohneFassung15(d);
    ohneFassung14(d);
    expect(d.version).toBe('1.3');
    d.version = '1.2';
    d.stand = '2026-09-12';
    expect(d._comment.length).toBeGreaterThan(KOMMENTAR_ZEILEN_1_2);
    d._comment = d._comment.slice(0, KOMMENTAR_ZEILEN_1_2);
    expect(d._herkunft.fassung_1_3).toBeDefined();
    delete d._herkunft.fassung_1_3;
    const bezugsgroessen = d.bezugsgroessen.length;
    d.bezugsgroessen = d.bezugsgroessen.filter((b: any) => !['BZ-6', 'BZ-7'].includes(b.kennzeichen));
    expect(bezugsgroessen - d.bezugsgroessen.length).toBe(2);
    expect(d.kennzahlen).toBeDefined();
    delete d.kennzahlen;
    const zeilen = d.zeitachse.length;
    d.zeitachse = d.zeitachse.filter(
      (z: any) => !(z.zeitpunkt === '2026-11-03T00:00:00+01:00' && z.herkunft.startsWith('AP-11')),
    );
    expect(zeilen - d.zeitachse.length).toBe(1);
    expect(createHash('sha256').update(kanonisch(d), 'utf8').digest('hex')).toBe(FASSUNG_1_2_SHA256);
  });

  /**
   * BZ-6 + BZ-7 = BZ-2; jede Kennzahl rechnet ihren Oktoberwert aus den Werten, auf die ihre
   * Kennzeichen zeigen; eine Zusammenfassung ist Summe durch Summe und nie die festgehaltene Zahl,
   * die NICHT entsteht; `kennzahl_beispiel` ist KZ-0004 auf 2 Stellen.
   */
  it('rechnet jede Kennzahl aus ihren Kennzeichen — Summe durch Summe, BZ-6 + BZ-7 = BZ-2', () => {
    const bz = new Map<string, any>((daten.bezugsgroessen as any[]).map((b) => [b.kennzeichen, b]));
    const kz = new Map<string, any>((daten.kennzahlen as any[]).map((k) => [k.kennzeichen, k]));
    expect([...kz.keys()]).toEqual(['KZ-0001', 'KZ-0002', 'KZ-0003', 'KZ-0004', 'KZ-0005']);
    expect(bz.get('BZ-6').oktober_2026_wert + bz.get('BZ-7').oktober_2026_wert).toBe(bz.get('BZ-2').oktober_2026_wert);
    const vier = (x: number): number => Math.round(x * 10000) / 10000;
    const flaecheAm = (gebaeude: string, tag: string): number | null =>
      ((daten.gebaeude as any[]).find((g) => g.kennzeichen === gebaeude)?.bezugsflaechen as any[] ?? [])
        .find((f) => giltAm(f, tag))?.flaeche_m2 ?? null;
    const fehler: string[] = [];
    for (const k of kz.values()) {
      if (k.rechenform === 'zusammenfassung') {
        const paare = (k.paare as string[]).map((p) => kz.get(p));
        const z = paare.reduce((s, p) => s + p.oktober_2026_zaehler, 0);
        const n = paare.reduce((s, p) => s + p.oktober_2026_nenner, 0);
        if (z !== k.oktober_2026_zaehler || n !== k.oktober_2026_nenner) {
          fehler.push(`${k.kennzeichen}: Zähler und Nenner sind nicht die Summen der Paare`);
        }
        if (k.mittel_ungewichtet_nicht_gebildet === k.oktober_2026_wert) {
          fehler.push(`${k.kennzeichen}: der Wert ist die Zahl, die nicht entstehen darf`);
        }
      } else {
        const soll = k.nenner_ort ? flaecheAm(k.nenner_ort, '2026-10-31') : bz.get(k.nenner).oktober_2026_wert;
        if (soll !== k.oktober_2026_nenner) fehler.push(`${k.kennzeichen}: Nenner ist nicht der Wert von ${k.nenner}`);
      }
      const wert = vier(k.oktober_2026_zaehler / k.oktober_2026_nenner);
      if (wert !== k.oktober_2026_wert) fehler.push(`${k.kennzeichen}: ${wert}, nicht ${k.oktober_2026_wert}`);
    }
    expect(fehler).toEqual([]);
    expect(daten.kennzahl_beispiel.ergebnis).toBe(Math.round(kz.get('KZ-0004').oktober_2026_wert * 100) / 100);
  });
});

describe('UEMS-Referenzunternehmen — Fassung 1.4 (AP-12 E15)', () => {
  /** Der Fingerabdruck der Fassung 1.3, kanonisch geschrieben, aus origin/uems vor AP-12 IP-2 — derselbe wie im Java-Zwilling. */
  const FASSUNG_1_3_SHA256 = 'e65be4ed56d5f3cec687075f0a782c4e1807c82410f8962444272dc200424196';

  const kanonisch = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`;
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(x);
  };

  it('ist ohne ihre Zusätze Zeichen für Zeichen die Fassung 1.3', () => {
    const d = structuredClone(daten) as Record<string, any>;
    ohneFassung17(d);
    ohneFassung16(d);
    ohneFassung15(d);
    ohneFassung14(d);
    expect(createHash('sha256').update(kanonisch(d), 'utf8').digest('hex')).toBe(FASSUNG_1_3_SHA256);
  });

  /**
   * Die Korrektur berichtigt die Zahl der Datei; Nr. 1 zitiert die Zahl der Datei in Version 1, Nr. 2
   * die Korrektur in Version 2; MS-15 ist in beiden die Formel; jeder Stand nennt nur Kennzeichen der
   * Datei; Datenstand vor Freigabe; Nr. 2 trägt den Datenstand der Kaskade; „ersetzt durch“ zeigt auf
   * den Nachfolger.
   */
  it('Korrektur und Bericht stimmen mit der Datei: Zahl der Datei, Korrektur, Formel, Datenstand, ersetzt durch', () => {
    const ms = new Map<string, any>((daten.messstellen as any[]).map((m) => [m.kennzeichen, m]));
    const bz = new Map<string, any>((daten.bezugsgroessen as any[]).map((b) => [b.kennzeichen, b]));
    const kz = new Map<string, any>((daten.kennzahlen as any[]).map((k) => [k.kennzeichen, k]));
    const personen = new Set((daten.personen as any[]).map((p) => p.kuerzel));
    const standorte = new Set((daten.standorte as any[]).map((s) => s.kennzeichen));
    const vier = (x: number): number => Math.round(x * 10000) / 10000;
    const oktober = (kennzeichen: string): number => ms.get(kennzeichen).beispielwerte.oktober_2026_kwh;
    const formel = (messstelle: string, ersetzt: string, durch: number): number => {
      let summe = 0;
      let vorzeichen = 1;
      for (const teil of (ms.get(messstelle).formel as string).split(' ')) {
        if (teil === '−' || teil === '+') {
          vorzeichen = teil === '+' ? 1 : -1;
          continue;
        }
        summe += vorzeichen * (teil === ersetzt ? durch : oktober(teil));
      }
      return summe;
    };
    const fehler: string[] = [];
    const k = daten.korrekturen[0];
    if (k.alt_kwh !== oktober(k.reihe)) fehler.push('Korrektur: alt ist nicht die Oktober-Zahl der Reihe');
    if (k.zeitraum_von !== '2026-10-01' || k.zeitraum_bis !== '2026-10-31' || k.periode !== '2026-10') fehler.push('Korrektur: nicht der Oktober 2026');
    if (!personen.has(k.vorgeschlagen_von) || !personen.has(k.freigegeben_von)) fehler.push('Korrektur: unbekannte Person');
    if (!(zeit(k.vorgeschlagen_am) < zeit(k.freigegeben_am))) fehler.push('Korrektur: freigegeben vor dem Vorschlag');
    if (formel('MS-15', k.reihe, k.alt_kwh) !== oktober('MS-15')) fehler.push('MS-15 ist mit der Zahl der Datei nicht seine Formel');
    const nenner1 = bz.get(kz.get('KZ-0001').nenner).oktober_2026_wert;
    const kz2 = kz.get('KZ-0002');
    const soll: Record<string, number> = {
      [k.reihe]: k.neu_kwh,
      'MS-15': formel('MS-15', k.reihe, k.neu_kwh),
      'KZ-0001': vier(k.neu_kwh / nenner1),
      'KZ-0003': vier((k.neu_kwh + kz2.oktober_2026_zaehler) / (nenner1 + kz2.oktober_2026_nenner)),
    };
    expect((k.folgen as any[]).map((f) => f.objekt)).toEqual(Object.keys(soll));
    for (const f of k.folgen as any[]) {
      if (f.wert !== soll[f.objekt] || f.version !== 2) fehler.push(`Folge ${f.objekt}: ${f.wert} v${f.version} statt ${soll[f.objekt]} v2`);
    }
    const b = daten.berichte[0];
    if (!standorte.has(b.geltung)) fehler.push(`Bericht: Geltung ${b.geltung} gibt es nicht`);
    const quellen = new Set(b.quellen as string[]);
    for (const q of quellen) if (!ms.has(q) && !bz.has(q) && !kz.has(q)) fehler.push(`Bericht: Quelle ${q} gibt es nicht`);
    const erste: Record<string, number> = { [k.reihe]: k.alt_kwh, 'MS-15': formel('MS-15', k.reihe, k.alt_kwh), 'KZ-0001': kz.get('KZ-0001').oktober_2026_wert };
    (b.staende as any[]).forEach((st, i) => {
      const nr = `Nr. ${st.nr}`;
      if (st.nr !== i + 1) fehler.push(`${nr}: Nummern nicht lückenlos`);
      if (!(zeit(st.datenstand) < zeit(st.freigegeben_am))) fehler.push(`${nr}: Datenstand nicht vor der Freigabe`);
      if (!personen.has(st.freigegeben_von)) fehler.push(`${nr}: unbekannte Person`);
      const letzter = i === b.staende.length - 1;
      if (letzter ? st.ersetzt_durch !== null : st.ersetzt_durch !== i + 2) fehler.push(`${nr}: ersetzt_durch zeigt nicht auf den Nachfolger`);
      const zahlen = i === 0 ? erste : soll;
      for (const w of st.werte as any[]) {
        if (!quellen.has(w.objekt)) fehler.push(`${nr}: ${w.objekt} steht nicht im Quellenverzeichnis`);
        if (w.wert !== zahlen[w.objekt] || w.version !== (i === 0 ? 1 : 2)) fehler.push(`${nr}: ${w.objekt} = ${w.wert} v${w.version}`);
      }
    });
    const [nr1, nr2] = b.staende as any[];
    if (nr1.anlass !== null || nr2.anlass !== k.kennung) fehler.push('Anlass: Nr. 1 ohne, Nr. 2 mit der Korrektur');
    if (zeit(nr2.datenstand) !== zeit(k.freigegeben_am)) fehler.push('Nr. 2: Datenstand ist nicht der der Kaskade');
    if (!(zeit(nr1.freigegeben_am) < zeit(k.freigegeben_am))) fehler.push('Nr. 1 ist nicht vor der Korrektur freigegeben');
    if (zeit(nr1.datenstand) < zeit('2026-11-08T00:00:00+01:00')) fehler.push('Nr. 1: Datenstand vor „endgültig ab“ des Oktobers');
    const abweichungen = (nr1.werte as any[]).filter((w: any, i: number) => w.wert !== nr2.werte[i].wert || w.version !== nr2.werte[i].version).length;
    if (nr2.abweichungen !== abweichungen) fehler.push(`Nr. 2: ${nr2.abweichungen} Abweichungen statt ${abweichungen}`);
    const zeitachse = new Set((daten.zeitachse as any[]).map((z) => zeit(z.zeitpunkt)));
    for (const t of [nr1.freigegeben_am, k.freigegeben_am, nr2.freigegeben_am]) if (!zeitachse.has(zeit(t))) fehler.push(`Zeitachse nennt ${t} nicht`);
    expect(fehler).toEqual([]);
  });
});

describe('UEMS-Referenzunternehmen — Fassung 1.5 (AP-15 E8)', () => {
  /** Der Fingerabdruck der Fassung 1.4, kanonisch geschrieben, aus origin/uems vor AP-15 IP-1 — derselbe wie im Java-Zwilling. */
  const FASSUNG_1_4_SHA256 = 'a32f92053787fb6cdbe31c5c1c154179ccfadd2bc330e4c8c3b0061a768000a4';

  const kanonisch = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`;
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(x);
  };
  /** kW auf eine Nachkommastelle — wie der Java-Zwilling mit BigDecimal rechnet (6 × 4,1 = 24,6, nicht 24,599…). */
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  const nach = (liste: any[]): Map<string, any> => new Map(liste.map((o) => [o.kennzeichen as string, o]));
  const ohne = (o: Record<string, any>, ...felder: string[]): Record<string, any> =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !felder.includes(k)));
  const grenzeAm = (netz: string, tag: string): any =>
    (daten.netzanschluss_grenzen as any[]).find((g) => g.netzanschluss === netz && giltAm(g, tag)) ?? null;
  const zustaendig = zuordnungen('datenquelle_box');
  const boxen = nach(daten.boxen);
  const quellen = nach(daten.datenquellen);
  const komponenten = nach(daten.komponenten);
  const geraete = nach(daten.geraete);
  const netzanschluesse = nach(daten.netzanschluesse);
  const anlagen = nach(daten.anlagen);

  it('ist ohne ihre Zusätze Zeichen für Zeichen die Fassung 1.4', () => {
    const d = structuredClone(daten) as Record<string, any>;
    ohneFassung17(d);
    ohneFassung16(d);
    ohneFassung15(d);
    expect(createHash('sha256').update(kanonisch(d), 'utf8').digest('hex')).toBe(FASSUNG_1_4_SHA256);
  });

  it('lässt höchstens eine Steuerquelle je Anlage zu — außer mit gemeinsamer Steuerung', () => {
    const fehler: string[] = [];
    const mehrAlsEine: string[] = [];
    const gemeinsam: string[] = [];
    for (const a of daten.anlagen as any[]) {
      const an = a.kennzeichen as string;
      const qs = (daten.datenquellen as any[]).filter((q) => q.anlage === an && q.steuerquelle);
      const mitglieder = (daten.gemeinsame_steuerungen as any[])
        .filter((v) => v.anlage === an)
        .flatMap((v) => v.mitglieder as any[]);
      if (qs.length > 1) mehrAlsEine.push(an);
      if (mitglieder.length) gemeinsam.push(an);
      const stichzeiten = new Set<number>([
        ...qs.flatMap((q) => (zustaendig.get(q.kennzeichen) ?? []).map((z) => zeit(z.gueltig_ab))),
        ...mitglieder.map((m) => zeit(m.gueltig_ab)),
      ]);
      for (const t of [...stichzeiten].sort((x, y) => x - y)) {
        const mitgliedBoxen = mitglieder.filter((m) => gilt(m, t)).map((m) => m.box as string);
        const lesend: string[] = [];
        for (const q of qs) {
          for (const z of zustaendig.get(q.kennzeichen) ?? []) {
            if (!gilt(z, t)) continue;
            lesend.push(q.kennzeichen);
            if (mitgliedBoxen.length && (!mitgliedBoxen.includes(z.nach) || boxen.get(z.nach).heimat_anlage !== an)) {
              fehler.push(`${an} ${new Date(t).toISOString()}: Steuerquelle ${q.kennzeichen} liest ${z.nach} — kein Mitglied`);
            }
          }
        }
        if (!mitgliedBoxen.length && lesend.length > 1) {
          fehler.push(`${an} ${new Date(t).toISOString()}: ${lesend.join(', ')} — mehr als eine Steuerquelle ohne gemeinsame Steuerung`);
        }
      }
    }
    expect(fehler).toEqual([]);
    expect(mehrAlsEine.length).toBeGreaterThan(0);
    expect(mehrAlsEine.filter((an) => !gemeinsam.includes(an))).toEqual([]);
  });

  it('hängt die gemeinsame Steuerung an ihre Anlage: ein führendes Mitglied, Heimat, eigener Messpunkt, Stufen, Grenze', () => {
    const STUFE: Record<string, string> = { S0: 'erklaert', S1: 'beobachtet', S2: 'geprueft', S3: 'anteile_aktiv' };
    const fehler: string[] = [];
    for (const v of daten.gemeinsame_steuerungen as any[]) {
      const { kennzeichen: kz, anlage: an, netzanschluss: netz } = v;
      if (anlagen.get(an).netzanschluss !== netz) fehler.push(`${kz}: ${netz} ist nicht der Netzanschluss von ${an}`);
      const mitglieder = v.mitglieder as any[];
      for (const m of mitglieder) {
        const ab = zeit(m.gueltig_ab);
        const box = boxen.get(m.box);
        if (box.heimat_anlage !== an) fehler.push(`${kz}: ${m.box} hat ihre Heimat nicht in ${an}`);
        if (!laeuft(box, ab, 'in_betrieb_ab', 'ausgebaut_am')) fehler.push(`${kz}: ${m.box} ist beim Eintritt nicht in Betrieb`);
        const punkt = quellen.get(m.messpunkt);
        if (punkt.anlage !== an || punkt.steuerquelle) fehler.push(`${kz}: ${m.messpunkt} ist kein Messpunkt in ${an}`);
        if (!(zustaendig.get(m.messpunkt) ?? []).some((z) => gilt(z, ab) && z.nach === m.box)) {
          fehler.push(`${kz}: ${m.box} liest ihren Messpunkt ${m.messpunkt} nicht selbst`);
        }
        if (m.rolle === 'fuehrt' && box.fuehrend_fuer !== an) fehler.push(`${kz}: ${m.box} führt, ist aber nicht die führende Box von ${an}`);
        const fuehrend = mitglieder.filter((x) => gilt(x, ab) && x.rolle === 'fuehrt').length;
        if (fuehrend !== 1) fehler.push(`${kz} ${m.gueltig_ab}: ${fuehrend} führende Mitglieder statt einem`);
      }
      const stufen = v.stufen as any[];
      stufen.forEach((s, i) => {
        if (STUFE[s.stufe] !== s.code) fehler.push(`${kz}: Stufe ${s.stufe} heißt nicht ${s.code}`);
        if (i > 0 && (s.stufe <= stufen[i - 1].stufe || s.ab <= stufen[i - 1].ab)) fehler.push(`${kz}: die Stufen steigen nicht`);
      });
      const erstesMitglied = mitglieder.map((m) => m.gueltig_ab as string).sort((x, y) => zeit(x) - zeit(y))[0];
      if (stufen[0].ab !== lokalerTag(erstesMitglied, ZONE)) fehler.push(`${kz}: die erste Stufe beginnt nicht mit den ersten Mitgliedern`);
      const grenze = grenzeAm(netz, stufen[0].ab);
      if (!grenze) fehler.push(`${kz}: ${netz} hat ab ${stufen[0].ab} keine Grenze`);
      else if (grenze.bezugsgrenze_kw > netzanschluesse.get(netz).vereinbart_kw) {
        fehler.push(`${kz}: die Bezugsgrenze liegt über der vereinbarten Leistung von ${netz}`);
      }
    }
    expect(fehler).toEqual([]);
  });

  it('rechnet die Auslegung aus der Datei: Vorbehalt, verteilbar, Anteile, Rückfälle, Urteil', () => {
    const fehler: string[] = [];
    for (const v of daten.gemeinsame_steuerungen as any[]) {
      const scharf = (v.stufen as any[]).find((s) => s.stufe === 'S3').ab as string;
      const t = mitternacht(scharf, ZONE).ms;
      const grenze = grenzeAm(v.netzanschluss, scharf);
      const vorbehalt = r1(v.grundlast.gemessenes_viertelstunden_maximum_kw * v.grundlast.zuschlag);
      const mitglieder = new Set((v.mitglieder as any[]).filter((m) => gilt(m, t)).map((m) => m.box as string));
      for (const richtung of ['einspeisung', 'bezug']) {
        const a = v.auslegung[richtung];
        const verteilbar = richtung === 'einspeisung' ? grenze.einspeisegrenze_kw : r1(grenze.bezugsgrenze_kw - vorbehalt);
        if (richtung === 'bezug' && a.vorbehalt_grundlast_kw !== vorbehalt) fehler.push(`${v.kennzeichen} bezug: Vorbehalt ${a.vorbehalt_grundlast_kw} statt ${vorbehalt}`);
        if (a.verteilbar_kw !== verteilbar) fehler.push(`${v.kennzeichen} ${richtung}: verteilbar ${a.verteilbar_kw} statt ${verteilbar}`);
        let summe = a.ungenutzt_kw as number;
        for (const [box, kw] of Object.entries(a.anteile as Record<string, number>)) {
          summe = r1(summe + kw);
          if (!mitglieder.has(box)) fehler.push(`${v.kennzeichen} ${richtung}: Anteil für ${box}, kein Mitglied am ${scharf}`);
        }
        if (summe !== verteilbar) fehler.push(`${v.kennzeichen} ${richtung}: Anteile + ungenutzt = ${summe} statt ${verteilbar}`);
        const jeBox = new Map<string, number>();
        for (const r of daten.geraete_rueckfaelle as any[]) {
          if (r.richtung !== richtung) continue;
          const quelle = geraete.get(komponenten.get(r.komponente).geraet).datenquelle;
          for (const z of zustaendig.get(quelle) ?? []) {
            if (gilt(z, t) && mitglieder.has(z.nach)) jeBox.set(z.nach, r1((jeBox.get(z.nach) ?? 0) + r.rueckfall_kw));
          }
        }
        const rueckfall = r1([...jeBox.values()].reduce((x, y) => x + y, 0));
        if (rueckfall !== a.summe_rueckfall_kw) fehler.push(`${v.kennzeichen} ${richtung}: Summe der Rückfälle ${rueckfall} statt ${a.summe_rueckfall_kw}`);
        for (const [box, kw] of jeBox) {
          if (!(box in a.anteile) || kw > a.anteile[box]) fehler.push(`${v.kennzeichen} ${richtung}: ${box} hält weniger Anteil als den Rückfall ${kw}`);
        }
        const urteil = rueckfall <= verteilbar ? 'passt' : 'auslegung_passt_nicht';
        if (a.urteil !== urteil) fehler.push(`${v.kennzeichen} ${richtung}: Urteil ${a.urteil} statt ${urteil}`);
      }
    }
    expect(fehler).toEqual([]);
  });

  it('hängt jeden Geräte-Rückfall an eine steuerbare Komponente — und jede steuerbare Komponente der gemeinsamen Steuerung hat einen', () => {
    const fehler: string[] = [];
    const gesehen = new Set<string>();
    for (const r of daten.geraete_rueckfaelle as any[]) {
      const k = komponenten.get(r.komponente);
      if (gesehen.has(`${r.komponente}/${r.richtung}`)) fehler.push(`${r.komponente}: zwei Rückfälle in derselben Richtung`);
      gesehen.add(`${r.komponente}/${r.richtung}`);
      if (!k.steuerbar || k.steuerbar.startsWith('nein')) fehler.push(`${r.komponente}: Rückfall an einer nicht steuerbaren Komponente`);
      if (r.rueckfall === 'laeuft_frei' ? r.rueckfall_kw !== r.nenn_kw : r.rueckfall_kw > r.nenn_kw) {
        fehler.push(`${r.komponente}: Rückfall ${r.rueckfall_kw} kW passt nicht zu ${r.rueckfall}`);
      }
    }
    const gemeinsam = new Set((daten.gemeinsame_steuerungen as any[]).map((v) => v.anlage as string));
    for (const k of daten.komponenten as any[]) {
      const quelle = quellen.get(geraete.get(k.geraet).datenquelle);
      if (gemeinsam.has(k.anlage) && quelle.steuerquelle && k.steuerbar?.startsWith('ja')
        && ![...gesehen].some((s) => s.startsWith(`${k.kennzeichen}/`))) {
        fehler.push(`${k.kennzeichen}: steuerbar in einer gemeinsamen Steuerung, aber ohne Rückfall`);
      }
    }
    expect(fehler).toEqual([]);
  });

  it('nennt in den Abnahmefällen R1 … R22 die Tatsachen der Datei', () => {
    const faelle = daten.abnahmefaelle_ap15.faelle as any[];
    expect(faelle.map((f) => f.fall)).toEqual(Array.from({ length: 22 }, (_, i) => `R${i + 1}`));
    expect(faelle.filter((f) => f.stand === 'entwurf').map((f) => f.fall)).toEqual(['R16']);
    const g: Record<string, any> = Object.fromEntries(faelle.map((f) => [f.fall, f.gegeben]));

    const v = (daten.gemeinsame_steuerungen as any[])[0];
    const grenze = (daten.netzanschluss_grenzen as any[]).find((x) => x.netzanschluss === v.netzanschluss);
    const { einspeisung, bezug } = v.auslegung;
    expect(kanonisch(g.R1.grenzen_na1), 'R1 Grenzen').toBe(kanonisch(ohne(grenze, 'netzanschluss', 'gueltig_bis')));
    expect(kanonisch(g.R1.einspeisung), 'R1 Einspeisung').toBe(kanonisch(einspeisung));
    expect(kanonisch(g.R1.bezug), 'R1 Bezug').toBe(kanonisch(bezug));
    expect(kanonisch(g.R3.bezug), 'R3 Bezug').toBe(kanonisch(bezug));
    expect(kanonisch(g.R3.grundlast), 'R3 Grundlast').toBe(kanonisch(v.grundlast));
    expect(kanonisch(g.R7.anteile_kw), 'R7').toBe(kanonisch(einspeisung.anteile));
    expect(kanonisch(g.R12.alt), 'R12 alt').toBe(kanonisch(einspeisung.anteile));
    expect(g.R2.arbeitspreis_ct_kwh, 'R2 Arbeitspreis').toBe(netzanschluesse.get(v.netzanschluss).arbeitspreis_ct_kwh);

    // Geräte-Rückfälle: K-1 wörtlich, die Ladepunkte der Anlage als Summe.
    const rueckfaelle = daten.geraete_rueckfaelle as any[];
    const k1 = rueckfaelle.find((r) => r.komponente === 'K-1');
    expect(kanonisch(g.R5.rueckfall_k1), 'R5 Rückfall K-1').toBe(kanonisch(ohne(k1, 'komponente', 'richtung')));
    const ladepunkte = r1(rueckfaelle
      .filter((r) => komponenten.get(r.komponente).anlage === v.anlage && komponenten.get(r.komponente).art?.startsWith('Ladepunkt'))
      .reduce((s, r) => s + r.rueckfall_kw, 0));
    expect(g.R3.geraete_rueckfall_ladepunkte_kw, 'R3 Ladepunkte').toBe(ladepunkte);

    // Der Augenblick des Beispielsonntags (R1 = R4 vorher = R5 vorher) rechnet in sich.
    const aug = g.R1.augenblick;
    expect(kanonisch(g.R4.vorher)).toBe(kanonisch(aug));
    expect(kanonisch(g.R5.vorher)).toBe(kanonisch(aug));
    expect(aug.grenze_kw).toBe(grenze.einspeisegrenze_kw);
    const ueberschussE4 = aug.pv_e4_kw - aug.last_kw;
    expect(aug.ungeregelt_einspeisung_kw).toBe(r1(ueberschussE4 + aug.pv_e1_verfuegbar_kw));
    expect(aug.einspeisung_kw).toBe(r1(aug.grenze_kw - aug.marge_kw));
    expect(aug.e1_darf_kw).toBe(r1(aug.einspeisung_kw - ueberschussE4));
    expect(aug.e1_regelt_ab_kw).toBe(r1(aug.pv_e1_verfuegbar_kw - aug.e1_darf_kw));
    // Der Dienstag (R3): der Ladepark bekommt seinen Anteil, schlimmstenfalls genau die Bezugsgrenze.
    const di = g.R3.augenblick;
    expect(di.anteil_e4_kw).toBe(bezug.anteile['E-4']);
    expect(di.laden_kw).toBe(Math.min(di.ladewunsch_kw, di.anteil_e4_kw));
    expect(di.schlimmster_fall_kw).toBe(grenze.bezugsgrenze_kw);
    expect(di.schlimmster_fall_kw).toBe(r1(bezug.vorbehalt_grundlast_kw + bezug.verteilbar_kw));

    // R17: die Nachfolgerin von E-4 übernimmt genau die Quellen, die ihr die Datei zuordnet.
    const nachfolger = g.R17.nachfolger as string;
    expect(boxen.get(nachfolger)?.vorgaenger, 'R17 Nachfolgerin').toBe('E-4');
    const uebernimmt = (daten.zuordnungen as any[])
      .filter((z) => z.art === 'datenquelle_box' && z.nach === nachfolger)
      .map((z) => z.von as string);
    expect([...uebernimmt].sort()).toEqual([...(g.R17.uebernimmt as string[])].sort());

    // R20: die Netzanschlüsse, wie die Datei sie führt, je mit ihrer Anlage.
    for (const [n, r] of Object.entries(g.R20.na as Record<string, any>)) {
      const anschluss = netzanschluesse.get(n);
      expect(r.standort).toBe(anschluss.standort);
      expect(r.anschluss_kva).toBe(anschluss.anschluss_kva);
      expect(r.vereinbart_kw).toBe(anschluss.vereinbart_kw);
      expect((daten.anlagen as any[]).filter((a) => a.netzanschluss === n).map((a) => a.kennzeichen)).toEqual([r.anlage]);
    }

    // R21: die Zuständigkeitskette von DQ-3, wie Fassung 1.4 sie führt.
    const kette = [...(zustaendig.get('DQ-3') ?? [])]
      .sort((x, y) => zeit(x.gueltig_ab) - zeit(y.gueltig_ab))
      .map((z) => z.nach)
      .join(' → ');
    expect(g.R21.zeitachse.endsWith(`DQ-3 ${kette}`)).toBe(true);
  });
});

describe('UEMS-Referenzunternehmen — Fassung 1.6 (AP-16 E11)', () => {
  const FASSUNG_1_5_SHA256 = 'c6a03b8b8446edc9324f6d5bb9288b4ebf16f5c3577a8210c805d4b76cdb5b8c';
  const kanonisch = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`;
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(x);
  };
  const nach = (liste: any[]): Map<string, any> => new Map(liste.map((o) => [o.kennzeichen as string, o]));

  it('ist ohne ihre Zusätze Zeichen für Zeichen die Fassung 1.5', () => {
    const d = structuredClone(daten) as Record<string, any>;
    ohneFassung17(d);
    ohneFassung16(d);
    expect(createHash('sha256').update(kanonisch(d), 'utf8').digest('hex')).toBe(FASSUNG_1_5_SHA256);
  });

  it('trägt die gegeben-Werte und die neuen Bewertungs-Invarianten', () => {
    const ms = nach(daten.messstellen as any[]);
    const oktober = new Map<string, number>();
    for (const m of daten.messstellen as any[]) {
      if (typeof m.beispielwerte.oktober_2026_kwh === 'number') oktober.set(m.kennzeichen, m.beispielwerte.oktober_2026_kwh);
    }
    for (const k of daten.korrekturen as any[]) {
      for (const f of k.folgen as any[]) if (f.objekt.startsWith('MS-')) oktober.set(f.objekt, f.wert);
    }
    const personen = new Set((daten.personen as any[]).map((p) => p.kuerzel as string));
    const bezugsgroessen = new Set((daten.bezugsgroessen as any[]).map((b) => b.kennzeichen as string));
    const paare = new Set<string>();
    const einsatzMengen = new Map<string, number>();
    const zugeordnetJeAnlage = new Map<string, number>();
    for (const e of daten.energieeinsaetze as any[]) {
      const paar = `${e.prozess}|${e.traeger}`;
      expect(paare.has(paar), `doppelter laufender Einsatz ${paar}`).toBe(false);
      paare.add(paar);
      expect(personen.has(e.verantwortlich)).toBe(true);
      for (const i of e.einflussgroessen as any[]) if (i.bezugsgroesse) expect(bezugsgroessen.has(i.bezugsgroesse)).toBe(true);
      if (e.traeger !== 'Strom') continue;
      let summe = 0;
      for (const kz of e.messstellen as string[]) {
        const wert = oktober.get(kz);
        if (wert == null) continue;
        summe += wert;
        const anlage = ms.get(kz).elektrische_stellung[0].anlage as string;
        zugeordnetJeAnlage.set(anlage, (zugeordnetJeAnlage.get(anlage) ?? 0) + wert);
      }
      einsatzMengen.set(e.kennzeichen, summe);
    }
    const rest = new Map<string, number>();
    for (const m of daten.messstellen as any[]) {
      if (m.formel_typ === 'rest') rest.set(m.elektrische_stellung[0].anlage, oktober.get(m.kennzeichen) as number);
    }
    const nenner = new Map(['AN-1', 'AN-2', 'AN-3'].map((a) => [a, (zugeordnetJeAnlage.get(a) ?? 0) + (rest.get(a) ?? 0)]));
    expect(Object.fromEntries(nenner)).toEqual({ 'AN-1': 139380, 'AN-2': 36900, 'AN-3': 9100 });
    expect([...nenner.values()].reduce((a, b) => a + b, 0)).toBe(185380);
    expect([...einsatzMengen.values()].reduce((a, b) => a + b, 0)).toBe(125740);
    expect([...rest.values()].reduce((a, b) => a + b, 0)).toBe(59640);
    expect(Object.fromEntries(einsatzMengen)).toMatchObject({ 'EE-1': 77500, 'EE-3': 15900, 'EE-2': 9640 });
    expect(ms.get('MS-20').beispielwerte.oktober_2026_kwh).toBe(88630);

    for (const e of daten.einstufungen as any[]) {
      for (const f of e.fassungen as any[]) {
        expect(personen.has(f.person)).toBe(true);
        expect(f.begruendung.trim().length).toBeGreaterThan(0);
        expect(Object.keys(f.herkunft)).toEqual(expect.arrayContaining(['zeitraum', 'kriterien_fassung', 'eingaenge', 'nenner', 'urteil', 'vorschlag']));
      }
    }
    const mb1 = (daten.messbedarfe as any[]).find((b) => b.kennzeichen === 'MB-1');
    expect(mb1.zustand).toBe('eingeloest');
    expect(ms.has(mb1.messstelle)).toBe(true);
    expect(ms.get(mb1.messstelle).geplante_elektrische_stellung).toMatchObject({
      anlage: 'AN-1',
      unterzaehler_von: 'MS-01',
    });

    const berichte = new Map((daten.berichte as any[]).map((b) => [b.kennung, b]));
    for (const z of (daten.zeitachse as any[]).filter((e) => e.energetische_bewertung)) {
      expect(berichte.has(z.energetische_bewertung)).toBe(true);
    }
    expect(berichte.get('BW-2026-0001').staende[0].werte[0].wert).toBe(6100);
    expect(berichte.get('BW-2026-0001').staende[1].werte[0].wert).toBe(6040);
    expect(berichte.get('BW-2026-0001').staende[1].werte[2].wert).toBe(59640);
    expect(berichte.get('BW-2027-0001').staende[0].annahme).toBe(true);
    expect(berichte.get('BW-2027-0001').staende[0].werte).toEqual([]);

    const angaben = new Map((daten.messmittel_angaben as any[]).map((a) => [a.ziel, a]));
    expect(angaben.get('GR-2').pruefungsart).toBe('eichung');
    expect(angaben.get('Z-5b').pruefungsart).toBe('werksbescheinigung');
    expect(angaben.get('GR-5').pruefungsart).toBe('nicht_erhoben');
    expect(angaben.get('K-8.2').genauigkeitsklasse).toBeNull();
    expect(ms.get('MS-21').beispielwerte.oktober_2026_m3).toBe(1240);
    const verantwortlich = Object.fromEntries((daten.energieeinsaetze as any[]).map((e) => [e.kennzeichen, e.verantwortlich]));
    expect(verantwortlich).toMatchObject({ 'EE-1': 'MD', 'EE-2': 'PH', 'EE-5': 'PH', 'EE-3': 'IK', 'EE-6': 'JW', 'EE-7': 'JW' });

    const fallListe = daten.abnahmefaelle_ap16.faelle as any[];
    // R9 kam mit Fassung 1.7 (K-1 an der Hauptgröße); geprüft im Block „Fassung 1.7“.
    expect(fallListe.map((f) => f.fall)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R7', 'R8', 'R9', 'R12', 'R14']);
    const gegeben: Record<string, any> = Object.fromEntries(fallListe.map((f) => [f.fall, f.gegeben]));
    expect(gegeben.R1.nenner_kwh).toBe(185380);
    expect(gegeben.R1.zugeordnet_kwh).toBe(125740);
    expect(gegeben.R1.rest_kwh).toBe(59640);
    for (const kz of ['EE-1', 'EE-3', 'EE-2', 'EE-6', 'EE-5', 'EE-4']) {
      expect(gegeben.R2.rangliste[kz].menge_kwh).toBe(einsatzMengen.get(kz));
      expect(gegeben.R2.rangliste[kz].anteil_prozent).toBe(Math.round((einsatzMengen.get(kz) as number) / 185380 * 1000) / 10);
    }
    const einstufungen = new Map((daten.einstufungen as any[]).map((e) => [e.einsatz, e]));
    for (const r of gegeben.R3.einstufungen) {
      const f = einstufungen.get(r.einsatz).fassungen[0];
      expect({ einstufung: r.einstufung, begruendung: r.begruendung, person: r.person })
        .toEqual({ einstufung: f.einstufung, begruendung: f.begruendung, person: f.person });
    }
    expect(gegeben.R4.EE_1_menge_kwh ?? gegeben.R4['EE-1_menge_kwh']).toBe(einsatzMengen.get('EE-1'));
    expect(gegeben.R4.MS_20_minus_EE_1 ?? gegeben.R4['MS-20_minus_EE-1']).toBe(11130);
    expect(kanonisch(gegeben.R5.messbedarf)).toBe(kanonisch(mb1));
    expect(gegeben.R5['MS-23'].name).toBe(ms.get('MS-23').name);
    expect(gegeben.R5['MS-23'].ort).toBe(ms.get('MS-23').ort.kennzeichen);
    const plan = ms.get('MS-23').geplante_elektrische_stellung;
    expect(gegeben.R5['MS-23'].stellung).toBe(`${plan.anlage} · ${plan.stellung} von ${plan.unterzaehler_von}`);
    expect(gegeben.R5['MS-23'].quelle_ab.startsWith(ms.get('MS-23').fuehrende_quelle[0].gueltig_ab)).toBe(true);
    expect(gegeben.R7.stand_2['MS-12'].wert).toBe(6040);
    expect(gegeben.R7.stand_2.rest_kwh).toBe(59640);
    expect(gegeben.R8['GR-2'].pruefungsart).toBe(angaben.get('GR-2').pruefungsart);
    expect(gegeben.R8['GR-5'].pruefungsart).toBe(angaben.get('GR-5').pruefungsart);
    expect(gegeben.R12['MS-21'].oktober_2026_m3).toBe(1240);
    expect(gegeben.R12['EE-7'].traeger).toBe('Gas');
    for (const kz of ['EE-2', 'EE-5', 'EE-3', 'EE-4', 'EE-6', 'EE-7']) {
      expect(gegeben.R14.verantwortlich[kz].startsWith(verantwortlich[kz])).toBe(true);
    }
  });
});

describe('UEMS-Referenzunternehmen — Fassung 1.7 (K-1 an der Hauptgröße, Befund PR 1104)', () => {
  const FASSUNG_1_6_SHA256 = '5b3c87b06a7b8b48d4b00a95f505cad6b7c75b54cdfdf33e1463a72977cf1c14';
  const kanonisch = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`;
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(x);
  };
  /** Herleitungen mit Monatsmenge (messstelle.md §5) — wie `VergleichToleranzService.MENGE`. */
  const MIT_MENGE = new Set(['zaehlerstand', 'differenzen', 'integration']);
  /** Je Vergleichsquelle von MS-01 („Größe · Komponente“): `ja` nur an der Hauptgröße mit Monatsmenge, sonst `ohne_monatsmenge` (bewertung.md §13). */
  const monatsvergleichArt = (ms01: any): Record<string, string> => Object.fromEntries([
    ...ms01.vergleichsquellen.map((q: any) => [`${ms01.hauptgroesse.groesse} · ${q.komponente}`,
      MIT_MENGE.has(q.herleitung) ? 'ja' : 'ohne_monatsmenge']),
    ...ms01.nebengroessen.flatMap((n: any) => n.vergleichsquellen.map((q: any) => [`${n.groesse} · ${q.komponente}`, 'ohne_monatsmenge'])),
  ]);
  const ms01Von = (d: any) => (d.messstellen as any[]).find((m) => m.kennzeichen === 'MS-01');

  it('ist ohne ihre Zusätze Zeichen für Zeichen die Fassung 1.6', () => {
    const d = structuredClone(daten) as Record<string, any>;
    ohneFassung17(d);
    expect(createHash('sha256').update(kanonisch(d), 'utf8').digest('hex')).toBe(FASSUNG_1_6_SHA256);
  });

  it('K-1 vergleicht auch an der Hauptgröße über integration — in Fassung 1.6 nur ohne_monatsmenge', () => {
    const alt = structuredClone(daten) as Record<string, any>;
    ohneFassung17(alt);
    expect(monatsvergleichArt(ms01Von(alt))).toEqual({ 'Wirkleistung · K-1': 'ohne_monatsmenge' });

    const ms01 = ms01Von(daten);
    expect(monatsvergleichArt(ms01)).toEqual({ 'Wirkenergie · K-1': 'ja', 'Wirkleistung · K-1': 'ohne_monatsmenge' });
    const [k1] = ms01.vergleichsquellen;
    expect([ms01.hauptgroesse.groesse, ms01.hauptgroesse.einheit, k1.kanal_wertart, k1.herleitung])
      .toEqual(['Wirkenergie', 'kWh', 'gauge', 'integration']);
    // Die Nebengröße Wirkleistung bleibt mit ihrer führenden Quelle K-3 und K-1 als Vergleich — ohne Toleranz.
    expect(ms01.nebengroessen.map((n: any) => [n.groesse, n.fuehrende_quelle.map((q: any) => q.komponente),
      n.vergleichsquellen.map((q: any) => [q.komponente, q.toleranz_fassungen ?? null])]))
      .toEqual([['Wirkleistung', ['K-3'], [['K-1', null]]]]);
  });

  it('R9 ergibt sich aus der Datei: 1,1 % passt, Gegenprobe 3,4 % ist ein Befund', () => {
    const r9 = (daten.abnahmefaelle_ap16.faelle as any[]).find((f) => f.fall === 'R9').gegeben;
    const [k1] = ms01Von(daten).vergleichsquellen;
    const fassung = k1.toleranz_fassungen.find((t: any) => t.fassung === r9.toleranz.fassung);
    expect(fassung.prozent_je_monat).toBe(r9.toleranz.prozent_je_monat);
    expect(r9.toleranz.vergleichsquelle).toBe(`MS-01 ← ${k1.komponente} Netzleistung`);
    const vergleiche = (m: any) => monatsvergleich(
      { menge: String(m.fuehrend_kwh), zustand: 'vollständig' },
      { menge: String(m.vergleich_kwh), zustand: 'vollständig' }, true, String(fassung.prozent_je_monat));
    const dez = vergleiche(r9.dezember_2026);
    const gegen = vergleiche(r9.gegenprobe);
    expect([dez.zustand, dez.abweichung_prozent, dez.toleranz_prozent]).toEqual(['passt', '1.1', '2']);
    expect([gegen.zustand, gegen.abweichung_prozent, gegen.befund]).toEqual(['abweichung', '3.4', true]);
    expect(Number(dez.abweichung_prozent)).toBe(r9.dezember_2026.abweichung_prozent);
    expect(Number(gegen.abweichung_prozent)).toBe(r9.gegenprobe.abweichung_prozent);
  });
});
