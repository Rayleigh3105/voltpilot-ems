import { describe, expect, it } from 'vitest';
import type { Earnings, OverviewSite } from './api';
import catalog from './anwendungen/catalog.json';
import { berlinDay, type FleetKind } from './fleet';
import {
  GELD_BAUSTEINE,
  PORTFOLIO_BAUSTEINE,
  SPALTEN_KOPF,
  UEBERSICHT_BAUSTEINE,
  UEMS_UEBERSICHT_BAUSTEINE,
  anlagenZeilen,
  bausteinOrt,
  leistenZellen,
  portfolioKennzahlen,
  tabellenSpalten,
  verfuegbareBausteine,
  vorteilUnterzeile,
  type PortfolioKennzahlen,
} from './portfolioCockpit';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from './test/funktionenFixtures';
import { FIXTURE_IDS, ahrenbergHeute, werkAhrenberg, werkLindach } from './test/standorteFixtures';
import {
  anlagenDerEbene,
  funktionsZeilen,
  geldAnlagen,
  kopfzeile,
  standortGruppen,
  steuerndeAnlagen,
  steuernSpricht,
  type UebersichtEbene,
} from './uebersicht';

/**
 * Die Unternehmens- und Standort-Übersicht, reine Hälfte (UEMS AP-01 IP-6) —
 * gegen das Referenzunternehmen Ahrenberg, Momentaufnahme 20.10.2026 10:15:
 * Netzbezug Halle 1 312,4 kW (PV 168,2 kW, Speicher 62 %), Halle 2 96,5 kW,
 * Werk Lindach 38,7 kW; Halle 1 steuert, Halle 2 und Lindach messen nur.
 */

const JETZT = new Date();
const { an1, an2, an3, st1, st2 } = FIXTURE_IDS;

function zeile(over: Partial<OverviewSite> & { id: string; name: string }): OverviewSite {
  return {
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
    ...over,
  } as OverviewSite;
}

const live = (gridKw: number, pvKw: number | null = null, socPct: number | null = null) => ({
  ts: JETZT.toISOString(),
  pvKw,
  loadKw: null,
  gridKw,
  socPct,
});

const HALLE1 = zeile({
  id: an1,
  name: 'Werk Ahrenberg – Halle 1',
  live: live(312.4, 168.2, 62),
  roleCounts: { pv: 1, storage: 1, consumer: 0, grid: 1 },
});
const HALLE2 = zeile({
  id: an2,
  name: 'Werk Ahrenberg – Halle 2',
  live: live(96.5),
  roleCounts: { pv: 0, storage: 0, consumer: 1, grid: 1 },
});
const LINDACH = zeile({
  id: an3,
  name: 'Werk Lindach',
  live: live(38.7),
  roleCounts: { pv: 0, storage: 0, consumer: 0, grid: 1 },
});
const AHRENBERG = [HALLE1, HALLE2, LINDACH];

const UNTERNEHMEN: UebersichtEbene = {
  art: 'unternehmen',
  name: 'Kunststoffwerk Ahrenberg GmbH',
  standorte: ahrenbergHeute().standorte,
};

/** Der Server liefert für JEDE Anlage Geld — die Regel muss es trotzdem filtern. */
function geldFuerAlle(): Earnings {
  const heute = berlinDay(JETZT);
  return {
    range: 'day',
    sites: AHRENBERG.map((s) => ({
      id: s.id,
      name: s.name,
      plantKind: 'eigenverbrauch',
      dailySaved: [{ day: heute, savedEur: 12.5, savedSteuerungEur: 12.5 }],
      peakShaving: { avoidedEur: 4800, avoidedKw: 40 },
    })),
    totals: {},
  } as unknown as Earnings;
}

