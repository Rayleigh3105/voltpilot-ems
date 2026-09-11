import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    'anlagen', 'boxen', 'datenquellen', 'geraete', 'komponenten', 'messstellen', 'bezugsgroessen',
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
    for (const q of alleQuellen(m)) {
      out.push([`${m.kennzeichen}.quelle.komponente`, q.komponente, ['komponenten']]);
      out.push([`${m.kennzeichen}.quelle.geraet`, q.geraet, ['geraete']]);
    }
  }
  for (const p of daten.personen as any[]) {
    for (const s of p.standorte as string[]) out.push([`${p.kuerzel}.standort`, s, ['standorte']]);
    if (p.unterstuetzung) {
      out.push([`${p.kuerzel}.gewaehrt_von`, p.unterstuetzung.gewaehrt_von, ['personen']]);
    }
  }
  for (const b of daten.bezugsgroessen as any[]) {
    if (b.geltung_art === 'prozess' && b.geltung) {
      out.push([`${b.kennzeichen}.geltung`, b.geltung, ['prozesse']]);
    }
  }
  const VON: Record<string, string[]> = {
    anlage_standort: ['anlagen'],
    messstelle_ort: ['messstellen'],
    datenquelle_box: ['datenquellen'],
  };
  const NACH: Record<string, string[]> = {
    anlage_standort: ['standorte'],
    messstelle_ort: ['standorte', 'gebaeude', 'bereiche', 'unternehmen'],
    datenquelle_box: ['boxen'],
  };
  for (const z of daten.zuordnungen as any[]) {
    out.push([`${z.art}.von`, z.von, VON[z.art]]);
    out.push([`${z.art}.nach`, z.nach, NACH[z.art]]);
  }
  return out;
};

/**
 * Ein kleiner Läufer über die Teilmenge von JSON-Schema draft 2020-12, die das
 * Schema benutzt — byte-gleich zum Java-Zwilling, weil das Projekt keine
 * Schema-Bibliothek hat.
 */
const schemaFehler = (wert: any, teilschema: any, pfad: string): string[] => {
  const fehler: string[] = [];
  if (teilschema.$ref) {
    const ziel = teilschema.$ref
      .slice(2)
      .split('/')
      .reduce((o: any, s: string) => (o == null ? o : o[s.replace(/~1/g, '/').replace(/~0/g, '~')]), schema);
    if (!ziel) return [`${pfad}: unbekannter Schema-Verweis ${teilschema.$ref}`];
    return schemaFehler(wert, ziel, pfad);
  }
  const typVon = (v: any): string => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v === 'object' ? 'object' : typeof v;
  };
  const passt = (v: any, t: string): boolean =>
    t === 'number' ? typeof v === 'number' : typVon(v) === t;
  if (teilschema.type) {
    const typen: string[] = Array.isArray(teilschema.type) ? teilschema.type : [teilschema.type];
    if (!typen.some((t) => passt(wert, t))) {
      return [`${pfad}: Typ ${typVon(wert)} passt nicht zu ${typen.join('|')}`];
    }
  }
  if ('const' in teilschema && wert !== teilschema.const) {
    fehler.push(`${pfad}: ${JSON.stringify(wert)} ist nicht ${JSON.stringify(teilschema.const)}`);
  }
  if (teilschema.enum && wert !== null && !teilschema.enum.includes(wert)) {
    fehler.push(`${pfad}: ${JSON.stringify(wert)} steht nicht im Vokabular`);
  }
  if (typeof wert === 'string') {
    if (teilschema.pattern && !new RegExp(teilschema.pattern, 'u').test(wert)) {
      fehler.push(`${pfad}: „${wert}“ passt nicht zum Muster ${teilschema.pattern}`);
    }
    if (teilschema.minLength != null && wert.length < teilschema.minLength) fehler.push(`${pfad}: zu kurz`);
    if (teilschema.maxLength != null && wert.length > teilschema.maxLength) fehler.push(`${pfad}: zu lang`);
  }
  if (typeof wert === 'number') {
    if (teilschema.minimum != null && wert < teilschema.minimum) fehler.push(`${pfad}: unter dem Mindestwert`);
    if (teilschema.maximum != null && wert > teilschema.maximum) fehler.push(`${pfad}: über dem Höchstwert`);
  }
  if (Array.isArray(wert)) {
    if (teilschema.minItems != null && wert.length < teilschema.minItems) {
      fehler.push(`${pfad}: zu wenige Einträge`);
    }
    if (teilschema.items) {
      wert.forEach((v, i) => fehler.push(...schemaFehler(v, teilschema.items, `${pfad}[${i}]`)));
    }
  }
  if (wert !== null && typeof wert === 'object' && !Array.isArray(wert)) {
    for (const p of teilschema.required ?? []) {
      if (!(p in wert)) fehler.push(`${pfad}: Pflichtfeld ${p} fehlt`);
    }
    const props = teilschema.properties ?? {};
    const zusatz = teilschema.additionalProperties;
    for (const [k, v] of Object.entries(wert)) {
      if (k in props) fehler.push(...schemaFehler(v, props[k], `${pfad}.${k}`));
      else if (zusatz && typeof zusatz === 'object') fehler.push(...schemaFehler(v, zusatz, `${pfad}.${k}`));
      else if (zusatz === false) fehler.push(`${pfad}: unbekanntes Feld ${k}`);
    }
  }
  return fehler;
};

