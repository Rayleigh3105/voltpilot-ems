import { describe, expect, it } from 'vitest';
import type { Device, EntityLocalSetup } from './api';
import { aufbauBaum, aufbauGeraet, type AufbauEingabe, type AufbauGeraet } from './aufbauBaum';
import { gruppeFuer, gruppenKopf, gruppenZahl, sortiereGeraete, werteFuerGruppe } from './aufbauGruppen';
import { LEERER_FILTER, tabellenZeilen, type Aufklappzustand, type TabellenZeile } from './aufbauTabelle';
import { geraeteArtWort } from './geraetSeite';
import type { PlantComponent } from './komponenten';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import type { GeraeteKarte } from './zentraleListe';

/*
 * Die Gruppen im Aufbau (Konzept `vp-anlage-geraete-gruppiert`, GR-1 A · GR-2 A · GR-3 A): fünf feste Gruppen,
 * jedes Gerät einmal, darin nach Namen, ein Kopf mit Anzahl und ehrlicher Summe - erst ab zwei Gruppen je Box.
 */

const NOW = Date.parse('2026-11-07T10:49:17Z');
const FRISCH = new Date(NOW - 17_000).toISOString();

const komp = (o: Partial<PlantComponent> & Pick<PlantComponent, 'id' | 'role'>): PlantComponent => ({
  entityId: o.id,
  aspect: 'main',
  label: o.id,
  alias: null,
  derivedLabel: o.id,
  renameable: true,
  summary: '',
  deviceIds: [],
  provenance: null,
  reading: null,
  channels: [],
  control: false,
  schaltbar: false,
  freigabeQuelle: null,
  freigabeFaehig: false,
  primary: false,
  health: 'ok',
  measuredVia: null,
  orphaned: false,
  ...o,
});

const karte = (o: Partial<GeraeteKarte> & Pick<GeraeteKarte, 'id' | 'art'>): GeraeteKarte => ({
  titel: o.id,
  technischerName: null,
  untertitel: 'Gerät',
  zustand: 'liefert Daten · vor 17 Sek.',
  zustandWort: 'liefert Daten',
  zustandZeit: 'vor 17 Sek.',
  ton: 'ok',
  href: null,
  komponenten: [],
  zusatz: null,
  ...o,
});

const kw = (value: number, caption: string | null = null) => ({ value, unit: 'kW' as const, caption });

const pv = (id: string, titel: string, wert: number | null, ton: GeraeteKarte['ton'] = 'ok') =>
  karte({
    id,
    art: 'geraet',
    titel,
    untertitel: 'PV-Wechselrichter',
    ton,
    // Der Ton der Zeile folgt der Gesundheit ihrer Komponente (`zentraleListe`): warn = veraltet, off = nie gemeldet.
    komponenten: [
      komp({
        id: `k-${id}`,
        role: 'pv',
        health: ton === 'ok' ? 'ok' : ton === 'warn' ? 'stale' : 'never',
        reading: wert == null ? null : kw(wert),
      }),
    ],
  });
const verbraucher = (id: string, titel: string, wert: number | null, entityType = 'heating-rod') =>
  karte({
    id,
    art: 'geraet',
    titel,
    untertitel: 'Verbraucher',
    komponenten: [komp({ id: `k-${id}`, role: 'consumer', entityType, reading: wert == null ? null : kw(wert) })],
  });
const unterzaehler = (id: string, titel: string, wert: number | null) => verbraucher(id, titel, wert, 'sub-meter');
const netz = (id: string, titel: string, wert: number, caption: string) =>
  karte({
    id,
    art: 'geraet',
    titel,
    untertitel: 'Zähler',
    komponenten: [komp({ id: `k-${id}`, role: 'grid', reading: kw(wert, caption) })],
  });

const saeule = (id: string, o: Partial<ChargePoint> = {}): ChargePoint => ({
  deviceId: 'b-1',
  chargePointId: id,
  priority: false,
  connected: true,
  ready: true,
  connectors: [{ connectorId: 1, charging: false, status: 'Available' }],
  ...o,
});
const ladepunkt = (id: string, titel: string) =>
  karte({ id: `cp-${id}`, art: 'ladepunkt', titel, untertitel: 'Ladesäule · 1 Stecker' });

const g = (k: GeraeteKarte, chargers: ChargePoint[] = []): AufbauGeraet =>
  aufbauGeraet(k, { charging: { budget: null, chargers } as unknown as SiteCharging });

