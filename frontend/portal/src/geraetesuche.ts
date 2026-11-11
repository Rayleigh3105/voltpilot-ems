/**
 * Gerätesuche (docs/contracts/v2/mqtt-geraetesuche.md §7): die Form der Antwort der vier Routen unter
 * `/api/v1/sites/{siteId}/geraetesuche` (OpenAPI-Tag `geraetesuche`) und ihre geschlossenen Wörter. Zwilling von
 * `GeraetesucheVertrag` (Java) über `docs/contracts/v2/geraetesuche-vectors.json`; der Test hält beide gleich.
 *
 * Gesucht wird auf der Box, gruppiert und abgeglichen in der API: das Portal zeigt nur, was die Antwort trägt, in der
 * Reihenfolge von `GERAETESUCHE_GRUPPEN`. Unbekannt ist null, nie 0. DP-3 A: keine MAC, kein Hostname; Geräte von
 * Personen nur als Zahl in `weitere`.
 */

/** Das Wort, mit dem eine Box die Fähigkeit in `supports[]` meldet; ohne es ist „Geräte suchen“ ausgegraut. */
export const GERAETESUCHE_FAEHIGKEIT = 'geraetesuche';

export const GERAETESUCHE_GRUPPEN = [
  'braucht_hilfe', 'bereit', 'nicht_anbindbar', 'vielleicht', 'schon_eingerichtet', 'weitere',
] as const;
export type GeraetesucheGruppeWort = (typeof GERAETESUCHE_GRUPPEN)[number];

export const GERAETESUCHE_ABGLEICH = [
  'neu', 'schon_eingerichtet', 'adresse_geaendert', 'anderes_geraet_an_bekannter_adresse',
  'adresse_bekannt_kennung_offen',
] as const;
export type GeraetesucheAbgleich = (typeof GERAETESUCHE_ABGLEICH)[number];

export const GERAETESUCHE_ZUSTAENDE = [
  'wartet', 'laeuft', 'fertig', 'abgebrochen', 'fehlgeschlagen', 'abgelehnt', 'keine_antwort',
] as const;
export type GeraetesucheZustand = (typeof GERAETESUCHE_ZUSTAENDE)[number];

/** Die Gründe der Box je Zustand ihres Ergebnisses; `fertig` trägt keinen. */
export const GERAETESUCHE_GRUENDE = {
  fertig: [],
  abgebrochen: ['auf_wunsch', 'neustart', 'zeitlimit'],
  abgelehnt: ['laeuft_schon', 'zu_oft', 'abgelaufen', 'lan_host_fehlt', 'kein_privates_netz'],
  fehlgeschlagen: ['interner_fehler'],
} as const;
export type GeraetesucheGrund = (typeof GERAETESUCHE_GRUENDE)[keyof typeof GERAETESUCHE_GRUENDE][number];

export const GERAETESUCHE_ERKENNER = [
  'solarman', 'shelly', 'goe', 'netztechnik', 'modbus_offen', 'sunspec', 'fronius_solar_api', 'kaco_aiswei',
  'kostal', 'huawei', 'sma', 'victron', 'opendtu_ahoy', 'ebyte', 'wago', 'mdns', 'ssdp', 'funkmodul',
] as const;
export type GeraetesucheErkenner = (typeof GERAETESUCHE_ERKENNER)[number];

export const GERAETESUCHE_ARTEN = [
  'wechselrichter', 'wallbox', 'schaltaktor', 'zaehler', 'io_modul', 'sps', 'dtu', 'modbus_geraet', 'router',
  'zugangspunkt',
] as const;
export type GeraetesucheArt = (typeof GERAETESUCHE_ARTEN)[number];

export const GERAETESUCHE_ANBINDUNGEN = [
  'uebernehmen', 'selbst_beschreiben', 'nicht_mit_dieser_box', 'kein_leseweg', 'nur_anzeige',
] as const;
export type GeraetesucheAnbindung = (typeof GERAETESUCHE_ANBINDUNGEN)[number];

export const GERAETESUCHE_ERKENNUNGEN = ['sicher', 'wahrscheinlich', 'unbekannt'] as const;
export type GeraetesucheErkennung = (typeof GERAETESUCHE_ERKENNUNGEN)[number];

export const GERAETESUCHE_HINDERNISSE = ['geschuetzt', 'lokale_api_aus'] as const;
export type GeraetesucheHindernis = (typeof GERAETESUCHE_HINDERNISSE)[number];

export const GERAETESUCHE_SCHRITTE = [
  'netze_bestimmen', 'nachbarn_finden', 'geraete_ansprechen', 'geraete_erkennen',
] as const;
export type GeraetesucheSchritt = (typeof GERAETESUCHE_SCHRITTE)[number];

