/**
 * Der KUNDENSATZ des geschlossenen Ereignis-Vokabulars (UEMS AP-07 IP-3, Entscheid E11: EIN
 * Ereignis-Vertrag für beide Pfade, nie gelöscht; Prosa in
 * `docs/contracts/v2/events-vocabulary.md`).
 *
 * Aus einem Ereignis (die Form von `events.raw#/ereignis`) wird GENAU EIN Satz für den
 * Verlauf-Marker: die Überschrift (`name`) und der Satz der Art, gewählt nach Anlass bzw. danach,
 * ob der Zeitraum noch offen ist, plus die Zusätze der gesetzten Felder. Zeiten spricht er in der
 * Zeitzone des Standorts, Zahlen deutsch, Namen aus dem, was die Fläche kennt.
 *
 * Der Zwilling ist `services/api/.../uems/EreignisVokabular.java` — er PRÜFT (angenommen oder
 * verworfen mit Grund), dieser Zwilling SPRICHT. Beide fahren dieselbe Vektor-Datei
 * (`docs/contracts/v2/events-vocabulary-vectors.json`).
 * **Wer eine Art, ein Feld oder einen Satz ändert, ändert beide Seiten, beide Schemas UND die
 * Vektor-Datei.**
 *
 * ⚠ NOCH RUFT NIEMAND AN: keine Fläche zeigt Ereignisse aus diesem Vertrag, es gibt noch keine
 * Ereignis-Tabelle (IP-8) und keinen Endpunkt.
 */
import { VORGABE_ZEITZONE, teile } from './uemsZustand';

// ───────────────────────────────────────────────────────────────────── Vokabular

/** Die Ereignisarten — geschlossen, in der Reihenfolge der Vektor-Datei. */
export const EREIGNIS_ARTEN = [
  'data_gap',
  'backfill',
  'duplicate_conflict',
  'sequence_gap',
  'sequence_reset',
  'late_arrival',
  'counter_reset',
  'counter_overflow',
  'device_boundary',
  'handover',
  'unassigned_reader',
  'rejected',
  'clock_ahead',
  'too_old',
  'clock_jump',
  'box_restart',
  'device_restart',
  'frozen_source',
  'range_limit',
  'layout_changed',
  'error_change',
  'state_change',
  'bitfield_change',
  'text_change',
  'substitute',
  'correction',
  'verteilung_geaendert',
  'bilanz_neu_berechnet',
] as const;
export type EreignisArt = (typeof EREIGNIS_ARTEN)[number];

/** Die Ablehnungsgründe mit ihrem Kundentext — er vollendet „Datenpaket von … abgewiesen: …". */
export const GRUND_TEXT = {
  herkunft_unvollstaendig: 'Herkunft unvollständig — Gerät oder Einstellung zur Messzeit unbekannt',
  fassung_unbekannt: 'unbekannte Fassung des Datenpakets',
  kennung_abweichend: 'es nennt eine andere Box, Anlage oder einen anderen Kundenbereich',
  schema_verletzt: 'Aufbau des Datenpakets nicht lesbar',
  wort_unbekannt: 'unbekanntes Wort — verworfen, nie geraten',
  urheber_unzulaessig: 'diese Meldung kommt nie von diesem Absender',
  zeit_ungueltig: 'unmögliche Zeitangabe',
  regel_verletzt: 'die Angaben widersprechen sich',
  fortschreibung_unzulaessig: 'es würde eine frühere Meldung ändern',
} as const;
export type Grund = keyof typeof GRUND_TEXT;

export type Feldtyp =
  | 'uuid'
  | 'wort'
  | 'zeit'
  | 'zeit_oder_leer'
  | 'kennung'
  | 'text'
  | 'ganz_ab_0'
  | 'ganz_ab_1'
  | 'sekunden'
  | 'statuswort'
  | 'stand'
  | 'messwert'
  | 'ganz_liste'
  | 'wert';

