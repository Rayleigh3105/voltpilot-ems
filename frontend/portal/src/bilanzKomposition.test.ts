import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bilanz } from './api';
import { HILFE_NEGATIV, energiebilanzBild, type ZeileBild } from './anlageEnergiebilanz';
import { ahrenbergBilanz } from './test/bilanzFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

type Pruefung = {
  regel: string;
  eingang: { eingaenge: Array<{ messstelle: string; menge: string | null }> };
  ergebnis: Record<string, unknown>;
};
type Fall = { id: string; pruefungen: Pruefung[] };

const vectors = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/bilanz-vectors.json'), 'utf8'),
) as { cases: Fall[] };
const arten = new Map(ahrenbergRegister().register.map((z) => [z.kennzeichen, z.art]));
const NBSP = String.fromCharCode(160);
const text = (s: string) => s.split(NBSP).join(' ');
const pruefung = (fall: string, regel: string): Pruefung => {
  const p = vectors.cases.find((f) => f.id === fall)?.pruefungen.find((x) => x.regel === regel);
  if (!p) throw new Error(`${fall}/${regel} fehlt im Bilanz-Vektor`);
  return p;
};
const bild = (antwort: Bilanz) => energiebilanzBild(antwort, { heute: '2026-11-09', arten });
const zeilen = (antwort: Bilanz): ZeileBild[] => bild(antwort).hauptzaehler[0].abschnitte[0].tage[0].zeilen;
const zeile = (antwort: Bilanz, art: ZeileBild['art']) => zeilen(antwort).find((z) => z.art === art)!;

/**
 * AP-10 IP-14 — die Portal-Komposition gegen genau die drei Abnahmefälle des Vertrags.
 * Die Route bleibt die einzige Rechenstelle; der Test setzt ihre Vektor-Ergebnisse in das Lesemodell ein und prüft
 * ausschließlich die Kundendarstellung.
 */
describe('Bilanz-Komposition aus bilanz-vectors.json', () => {
  it('F1: 100 kWh Gesamtverbrauch, 90 kWh zugeordnet und 10 kWh Bilanzdifferenz', () => {
    const v = pruefung('F1', 'rest').ergebnis;
    const antwort = ahrenbergBilanz(FIXTURE_IDS.an3, 'tag', '2026-10-18');

    expect(text(zeile(antwort, 'zufluss').zahl)).toBe(`${v.verbrauch_system} kWh`);
    expect(text(zeile(antwort, 'zugeordnet').zahl)).toBe(`${v.zugeordnet} kWh`);
    expect(text(zeile(antwort, 'rest').zahl)).toBe(`${v.menge} kWh`);
    expect(zeile(antwort, 'rest').woerter).toContain('berechnet (Differenz)');
  });

  it('F5: die Summe sagt „mindestens …“, der Rest bleibt ohne Zahl', () => {
    const summe = pruefung('F5', 'summe').ergebnis;
    const rest = pruefung('F5', 'rest').ergebnis;
    const antwort = ahrenbergBilanz(FIXTURE_IDS.an2, 'tag', '2026-11-04');

    expect(text(zeile(antwort, 'zugeordnet').zahl)).toBe(text(String(summe.anzeige)));
    expect(zeile(antwort, 'rest').zahl).toBe('—');
    expect(zeile(antwort, 'rest').woerter).toContain(rest.zustand);
    expect(JSON.stringify(bild(antwort))).not.toContain('145 kWh');
  });

  it('F6: der negative Rest bleibt −5 kWh und der Hilfesatz behauptet keine Ursache', () => {
    const p = pruefung('F6', 'rest');
    const v = p.ergebnis;
    const antwort = structuredClone(ahrenbergBilanz(FIXTURE_IDS.an3, 'tag', '2026-10-18'));
    const werte = antwort.hauptzaehler[0].abschnitte[0].werte[0];
    const mengen = new Map(p.eingang.eingaenge.map((e) => [e.messstelle, e.menge === null ? null : Number(e.menge)]));
    werte.eingaenge = werte.eingaenge.map((e) => ({ ...e, menge: mengen.get(e.messstelle) ?? null }));
    Object.assign(werte.zugeordnet, { menge: Number(v.zugeordnet), anzeige: null });
    Object.assign(werte.rest, {
      menge: Number(v.menge),
      zustand: v.zustand,
      abdeckung_prozent: v.abdeckung_prozent,
      fehlend: v.fehlend,
      kennzeichen: v.kennzeichen,
      kundensatz: v.kundensatz,
    });

    const rest = zeile(antwort, 'rest');
    expect(text(rest.zahl)).toBe('−5 kWh');
    expect(rest.saetze).toEqual([v.kundensatz, HILFE_NEGATIV]);
    expect(rest.saetze.join(' ')).not.toMatch(/Verlust|Schwund/iu);
  });
});