describe('gruppeFuer - jedes Gerät einmal, in der ersten passenden Gruppe', () => {
  it('stellt einen Hybrid-Wechselrichter unter Erzeugung, nicht unter Speicher oder Netz', () => {
    const hybrid = karte({
      id: 'inv',
      art: 'geraet',
      komponenten: [
        komp({ id: 'batt', role: 'storage', reading: { value: 68, unit: '%', caption: 'geladen' } }),
        komp({ id: 'batt#pv', role: 'pv', aspect: 'pv', reading: kw(4.2) }),
        komp({ id: 'grid', role: 'grid', reading: kw(0.3, 'Bezug') }),
        komp({ id: 'house', role: 'house', reading: kw(2.1) }),
      ],
    });
    expect(gruppeFuer(hybrid)).toBe('erzeugung');
  });

  it('ordnet Speicher, Zähler, Verbraucher, Unterzähler und Ladesäule ihrer Gruppe zu', () => {
    expect(gruppeFuer(karte({ id: 'b', art: 'geraet', komponenten: [komp({ id: 's', role: 'storage' })] }))).toBe('speicher');
    expect(gruppeFuer(netz('n', 'Netzanschluss', 0.6, 'Einspeisung'))).toBe('netz');
    expect(gruppeFuer(verbraucher('h', 'Heizstab', 2))).toBe('verbrauch');
    expect(gruppeFuer(unterzaehler('u', 'UV Halle', 7.9))).toBe('verbrauch');
    expect(gruppeFuer(ladepunkt('1', 'Wallbox'))).toBe('laden');
  });

  it('stellt eine Anlagensteuerung unter Erzeugung', () => {
    expect(gruppeFuer(karte({ id: 'as-ent-1', art: 'geraet' }))).toBe('erzeugung');
  });

  it('nimmt für ein Gerät ohne Komponente die gemeldete Rolle - ein Wechselrichter erzeugt', () => {
    const leer = karte({ id: 'src-1', art: 'geraet' });
    expect(gruppeFuer(leer, { role: 'pv-generation', kind: 'source' })).toBe('erzeugung');
    expect(gruppeFuer(leer, { role: 'grid-meter', kind: 'source' })).toBe('netz');
    expect(gruppeFuer(leer, { role: null, kind: 'inverter' })).toBe('erzeugung');
    // Schalter und Unbekanntes stehen unter Verbrauch (Konzept §3: Heizstab, Wärmepumpe, Schalter → Verbrauch).
    expect(gruppeFuer(leer, null)).toBe('verbrauch');
  });

  it('lässt Funde und „Nicht mehr verbunden" ohne Gruppe', () => {
    expect(gruppeFuer(karte({ id: 'neu:src-7', art: 'neu' }))).toBeNull();
    expect(gruppeFuer(karte({ id: 'verwaist', art: 'verwaist' }))).toBeNull();
  });
});

describe('werteFuerGruppe - der Wert der Gruppe zuerst', () => {
  it('zeigt am Hybrid unter Erzeugung zuerst die PV, den Ladestand danach', () => {
    const werte = [
      { art: 'speicher' as const, text: '68 % geladen', label: 'Speicher 68 % geladen' },
      { art: 'pv' as const, text: '4,2 kW', label: 'PV 4,2 kW' },
    ];
    expect(werteFuerGruppe(werte, 'erzeugung').map((w) => w.art)).toEqual(['pv', 'speicher']);
    // Ohne passenden Wert bleibt alles, wie es ist.
    expect(werteFuerGruppe(werte, 'netz')).toEqual(werte);
  });
});

describe('sortiereGeraete - nach Gruppe, darin nach Namen, nie nach Leistung', () => {
  it('sortiert natürlich: Kaco 2 vor Kaco 10', () => {
    const liste = [pv('a', 'Kaco 10', 1), pv('b', 'Kaco 2', 9), pv('c', 'Kaco 1', 5)].map((k) => g(k));
    expect(sortiereGeraete(liste).map((x) => x.titel)).toEqual(['Kaco 1', 'Kaco 2', 'Kaco 10']);
  });

  it('stellt im Verbrauch die Unterzähler zuerst und Funde ans Ende', () => {
    const liste = [
      karte({ id: 'neu:src-9', art: 'neu' }),
      verbraucher('h', 'Heizstab', 2),
      ladepunkt('1', 'Wallbox'),
      unterzaehler('u2', 'UV Keller', 0.1),
      unterzaehler('u1', 'UV Halle', 7.9),
      netz('n', 'Netzanschluss', 0.6, 'Einspeisung'),
      pv('k', 'Kaco 1', 2.9),
    ].map((k) => g(k));
    expect(sortiereGeraete(liste).map((x) => x.id)).toEqual(['k', 'n', 'u1', 'u2', 'h', 'cp-1', 'neu:src-9']);
  });
});

