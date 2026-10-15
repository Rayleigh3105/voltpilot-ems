/**
 * Der Werte-Katalog, TS-Zwilling (Alerting Scheibe 2, Konzept vp-alerting-konzept-m1 §6.3).
 *
 * Die EINE Wahrheit ist die Server-Ressource
 * `services/api/src/main/resources/wertekatalog/katalog.json`; dieser Zwilling spiegelt ihre
 * `eintraege` inhaltlich (nicht byte-gleich - andere JSON-Formatierung ist erlaubt), geprüft von
 * `werteKatalog.sync.test.ts`. Muster: `ConsumerSignalCatalog.java` + `consumers/signals.ts`
 * ("the ONE truth" mit TS-Zwilling) und der Flow-Katalog (`flows/catalog.sync.test.ts`).
 *
 * `leser.art` ist eine der festen Leserarten aus §6.3 (acht insgesamt, hier nur die vier, die der
 * Katalog bisher nutzt: `zustand`, `ereignis`, `anlagenfluss`, `messreihe`). Ein neuer Eintrag
 * derselben Leserart ist ein weiterer Katalog-Eintrag, kein neuer Code (§6.3 Nr. 2); `geraet.messwert`
 * ist eine FAMILIE (Bezug `komponente` + Parameter `kanal`), kein Eintrag je Kanal.
 */

export type LeserArt =
  | 'anlagenfluss'
  | 'messreihe'
  | 'menge'
  | 'kennzahl'
  | 'geld'
  | 'zustand'
  | 'ereignis'
  | 'zaehlung';

/** Geschlossenes Vokabular der Bedingungsarten (§6.4). */
export type Bedingungsart = 'zustand' | 'ereignis' | 'ueber' | 'unter' | 'ausserhalb' | 'keine_daten';

export type Schwere = 'hinweis' | 'warnung' | 'dringend';

export interface WerteKatalogLeser {
  art: LeserArt;
  feld?: string;
  arten?: string[];
  bezugsfeld?: string;
}

export interface WerteKatalogVorschlag {
  dauer_s?: number;
  erholen_s?: number;
  schwere?: Schwere;
  ziel?: string[];
}

export interface WerteKatalogEintrag {
  wertart: string;
  name: string;
  satzname: string;
  bezug: string;
  form: string;
  leser: WerteKatalogLeser;
  recht: string;
  bedingungen: Bedingungsart[];
  zustaende?: string[];
  vorschlag?: WerteKatalogVorschlag;
}

/**
 * Die Einträge, inhaltlich identisch zu `services/api/.../wertekatalog/katalog.json`
 * (`werteKatalog.sync.test.ts` hält das fest). Reihenfolge ist wie in der JSON-Datei, aber nicht
 * bedeutungstragend - Wertart ist der Schlüssel.
 */
export const WERTE_KATALOG: WerteKatalogEintrag[] = [
  {
    wertart: 'box.erreichbar',
    name: 'Box erreichbar',
    satzname: 'die Box',
    bezug: 'anlage',
    form: 'zustand',
    leser: { art: 'zustand', feld: 'box_erreichbar' },
    recht: 'messwerte.ansehen',
    zustaende: ['erreichbar', 'nicht_erreichbar'],
    bedingungen: ['zustand'],
    vorschlag: { dauer_s: 900, erholen_s: 300, schwere: 'warnung', ziel: ['nicht_erreichbar'] },
  },
  {
    wertart: 'datenquelle.liefert_daten',
    name: 'Datenquelle liefert Daten',
    satzname: 'die Datenquelle',
    bezug: 'anlage',
    form: 'zustand',
    leser: { art: 'zustand', feld: 'datenquelle_status' },
    recht: 'messwerte.ansehen',
    zustaende: ['ok', 'stale', 'never'],
    bedingungen: ['zustand'],
    vorschlag: { dauer_s: 3600, erholen_s: 300, schwere: 'warnung', ziel: ['stale', 'never'] },
  },
  {
    wertart: 'box.luecke',
    name: 'Datenlücke der Box',
    satzname: 'die Box',
    bezug: 'anlage',
    form: 'ereignis',
    leser: { art: 'ereignis', arten: ['data_gap'], bezugsfeld: 'box' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ereignis'],
  },
  {
    wertart: 'box.neustarts',
    name: 'Neustarts der Box',
    satzname: 'die Box',
    bezug: 'anlage',
    form: 'ereignis',
    leser: { art: 'ereignis', arten: ['box_restart'], bezugsfeld: 'box' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ereignis'],
  },
  {
    wertart: 'anlage.netz.leistung',
    name: 'Netzbezug',
    satzname: 'der Netzbezug',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'netz' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'],
  },
  {
    wertart: 'anlage.pv.leistung',
    name: 'PV-Leistung',
    satzname: 'die PV-Leistung',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'pv' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'keine_daten'],
  },
  {
    wertart: 'anlage.speicher.leistung',
    name: 'Speicher-Leistung',
    satzname: 'die Speicher-Leistung',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'speicher_leistung' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'],
  },
  {
    wertart: 'anlage.speicher.ladestand',
    name: 'Speicher-Ladestand',
    satzname: 'der Speicher-Ladestand',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'speicher_ladestand' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'],
  },
  {
    wertart: 'anlage.verbrauch.leistung',
    name: 'Verbrauch',
    satzname: 'der Verbrauch',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'verbrauch' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'keine_daten'],
  },
  {
    wertart: 'anlage.ladepunkte.leistung',
    name: 'Ladepunkte-Leistung',
    satzname: 'die Ladepunkte-Leistung',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'ladepunkte' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'keine_daten'],
  },
  {
    wertart: 'anlage.preis.jetzt',
    name: 'Börsenpreis',
    satzname: 'der Börsenpreis',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'preis' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'keine_daten'],
  },
  {
    wertart: 'geraet.messwert',
    name: 'Messwert der Komponente',
    satzname: 'der Messwert',
    bezug: 'komponente',
    form: 'zahl',
    leser: { art: 'messreihe' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'],
  },
];

const WERTART_ZU_EINTRAG: Record<string, WerteKatalogEintrag> = Object.fromEntries(
  WERTE_KATALOG.map((e) => [e.wertart, e]),
);

/** Der Katalog-Eintrag einer Wertart, oder `undefined` für eine (noch) unbekannte. */
export function katalogEintrag(wertart: string): WerteKatalogEintrag | undefined {
  return WERTART_ZU_EINTRAG[wertart];
}
