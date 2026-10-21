/**
 * Der Werte-Katalog, TS-Zwilling (Alerting Scheibe 2, Konzept vp-alerting-konzept-m1 §6.3).
 *
 * Die EINE Wahrheit ist die Server-Ressource
 * `services/api/src/main/resources/wertekatalog/katalog.json`; dieser Zwilling spiegelt ihre
 * `eintraege` inhaltlich (nicht byte-gleich - andere JSON-Formatierung ist erlaubt), geprüft von
 * `werteKatalog.sync.test.ts`. Muster: `ConsumerSignalCatalog.java` + `consumers/signals.ts`
 * ("the ONE truth" mit TS-Zwilling) und der Flow-Katalog (`flows/catalog.sync.test.ts`).
 *
 * `leser.art` ist eine der festen Leserarten aus §6.3 (acht insgesamt; Scheibe 1/2 bauten `zustand`,
 * `ereignis`, `anlagenfluss`, `messreihe`, Scheibe 4 fügt `menge` und `geld` additiv hinzu - periodisch
 * ausgewertet, NIE im Minutentakt; Scheibe 5 fügt `kennzahl` (Kennzahl gegen Bezugsbasis,
 * Energieziel-Kurs) und `zaehlung` (Messstelle: Menge je Monat, Beobachtung, Monat unvollständig)
 * hinzu - keiner ihrer Einträge trägt einen Vorschlag ab Werk, Entscheid 9A). Ein neuer Eintrag
 * derselben Leserart ist ein weiterer Katalog-Eintrag, kein neuer Code (§6.3 Nr. 2); `geraet.messwert`
 * ist eine FAMILIE (Bezug `komponente` + Parameter `kanal`), kein Eintrag je Kanal.
 *
 * UEMS EZ-11 fügt die Leserart `erzeuger` mit fünf Alarm-Vorlagen hinzu (`vorlage` statt `vorschlag`: nie
 * gesät, je Anlage mit Anlagensteuerung wählbar; die Wertart ist die stabile Kennung der Vorlage).
 */

export type LeserArt =
  | 'anlagenfluss'
  | 'messreihe'
  | 'menge'
  | 'kennzahl'
  | 'geld'
  | 'zustand'
  | 'ereignis'
  | 'zaehlung'
  | 'erzeuger';

/** Geschlossenes Vokabular der Bedingungsarten (§6.4). `periode` und `aenderung` (Scheibe 4) gelten
 * nur für periodische Einträge (an ihren `bedingungen`, nicht an der Leserart zu erkennen - Scheibe 5
 * fügt `messstelle.menge` hinzu, Leserart `zaehlung`). */
export type Bedingungsart =
  | 'zustand'
  | 'ereignis'
  | 'ueber'
  | 'unter'
  | 'ausserhalb'
  | 'keine_daten'
  | 'periode'
  | 'aenderung';

/** Geschlossenes Vokabular der Perioden (§6.3/§6.4) - nie "im Minutentakt". */
export type Periode = 'tag' | 'woche' | 'monat' | 'abrechnungszeitraum';

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