/** Jedes Feld mit seinem Typ — der Typ bestimmt, wie es im Satz steht. */
export const FELDTYP: Record<string, Feldtyp> = {
  ereignis_id: 'uuid',
  art: 'wort',
  zeitpunkt: 'zeit',
  von: 'zeit',
  bis: 'zeit_oder_leer',
  box: 'kennung',
  box_alt: 'kennung',
  box_neu: 'kennung',
  zustaendige_box: 'kennung',
  datenquelle: 'kennung',
  komponente: 'kennung',
  messkanal: 'text',
  messstelle: 'kennung',
  einbau_alt: 'kennung',
  einbau_neu: 'kennung',
  erkannt_aus: 'wort',
  erwartet_fehlend: 'ganz_ab_0',
  nachgeliefert_am: 'zeit_oder_leer',
  fehlerklasse: 'wort',
  ursache_ereignis: 'uuid',
  eingang_von: 'zeit',
  eingang_bis: 'zeit',
  anzahl: 'ganz_ab_1',
  erwartet: 'ganz_ab_1',
  messzeit: 'zeit',
  gespeicherter_wert: 'messwert',
  abgewiesener_wert: 'messwert',
  sequenzen: 'ganz_liste',
  einheit: 'text',
  strom: 'wort',
  sequenz: 'ganz_ab_0',
  sequenz_erwartet: 'ganz_ab_0',
  sequenz_erhalten: 'ganz_ab_0',
  eingangszeit: 'zeit',
  stand_alt: 'stand',
  stand_neu: 'stand',
  messzeit_alt: 'zeit',
  wertebereich_modul: 'stand',
  hoechstzuwachs_je_kadenz: 'stand',
  kadenz_s: 'sekunden',
  anlass: 'wort',
  eingetragen_am: 'zeit',
  endstand: 'stand',
  anfangsstand: 'stand',
  bestaetigt_ereignis: 'uuid',
  grund: 'wort',
  vor_s: 'sekunden',
  alter_s: 'sekunden',
  sprung_s: 'sekunden',
  herzschlag_vorher: 'ganz_ab_0',
  herzschlag_nachher: 'ganz_ab_0',
  lesungen: 'ganz_ab_1',
  herzschlag: 'ganz_ab_0',
  statuswort: 'statuswort',
  fassung_erwartet: 'ganz_ab_1',
  fassung_gelesen: 'ganz_ab_1',
  karten_erwartet: 'ganz_ab_0',
  karten_gelesen: 'ganz_ab_0',
  alt: 'wert',
  neu: 'wert',
  zuwachs: 'stand',
  stand_vor: 'stand',
  stand_nach: 'stand',
  ersatzwert: 'kennung',
  methode: 'wort',
  status: 'wort',
  korrektur: 'kennung',
  korrektur_art: 'wort',
  ausloeser: 'kennung',
};

export interface ArtText {
  /** Die Überschrift des Markers. */
  name: string;
  /** Hat die Art einen Zeitraum (dann gibt es `…_offen`-Sätze, wo er offen sein darf)? */
  zeitraum: boolean;
  /** Das Feld, dessen Wert den Satz wählt (sonst `standard`). */
  varianteNach: string | null;
  saetze: Record<string, string>;
  /** Je gesetztem Feld ein Zusatz, in dieser Reihenfolge angehängt. */
  zusaetze: Record<string, string>;
}

const UEBERGANG = (name: string, satz: string): ArtText => ({
  name,
  zeitraum: false,
  varianteNach: null,
  saetze: { standard: satz },
  zusaetze: {},
});

/**
 * Die Sätze je Art. Platzhalter sind Feldnamen; `{anzahl_werte}` und `{anzahl_datenpakete}`
 * sprechen `anzahl` mit dem richtigen Hauptwort („1 Wert", „188 Datenpakete").
 */