/** Die Ablehnungen beim Starten (`GeraetesucheFehler.code`), je HTTP-Status. */
export const GERAETESUCHE_FEHLER_START = {
  409: ['laeuft_schon', 'nicht_unterstuetzt', 'box_offline'],
  429: ['zu_oft'],
} as const;

/** „Erkannt, mit dieser Box noch nicht anbindbar“: die andere Box-Art liest es schon, oder keine. */
export function nochNichtAnbindbar(anbindung: GeraetesucheAnbindung): boolean {
  return anbindung === 'nicht_mit_dieser_box' || anbindung === 'kein_leseweg';
}

export interface GeraetesucheUrheber {
  name: string;
  rolle: string | null;
  art: 'kunde' | 'unterstuetzung' | 'voltpilot' | 'notfall' | null;
}

export interface GeraetesucheNetz {
  rolle: 'kundennetz' | 'box_netz';
  netz: string;
  boxAdresse: string;
  /** true = nur das /24 um die Box durchsucht; null = unbekannt (Docker-Box). */
  ausschnitt: boolean | null;
  erreichbar: boolean;
  aktiv: number;
}

export interface GeraetesucheFund {
  schluessel: string;
  erkenner: Exclude<GeraetesucheErkenner, 'mdns' | 'ssdp' | 'funkmodul'>;
  art: GeraetesucheArt;
  hersteller: string | null;
  /** Wie die Box es meldet; bei Shelly der Modellcode (`SPSW-003XE16EU`). */
  modell: string | null;
  /** Der Produktname zum Code, wo der Hersteller ihn belegt („Shelly Pro 3"); null = unbekannt, `modell` gilt. */
  modellName: string | null;
  seriennummer: string | null;
  firmware: string | null;
  familie: string | null;
  spannung: 'hv' | 'lv' | null;
  kanaele: number | null;
  erkennung: GeraetesucheErkennung;
  merkmale: string[];
  anbindung: GeraetesucheAnbindung;
  hindernis: GeraetesucheHindernis | null;
  /** Die Verbindungsfelder der Vorlage, genau so als `connection` an `component-test`. */
  verbindung: Record<string, unknown>;
  liestBoxSchon: boolean;
  abgleich: GeraetesucheAbgleich;
  komponente: { id: string; name: string } | null;
  bekannteAdresse: string | null;
  /** Passende `templateRef`; leer, wenn sich der Fund nicht übernehmen lässt. */
  vorlagen: string[];
}

export interface GeraetesucheGruppe {
  gruppe: GeraetesucheGruppeWort;
  funde: GeraetesucheFund[];
}

export interface GeraetesucheWeitere {
  telefonTablet: number | null;
  rechner: number | null;
  unbekannt: number | null;
}

export interface GeraetesucheLadesaeuleKlopftAn {
  chargePointId: string;
  ip: string | null;
  zuerst: string;
  zuletzt: string;
  versuche: number;
}

export interface Geraetesuche {
  suchId: string;
  deviceId: string;
  zustand: GeraetesucheZustand;
  grund: GeraetesucheGrund | null;
  gestartetAm: string;
  gestartetVon: GeraetesucheUrheber;
  beendetAm: string | null;
  dauerMs: number | null;
  schritt: GeraetesucheSchritt | null;
  erledigt: number | null;
  gesamt: number | null;
  restSekunden: number | null;
  netze: GeraetesucheNetz[];
  /** Was wirklich lief; null, solange kein Ergebnis da ist. Ein fehlender Erkenner heißt „nicht gesucht“. */
  erkenner: GeraetesucheErkenner[] | null;
  gruppen: GeraetesucheGruppe[];
  weitere: GeraetesucheWeitere;
  /** null = die Box meldet es nicht (unbekannt); [] = niemand hat angeklopft. */
  ladesaeulenKlopfenAn: GeraetesucheLadesaeuleKlopftAn[] | null;
}

export interface GeraetesucheVerlaufEintrag {
  suchId: string;
  deviceId: string;
  zustand: GeraetesucheZustand;
  grund: GeraetesucheGrund | null;
  gestartetAm: string;
  gestartetVon: GeraetesucheUrheber;
  dauerMs: number | null;
  zaehler: Record<GeraetesucheGruppeWort, number>;
}

export interface GeraetesucheFehler {
  code: 'anfrage_ungueltig' | 'anfrage_kennung_ungueltig' | 'anfrage_kennung_anders' | 'nicht_gefunden'
    | (typeof GERAETESUCHE_FEHLER_START)[keyof typeof GERAETESUCHE_FEHLER_START][number];
  message: string;
  suchId: string | null;
  zuletztGesehen: string | null;
  wiederAb: string | null;
}