/** Eine Alarm-Vorlage (EZ-11): Vorbelegung des Blatts „Überwachen“, `schwellen` sind je Anlage änderbar. */
export interface WerteKatalogVorlage {
  dauer_s: number;
  erholen_s: number;
  schwere: Schwere;
  ziel: string[];
  schwellen?: Record<string, number>;
  nur_mit_anlagensteuerung?: boolean;
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
  vorlage?: WerteKatalogVorlage;
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
  {
    wertart: 'anlage.netz.lastspitze_laufend',
    name: 'Laufendes Viertelstunden-Mittel',
    satzname: 'das laufende Viertelstunden-Mittel des Netzbezugs',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'anlagenfluss', feld: 'netz_lastspitze_laufend' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'keine_daten'],
  },
  {
    wertart: 'anlage.lastspitze.periode',
    name: 'Lastspitze im Abrechnungszeitraum',
    satzname: 'die Lastspitze',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'menge', feld: 'lastspitze_periode' },
    recht: 'messwerte.ansehen',
    bedingungen: ['periode'],
  },
  {
    wertart: 'anlage.verbrauch.menge',
    name: 'Verbrauch im Zeitraum',
    satzname: 'der Verbrauch im Zeitraum',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'menge', feld: 'verbrauch_kwh' },
    recht: 'messwerte.ansehen',
    bedingungen: ['periode', 'aenderung'],
  },
  {
    wertart: 'anlage.geld.erloes',
    name: 'Erlös im Zeitraum',
    satzname: 'der Erlös im Zeitraum',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'geld', feld: 'erloes' },
    recht: 'messwerte.ansehen',
    bedingungen: ['periode', 'aenderung'],
  },
  {
    wertart: 'anlage.geld.kosten',
    name: 'Netzkosten im Zeitraum',
    satzname: 'die Netzkosten im Zeitraum',
    bezug: 'anlage',
    form: 'zahl',
    leser: { art: 'geld', feld: 'kosten' },
    recht: 'messwerte.ansehen',
    bedingungen: ['periode', 'aenderung'],
  },
  {
    wertart: 'kennzahl.bezugsbasis',
    name: 'Kennzahl gegen Bezugsbasis',
    satzname: 'die Abweichung von der Bezugsbasis',
    bezug: 'kennzahl',
    form: 'zahl',
    leser: { art: 'kennzahl', feld: 'bezugsbasis_abweichung_prozent' },
    recht: 'messwerte.ansehen',
    bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'],
  },
  {
    wertart: 'energieziel.kurs',
    name: 'Energieziel-Kurs',
    satzname: 'der Kurs zum Energieziel',
    bezug: 'energieziel',
    form: 'zustand',
    leser: { art: 'kennzahl', feld: 'kurs_lage' },
    recht: 'messwerte.ansehen',
    zustaende: ['noch_keine_aussage', 'auf_kurs', 'knapp_dahinter', 'nicht_auf_kurs'],
    bedingungen: ['zustand'],
  },
  {
    wertart: 'messstelle.menge',
    name: 'Menge je Monat',
    satzname: 'die Menge im Monat',
    bezug: 'messstelle',
    form: 'zahl',
    leser: { art: 'zaehlung', feld: 'menge_monat' },
    recht: 'messwerte.ansehen',
    bedingungen: ['periode', 'aenderung'],
  },
  {
    wertart: 'messstelle.beobachtung',
    name: 'Beobachtung der Messstelle',
    satzname: 'die Beobachtung der Messstelle',
    bezug: 'messstelle',
    form: 'zustand',
    leser: { art: 'zaehlung', feld: 'beobachtung' },
    recht: 'messwerte.ansehen',
    zustaende: ['liefert', 'liefert_nicht_seit', 'wartet_auf_erste_daten', 'keine_datenquelle'],
    bedingungen: ['zustand'],
  },
  {
    wertart: 'messstelle.monat_unvollstaendig',
    name: 'Monat unvollständig',
    satzname: 'die Vollständigkeit des Monats',
    bezug: 'messstelle',
    form: 'zustand',
    leser: { art: 'zaehlung', feld: 'monat_vollstaendigkeit' },
    recht: 'messwerte.ansehen',
    zustaende: ['vollstaendig', 'unvollstaendig'],
    bedingungen: ['zustand'],
  },
  {
    wertart: 'erzeuger.fernsteuerung_nicht_bereit',
    name: 'Fernsteuerung nicht bereit',
    satzname: 'eine Erzeugungseinheit',
    bezug: 'anlage',
    form: 'zustand',
    leser: { art: 'erzeuger', feld: 'fernsteuerung' },
    recht: 'messwerte.ansehen',
    zustaende: ['bereit', 'nicht_bereit', 'kein_direktvermarkter'],
    bedingungen: ['zustand'],
    vorlage: { dauer_s: 300, erholen_s: 300, schwere: 'warnung', ziel: ['nicht_bereit'], nur_mit_anlagensteuerung: true },
  },
  {
    wertart: 'erzeuger.daten_veraltet',
    name: 'Daten veraltet',
    satzname: 'das Bild der Anlagensteuerung',
    bezug: 'anlage',
    form: 'zustand',
    leser: { art: 'erzeuger', feld: 'datenlage' },
    recht: 'messwerte.ansehen',
    zustaende: ['aktuell', 'veraltet'],
    bedingungen: ['zustand'],
    vorlage: { dauer_s: 300, erholen_s: 300, schwere: 'warnung', ziel: ['veraltet'], nur_mit_anlagensteuerung: true },
  },
  {
    wertart: 'erzeuger.anlage_folgt_nicht',
    name: 'Anlage folgt nicht',
    satzname: 'die Anlage',
    bezug: 'anlage',
    form: 'zustand',
    leser: { art: 'erzeuger', feld: 'folgen' },
    recht: 'messwerte.ansehen',
    zustaende: ['folgt', 'folgt_nicht', 'nicht_begrenzt'],
    bedingungen: ['zustand'],
    vorlage: {
      dauer_s: 300,
      erholen_s: 300,
      schwere: 'warnung',
      ziel: ['folgt_nicht'],
      schwellen: { toleranz_prozent: 5, toleranz_kw: 5 },
      nur_mit_anlagensteuerung: true,
    },
  },
  {
    wertart: 'erzeuger.netzbetreiber_abgeschaltet',
    name: 'Netzbetreiber hat abgeschaltet',
    satzname: 'die Anlage',
    bezug: 'anlage',
    form: 'zustand',
    leser: { art: 'erzeuger', feld: 'abschaltung' },
    recht: 'messwerte.ansehen',
    zustaende: ['abgeschaltet', 'nicht_abgeschaltet'],
    bedingungen: ['zustand'],
    vorlage: { dauer_s: 0, erholen_s: 300, schwere: 'warnung', ziel: ['abgeschaltet'], nur_mit_anlagensteuerung: true },
  },
  {
    wertart: 'erzeuger.fernwirk_verbindung_weg',
    name: 'Fernwirk-Verbindung weg',
    satzname: 'die Fernwirk-Verbindung',
    bezug: 'anlage',
    form: 'zustand',
    leser: { art: 'erzeuger', feld: 'fernwirk' },
    recht: 'messwerte.ansehen',
    zustaende: ['verbunden', 'getrennt', 'keine_fernwirktechnik'],
    bedingungen: ['zustand'],
    vorlage: { dauer_s: 600, erholen_s: 300, schwere: 'warnung', ziel: ['getrennt'], nur_mit_anlagensteuerung: true },
  },
];

const WERTART_ZU_EINTRAG: Record<string, WerteKatalogEintrag> = Object.fromEntries(
  WERTE_KATALOG.map((e) => [e.wertart, e]),
);

/** Der Katalog-Eintrag einer Wertart, oder `undefined` für eine (noch) unbekannte. */
export function katalogEintrag(wertart: string): WerteKatalogEintrag | undefined {
  return WERTART_ZU_EINTRAG[wertart];
}