describe('der Standort-Filter: die Standort-Übersicht ist dieselbe Seite', () => {
  it('am Standort genau seine heute zugeordneten Anlagen, im Unternehmen alle', () => {
    expect(anlagenDerEbene(AHRENBERG, { art: 'standort', standort: werkLindach() }).map((s) => s.id)).toEqual([an3]);
    expect(anlagenDerEbene(AHRENBERG, { art: 'standort', standort: werkAhrenberg() }).map((s) => s.id)).toEqual([
      an1,
      an2,
    ]);
    expect(anlagenDerEbene(AHRENBERG, UNTERNEHMEN)).toHaveLength(3);
    expect(anlagenDerEbene(AHRENBERG, null)).toHaveLength(3);
  });

  it('eine Summe am Standort geht nur über seine Anlagen', () => {
    const lindach = anlagenDerEbene(AHRENBERG, { art: 'standort', standort: werkLindach() });
    const k = portfolioKennzahlen({ sites: lindach } as never, null, JETZT, geldAnlagen(lindach, null));
    expect(k.netzbezugJetztKw).toBeCloseTo(38.7, 5);
  });
});

describe('Netzbezug gesamt und Datenlage (die zwei Katalog-Bausteine der Funktion messen)', () => {
  it('A7: Netzbezug jetzt 447,6 kW = 312,4 + 96,5 + 38,7', () => {
    const k = portfolioKennzahlen({ sites: AHRENBERG } as never, null, JETZT);
    expect(k.netzbezugJetztKw).toBeCloseTo(447.6, 5);
    expect(k.netzbezugJetztAnlagen).toBe(3);
    const zelle = leistenZellen({ order: ['netzbezug-gesamt'], kennzahlen: k, anlagen: 3, tonalitaet: 'eigenverbrauch' });
    expect(zelle).toEqual([
      expect.objectContaining({ label: 'Netzbezug jetzt', wert: '447,6', einheit: 'kW', unterzeile: '3 von 3 Anlagen melden gerade' }),
    ]);
  });

  it('eine einspeisende Anlage bezieht 0 kW — ihre Einspeisung tilgt keinen fremden Bezug', () => {
    const einspeisend = zeile({ id: 'x', name: 'Dach', live: live(-50) });
    const k = portfolioKennzahlen({ sites: [HALLE2, einspeisend] } as never, null, JETZT);
    expect(k.netzbezugJetztKw).toBeCloseTo(96.5, 5);
    expect(k.netzbezugJetztAnlagen).toBe(2);
  });

  it('ohne frischen Netz-Messwert zählt eine Anlage nicht mit — und die Zelle sagt es', () => {
    const alt = zeile({
      id: 'y',
      name: 'Alt',
      live: { ...live(20), ts: new Date(JETZT.getTime() - 3_600_000).toISOString() },
    });
    const k = portfolioKennzahlen({ sites: [HALLE2, alt] } as never, null, JETZT);
    expect(k.netzbezugJetztKw).toBeCloseTo(96.5, 5);
    const [zelle] = leistenZellen({ order: ['netzbezug-gesamt'], kennzahlen: k, anlagen: 2, tonalitaet: 'eigenverbrauch' });
    expect(zelle.unterzeile).toBe('1 von 2 Anlagen melden gerade');
    expect(zelle.ton).toBe('warn');
  });

  it('je Anlage ist der Netzbezug die Spalte „Netz jetzt" — auch ohne Tageswerte', () => {
    expect(bausteinOrt('netzbezug-gesamt')).toEqual({ leiste: true, spalte: true });
    const z = anlagenZeilen({ overview: { sites: AHRENBERG } as never, earnings: null, dichte: 'komfortabel', now: JETZT });
    expect(tabellenSpalten(z, ['netzbezug-gesamt'])).toEqual(['netz-heute']);
    expect(z.map((r) => r.netz?.kw)).toEqual([312.4, 96.5, 38.7]);
  });

  it('„PV jetzt" zählt als Nenner nur Anlagen MIT PV (Befund aus den Bildern)', () => {
    // Ahrenberg: nur Halle 1 hat PV — Halle 2 und Lindach „melden" keine PV, sie
    // melden sich nicht „nicht". Vorher stand hier „1 von 3 Anlagen melden gerade".
    const k = portfolioKennzahlen({ sites: AHRENBERG } as never, null, JETZT);
    expect(k.pvAnlagen).toBe(1);
    const [zelle] = leistenZellen({ order: ['pv-jetzt'], kennzahlen: k, anlagen: 3, tonalitaet: 'eigenverbrauch' });
    expect(zelle).toMatchObject({ wert: '168,2', unterzeile: '1 von 1 Anlage meldet gerade', ton: 'ruhig' });
    // Meldet eine Anlage MIT PV gerade nicht, bleibt der Vorbehalt wie bisher.
    const alt = { ...HALLE1, id: 'alt', live: { ...live(10, 20), ts: new Date(JETZT.getTime() - 3_600_000).toISOString() } };
    const k2 = portfolioKennzahlen({ sites: [...AHRENBERG, alt] } as never, null, JETZT);
    const [z2] = leistenZellen({ order: ['pv-jetzt'], kennzahlen: k2, anlagen: 4, tonalitaet: 'eigenverbrauch' });
    expect(z2).toMatchObject({ unterzeile: '1 von 2 Anlagen melden gerade', ton: 'warn' });
  });

  it('die Datenlage zählt Anlagen im Wortlaut des Vertrags „liefert Daten"', () => {
    expect(portfolioKennzahlen({ sites: AHRENBERG } as never, null, JETZT).datenlage?.text).toBe(
      '3 von 3 Anlagen liefern Daten',
    );
    const stumm = zeile({ id: 'z', name: 'Z', onlineCount: 0 });
    expect(portfolioKennzahlen({ sites: [HALLE2, stumm] } as never, null, JETZT).datenlage?.text).toBe(
      '1 von 2 Anlagen liefert Daten',
    );
  });

  it('beide Bausteine gibt es NUR auf einer Ebene — jede andere Flotte bleibt zeichengleich', () => {
    const k = portfolioKennzahlen({ sites: AHRENBERG } as never, null, JETZT);
    const ohne = verfuegbareBausteine({ anwendungen: ['monitoring'], kennzahlen: k, anlagen: 3 });
    const mit = verfuegbareBausteine({
      anwendungen: ['monitoring'],
      kennzahlen: k,
      anlagen: 3,
      uebersicht: { geld: false, uems: [...UEMS_UEBERSICHT_BAUSTEINE] },
    });
    for (const id of UEBERSICHT_BAUSTEINE) {
      expect(ohne, id).not.toContain(id);
      expect(mit, id).toContain(id);
    }
  });

  it('AP-13 IP-7: ein Baustein der Messstellen-Welt ohne Inhalt wird nicht angeboten (Ü1)', () => {
    const k = portfolioKennzahlen({ sites: AHRENBERG } as never, null, JETZT);
    const leer = verfuegbareBausteine({ anwendungen: ['monitoring'], kennzahlen: k, anlagen: 3, uebersicht: { geld: false, uems: [] } });
    for (const id of UEMS_UEBERSICHT_BAUSTEINE) expect(leer, id).not.toContain(id);
    expect(leer).toContain('datenlage');
    const nurMessstellen = verfuegbareBausteine({
      anwendungen: ['monitoring'],
      kennzahlen: k,
      anlagen: 3,
      uebersicht: { geld: false, uems: ['messstellen'] },
    });
    expect(nurMessstellen.filter((id) => UEMS_UEBERSICHT_BAUSTEINE.includes(id))).toEqual(['messstellen']);
  });
});

