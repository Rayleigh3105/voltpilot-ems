import { describe, expect, it } from 'vitest';
import type { OverviewSite } from './api';
import { anlagenKopf, aufbauBaum, KOPF_FRISCH_MS, type AufbauAnlage } from './aufbauBaum';
import { plantModel, type PlantComponent } from './komponenten';
import { zentraleListe, type GeraeteKarte } from './zentraleListe';
import {
  ZB_BOX_REF,
  ZB_SITE_ID,
  ZB_SITE_NAME,
  zbBox,
  zbEntities,
  zbLocalSetup,
  zbOverviewSite,
  zbScreenshot,
  zbSources,
  zbTopology,
  type ZeitbasisStand,
} from './test/zeitbasisFixtures';

const plain = (s: string) => s.replace(/ /g, ' ');
const NOW = Date.parse('2026-11-07T11:23:00Z');

/** Die ganze Kette der Seite: Modell → Karten → Baum, mit der Übersicht daneben. */
function anlage(stand: ZeitbasisStand, now = NOW): { a: AufbauAnlage; karten: GeraeteKarte[] } {
  const sources = zbSources(stand);
  const model = plantModel(zbEntities, zbTopology(stand), zbLocalSetup, sources);
  const box = zbBox(now);
  const karten = zentraleListe({
    siteId: ZB_SITE_ID, model, devices: [box], devicesFetchedAt: now, boxRef: ZB_BOX_REF,
    localSetup: zbLocalSetup, sources, charging: null, now,
  });
  const baum = aufbauBaum({
    siteId: ZB_SITE_ID, siteName: ZB_SITE_NAME, standorte: null, devices: [box], devicesFetchedAt: now, karten,
    localSetup: zbLocalSetup, charging: null, registryBoxId: box.id, overview: [zbOverviewSite(stand)], now,
  });
  return { a: baum.anlagen[0], karten };
}
const kopf = (a: AufbauAnlage) => a.werte.map((w) => `${w.label}`).map(plain);
const zeile = (a: AufbauAnlage, titel: string) =>
  plain(a.boxen.flatMap((b) => b.geraete).find((g) => g.titel === titel)?.werte[0]?.text ?? '–');

describe('Anlagenkopf und Gerätezeilen auf einer Zeitbasis (Werkhof Linde = Fall vom 07.11.2026, 12:23)', () => {
  it('Nachstellung: der Kopf sagt dasselbe wie die Zeile des Netzzählers, nie „Bezug 5,4" neben „0,6 kW Einspeisung"', () => {
    const { a } = anlage(zbScreenshot(NOW));
    expect(zeile(a, 'Netzanschluss')).toBe('0,6 kW Einspeisung');
    expect(kopf(a)).toContain('Netz Einspeisung 0,6 kW');
    expect(kopf(a).join(' | ')).not.toContain('Bezug');
  });

  it('PV im Kopf ist die Summe der PV-Zeilen (7,9 kW), nicht der Rohwert der Übersicht (8,1 kW)', () => {
    const { a } = anlage(zbScreenshot(NOW));
    expect(['PV Dach Ost', 'PV Dach Mitte', 'PV Dach West'].map((t) => zeile(a, t))).toEqual(['2,6 kW', '2,6 kW', '2,7 kW']);
    expect(kopf(a)).toEqual(['PV 7,9 kW', 'Netz Einspeisung 0,6 kW']);
    expect(a.wertStand).toBe('aktuell');
  });

  it('frische Werte tragen kein Alter; ab zwei Abruftakten nennt der Kopf das Alter der ältesten Zeile', () => {
    expect(anlage(zbScreenshot(NOW)).a.wertAlter).toBeNull();
    const alt = { ...zbScreenshot(NOW), gelesenAm: NOW - 2 * 60_000 };
    const { a } = anlage(alt);
    expect(plain(a.wertAlter ?? '')).toBe('vor 2 Min.');
    // Dieselbe Zeit, die die Zeile selbst nennt.
    expect(plain(a.boxen[0].geraete.find((g) => g.titel === 'Netzanschluss')!.zustandZeit ?? '')).toBe('vor 2 Min.');
    expect(KOPF_FRISCH_MS).toBe(60_000);
  });

  it('folgt der nächsten Lesung: die Zeile bewegt sich, der Kopf mit ihr', () => {
    const naechste = { ...zbScreenshot(NOW), netzKw: 1.2, uebersicht: { pvKw: 7.0, gridKw: -4.0 } };
    const { a } = anlage(naechste);
    expect(zeile(a, 'Netzanschluss')).toBe('1,2 kW Bezug');
    expect(kopf(a)).toContain('Netz Bezug 1,2 kW');
  });
});

