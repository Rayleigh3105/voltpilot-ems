import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dez, dezVergleich, type Dez } from './bezugsdaten';
import { stellungenDesReferenzunternehmens } from './test/uemsReferenzStellungen';
import { REST_OHNE_HAUPTZAEHLER, VERBOTENE_WOERTER, VOLLSTAENDIG, restAusStellung } from './uemsBilanz';
import { GROESSEN_KATALOG, SALDIERT, groessePruefen } from './uemsMessstelle';
import {
  FORMEL_TYPEN,
  formelGroesse,
  hauptgroesse,
  periodenwert,
  speichertTerme,
  type Periodeneingang,
  type Term,
} from './uemsMessstelleFormel';

/**
 * AP-10 IP-4 — die Formel-Typen `rest` und `saldo` werden RECHENBAR: `uemsMessstelleFormel.ts`
 * verzweigt je Typ (`hauptgroesse`, `periodenwert`) und rechnet die neuen Typen nicht selbst.
 * Der Java-Zwilling ist `services/api .../uems/MessstelleFormelTypenTest`; beide fahren
 * `bilanz-vectors.json` (F1, F4, F5, F6, F9 namentlich) durch die Verzweigung und
 * `messstelle-formel-vectors.json` (PR #688) als Beweis, dass die gewichtete Summe vektor-gleich bleibt.
 *
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const bilanz: Json = lies('bilanz-vectors.json');
const formel: Json = lies('messstelle-formel-vectors.json');
const referenz: Json = lies('uems-referenzunternehmen.json');

const betrag = (v: unknown): Dez | null => (v === null || v === undefined ? null : dez(String(v)));
const betragGleich = (ist: Dez | null, soll: unknown, was: string): void => {
  if (soll === null || soll === undefined) {
    expect(ist, was).toBeNull();
    return;
  }
  expect(ist, was).not.toBeNull();
  expect(dezVergleich(ist as Dez, dez(String(soll))), `${was}: soll ${soll} sein`).toBe(0);
};
const messstelle = (kennzeichen: string): Json =>
  referenz.messstellen.find((m: Json) => m.kennzeichen === kennzeichen);

describe('Formel-Typen: die Typen und der Katalog', () => {
  it('die Typen sind die des Vertrags; ein Rest speichert keine Terme (E3)', () => {
    expect([...FORMEL_TYPEN]).toEqual(bilanz.vokabulare.formel_typ);
    expect(speichertTerme('gewichtete_summe')).toBe(true);
    expect(speichertTerme('saldo')).toBe(true);
    expect(speichertTerme('rest')).toBe(false);
    expect(() => hauptgroesse('verteilung', 'berechnet', null, null)).toThrow();
  });

  it('„saldiert" steht im Katalog NUR für berechnete Messstellen', () => {
    const wirkenergie = GROESSEN_KATALOG[0];
    expect(wirkenergie.groesse).toBe('Wirkenergie');
    expect(wirkenergie.richtungenNurBerechnet).toEqual(bilanz.vokabulare.richtung_berechnet_additiv);
    for (const e of GROESSEN_KATALOG) expect(e.richtungen, e.groesse).not.toContain(SALDIERT);
    const saldiert = { groesse: 'Wirkenergie', richtung: SALDIERT, einheit: 'kWh', wertart: 'Intervallmenge' };
    expect(groessePruefen('Strom', saldiert, 'berechnet').fehler).toBeNull();
    expect(groessePruefen('Strom', saldiert, 'gemessen').grund).toBe('richtung');
    expect(groessePruefen('Strom', saldiert).grund).toBe('richtung');
    expect(hauptgroesse('saldo', 'gemessen', 'Intervallmenge', null)).toEqual({
      fehler: 'groessen_gemischt',
      grund: 'saldiert_nur_berechnet',
      hauptgroesse: null,
    });
  });
});

describe('Formel-Typen: die Plan-Abnahme des Captains wird gerechnet', () => {
  it('F1 von der Stellung bis zum Kundensatz: 100 − 60 − 30 = 10 kWh Bezug, „nicht zugeordnet"', () => {
    const fassung = restAusStellung('MS-16', '2026-10-18', stellungenDesReferenzunternehmens());
    expect(fassung.fehler).toBeNull();
    expect(fassung.anlage).toBe('AN-3');
    const eingaenge: Periodeneingang[] = fassung.terme.map((t) => ({
      messstelle: t.messstelle,
      rolle: t.rolle,
      anteil: t.anteil,
      vorzeichen: null,
      faktor: null,
      menge: betrag(messstelle(t.messstelle).beispielwerte.tag_2026_10_18_kwh),
      zustand: VOLLSTAENDIG,
      abdeckung_prozent: 100,
      version: 1,
      kennzeichen: [],
    }));
    ['100', '60', '30'].forEach((soll, i) => betragGleich(eingaenge[i].menge, soll, eingaenge[i].messstelle));

    const ms22 = messstelle('MS-22');
    expect(ms22.formel_typ).toBe('rest');
    const wert = periodenwert(ms22.formel_typ, ms22.art, 'kWh', 'tag', 1, [], eingaenge);
    betragGleich(wert.menge, ms22.beispielwerte.tag_2026_10_18_kwh, 'MS-22 am 18.10.2026');
    betragGleich(wert.menge, '10', 'die Abnahme');
    expect(wert.zustand).toBe(VOLLSTAENDIG);
    expect(wert.kennzeichen).toEqual(['berechnet (Differenz)', 'nicht zugeordnet']);
    const f1 = bilanz.cases.find((c: Json) => c.id === 'F1');
    const kundensatz = f1.pruefungen.find((p: Json) => p.regel === 'rest').ergebnis.kundensatz;
    expect(wert.satz).toBe(kundensatz);
    expect(wert.satz).toBe('10\u00a0kWh sind keiner Messstelle zugeordnet');
    for (const wort of VERBOTENE_WOERTER) expect(wert.satz).not.toContain(wort);

    expect(hauptgroesse(ms22.formel_typ, ms22.art, 'Intervallmenge', null).hauptgroesse).toEqual({
      groesse: ms22.hauptgroesse.groesse,
      richtung: ms22.hauptgroesse.richtung,
      einheit: ms22.hauptgroesse.einheit,
      wertart: ms22.hauptgroesse.wertart,
    });
    expect(restAusStellung('MS-16', '2026-10-14', stellungenDesReferenzunternehmens()).fehler).toBe(
      REST_OHNE_HAUPTZAEHLER,
    );
  });
});

describe('Formel-Typen: der Bilanz-Vertrag durch die Verzweigung', () => {
  const faelle: Array<[string, Json, Json]> = [];
  for (const fall of bilanz.cases) {
    for (const p of fall.pruefungen) {
      if (['rest', 'saldo', 'summe', 'richtung'].includes(p.regel)) {
        faelle.push([`${fall.id} · ${p.regel} :: ${p.name}`, fall, p]);
      }
    }
  }

  it('die Abnahme dieses Pakets ist dabei: F1, F4, F5, F6, F9', () => {
    const ids = faelle.map(([, fall, p]) => `${fall.id}/${p.regel}`);
    const abnahme = ['F1/rest', 'F1/richtung', 'F4/rest', 'F5/rest', 'F5/summe', 'F6/rest', 'F6/richtung'];
    for (const soll of [...abnahme, 'F9/saldo', 'F9/richtung']) expect(ids).toContain(soll);
  });

  it.each(faelle)('%s', (_name, fall: Json, p: Json) => {
    const why = `${fall.id} (${fall.why})`;
    const ein = p.eingang;
    const soll = p.ergebnis;
    if (p.regel === 'richtung') {
      const ist = hauptgroesse(ein.typ, ein.art, ein.wertart, ein.terme as Term[] | null);
      expect(ist.hauptgroesse?.groesse ?? null, `${why} · Größe`).toBe(soll.groesse);
      expect(ist.hauptgroesse?.richtung ?? null, `${why} · Richtung`).toBe(soll.richtung);
      expect(ist.hauptgroesse?.einheit ?? null, `${why} · Einheit`).toBe(soll.einheit);
      expect(ist.hauptgroesse?.wertart ?? null, `${why} · Wertart`).toBe(soll.wertart);
      expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
      expect(ist.grund, `${why} · Grund`).toBe(soll.grund);
      return;
    }
    const typ = p.regel === 'rest' ? 'rest' : p.regel === 'saldo' ? 'saldo' : 'gewichtete_summe';
    const eingaenge: Periodeneingang[] = ein.eingaenge.map((e: Json) => ({
      messstelle: e.messstelle,
      rolle: e.rolle ?? null,
      anteil: e.anteil ?? null,
      vorzeichen: e.vorzeichen ?? null,
      faktor: betrag(e.faktor),
      menge: betrag(e.menge),
      zustand: e.zustand,
      abdeckung_prozent: e.abdeckung_prozent,
      version: e.version,
      kennzeichen: e.kennzeichen,
    }));
    const ist = periodenwert(
      typ,
      ein.art ?? 'berechnet',
      ein.einheit,
      ein.zahl_ebene ?? null,
      ein.version ?? 1,
      ein.vermerke ?? [],
      eingaenge,
    );
    expect(ist.typ).toBe(typ);
    betragGleich(ist.menge, soll.menge, `${why} · Menge`);
    expect(ist.zustand, `${why} · Zustand`).toBe(soll.zustand);
    expect(ist.abdeckung_prozent, `${why} · Abdeckung`).toBe(soll.abdeckung_prozent);
    expect(ist.fehlend, `${why} · fehlend`).toEqual(soll.fehlend);
    expect(ist.kennzeichen, `${why} · Kennzeichen`).toEqual(soll.kennzeichen);
    const satz = p.regel === 'rest' ? soll.kundensatz : p.regel === 'summe' ? soll.anzeige : null;
    expect(ist.satz, `${why} · Satz`).toBe(satz);
    if (p.regel === 'saldo') {
      expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
      expect(ist.grund, `${why} · Grund`).toBe(soll.grund);
    }
  });
});

describe('Formel-Typen: die gewichtete Summe bleibt, wo sie ist (PR #688 vektor-gleich)', () => {
  it('der Fall netto-ohne-richtungslos-im-katalog-abgelehnt ist dabei', () => {
    expect(formel.cases.groesse.map((c: Json) => c.name)).toContain('netto-ohne-richtungslos-im-katalog-abgelehnt');
  });

  it.each(formel.cases.groesse)('Größe über den Typ: $name', (c: Json) => {
    const ueberTyp = hauptgroesse('gewichtete_summe', 'berechnet', null, c.input.terme as Term[]);
    expect(ueberTyp).toEqual(formelGroesse(c.input.terme as Term[]));
    expect(ueberTyp).toEqual(c.expected);
  });
});