describe('gruppenKopf - Anzahl und ehrliche Summe (GR-3 A)', () => {
  it('summiert die Zeilen, wenn mindestens zwei da sind und alle aktuell sind', () => {
    const kopf = gruppenKopf('erzeugung', [pv('1', 'Kaco 1', 2.9), pv('2', 'Kaco 2', 2.9), pv('3', 'Kaco 3', 2.1)].map((k) => g(k)));
    expect(kopf).toMatchObject({ wort: 'Erzeugung', anzahl: 3, summe: '7,9 kW', hinweis: null });
    expect(kopf.label).toBe('Erzeugung, 3 Geräte, zusammen 7,9 kW');
  });

  it('zeigt bei einer Zeile keine Summe - die Zeile sagt es selbst', () => {
    expect(gruppenKopf('erzeugung', [g(pv('1', 'Kaco 1', 2.9))])).toMatchObject({ anzahl: 1, summe: null, hinweis: null });
  });

  it('zeigt statt einer Teilsumme, wie viele Geräte keinen aktuellen Wert haben - nie eine 0', () => {
    const ohneWert = gruppenKopf('erzeugung', [pv('1', 'Kaco 1', 2.9), pv('2', 'Kaco 2', null)].map((k) => g(k)));
    expect(ohneWert).toMatchObject({ summe: null, hinweis: '1 Gerät ohne aktuellen Wert' });
    // Ein Wert an einer Komponente, die sich nicht meldet, gilt nicht als aktuell - dieselbe Regel wie der Anlagenkopf.
    const alt = gruppenKopf('erzeugung', [pv('1', 'Kaco 1', 2.9), pv('2', 'Kaco 2', 2.9, 'warn'), pv('3', 'K3', 1, 'off')].map((k) => g(k)));
    expect(alt).toMatchObject({ summe: null, hinweis: '2 Geräte ohne aktuellen Wert' });
  });

  it('summiert Verbraucher und - für sich - Unterzähler', () => {
    const uv = gruppenKopf('verbrauch', [unterzaehler('u1', 'UV Halle', 7.9), unterzaehler('u2', 'UV Keller', 0.1)].map((k) => g(k)));
    expect(uv.summe).toBe('8,0 kW');
    const einzeln = gruppenKopf('verbrauch', [verbraucher('h', 'Heizstab', 2), verbraucher('w', 'Wärmepumpe', 0.9)].map((k) => g(k)));
    expect(einzeln.summe).toBe('2,9 kW');
  });

  it('zählt nichts doppelt: mischt die Verbrauchsgruppe Unterzähler und einzelne Verbraucher, entfällt ihre Summe', () => {
    // Der Heizstab kann hinter UV Keller hängen - dann stünde er zweimal in der Summe.
    const kopf = gruppenKopf(
      'verbrauch',
      [unterzaehler('u1', 'UV Halle', 7.9), unterzaehler('u2', 'UV Keller', 2.1), verbraucher('h', 'Heizstab', 2)].map((k) => g(k)),
    );
    expect(kopf).toMatchObject({ anzahl: 3, summe: null, hinweis: null });
    expect(kopf.label).toBe('Verbrauch, 3 Geräte');
  });

  it('summiert das Netz nie (zwei Zähler messen oft denselben Anschluss) und nie einen Ladestand', () => {
    const zwei = gruppenKopf('netz', [netz('n1', 'Netz A', 3, 'Bezug'), netz('n2', 'Netz B', 3, 'Bezug')].map((k) => g(k)));
    expect(zwei).toMatchObject({ anzahl: 2, summe: null, hinweis: null });
    const speicher = (id: string) =>
      karte({ id, art: 'geraet', komponenten: [komp({ id: `k-${id}`, role: 'storage', reading: { value: 50, unit: '%', caption: 'geladen' } })] });
    expect(gruppenKopf('speicher', [g(speicher('s1')), g(speicher('s2'))])).toMatchObject({ summe: null, hinweis: null });
  });

  it('zählt an den Ladesäulen, wie viele laden - im Wortlaut des Cockpits', () => {
    const laedt = (id: string, powerKw: number | null) =>
      saeule(id, { connectors: [{ connectorId: 1, charging: true, powerKw, status: 'Charging' }] });
    const punkte = ['A', 'B', 'C', 'D'].map((id) => ladepunkt(id, `Ladepunkt ${id}`));
    const chargers = [laedt('A', 11), laedt('B', 7.2), saeule('C'), saeule('D')];
    expect(gruppenKopf('laden', punkte.map((k) => g(k, chargers))).summe).toBe('2 von 4 laden · 18,2 kW');
    const ohneMessung = [laedt('A', 11), laedt('B', null), saeule('C'), saeule('D')];
    expect(gruppenKopf('laden', punkte.map((k) => g(k, ohneMessung))).summe).toBe('2 von 4 laden · Leistung nicht messbar');
    expect(gruppenKopf('laden', punkte.slice(2).map((k) => g(k, chargers))).summe).toBe('lädt gerade nicht');
    // Eine getrennte Säule hat keinen aktuellen Wert.
    const getrennt = [laedt('A', 11), { ...saeule('B'), connected: false }];
    const kopf = gruppenKopf('laden', punkte.slice(0, 2).map((k) => g({ ...k, ton: k.id === 'cp-B' ? 'warn' : 'ok' }, getrennt)));
    expect(kopf).toMatchObject({ summe: null, hinweis: '1 Gerät ohne aktuellen Wert' });
  });

  it('zeigt unter Suche und Filter keine Teilsumme', () => {
    const kopf = gruppenKopf('erzeugung', [pv('1', 'Kaco 1', 2.9), pv('2', 'Kaco 2', 2.9)].map((k) => g(k)), true);
    expect(kopf).toMatchObject({ anzahl: 2, summe: null, hinweis: null });
  });
});