export const EREIGNIS_TEXTE: Record<EreignisArt, ArtText> = {
  data_gap: {
    name: 'Lücke',
    zeitraum: true,
    varianteNach: null,
    saetze: {
      standard: 'Lücke von {von} bis {bis} — nie als 0 gerechnet',
      standard_offen: 'Lücke seit {von} — nie als 0 gerechnet',
    },
    zusaetze: {
      zuwachs: ' · der Zähler hat weitergezählt: Zuwachs {zuwachs} — nicht auf Viertelstunden verteilbar',
      nachgeliefert_am: ' · nachgeliefert am {nachgeliefert_am}',
    },
  },
  backfill: {
    name: 'Nachlieferung',
    zeitraum: true,
    varianteNach: null,
    saetze: {
      standard: 'Nachgeliefert: {anzahl_werte} von {von} bis {bis}, eingegangen {eingang_von} bis {eingang_bis}',
    },
    zusaetze: {},
  },
  duplicate_conflict: {
    name: 'Abweichender Wert',
    zeitraum: false,
    varianteNach: null,
    saetze: {
      standard:
        'Zweiter Wert für {messzeit} abgewiesen: {abgewiesener_wert} statt {gespeicherter_wert} — der erste Wert bleibt',
    },
    zusaetze: {},
  },
  sequence_gap: {
    name: 'Datenpakete fehlen',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Nie angekommen: {anzahl_datenpakete} von {box} — die Werte darin bleiben Lücke' },
    zusaetze: {},
  },
  sequence_reset: {
    name: 'Paketzählung neu begonnen',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: '{box} hat ihre Paketzählung neu begonnen — nichts wird doppelt gezählt' },
    zusaetze: {},
  },
  late_arrival: {
    name: 'Nach Abschluss eingegangen',
    zeitraum: true,
    varianteNach: null,
    saetze: {
      standard:
        'Nach Abschluss eingegangen: {anzahl_werte} für {von} bis {bis}, am {eingangszeit} — der endgültige Viertelstundenwert bleibt unverändert',
    },
    zusaetze: {},
  },
  counter_reset: {
    name: 'Zähler zurückgesetzt',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Zähler zurückgesetzt am {zeitpunkt}: von {stand_alt} auf {stand_neu} (Ursache unbekannt)' },
    zusaetze: {},
  },
  counter_overflow: {
    name: 'Zähler übergelaufen',
    zeitraum: false,
    varianteNach: null,
    saetze: {
      standard:
        'Zähler am {zeitpunkt} über das Ende seines Wertebereichs ({wertebereich_modul}) gelaufen: von {stand_alt} auf {stand_neu} — der Verbrauch dazwischen ist mitgezählt',
    },
    zusaetze: {},
  },
  device_boundary: {
    name: 'Gerätegrenze',
    zeitraum: false,
    varianteNach: 'anlass',
    saetze: {
      zaehlerwechsel: 'Zählerwechsel am {zeitpunkt}: {einbau_alt} → {einbau_neu}',
      controllerwechsel: 'Controllerwechsel am {zeitpunkt}: {einbau_alt} → {einbau_neu}',
      kartenwechsel: 'Karte getauscht am {zeitpunkt} — Gerät bleibt {einbau_alt}',
      zaehler_zurueckgesetzt: 'Zähler zurückgesetzt am {zeitpunkt} (bestätigt) — Gerät bleibt {einbau_alt}',
    },
    zusaetze: { endstand: ', Endstand {endstand}', anfangsstand: ', Anfangsstand {anfangsstand}' },
  },
  handover: {
    name: 'Übergabe',
    zeitraum: true,
    varianteNach: 'anlass',
    saetze: {
      uebergabe: 'Übergabe von {box_alt} an {box_neu}: keine Werte von {von} bis {bis}',
      uebergabe_offen: 'Übergabe von {box_alt} an {box_neu} seit {von} — {box_neu} hat noch nicht bestätigt',
      box_tausch: 'Box-Tausch: {box_neu} ersetzt {box_alt} — keine Werte von {von} bis {bis}',
      box_tausch_offen: 'Box-Tausch: {box_neu} ersetzt {box_alt} seit {von} — {box_neu} hat noch nicht bestätigt',
    },
    zusaetze: {},
  },
  unassigned_reader: {
    name: 'Nicht zuständige Box',
    zeitraum: true,
    varianteNach: null,
    saetze: {
      standard:
        'Nicht gezählt: {anzahl_werte} von {box} für {komponente} von {von} bis {bis} — {box} war nicht zuständig',
    },
    zusaetze: {},
  },
  rejected: {
    name: 'Abgewiesen',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Datenpaket von {box} abgewiesen: {grund}' },
    zusaetze: {},
  },
  clock_ahead: {
    name: 'Uhr geht vor',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Uhr von {box} geht {vor_s} vor — Datenpaket abgewiesen' },
    zusaetze: {},
  },
  too_old: {
    name: 'Zu alt',
    zeitraum: false,
    varianteNach: null,
    saetze: {
      standard: 'Datenpaket von {box} abgewiesen: Messzeit liegt {alter_s} zurück — angenommen werden höchstens 90 Tage',
    },
    zusaetze: {},
  },
  clock_jump: {
    name: 'Uhrsprung',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Uhr von {box} ist um {sprung_s} gesprungen — die Werte bleiben' },
    zusaetze: {},
  },
  box_restart: {
    name: 'Neustart der Box',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: '{box} ist neu gestartet' },
    zusaetze: {},
  },
  device_restart: {
    name: 'Neustart des Geräts',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Das Gerät an {datenquelle} ist neu gestartet' },
    zusaetze: {},
  },
  frozen_source: {
    name: 'Werte eingefroren',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Werte von {datenquelle} eingefroren seit {zeitpunkt} — nicht als gemessen gezählt' },
    zusaetze: {},
  },
  range_limit: {
    name: 'Bereichsbegrenzung',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Bereichsbegrenzung an {datenquelle} — betroffene Werte gelten als ungültig' },
    zusaetze: { komponente: ' · {komponente}' },
  },
  layout_changed: {
    name: 'Aufbau geändert',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Aufbau geändert an {datenquelle} — nichts wurde umgehängt' },
    zusaetze: {
      fassung_gelesen: ' · Registerbild Version {fassung_gelesen} statt {fassung_erwartet}',
      karten_gelesen: ' · {karten_gelesen} statt {karten_erwartet} Karten',
    },
  },
  error_change: UEBERGANG('Fehlermeldung', 'Fehlermeldung geändert: {alt} → {neu}'),
  state_change: UEBERGANG('Zustand', 'Zustand geändert: {alt} → {neu}'),
  bitfield_change: UEBERGANG('Statusbits', 'Statusbits geändert: {alt} → {neu}'),
  text_change: UEBERGANG('Text', 'Text geändert: {alt} → {neu}'),
  substitute: {
    name: 'Ersatzwert',
    zeitraum: true,
    varianteNach: 'status',
    saetze: {
      wirksam: 'Ersatzwert {ersatzwert} für {von} bis {bis}: {methode} — kein gemessener Wert',
      zurueckgenommen: 'Ersatzwert {ersatzwert} für {von} bis {bis} zurückgenommen: {methode}',
    },
    zusaetze: {},
  },
  correction: {
    name: 'Korrektur',
    zeitraum: true,
    varianteNach: 'status',
    saetze: {
      vorschlag:
        'Korrektur {korrektur} vorgeschlagen für {von} bis {bis}: {korrektur_art} — die Werte bleiben bis zur Freigabe unverändert',
      freigegeben: 'Korrektur {korrektur} freigegeben für {von} bis {bis}: {korrektur_art}',
      abgelehnt: 'Korrektur {korrektur} abgelehnt für {von} bis {bis}: {korrektur_art} — die Werte bleiben unverändert',
      zurueckgenommen: 'Korrektur {korrektur} zurückgenommen für {von} bis {bis}: {korrektur_art}',
    },
    zusaetze: { ersatzwert: ' ({ersatzwert})' },
  },
  verteilung_geaendert: {
    name: 'Verteilung geändert',
    zeitraum: false,
    varianteNach: null,
    saetze: { standard: 'Verteilung auf Kostenstellen geändert ab {zeitpunkt} (eingetragen am {eingetragen_am})' },
    zusaetze: {},
  },
  bilanz_neu_berechnet: {
    name: 'Bilanz neu berechnet',
    zeitraum: true,
    varianteNach: null,
    saetze: { standard: 'Bilanz neu berechnet für {von} bis {bis} nach {ausloeser}' },
    zusaetze: {},
  },
};