describe('UEMS-Referenzunternehmen — Form', () => {
  it('hält ihr eigenes Schema', () => {
    expect(schemaFehler(daten, schema, '$')).toEqual([]);
  });

  it('hat den Umfang, den AP-00 §4.4 zusagt', () => {
    expect(daten.standorte).toHaveLength(2);
    expect(daten.gebaeude).toHaveLength(5);
    expect(daten.bereiche).toHaveLength(7);
    expect(daten.prozesse).toHaveLength(6);
    expect(daten.netzanschluesse).toHaveLength(3);
    expect(daten.anlagen).toHaveLength(3);
    expect(daten.datenquellen).toHaveLength(7);
    expect(daten.geraete).toHaveLength(10);
    expect(daten.messstellen).toHaveLength(21);

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
    expect((daten.kostenstellen as any[]).filter((k) => gilt(k, jetzt))).toHaveLength(5);

    const nachArt = (a: string) => (daten.messstellen as any[]).filter((m) => m.art === a).length;
    expect(nachArt('gemessen')).toBe(17);
    expect(nachArt('berechnet')).toBe(4);
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
        if (st.stellung !== 'Hauptzähler' || !gilt(st, jetzt)) continue;
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

  it('lässt die Kostenstellen-Anteile je Zeitpunkt auf 100 % aufgehen', () => {
    const fehler: string[] = [];
    for (const m of daten.messstellen as any[]) {
      const stichzeiten = new Set((m.kostenstellen_anteile as any[]).map((k) => zeit(k.gueltig_ab)));
      for (const t of stichzeiten) {
        const summe = (m.kostenstellen_anteile as any[])
          .filter((k) => gilt(k, t))
          .reduce((s, k) => s + k.anteil_prozent, 0);
        if (summe !== 100) fehler.push(`${m.kennzeichen} @ ${new Date(t).toISOString()}: ${summe} %`);
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
      if (ueberlappungen(zs).length) fehler.push(`${m.kennzeichen}: Ort-Zeiträume überlappen`);
      const jetztGueltig = zs.filter((z) => gilt(z, jetzt));
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
        const ab = zeit(st.gueltig_ab);
        const gleicheAnlage = (ms.get(st.unterzaehler_von).elektrische_stellung as any[]).some(
          (e) => gilt(e, ab) && e.anlage === st.anlage,
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
      for (const q of alleQuellen(m)) {
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
      if (ueberlappungen(zs).length) fehler.push(name);
    }
    // Auch die Gültigkeiten, die AN einem Objekt hängen, überlappen nie.
    for (const o of [...(daten.standorte as any[]), ...(daten.gebaeude as any[])]) {
      if (ueberlappungen(o.bezugsflaechen).length) fehler.push(`Flächen ${o.kennzeichen}`);
    }
    for (const g of daten.geraete as any[]) {
      if (ueberlappungen(g.einbauten).length) fehler.push(`Einbauten ${g.kennzeichen}`);
    }
    for (const k of daten.komponenten as any[]) {
      if (ueberlappungen(k.wandler).length) fehler.push(`Wandler ${k.kennzeichen}`);
    }
    for (const m of daten.messstellen as any[]) {
      if (ueberlappungen(m.elektrische_stellung).length) fehler.push(`Stellung ${m.kennzeichen}`);
    }
    expect(fehler).toEqual([]);
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