describe('gruppenZahl', () => {
  it('zählt Gruppen, nicht Geräte - Funde zählen nicht', () => {
    const liste = [pv('1', 'Kaco 1', 1), pv('2', 'Kaco 2', 1), karte({ id: 'neu:x', art: 'neu' })].map((k) => g(k));
    expect(gruppenZahl(liste)).toBe(1);
  });
});

/* --- Am ganzen Baum: Schramm „Zuhause" (Mitschnitt 07.11.2026 10:49Z, Werte wie im Screenshot 12:23) --------- */

const BOX: Device = {
  id: 'b-1',
  externalRef: 'edge-tgjn9gd',
  siteId: 's-1',
  kind: 'inverter',
  name: null,
  status: 'active',
  lastSeenAt: FRISCH,
  createdAt: null,
} as Device;

/** Die Reihenfolge, in der die Box die Quellen meldet (nach Quellkennung) - für den Kunden Zufall. */
const SCHRAMM: GeraeteKarte[] = [
  karte({ id: 'box:edge-tgjn9gd', art: 'box' }),
  pv('src-0b1c', 'Kaco 3', 2.1),
  netz('src-2a7f', 'Netzanschluss', 0.6, 'Einspeisung'),
  pv('src-3d90', 'Kaco 2', 2.9),
  unterzaehler('src-5e11', 'UV Keller', 0.1),
  pv('src-8c42', 'Kaco 1', 2.9),
  unterzaehler('src-c7a0', 'UV Halle', 7.9),
];

const schramm = (o: Partial<AufbauEingabe> = {}): AufbauEingabe => ({
  siteId: 's-1',
  siteName: 'Zuhause',
  standorte: null,
  devices: [BOX],
  devicesFetchedAt: NOW,
  karten: SCHRAMM,
  localSetup: [] as EntityLocalSetup[],
  charging: null,
  registryBoxId: 'b-1',
  overview: null,
  now: NOW,
  ...o,
});

const OFFEN: Aufklappzustand = { offen: (_id, vorgabe) => vorgabe, geraete: new Set() };
const lesen = (rows: TabellenZeile[]) =>
  rows.map((r) =>
    r.typ === 'gruppe'
      ? `[${r.kopf.wort} ${r.kopf.anzahl}${r.kopf.summe ? ` · ${r.kopf.summe.replace(' ', ' ')}` : ''}]`
      : r.typ === 'geraet'
        ? r.geraet.titel
        : r.typ,
  );