/**
 * AP-08 IP-12 — die Namen der Ersatzwert-Methoden (E7, a–g) und der Korrektur-Arten (§4.6) in
 * Kundensprache; der Satz spricht nie das Vertragswort.
 */
export const METHODE_TEXT: Record<string, string> = {
  gleichmaessig_verteilen: 'Zuwachs gleichmäßig verteilen',
  profil_vorperiode: 'Zuwachs nach dem Profil der Vorperiode verteilen',
  profil_vergleichsquelle: 'Zuwachs nach dem Profil der Vergleichsquelle verteilen',
  ablesestand_nachtragen: 'Ablesestand nachtragen',
  wert_eingeben: 'Wert eingeben (mit Beleg)',
  vorperiode_uebernehmen: 'Vorperiode übernehmen',
  vergleichsquelle_uebernehmen: 'Vergleichsquelle übernehmen',
};

export const KORREKTUR_ART_TEXT: Record<string, string> = {
  nachlieferung_nach_endgueltigkeit: 'Nachlieferung nach Endgültigkeit',
  ablesestaende_nachgetragen: 'Ablesestände nachgetragen',
  umklassifizierung: 'Rücksetzung und Überlauf umklassifiziert',
  ersatzwert: 'Ersatzwert',
  wert_berichtigt: 'Wert berichtigt (mit Beleg)',
};

