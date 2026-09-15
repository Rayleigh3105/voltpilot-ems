import { describe, expect, it } from 'vitest';
import type { FunktionStandort, OverviewSite, StandortAmStichtag } from './api';
import { anlagenZeilen } from './portfolioCockpit';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from './test/funktionenFixtures';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from './test/standorteFixtures';
import { kopfzeile, standortGruppen, steuerndeAnlagen, type UebersichtEbene } from './uebersicht';

/**
 * UEMS AP-02 IP-11 × AP-01 IP-6 — zählt die Unternehmens-Übersicht nach einem Umzug richtig?
 *
 * Die Übersicht gruppiert nach dem Standort-Schnappschuss von HEUTE (`GET /standorte`,
 * `StandortAmStichtag.anlagen`) und zählt „steuert“ über die Menge der aktiven Teilnahmen aus
 * `GET /funktionen`. Die Zuordnung ändert genau das, woran die Gruppierung hängt. Die Fixtures sind
 * die Antworten, die der Server nach dem Umzug liefert: Halle 1 (AN-1, steuert aktiv) gehört ab
 * heute zu Werk Ahrenberg Nord (ST-3) — ihre Teilnahme bleibt an der Funktion von Werk Ahrenberg
 * (der Umzug hängt sie nicht um), darum nennt `GET /funktionen` sie unter BEIDEN Standorten:
 * unter Werk Ahrenberg mit ihrer Teilnahme, unter Nord als heute zugeordnet ohne Teilnahme
 * (`FunktionService.standortBlock`).
 */

const JETZT = new Date();
const { an1, an2, an3 } = FIXTURE_IDS;
const NORD = '5a1d0000-0000-4000-8000-000000000003';
const HEUTE = JETZT.toISOString().slice(0, 10);

function site(id: string, name: string): OverviewSite {
  return {
    id,
    name,
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: JETZT.toISOString(),
    live: null,
    plannedSavingsTodayEur: null,
    roleCounts: { pv: 0, storage: 0, consumer: 1, grid: 1 },
  } as OverviewSite;
}

const SITES = [
  site(an1, 'Werk Ahrenberg – Halle 1'),
  site(an2, 'Werk Ahrenberg – Halle 2'),
  site(an3, 'Werk Lindach'),
];
const ZEILEN = anlagenZeilen({ overview: { sites: SITES } as never, earnings: null, dichte: 'komfortabel', now: JETZT });

function nord(anlagen: StandortAmStichtag['anlagen']): StandortAmStichtag {
  return werkAhrenberg({ id: NORD, kurzzeichen: 'ST-3', name: 'Werk Ahrenberg Nord', anlagen, anlagenZahl: anlagen.length });
}