describe('tabellenZeilen gruppiert - Schramm „Zuhause"', () => {
  it('liest Erzeugung · Netz · Verbrauch mit Köpfen, darin nach Namen, Unterzähler mit Summe', () => {
    expect(lesen(tabellenZeilen(aufbauBaum(schramm()), LEERER_FILTER, OFFEN))).toEqual([
      'anlage',
      'box',
      '[Erzeugung 3 · 7,9 kW]',
      'Kaco 1',
      'Kaco 2',
      'Kaco 3',
      '[Netz 1]',
      'Netzanschluss',
      '[Verbrauch 2 · 8,0 kW]',
      'UV Halle',
      'UV Keller',
    ]);
  });

  it('läuft nie gegen den Anlagenkopf: PV im Kopf = Summe unter Erzeugung (eine Zeitbasis, PR 1778)', () => {
    const baum = aufbauBaum(schramm());
    const kopfPv = baum.anlagen[0].werte.find((w) => w.art === 'pv')?.text;
    const erzeugung = tabellenZeilen(baum, LEERER_FILTER, OFFEN).find((r) => r.typ === 'gruppe' && r.kopf.gruppe === 'erzeugung');
    expect(kopfPv).toBe('7,9\u00a0kW');
    expect(erzeugung?.typ === 'gruppe' && erzeugung.kopf.summe).toBe(kopfPv);
  });

  it('nennt einen Unterzähler so wie seine Geräteseite, mit dem Zählersymbol', () => {
    const uv = aufbauBaum(schramm()).anlagen[0].boxen[0].geraete.find((x) => x.titel === 'UV Halle');
    expect(uv).toMatchObject({ gruppe: 'verbrauch', icon: 'activity', kategorie: 'home' });
    // Das Wort der Spalte Art kommt aus derselben Quelle wie die Geräteseite (UV-3 A).
    const zaehler = [komp({ id: 'k', role: 'consumer', entityType: 'sub-meter' })];
    expect(geraeteArtWort('quelle', 'consumer', zaehler)).toBe('Unterzähler');
    expect(geraeteArtWort('quelle', 'consumer', [komp({ id: 'k', role: 'consumer', entityType: 'heating-rod' })])).toBe('Verbraucher');
  });

  it('zeigt einen Treffer mit seiner Gruppe, Gruppen ohne Treffer entfallen', () => {
    expect(lesen(tabellenZeilen(aufbauBaum(schramm()), { ...LEERER_FILTER, q: 'uv halle' }, OFFEN))).toEqual([
      'anlage',
      'box',
      // Ein Treffer von zweien: keine Teilsumme.
      '[Verbrauch 1]',
      'UV Halle',
    ]);
  });

  it('zeigt bei nur einer Gruppe an der Box keine Köpfe, nur die Reihenfolge', () => {
    const nurPv = schramm({ karten: SCHRAMM.filter((k) => k.art === 'box' || k.untertitel === 'PV-Wechselrichter') });
    expect(lesen(tabellenZeilen(aufbauBaum(nurPv), LEERER_FILTER, OFFEN))).toEqual(['anlage', 'box', 'Kaco 1', 'Kaco 2', 'Kaco 3']);
  });

  it('gruppiert je Box (GR-2 A): eine Box nur mit Ladepunkten bleibt ohne Kopf', () => {
    const hof: Device = { ...BOX, id: 'b-2', externalRef: 'edge-hof' } as Device;
    const punkte = ['2', '1'].map((n) => ladepunkt(n, `Ladepunkt ${n}`));
    const chargers = ['2', '1'].map((n) => saeule(n, { deviceId: 'b-2' }));
    const rows = tabellenZeilen(
      aufbauBaum(
        schramm({
          devices: [BOX, hof],
          karten: [...SCHRAMM, ...punkte],
          charging: { budget: null, chargers } as unknown as SiteCharging,
        }),
      ),
      LEERER_FILTER,
      OFFEN,
    );
    const ab = lesen(rows).lastIndexOf('box');
    expect(lesen(rows).slice(ab)).toEqual(['box', 'Ladepunkt 1', 'Ladepunkt 2']);
    expect(rows.filter((r) => r.typ === 'gruppe').map((r) => r.key)).toEqual([
      'b-1::gruppe::erzeugung',
      'b-1::gruppe::netz',
      'b-1::gruppe::verbrauch',
    ]);
  });
});