/** Die Hauptwörter, die `{anzahl_…}` zu `anzahl` spricht. */
export const ANZAHL_WORT: Record<string, { singular: string; plural: string }> = {
  werte: { singular: 'Wert', plural: 'Werte' },
  datenpakete: { singular: 'Datenpaket', plural: 'Datenpakete' },
};

// ───────────────────────────────────────────────────────────────────── Satz

/** Ein Ereignis in der Form von `events.raw#/ereignis` (Feldnamen wie im Vertrag). */
export type Ereignis = { art: string } & Record<string, unknown>;

/** Kennung → Name, so wie die Fläche es kennt (Box, Komponente, Messstelle …). */
export type Namen = Readonly<Record<string, string>>;

/** Die Zeitraum-Grenze, an der ein Ende gemessen wird: am selben Tag nur die Uhrzeit. */
const PARTNER: Record<string, string> = { bis: 'von', eingang_bis: 'eingang_von' };

const ZAHL = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });

/** „1.083.415,2" — deutsch, höchstens drei Nachkommastellen. */
export function zahlText(n: number): string {
  return ZAHL.format(n);
}

/** „03.11.2026 14:00" — Sekunden nur, wenn sie nicht 0 sind; die Zeitzone ist die des Standorts. */
export function zeitText(iso: string, zone: string, bezug?: string): string {
  const t = teile(iso, zone);
  const sekunden = new Date(iso).getUTCSeconds();
  const uhr = `${t.stunde}:${t.minute}${sekunden === 0 ? '' : `:${String(sekunden).padStart(2, '0')}`}`;
  if (bezug !== undefined && teile(bezug, zone).tag === t.tag) return uhr;
  return `${t.tag} ${uhr}`;
}

const DAUER = [
  [86400, 'Tag', 'Tage'],
  [3600, 'h', 'h'],
  [60, 'min', 'min'],
  [1, 's', 's'],
] as const;