describe('die Kopfzeile (A7)', () => {
  const funktionen = ahrenbergFunktionen();

  it('Unternehmen: Name · Standorte · Anlagen · wer steuert · Datenlage', () => {
    const k = kopfzeile({ ebene: UNTERNEHMEN, sites: AHRENBERG, funktionen, mitDatenlage: true, now: JETZT });
    expect(k).toEqual({
      titel: 'Kunststoffwerk Ahrenberg GmbH',
      zahlen: '2 Standorte · 3 Anlagen · 1 steuert',
      datenlage: { text: '3 von 3 Anlagen liefern Daten', ton: 'ok' },
    });
  });

  it('eine Anlage, die sich nicht meldet, steht beim Namen hinter der Datenlage', () => {
    const stumm = { ...LINDACH, onlineCount: 0, lastSeenAt: new Date(JETZT.getTime() - 3 * 3_600_000).toISOString() };
    const k = kopfzeile({ ebene: UNTERNEHMEN, sites: [HALLE1, HALLE2, stumm], funktionen, mitDatenlage: true, now: JETZT });
    expect(k.datenlage?.ton).toBe('warn');
    expect(k.datenlage?.text).toMatch(/^2 von 3 Anlagen liefern Daten · Werk Lindach meldet sich .*nicht$/);
    // Blendet der Kunde die Datenlage aus, bleibt der Hinweis — er gehört zum Flotten-Status.
    const ohne = kopfzeile({ ebene: UNTERNEHMEN, sites: [HALLE1, HALLE2, stumm], funktionen, mitDatenlage: false, now: JETZT });
    expect(ohne.datenlage?.text).toMatch(/^Werk Lindach meldet sich .*nicht$/);
    expect(kopfzeile({ ebene: UNTERNEHMEN, sites: AHRENBERG, funktionen, mitDatenlage: false, now: JETZT }).datenlage).toBeNull();
  });

  it('Standort: Name und Anlagen stehen im Standort-Kopf, wer steuert in den Funktions-Zeilen — die Kopfzeile trägt die Datenlage', () => {
    const k = kopfzeile({
      ebene: { art: 'standort', standort: werkLindach() },
      sites: [LINDACH],
      funktionen,
      mitDatenlage: true,
      now: JETZT,
    });
    expect(k).toEqual({ titel: null, zahlen: null, datenlage: { text: '1 von 1 Anlage liefert Daten', ton: 'ok' } });
  });

  it('ohne Funktionen wird nichts über Steuerung behauptet', () => {
    const k = kopfzeile({ ebene: UNTERNEHMEN, sites: AHRENBERG, funktionen: null, mitDatenlage: true, now: JETZT });
    expect(k.zahlen).toBe('2 Standorte · 3 Anlagen');
    expect(steuerndeAnlagen(null)).toBeNull();
  });

  it('„reine Messung“ bleibt als Wort (Steuern-Regel): es benennt, was der Kunde ist — in der Kopfzeile des reinen Messkunden und in den Zahlen von Werk Lindach', () => {
    const nurMessen = structuredClone(funktionen);
    nurMessen.standorte[0].steuern.anlagen[0].teilnahme.zustand = 'kein_objekt';
    expect(kopfzeile({ ebene: UNTERNEHMEN, sites: AHRENBERG, funktionen: nurMessen, mitDatenlage: false, now: JETZT }).zahlen).toBe(
      '2 Standorte · 3 Anlagen · reine Messung',
    );
    const [ahrenberg, lindach] = standortGruppen({ ebene: UNTERNEHMEN, zeilen: [], sites: AHRENBERG, funktionen, now: JETZT });
    expect(ahrenberg.zahlen).toBe('2 Anlagen · 1 steuert · 2 von 2 Anlagen liefern Daten');
    expect(lindach.zahlen).toBe('1 Anlage · reine Messung · 1 von 1 Anlage liefert Daten');
    // … und dabei trägt Werk Lindach keine Zeile „Steuern & Optimieren“.
    expect(lindach.funktionen?.map((f) => f.funktion)).toEqual(['messen']);
  });
});