describe('anlagenKopf — Regeln je Rolle', () => {
  const ov = (o: Partial<OverviewSite['live']> = {}, ts = new Date(NOW - 6_000).toISOString()): OverviewSite =>
    ({ id: 's', name: 'S', onlineCount: 1, live: { ts, pvKw: 8.1, gridKw: 5.4, loadKw: 13.5, socPct: 55, ...o } }) as OverviewSite;
  const komp = (o: Partial<PlantComponent> & Pick<PlantComponent, 'id' | 'role'>): PlantComponent =>
    ({ entityId: o.id, aspect: 'main', label: o.id, health: 'ok', orphaned: false, reading: null, primary: false, ...o }) as PlantComponent;
  const karte = (komponenten: PlantComponent[], gelesenAm: string | null = new Date(NOW - 10_000).toISOString()): GeraeteKarte => ({
    id: komponenten[0].id, art: 'geraet', titel: komponenten[0].id, untertitel: '', zustand: '', ton: 'ok', href: null,
    komponenten, zusatz: null, gelesenAm,
  });
  const texte = (k: { werte: { label: string }[] }) => k.werte.map((w) => plain(w.label));

  it('ohne Karten (Seite lädt noch) bleibt der Kopf der Übersicht', () => {
    expect(texte(anlagenKopf(null, ov(), NOW))).toEqual(['PV 8,1 kW', 'Speicher 55 %', 'Netz Bezug 5,4 kW']);
  });

  it('eine Rolle ohne jede Zeile nimmt die Übersicht - es gibt nichts, dem sie widerspräche', () => {
    const k = anlagenKopf([karte([komp({ id: 'pv', role: 'pv', reading: { value: 3, unit: 'kW', caption: null } })])], ov(), NOW);
    expect(texte(k)).toEqual(['PV 3,0 kW', 'Speicher 55 %', 'Netz Bezug 5,4 kW']);
  });

  it('mehrere Netz-Komponenten: keine Zeile ist „das Netz" (Zuordnung kann summieren) - die Übersicht bleibt', () => {
    const g = (id: string) => komp({ id, role: 'grid', reading: { value: 0.6, unit: 'kW', caption: 'Einspeisung' } });
    expect(texte(anlagenKopf([karte([g('a')]), karte([g('b')])], ov({ socPct: null }), NOW))).toEqual(['PV 8,1 kW', 'Netz Bezug 5,4 kW']);
  });

  it('der Speicher-Chip ist der Ladestand der einen Speicher-Zeile', () => {
    const s = komp({ id: 'bat', role: 'storage', reading: { value: 61.6, unit: '%', caption: 'geladen' } });
    expect(texte(anlagenKopf([karte([s])], ov({ pvKw: null, gridKw: null }), NOW))).toEqual(['Speicher 62 %']);
  });

  it('Zeilen ohne aktuellen Wert: kein Chip, „keine aktuellen Werte" - nie der Rohwert daneben, nie eine 0', () => {
    const k = anlagenKopf(
      [
        karte([komp({ id: 'pv', role: 'pv', health: 'stale', reading: { value: 3, unit: 'kW', caption: null } })]),
        karte([komp({ id: 'netz', role: 'grid', health: 'never' })]),
      ],
      ov({ socPct: null }),
      NOW,
    );
    expect(k).toEqual({ werte: [], stand: 'veraltet', alter: null });
  });

  it('eine verwaiste Komponente zählt nicht in die PV-Summe', () => {
    const k = anlagenKopf(
      [karte([
        komp({ id: 'a', role: 'pv', reading: { value: 2, unit: 'kW', caption: null } }),
        komp({ id: 'b', role: 'pv', orphaned: true, reading: { value: 5, unit: 'kW', caption: null } }),
      ])],
      ov({ socPct: null, gridKw: null }),
      NOW,
    );
    expect(texte(k)).toEqual(['PV 2,0 kW']);
  });

  it('ein Übersichts-Chip ohne Zeile nennt sein Alter, wenn er nicht frisch ist', () => {
    const k = anlagenKopf(null, ov({}, new Date(NOW - 3 * 60_000).toISOString()), NOW);
    expect(plain(k.alter ?? '')).toBe('vor 3 Min.');
  });
});