/** „6 min 30 s", „91 Tage 1 h" — ab der größten Einheit höchstens zwei, vom Betrag. */
export function dauerText(sekunden: number): string {
  let rest = Math.abs(sekunden);
  const stellen = DAUER.map(([groesse, einzahl, mehrzahl]) => {
    const n = Math.floor(rest / groesse);
    rest -= n * groesse;
    return { n, wort: n === 1 ? einzahl : mehrzahl };
  });
  const erste = stellen.findIndex((x) => x.n > 0);
  if (erste < 0) return '0 s';
  return stellen
    .slice(erste, erste + 2)
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.wort}`)
    .join(' ');
}

function einheit(e: Ereignis): string {
  return typeof e.einheit === 'string' ? ` ${e.einheit}` : '';
}

function wertText(w: unknown): string {
  if (w === null || w === undefined) return '—';
  if (typeof w === 'number') return zahlText(w);
  if (typeof w === 'boolean') return w ? 'an' : 'aus';
  return String(w);
}

function feldText(feld: string, e: Ereignis, namen: Namen, zone: string): string {
  const anzahl = /^anzahl_(\w+)$/.exec(feld);
  if (anzahl !== null) {
    const n = Number(e.anzahl);
    const wort = ANZAHL_WORT[anzahl[1]];
    return `${zahlText(n)} ${n === 1 ? wort.singular : wort.plural}`;
  }
  const w = e[feld];
  switch (FELDTYP[feld]) {
    case 'zeit':
    case 'zeit_oder_leer': {
      const partner = PARTNER[feld];
      const bezug = partner === undefined ? undefined : (e[partner] as string);
      return zeitText(String(w), zone, bezug);
    }
    case 'kennung':
      return namen[String(w)] ?? String(w);
    case 'sekunden':
      return dauerText(Number(w));
    case 'stand':
      return `${zahlText(Number(w))}${einheit(e)}`;
    case 'messwert': {
      // decoded ist null, wenn der Kanal keinen decodierten Wert liefert — dann spricht der Rohwert.
      const m = w as { raw: unknown; decoded: unknown };
      const x = m.decoded ?? m.raw;
      return typeof x === 'number' ? `${zahlText(x)}${einheit(e)}` : wertText(x);
    }
    case 'wort':
      if (feld === 'grund') return GRUND_TEXT[w as Grund] ?? String(w);
      if (feld === 'methode') return METHODE_TEXT[String(w)] ?? String(w);
      if (feld === 'korrektur_art') return KORREKTUR_ART_TEXT[String(w)] ?? String(w);
      return String(w);
    default:
      return wertText(w);
  }
}

function fuelle(vorlage: string, e: Ereignis, namen: Namen, zone: string): string {
  return vorlage.replace(/\{(\w+)\}/g, (_, feld: string) => feldText(feld, e, namen, zone));
}

/**
 * Der Kundensatz eines Ereignisses. Wirft, wenn die Art nicht im Vokabular steht — ein
 * unbekanntes Wort wird nie geraten (die Prüfung hat es vorher verworfen).
 */
export function ereignisSatz(e: Ereignis, namen: Namen = {}, zeitzone: string = VORGABE_ZEITZONE): string {
  const text = (EREIGNIS_TEXTE as Record<string, ArtText | undefined>)[e.art];
  if (text === undefined) throw new Error(`unbekannte Ereignisart: ${e.art}`);
  const variante = text.varianteNach === null ? 'standard' : String(e[text.varianteNach]);
  const offen = text.zeitraum && (e.bis === null || e.bis === undefined);
  const vorlage = text.saetze[offen ? `${variante}_offen` : variante];
  if (vorlage === undefined) throw new Error(`kein Satz für ${e.art}/${variante}${offen ? ' (offen)' : ''}`);
  let satz = fuelle(vorlage, e, namen, zeitzone);
  for (const [feld, zusatz] of Object.entries(text.zusaetze)) {
    if (e[feld] !== null && e[feld] !== undefined) satz += fuelle(zusatz, e, namen, zeitzone);
  }
  return satz;
}

/** Die Überschrift des Markers („Lücke", „Übergabe" …). */
export function ereignisName(art: EreignisArt): string {
  return EREIGNIS_TEXTE[art].name;
}