describe('die Funktionen je Standort: Messen immer, Steuern nur mit teilnehmender Anlage (Steuern-Regel)', () => {
  it('Werk Ahrenberg: Messen mit Datenlage der Messstellen, Steuern mit der teilnehmenden Anlage', () => {
    expect(funktionsZeilen(funktionWerkAhrenberg())).toEqual([
      {
        funktion: 'messen',
        label: 'Messen & Auswerten',
        zustand: 'aktiv',
        satz: 'Eingerichtet am 01.10.2026 · 15 von 16 Messstellen liefern Daten',
        ton: 'ok',
      },
      {
        funktion: 'steuern',
        label: 'Steuern & Optimieren',
        zustand: 'aktiv',
        satz: 'Läuft mit Werk Ahrenberg – Halle 1',
        ton: 'ok',
      },
    ]);
  });

  it('löst „immer beide, nie eine Leerstelle“ (PR 771) BEWUSST ab: an einem Standort, an dem keine Anlage steuert, schweigt Steuern — Messen bleibt benannt, auch „Noch nicht eingerichtet“', () => {
    // Werk Lindach misst nur: die Zeile „Steuern & Optimieren · Noch nicht eingerichtet“ war das Aufdrängen.
    for (const fs of [funktionWerkLindach(), funktionWerkLindach('bestand')]) {
      expect(funktionsZeilen(fs).map((z) => z.funktion), fs.name).toEqual(['messen']);
    }
    // Messen bleibt auch ohne Objekt eine benannte Zeile — dort gilt „nie eine Leerstelle“ weiter.
    for (const fs of [funktionWerkLindach('bestand'), funktionWerkAhrenberg('bestand')]) {
      expect(funktionsZeilen(fs)[0], fs.name).toMatchObject({ funktion: 'messen', satz: 'Noch nicht eingerichtet', ton: 'off' });
    }
    // Werk Ahrenberg spricht weiter, weil Halle 1 steuert — auch nach dem Umstieg.
    for (const fs of [funktionWerkAhrenberg(), funktionWerkAhrenberg('bestand')]) {
      const zeilen = funktionsZeilen(fs);
      expect(zeilen.map((z) => z.funktion), fs.name).toEqual(['messen', 'steuern']);
      for (const z of zeilen) {
        expect(z.satz.trim(), `${fs.name} ${z.funktion}`).not.toBe('');
        // Der Name steht vor dem Satz — im Satz nie ein zweites Mal.
        expect(z.satz, `${fs.name} ${z.funktion}`).not.toContain(z.label);
      }
    }
  });

  it('die Ebene ist die ANLAGE: jede Teilnahme, die der Kunde angestoßen hat, lässt den Standort sprechen — nur „kein Objekt“ und „archiviert“ schweigen', () => {
    for (const zustand of ['entwurf', 'eingerichtet', 'angehalten', 'aktiv'] as const) {
      const fs = funktionWerkLindach();
      fs.steuern.anlagen[0].teilnahme.zustand = zustand;
      expect(steuernSpricht(fs), zustand).toBe(true);
    }
    for (const zustand of ['kein_objekt', 'archiviert'] as const) {
      const fs = funktionWerkLindach();
      fs.steuern.anlagen[0].teilnahme.zustand = zustand;
      expect(steuernSpricht(fs), zustand).toBe(false);
    }
    // Werk Ahrenberg spricht, obwohl Halle 2 nur misst — eine teilnehmende Anlage genügt.
    expect(steuernSpricht(funktionWerkAhrenberg())).toBe(true);
    // Die Fixture teilt Halle 1 zwischen den Aufrufen — nur an einer Kopie drehen.
    const ohneHalle1 = structuredClone(funktionWerkAhrenberg());
    ohneHalle1.steuern.anlagen[0].teilnahme.zustand = 'kein_objekt';
    expect(steuernSpricht(ohneHalle1)).toBe(false);
    expect(funktionsZeilen(ohneHalle1).map((z) => z.funktion)).toEqual(['messen']);
  });
});