function unternehmen(standorte: StandortAmStichtag[]): UebersichtEbene {
  return { art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH', standorte };
}

/** `GET /funktionen` nach dem Umzug: Nord hat keine Steuern-Funktion, Halle 1 steht dort ohne Teilnahme. */
function funktionNord(): FunktionStandort {
  const lindach = funktionWerkLindach();
  return {
    ...lindach,
    id: NORD,
    kurzzeichen: 'ST-3',
    name: 'Werk Ahrenberg Nord',
    steuern: {
      ...lindach.steuern,
      anlagen: [{ ...lindach.steuern.anlagen[0], id: an1, name: 'Werk Ahrenberg – Halle 1' }],
    },
  };
}

describe('Unternehmens-Übersicht nach „Anlage zuordnen“ (IP-11 × AP-01 IP-6)', () => {
  const heuteNachUmzug = unternehmen([
    werkAhrenberg({ anlagen: werkAhrenberg().anlagen.filter((a) => a.id !== an1), anlagenZahl: 1 }),
    werkLindach(),
    nord([{ id: an1, name: 'Werk Ahrenberg – Halle 1', gueltigAb: HEUTE, gueltigBis: null }]),
  ]);
  const funktionen = ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg(), funktionWerkLindach(), funktionNord()] });

  it('jede Anlage steht genau einmal — beim NEUEN Standort, und „steuert“ zieht mit ihr', () => {
    const gruppen = standortGruppen({ ebene: heuteNachUmzug, zeilen: ZEILEN, sites: SITES, funktionen, now: JETZT });
    expect(gruppen.map((g) => [g.name, g.zahlen, g.zeilen.map((z) => z.id)])).toEqual([
      ['Werk Ahrenberg', '1 Anlage · reine Messung · 1 von 1 Anlage liefert Daten', [an2]],
      ['Werk Lindach', '1 Anlage · reine Messung · 1 von 1 Anlage liefert Daten', [an3]],
      ['Werk Ahrenberg Nord', '1 Anlage · 1 steuert · 1 von 1 Anlage liefert Daten', [an1]],
    ]);
    expect(gruppen.flatMap((g) => g.zeilen.map((z) => z.id)).sort()).toEqual([an1, an2, an3].sort());
    expect(gruppen.some((g) => g.standortId === null)).toBe(false);
  });

  it('die Kopfzeile zählt nicht doppelt, obwohl `GET /funktionen` Halle 1 unter zwei Standorten nennt', () => {
    expect(steuerndeAnlagen(funktionen)).toEqual(new Set([an1]));
    expect(kopfzeile({ ebene: heuteNachUmzug, sites: SITES, funktionen, mitDatenlage: false, now: JETZT }).zahlen).toBe(
      '3 Standorte · 3 Anlagen · 1 steuert',
    );
    // Auch wenn der Server sie an beiden Standorten als aktiv nennte: eine Anlage ist ein „steuert“.
    const doppelt = funktionNord();
    doppelt.steuern.anlagen = funktionWerkAhrenberg().steuern.anlagen.filter((a) => a.id === an1);
    const beideAktiv = ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg(), funktionWerkLindach(), doppelt] });
    expect(kopfzeile({ ebene: heuteNachUmzug, sites: SITES, funktionen: beideAktiv, mitDatenlage: false, now: JETZT }).zahlen).toBe(
      '3 Standorte · 3 Anlagen · 1 steuert',
    );
  });

  it('⚠ Befund: die Teilnahme bleibt bei Werk Ahrenberg — dessen Steuern-Zeile nennt Halle 1 weiter, Nord schweigt (Steuern-Regel), obwohl seine Zahlen „1 steuert“ sagen', () => {
    const gruppen = standortGruppen({ ebene: heuteNachUmzug, zeilen: ZEILEN, sites: SITES, funktionen, now: JETZT });
    const steuern = (name: string) => gruppen.find((g) => g.name === name)?.funktionen?.find((f) => f.funktion === 'steuern');
    // Genau das sagt die Folgen-Karte vorher: „geführt wird sie weiter bei Werk Ahrenberg (ST-1)“.
    expect(steuern('Werk Ahrenberg')?.satz).toBe('Läuft mit Werk Ahrenberg – Halle 1');
    // Unter Nord nennt `GET /funktionen` Halle 1 ohne Teilnahme — dort nimmt keine Anlage teil, also keine
    // Steuern-Zeile mehr (vorher: „Noch nicht eingerichtet“). Die Zahl zählt die Anlage, die heute dort steht.
    const nord = gruppen.find((g) => g.name === 'Werk Ahrenberg Nord');
    expect(steuern('Werk Ahrenberg Nord')).toBeUndefined();
    expect(nord?.funktionen?.map((f) => f.funktion)).toEqual(['messen']);
    expect(nord?.zahlen).toContain('1 steuert');
  });

  it('ein GEPLANTER Umzug ändert die Übersicht heute nicht: bis zum Vortag zählt der alte Standort', () => {
    const vortag = new Date(JETZT.getTime() + 9 * 86_400_000).toISOString().slice(0, 10);
    const heuteVorUmzug = unternehmen([
      werkAhrenberg({
        anlagen: werkAhrenberg().anlagen.map((a) => (a.id === an1 ? { ...a, gueltigBis: vortag } : a)),
      }),
      werkLindach(),
      nord([]),
    ]);
    const vorher = ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg(), funktionWerkLindach()] });
    const gruppen = standortGruppen({ ebene: heuteVorUmzug, zeilen: ZEILEN, sites: SITES, funktionen: vorher, now: JETZT });
    expect(gruppen.map((g) => [g.name, g.zeilen.map((z) => z.id), g.leer])).toEqual([
      ['Werk Ahrenberg', [an1, an2], null],
      ['Werk Lindach', [an3], null],
      ['Werk Ahrenberg Nord', [], 'Diesem Standort ist heute keine Anlage zugeordnet.'],
    ]);
    expect(kopfzeile({ ebene: heuteVorUmzug, sites: SITES, funktionen: vorher, mitDatenlage: false, now: JETZT }).zahlen).toBe(
      '3 Standorte · 3 Anlagen · 1 steuert',
    );
  });
});
