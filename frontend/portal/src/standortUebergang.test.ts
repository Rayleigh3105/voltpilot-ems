import { describe, expect, it } from 'vitest';
import type { Earnings, Funktionen, Overview, OverviewSite, Site } from './api';
import { anlageOhneGeld } from './anlageGeld';
import { canonicalShellHash, canonicalShellRoute, orteAus, startEbene, type ShellInput } from './betriebsart';
import { geraetSeiteHash, hashForRoute, pageRoute, parseRoute } from './nav';
import { portfolioKennzahlen } from './portfolioCockpit';
import { anlageSurface, type AnlageSurfaceInput } from './surface';
import {
  GELD_BLEIBT,
  STARTSEITE_UNTERNEHMEN,
  STEUERUNG_BLEIBT,
  wasSichAendert,
} from './standortVorschlag';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  FIXTURE_IDS,
} from './test/standorteFixtures';
import { geldAnlagen } from './uebersicht';

const { an1, an2, an3 } = FIXTURE_IDS;

describe('AP-14 IP-14 · „Was sich ändert“ ist ein reines Kundenurteil', () => {
  const faelle = [
    {
      name: 'Mehr-Anlagen-Steuerkunde wechselt vom Portfolio zur Unternehmens-Übersicht',
      input: { aktuelleEbene: 'heute', zielGruppen: 2, isAdmin: false, betriebsart: 'endkunde', anlagen: [{ tarifArt: 'fest' }], anwendungen: ['monitoring', 'lastspitzenkappung'] },
      erwartet: [STARTSEITE_UNTERNEHMEN, GELD_BLEIBT, STEUERUNG_BLEIBT],
    },
    {
      name: 'reiner Messkunde liest weder Geld noch Steuerung oder Fahrpläne',
      input: { aktuelleEbene: 'heute', zielGruppen: 2, isAdmin: false, betriebsart: null, anlagen: [{ tarifArt: 'ohne' }], anwendungen: ['monitoring'] },
      erwartet: [STARTSEITE_UNTERNEHMEN],
    },
    {
      name: 'Zusammenlegen zu einem Standort verspricht keine Unternehmens-Übersicht',
      input: { aktuelleEbene: 'heute', zielGruppen: 1, isAdmin: false, betriebsart: 'endkunde', anlagen: [{ tarifArt: 'dynamisch' }], anwendungen: ['verbraucher'] },
      erwartet: [GELD_BLEIBT, STEUERUNG_BLEIBT],
    },
    {
      name: 'bestehende Unternehmens-Landung wird nicht als Änderung ausgegeben',
      input: { aktuelleEbene: 'unternehmen', zielGruppen: 3, isAdmin: false, betriebsart: 'endkunde', anlagen: [{ tarifArt: 'ohne' }], anwendungen: ['monitoring'] },
      erwartet: [],
    },
    {
      name: 'Betreiber-Rahmen bleibt im Portfolio und bekommt kein falsches Startseiten-Versprechen',
      input: { aktuelleEbene: 'heute', zielGruppen: 2, isAdmin: false, betriebsart: 'betreiber', anlagen: [{ tarifArt: 'ohne' }], anwendungen: ['monitoring'] },
      erwartet: [],
    },
  ] as const;

  for (const fall of faelle) {
    it(fall.name, () => expect(wasSichAendert(fall.input)).toEqual(fall.erwartet));
  }
});