describe('die Standort-Gruppen der Anlagen-Tabelle', () => {
  const zeilen = anlagenZeilen({ overview: { sites: AHRENBERG } as never, earnings: null, dichte: 'komfortabel', now: JETZT });

  it('A7: je Standort seine Anlagen, seine Zahlen und ihre Funktionen — in der Reihenfolge des Servers', () => {
    const gruppen = standortGruppen({ ebene: UNTERNEHMEN, zeilen, sites: AHRENBERG, funktionen: ahrenbergFunktionen(), now: JETZT });
    expect(gruppen.map((g) => [g.name, g.zahlen, g.zeilen.map((z) => z.id)])).toEqual([
      ['Werk Ahrenberg', '2 Anlagen · 1 steuert · 2 von 2 Anlagen liefern Daten', [an1, an2]],
      ['Werk Lindach', '1 Anlage · reine Messung · 1 von 1 Anlage liefert Daten', [an3]],
    ]);
    expect(gruppen.map((g) => g.standortId)).toEqual([st1, st2]);
    expect(gruppen[0].funktionen?.map((f) => f.funktion)).toEqual(['messen', 'steuern']);
    // Werk Lindach misst nur: keine Steuern-Zeile (Steuern-Regel, löst „immer beide“ ab).
    expect(gruppen[1].funktionen?.map((f) => f.satz)).toEqual([
      'Eingerichtet am 15.10.2026 · 3 von 3 Messstellen liefern Daten',
    ]);
  });

  it('keine Anlage fällt heraus: ohne Standort steht sie zuletzt in einer benannten Gruppe', () => {
    const neu = zeile({ id: 'neu', name: 'Neubau Süd' });
    const alle = [...AHRENBERG, neu];
    const z = anlagenZeilen({ overview: { sites: alle } as never, earnings: null, dichte: 'komfortabel', now: JETZT });
    const gruppen = standortGruppen({ ebene: UNTERNEHMEN, zeilen: z, sites: alle, funktionen: ahrenbergFunktionen(), now: JETZT });
    expect(gruppen.flatMap((g) => g.zeilen.map((r) => r.id)).sort()).toEqual(alle.map((s) => s.id).sort());
    expect(gruppen.at(-1)).toMatchObject({
      standortId: null,
      name: 'Noch keinem Standort zugeordnet',
      zahlen: '1 Anlage · 1 von 1 Anlage liefert Daten',
      funktionen: [],
    });
  });

  it('ein archivierter Standort ist keine Gruppe; ein Standort ohne Anlage sagt das', () => {
    const ebene: UebersichtEbene = {
      art: 'unternehmen',
      name: 'Ahrenberg',
      standorte: [werkAhrenberg(), werkLindach({ zustand: 'archiviert' }), werkLindach({ id: 'leer', name: 'Lager Nord', anlagen: [] })],
    };
    const gruppen = standortGruppen({ ebene, zeilen, sites: [HALLE1, HALLE2], funktionen: null, now: JETZT });
    expect(gruppen.map((g) => g.name)).toEqual(['Werk Ahrenberg', 'Lager Nord']);
    expect(gruppen[1]).toMatchObject({ zahlen: '0 Anlagen', leer: 'Diesem Standort ist heute keine Anlage zugeordnet.' });
    // Ohne Funktionen: `null` = nicht abrufbar, nie eine erfundene Zeile.
    expect(gruppen[0].funktionen).toBeNull();
  });
});

