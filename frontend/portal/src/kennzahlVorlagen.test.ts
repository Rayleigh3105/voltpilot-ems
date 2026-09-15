import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KennzahlVorlage, KennzahlVorlageErwartung } from './api';
import { KENNZAHL_VORLAGEN, PLATZHALTER, kennzahlVorlage, vorbelegung, vorlagenTitel } from './kennzahlVorlagen';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { PROZENT } from './uemsErgebnis';
import * as K from './uemsKennzahl';
import { GROESSEN_KATALOG } from './uemsMessstelle';

/**
 * Der Vorlagen-Katalog der Kennzahlen (UEMS AP-11 IP-10, §4.12, E9 = A) im Portal: die Kopie gegen das Schema, die
 * Einheiten-Regel des TS-Zwillings und den Referenzfall K20 — dieselben Prüfungen, die `KennzahlVorlagenTest` in Java
 * fährt. Die Byte-Gleichheit mit der Server-Ressource hält `kennzahlVorlagen.sync.test.ts`.
 *
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
type Json = any;
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const KOPIE: Json = JSON.parse(readFileSync(resolve(process.cwd(), 'src/kennzahlen/kennzahl-vorlagen.json'), 'utf8'));

/** §4.12, in seiner Reihenfolge. */
const ACHT = [
  'stromeinsatz_je_stueck', 'stromeinsatz_je_kg', 'stromeinsatz_je_betriebsstunde', 'stromeinsatz_je_m2',
  'stromeinsatz_je_mitarbeitenden', 'anteil_am_netzbezug', 'autarkiegrad', 'eigenverbrauchsanteil',
];

const katalog = (groesse: string) => {
  const k = GROESSEN_KATALOG.find((e) => e.groesse === groesse);
  if (!k) throw new Error(`Größe nicht im Katalog: ${groesse}`);
  return k;
};

const seiten = (e: KennzahlVorlageErwartung, objekt: string): K.EinheitSeite[] =>
  e.art === 'messstelle'
    ? e.wertarten.map((wertart) => ({ art: e.art, objekt, einheit: katalog(e.groesse).einheit, groesse: e.groesse, wertart }))
    : e.wertarten.flatMap((wertart) => e.einheiten.map((einheit) => ({ art: e.art, objekt, einheit, groesse: null, wertart })));

describe('UEMS AP-11 IP-10 · der Vorlagen-Katalog der Kennzahlen', () => {
  it('die Portal-Kopie erfüllt das Schema — und das Schema beißt', () => {
    const schema = lies('kennzahl-vorlagen.schema.json');
    expect(schemaVerstoesse(KOPIE, schema)).toEqual([]);
    const kaputt = structuredClone(KOPIE);
    kaputt.vorlagen[0].rechenform = 'zusammenfassung';
    kaputt.vorlagen[0].zaehler_erwartung.wertarten.push('Momentanwert');
    expect(schemaVerstoesse(kaputt, schema).length).toBeGreaterThan(0);
  });

  it('es sind die acht Vorlagen aus §4.12, in ihrer Reihenfolge', () => {
    expect(KENNZAHL_VORLAGEN.map((v) => v.kennung)).toEqual(ACHT);
    expect(kennzahlVorlage('gibt_es_nicht')).toBeNull();
  });

  it('jede Vorlage besteht die Einheiten-Regel des Zwillings: ein Anteil gibt %, ein Quotient das ungekürzte Paar', () => {
    for (const v of KENNZAHL_VORLAGEN) {
      expect(K.rechenform(v.rechenform).fehler, v.kennung).toBeNull();
      if (v.rechenform !== K.ANTEIL) expect(v.komplement, `${v.kennung}: Komplement nur beim Anteil`).toBe(false);
      for (const z of seiten(v.zaehler_erwartung, 'Menge')) {
        for (const n of seiten(v.nenner_erwartung, 'Bezug')) {
          const u = K.einheit(v.rechenform, z, n, []);
          expect(u.fehler, `${v.kennung} · ${z.wertart} · ${n.einheit}: ${u.kundensatz}`).toBeNull();
          if (v.rechenform === K.ANTEIL) expect(u.einheit, v.kennung).toBe(PROZENT);
          else expect(u.einheit?.startsWith(`${katalog(z.groesse!).einheit}/`), `${v.kennung}: ${u.einheit}`).toBe(true);
        }
      }
    }
  });

  it('K20: „Stromeinsatz je Stück“ steht im Katalog wie im Fall und belegt „Halle 2“ vor, wie die Prüfung es verlangt', () => {
    const k20 = lies('kennzahl-vectors.json').cases.find((c: Json) => c.id === 'K20');
    const p = k20.pruefungen.find((x: Json) => x.regel === 'vorlage');
    const v = kennzahlVorlage(p.eingang.vorlage.kennung) as KennzahlVorlage;
    expect(v, 'vorlage_gefunden').not.toBeNull();
    expect({ rechenform: v.rechenform, name_vorschlag: v.name_vorschlag, zweck_vorschlag: v.zweck_vorschlag }).toEqual({
      rechenform: p.eingang.vorlage.rechenform,
      name_vorschlag: p.eingang.vorlage.name_vorschlag,
      zweck_vorschlag: p.eingang.vorlage.zweck_vorschlag,
    });
    // Schritt 2 filtert auf Messstellen mit Wirkenergie · Bezug, Schritt 3 auf Bezugsgrößen in Stück.
    expect(v.zaehler_erwartung).toMatchObject({ art: 'messstelle', groesse: 'Wirkenergie', richtungen: ['Bezug'] });
    expect(v.nenner_erwartung).toMatchObject({ art: 'bezugsgroesse', bezugsgroesse_arten: ['gutteile', 'produktionsmenge'], einheiten: ['Stück'] });

    const anfrage = vorbelegung(v, { art: 'gebaeude', id: 'g-2', name: p.eingang.geltung_name });
    expect({ rechenform: anfrage.rechenform, name: anfrage.name, zweck: anfrage.zweck }).toEqual(p.ergebnis);
    expect(anfrage).toMatchObject({ kennzeichen: null, verantwortlich_name: null, periode_art: null, komplement: null, eingaenge: [] });
    expect(vorlagenTitel(v)).toBe('Stromeinsatz je Stück');

    const kopie = K.kopie({ kennzeichen: 'KZ-0001', name: anfrage.name, zweck: anfrage.zweck ?? '', rechenform: anfrage.rechenform, geltung_name: 'Halle 2' }, 'Montagehalle Lindach');
    expect(kopie).toMatchObject({ name: 'Stromeinsatz je Stück — Montagehalle Lindach', fassung_nummer: 1, kennzeichen: null, eingaenge: [] });
  });

  it('jede Vorbelegung trägt keinen Platzhalter mehr und lässt sich für einen anderen Ort kopieren', () => {
    for (const v of KENNZAHL_VORLAGEN) {
      const a = vorbelegung(v, { art: 'standort', id: 'st-1', name: 'Werk Ahrenberg' });
      expect(a.name, v.kennung).toBe(`${vorlagenTitel(v)} — Werk Ahrenberg`);
      expect(a.komplement, v.kennung).toBe(v.rechenform === K.ANTEIL ? v.komplement : null);
      const k = K.kopie({ kennzeichen: 'KZ-0001', name: a.name, zweck: a.zweck ?? '', rechenform: a.rechenform, geltung_name: 'Werk Ahrenberg' }, 'Werk Lindach');
      expect(k.name, v.kennung).toBe(v.name_vorschlag.split(PLATZHALTER).join('Werk Lindach'));
    }
  });
});