describe('AP-14 IP-14 · gestern Portfolio, heute Unternehmens-Übersicht', () => {
  const ids = [an1, an2, an3];
  const rahmen = { isAdmin: false, loaded: true, tenantReady: true, betriebsart: 'endkunde' as const };
  const vorherOrte = orteAus(
    {
      stichtag: '2026-09-20',
      standorte: [],
      nichtGezeigt: [],
      nochNichtZugeordnet: { anlagenZahl: 3, anlagen: ids.map((id) => ({ id, name: id })) },
    },
    ahrenbergUnternehmen({ standortZahl: 0, anlagenZahl: 3, sitz: null }),
  );
  const nachherOrte = orteAus(ahrenbergHeute(), ahrenbergUnternehmen());

  function shell(orte: NonNullable<ReturnType<typeof orteAus>>): ShellInput {
    return { ...rahmen, siteCount: ids.length, ebene: startEbene({ ...rahmen, siteIds: ids, orte }) };
  }

  function ziel(hash: string, zustand: ShellInput): string {
    const route = parseRoute(hash);
    const kanonisch = canonicalShellRoute({ shell: zustand, route, siteIds: ids }) ?? route;
    return canonicalShellHash(kanonisch, hash);
  }

  it('ändert die Bedeutung der Landung, nicht ihre stabile Portfolio-Adresse', () => {
    expect(shell(vorherOrte).ebene).toEqual({ art: 'heute' });
    expect(shell(nachherOrte).ebene?.art).toBe('unternehmen');
    expect(ziel('#/uebersicht', shell(vorherOrte))).toBe('#/portfolio');
    expect(ziel('#/uebersicht', shell(nachherOrte))).toBe('#/portfolio');
  });

  it('trägt Portfolio- und Geräte-Lesezeichen vor und nach der Bestätigung verlustfrei', () => {
    const geraet = geraetSeiteHash(an1, 'VP-BOX-2024-0117', 'inverter-1');
    const lesezeichen = ['#/portfolio/messwerte?z=monat&at=2026-09-01', '#/portfolio/erloese?z=monat&at=2026-09-01', geraet];
    for (const bookmark of lesezeichen) {
      expect(ziel(bookmark, shell(vorherOrte)), `vorher ${bookmark}`).toBe(bookmark);
      expect(ziel(bookmark, shell(nachherOrte)), `nachher ${bookmark}`).toBe(bookmark);
    }
    expect(parseRoute(geraet).siteId).toBe(an1);
    expect(hashForRoute(parseRoute(geraet))).toBe(geraet);
  });
});

describe('AP-14 IP-14 · reine Verbrauchsanlage mit Tarif', () => {
  const zeile = {
    id: an2,
    name: 'Werk Ahrenberg – Halle 2',
    roleCounts: { pv: 0, storage: 0, consumer: 1, grid: 1 },
  } as OverviewSite;
  const funktionen: Funktionen = ahrenbergFunktionen();
  const eingang = {
    config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', netzladenErlaubt: false, leistungspreisEurKw: 120 },
    entities: [{ id: 'netz', entityType: 'grid-meter', label: 'Hauptzähler', capabilities: { measure: [{ channel: 'power_kw' }] } }],
  } as AnlageSurfaceInput;
  const earnings = {
    sites: [{ id: an2, dailySaved: [], peakShaving: { avoidedEur: 2640, avoidedKw: 22 } }],
    totals: { savedEur: 2640 },
  } as unknown as Earnings;
  const overview = { sites: [zeile], totals: {}, dailySavings: [] } as unknown as Overview;

  it('hält Cockpit, Portfolio und Erlöse mit demselben Tarif zeichenidentisch', () => {
    const flaeche = anlageSurface(eingang);
    expect(flaeche.moneyStreams.length).toBeGreaterThan(0);
    expect(flaeche.deepViews).toContain('erloes-historie');

    const vorher = anlageOhneGeld(an2, null, zeile, 'fest') ? null : flaeche;
    const nachher = anlageOhneGeld(an2, funktionen, zeile, 'fest') ? null : flaeche;
    expect(JSON.stringify(nachher)).toBe(JSON.stringify(vorher));

    const portfolioVorher = portfolioKennzahlen(overview, earnings, new Date('2026-10-20T08:15:30Z'), null);
    const portfolioNachher = portfolioKennzahlen(overview, earnings, new Date('2026-10-20T08:15:30Z'), null);
    expect(JSON.stringify(portfolioNachher)).toBe(JSON.stringify(portfolioVorher));
    expect(portfolioNachher.vermiedeneSpitzeEur).toBe(2640);
  });

  it('zeigt auf der Ebenen-Übersicht weiterhin kein Geld', () => {
    expect(geldAnlagen([zeile], funktionen)).toEqual(new Set());
  });
});