describe('A13 · Geld-Regel: „Die Messdatenkunden brauchen keine Geldanzeige." (Captain 10.09.2026)', () => {
  /** Jede Kennzahl hat einen Wert — so erzeugt `leistenZellen` für JEDEN Baustein seine Zelle. */
  const ALLES = new Proxy({} as PortfolioKennzahlen, {
    get: (_t, key) =>
      key === 'geldNamen' ? null : key === 'datenlage' ? { erfuellt: 1, gesamt: 1, text: '1 von 1 Anlage liefert Daten' } : 1,
  });
  const ALLE_ANWENDUNGEN = catalog.anwendungen.map((a) => a.id);

  it('jede Zelle und jede Spalte mit Euro gehört einem GELD-Baustein — auch jede künftige', () => {
    const zellen = leistenZellen({
      order: PORTFOLIO_BAUSTEINE.map((b) => b.id),
      kennzahlen: ALLES,
      anlagen: 2,
      tonalitaet: 'eigenverbrauch' as FleetKind,
    });
    // Der Wächter ist verdrahtet: JEDER Leisten-Baustein des Katalogs hat eine
    // Zelle gebaut. Ein neuer Baustein ohne Zelle wird hier rot, bevor er
    // unbemerkt an der Regel vorbeigeht.
    expect(zellen.map((z) => z.id).sort()).toEqual(
      PORTFOLIO_BAUSTEINE.filter((b) => bausteinOrt(b.id).leiste).map((b) => b.id).sort(),
    );
    const mitEuro = zellen.filter((z) => z.einheit === '€' || /€|EUR/.test(`${z.wert} ${z.unterzeile ?? ''}`));
    expect(mitEuro.length).toBeGreaterThan(0);
    for (const z of mitEuro) expect(GELD_BAUSTEINE, `Zelle „${z.label}" zeigt Euro`).toContain(z.id);
    for (const [id, kopf] of Object.entries(SPALTEN_KOPF)) {
      if (kopf.einheit === '€') expect(GELD_BAUSTEINE, `Spalte „${kopf.titel}" zeigt Euro`).toContain(id);
    }
  });

  it('ein reiner Messkunde bekommt keinen Geld-Baustein — auch wenn JEDE Anwendung läuft und jeder Wert da ist', () => {
    const ids = verfuegbareBausteine({ anwendungen: ALLE_ANWENDUNGEN, kennzahlen: ALLES, anlagen: 1, uebersicht: { geld: false } });
    expect(ids.filter((id) => GELD_BAUSTEINE.includes(id))).toEqual([]);
    // … und die Regel beisst wirklich nur dort: mit Geld-Anlage sind sie da.
    const mitGeld = verfuegbareBausteine({ anwendungen: ALLE_ANWENDUNGEN, kennzahlen: ALLES, anlagen: 1, uebersicht: { geld: true } });
    expect(mitGeld).toEqual(expect.arrayContaining([...GELD_BAUSTEINE]));
  });

  it('Werk Lindach (reine Messung, kein Erzeuger/Speicher) ist keine Geld-Anlage — Halle 1 schon', () => {
    expect([...geldAnlagen([LINDACH], ahrenbergFunktionen())]).toEqual([]);
    expect([...geldAnlagen(AHRENBERG, ahrenbergFunktionen())]).toEqual([an1]);
    // Unbekannt ist nie „erlaubt": ohne Rollen und ohne Funktionen kein Geld.
    const ohneRollen = zeile({ id: 'r', name: 'R' });
    expect([...geldAnlagen([ohneRollen], null)]).toEqual([]);
  });

  it('Unternehmens-Übersicht: der Vorteil zählt NUR Halle 1, auch wenn der Server für alle Geld liefert', () => {
    const geld = geldAnlagen(AHRENBERG, ahrenbergFunktionen());
    const k = portfolioKennzahlen({ sites: AHRENBERG } as never, geldFuerAlle(), JETZT, geld);
    expect(k.erloesHeuteEur).toBeCloseTo(12.5, 5);
    expect(k.vermiedeneSpitzeEur).toBe(4800);
    expect(vorteilUnterzeile(k.erloesHeuteAnlagen, 3, k.geldNamen)).toBe('gegenüber Speicher ohne Steuerung · 1 von 3 Anlagen · nur Werk Ahrenberg – Halle 1');
    const z = anlagenZeilen({ overview: { sites: AHRENBERG } as never, earnings: geldFuerAlle(), dichte: 'komfortabel', now: JETZT, geld });
    expect(Object.fromEntries(z.map((r) => [r.id, r.heuteEur]))).toEqual({ [an1]: 12.5, [an2]: null, [an3]: null });
    // Ohne Regel (jede andere Flotte) zählt wie bisher jede Anlage.
    expect(portfolioKennzahlen({ sites: AHRENBERG } as never, geldFuerAlle(), JETZT).erloesHeuteEur).toBeCloseTo(37.5, 5);
  });

  it('Halle 2 ab 01.12.2026: steuert der Ladepunkt, zählt sie mit', () => {
    const ab = ahrenbergFunktionen();
    ab.standorte[0].steuern.anlagen[1].teilnahme.zustand = 'aktiv';
    const geld = geldAnlagen(AHRENBERG, ab);
    expect([...geld].sort()).toEqual([an1, an2].sort());
    const k = portfolioKennzahlen({ sites: AHRENBERG } as never, geldFuerAlle(), JETZT, geld);
    expect(k.erloesHeuteEur).toBeCloseTo(25, 5);
    expect(vorteilUnterzeile(k.erloesHeuteAnlagen, 3, k.geldNamen)).toBe(
      'gegenüber Speicher ohne Steuerung · 2 von 3 Anlagen · nur Werk Ahrenberg – Halle 1 und Werk Ahrenberg – Halle 2',
    );
  });
});
