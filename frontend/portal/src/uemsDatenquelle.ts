/**
 * Die REINEN Regeln des Vertrags „Datenquelle und Zuständigkeit" (UEMS AP-06 IP-1; Prosa in
 * `docs/contracts/v2/data-source-assignment.md`, Regeln im AP-06-Konzept §4.1–§4.7, Entscheide
 * E1, E2, E3, E5, E7, E8, E9, E10 = B, E11, E12).
 *
 * Die Datenquelle ist ein eigenes Objekt mit Kennzeichen (E1); gelesen wird sie je Zeitpunkt
 * von höchstens EINER Box (E2), in halboffenen Zeiträumen auf die volle Minute
 * (`effective_from` gehört dazu, `effective_to` nicht). Die Formen sind die der Vektor-Datei.
 *
 * Der Zwilling ist `services/api/.../uems/DatenquelleRegeln.java`; beide fahren dieselben
 * Vektoren (`docs/contracts/v2/data-source-vectors.json`), die Fähigkeiten stehen als Daten in
 * `docs/contracts/v2/edge-capabilities.json`.
 * **Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.**
 *
 * ⚠ NOCH RUFT NIEMAND AN: keine Fläche, kein Endpunkt, kein Push ist umgestellt.
 */
import { VORGABE_ZEITZONE, teile } from './uemsZustand';

// ───────────────────────────────────────────────────────────────────── Vokabular

/** Das geschlossene Vokabular der Protokolle (§4.2) — neue kommen nur über den Katalog. */
export const PROTOKOLLE = [
  { code: 'modbus_tcp', name: 'Modbus TCP' },
  { code: 'sunspec_modbus', name: 'SunSpec-Modbus' },
  { code: 'mqtt', name: 'MQTT-Themen' },
  { code: 'http', name: 'HTTP-Auskunft' },
  { code: 'ocpp', name: 'OCPP-Station' },
] as const;
export type Protokoll = (typeof PROTOKOLLE)[number]['code'];

export const URTEILE = ['erlaubt', 'bestaetigung_noetig', 'abgelehnt'] as const;
export type Urteil = (typeof URTEILE)[number];

/**
 * Jeder Grund mit seinem Kundensatz. Platzhalter: {box}, {kennzeichen}, {zeitpunkt}; bei
 * `pruefung_gescheitert` steht der Satz der Fehlerklasse.
 */
export const GRUENDE = [
  {
    code: 'protokoll_unbekannt',
    urteil: 'abgelehnt',
    text: 'Dieses Protokoll kennt VoltPilot nicht — neue Protokolle kommen nur über den Katalog',
  },
  {
    code: 'keine_volle_minute',
    urteil: 'abgelehnt',
    text: 'Eine Zuständigkeit beginnt auf die volle Minute — bitte eine Uhrzeit ohne Sekunden wählen',
  },
  {
    code: 'leerer_zeitraum',
    urteil: 'abgelehnt',
    text: 'Das Ende liegt nicht nach dem Beginn — ein Zeitraum dauert mindestens eine Minute',
  },
  {
    code: 'rueckwirkend',
    urteil: 'abgelehnt',
    text: 'Eine Zuständigkeit beginnt frühestens jetzt — nie rückwirkend',
  },
  {
    code: 'steuerquelle',
    urteil: 'abgelehnt',
    text: 'Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Steuerung wechseln',
  },
  {
    code: 'spaeterer_wechsel_geplant',
    urteil: 'abgelehnt',
    text: 'Ab {zeitpunkt} liest bereits {box} — erst diesen geplanten Wechsel zurücknehmen',
  },
  {
    code: 'schon_zustaendig',
    urteil: 'abgelehnt',
    text: '{box} liest diese Quelle zu diesem Zeitpunkt bereits',
  },
  {
    code: 'ueberschneidung',
    urteil: 'abgelehnt',
    text: 'Überschneidet sich mit der Zuständigkeit von {box} — je Zeitpunkt liest höchstens eine Box',
  },
  {
    code: 'adresse_an_box_vergeben',
    urteil: 'abgelehnt',
    text: 'Diese Adresse liest {box} bereits als {kennzeichen} — Gerät dort hinzufügen?',
  },
  {
    code: 'netzlage_fehlt',
    urteil: 'abgelehnt',
    text: 'Gleiche Adresse wie {kennzeichen} an {box} — erst das Netz beider Quellen eintragen (Bogen D1/D2)',
  },
  {
    code: 'nur_ein_leser',
    urteil: 'abgelehnt',
    text: 'Gleiche Adresse wie {kennzeichen} an {box} im selben Netz — nicht möglich: dieses Gerät verträgt nur einen Leser',
  },
  {
    code: 'vergleich_bestaetigen',
    urteil: 'bestaetigung_noetig',
    text: 'Gleiche Adresse wie {kennzeichen} an {box} im selben Netz — als Vergleichsquelle anlegen (gekennzeichnet)?',
  },
  { code: 'pruefung_fehlt', urteil: 'abgelehnt', text: 'Es fehlt: Prüfung von {box}' },
  { code: 'pruefung_gescheitert', urteil: 'abgelehnt', text: '{fehlerklasse}' },
] as const satisfies ReadonlyArray<{ code: string; urteil: Urteil; text: string }>;
export type Grund = (typeof GRUENDE)[number]['code'];

/** In dieser Reihenfolge wird ein Antrag geprüft — die Reihenfolge IST die Regel. */
export const PRUEFREIHENFOLGE_ANTRAG: Grund[] = [
  'protokoll_unbekannt',
  'keine_volle_minute',
  'rueckwirkend',
  'steuerquelle',
  'spaeterer_wechsel_geplant',
  'schon_zustaendig',
  'adresse_an_box_vergeben',
  'netzlage_fehlt',
  'nur_ein_leser',
  'vergleich_bestaetigen',
  'pruefung_fehlt',
  'pruefung_gescheitert',
];
export const PRUEFREIHENFOLGE_ZEITRAUM: Grund[] = ['keine_volle_minute', 'leerer_zeitraum', 'ueberschneidung'];
export const PRUEFREIHENFOLGE_TAUSCH: Grund[] = ['keine_volle_minute', 'rueckwirkend'];

export type Herkunft = 'box' | 'cloud';

/**
 * Warum eine Quelle nicht gelesen wird (E5 = A): die Wörter des Verbindungstests, dazu
 * `layout_changed` (AP-05) und `budget` von der Box, `box_meldet_sich_nicht` nur aus der Cloud.
 * Platzhalter: {box}, {adresse}.
 */
export const FEHLERKLASSEN = [
  {
    code: 'unreachable',
    name: 'nicht erreichbar',
    von: 'box',
    text: '{box} erreicht {adresse} nicht — Netz/VLAN prüfen (Bogen D1/D2)',
  },
  {
    code: 'no_answer',
    name: 'Zeitüberschreitung',
    von: 'box',
    text: 'Gerät antwortet nicht rechtzeitig — Geräte-ID, Last oder Watchdog prüfen (Bogen D3/D4)',
  },
  {
    code: 'invalid_response',
    name: 'Gerät meldet Fehler',
    von: 'box',
    text: 'Gerät antwortet mit Fehler — Registerbild oder Vorlage prüfen',
  },
  {
    code: 'implausible',
    name: 'Werte unplausibel',
    von: 'box',
    text: 'Gerät antwortet, die Werte sind aber unplausibel — Vorlage und Wandlerfaktor prüfen',
  },
  {
    code: 'fronius_api',
    name: 'Solar-API antwortet nicht',
    von: 'box',
    text: 'Die Solar-API des Geräts antwortet nicht',
  },
  {
    code: 'timeout',
    name: 'kein Ergebnis',
    von: 'box',
    text: '{box} bekommt von {adresse} kein Ergebnis im Lesefenster',
  },
  {
    code: 'layout_changed',
    name: 'Aufbau geändert',
    von: 'box',
    text: 'Aufbau geändert — nichts wurde umgehängt',
  },
  {
    code: 'budget',
    name: 'Budget überschritten',
    von: 'box',
    text: 'Diese Quelle passt nicht mehr in das Lesebudget von {box} — Takt strecken oder andere Box wählen',
  },
  {
    code: 'box_meldet_sich_nicht',
    name: 'Box meldet sich nicht',
    von: 'cloud',
    text: '{box} meldet sich nicht',
  },
] as const satisfies ReadonlyArray<{ code: string; name: string; von: Herkunft; text: string }>;
export type Fehlerklasse = (typeof FEHLERKLASSEN)[number];

/**
 * Nimmt eine Fehlerklasse an — oder verwirft sie (`null`). Nur das exakte Wort zählt, und nur
 * von dem, der sie feststellen kann: eine Box meldet nie, dass sie schweigt, die Cloud nie, dass
 * ein Gerät nicht antwortet.
 */
export function fehlerklasse(code: string, von: Herkunft): Fehlerklasse | null {
  return FEHLERKLASSEN.find((k) => k.code === code && k.von === von) ?? null;
}

/** Woher die führende Box einer Anlage kommt, in Vorrang-Reihenfolge (E3). */
export const FUEHRUNGS_GRUENDE = ['gespeichert', 'speicher', 'einzige', 'keine_wahl'] as const;
export type FuehrungsGrund = (typeof FUEHRUNGS_GRUENDE)[number];

/** Die übrigen Sätze und Satzteile — dieselben wie `texte` in der Vektor-Datei. */
export const TEXTE = {
  erlaubt: 'Ab {zeitpunkt} liest {box}',
  hinweis_anderes_netz: 'Gleiche Adresse wie {kennzeichen} — anderes Netz',
  hinweis_vergleichsquelle: 'Vergleichsquelle zu {kennzeichen} an {box} — gekennzeichnet, ohne Bewertung',
  ausgebaut: 'Ausgebaut am {zeitpunkt} — ersetzt durch {box}',
  fuehrt: '{box} führt die Anlage',
  keine_wahl: 'Welche Box führt diese Anlage? — Box wählen',
  rolle_fuehrt: 'liest {anzahl} · führt die Anlage',
  rolle_fuehrt_nicht: 'liest {anzahl} · führt die Anlage nicht',
  anzahl_null: 'keine Datenquelle',
  anzahl_eins: '1 Datenquelle',
  anzahl_viele: '{n} Datenquellen',
  software: 'Software {stand}',
  software_unbekannt: 'Software-Stand unbekannt',
  alle_faehigkeiten: 'alle Fähigkeiten',
  update_noetig: 'Update nötig für: {liste}',
} as const;

// ───────────────────────────────────────────────────────────────────────── Formen

/** Ein Zeitraum, in dem `box` liest: `effective_from` gehört dazu, `effective_to` nicht; `null` = offen. */
export interface Zeitraum {
  box: string;
  effective_from: string;
  effective_to: string | null;
}

/** Eine bestehende Datenquelle mit den Zeiträumen ihrer zuständigen Box. */
export interface Quelle {
  kennzeichen: string;
  anlage?: string;
  protokoll: string;
  adresse: string;
  netz: string | null;
  steuerquelle: boolean;
  mehrere_leser: boolean;
  zeitraeume: Zeitraum[];
}

/** Eine Quelle, die neu angelegt werden soll. */
export interface Kandidat {
  protokoll: string;
  adresse: string;
  netz: string | null;
  geraete_ids: number[];
  mehrere_leser: boolean;
}

/** Das Ergebnis der Erreichbarkeitsprüfung: „ok" oder eine Fehlerklasse der Box. */
export interface Pruefung {
  box: string;
  ergebnis: string;
  zeitpunkt: string;
}

export interface Antrag {
  art: 'anlegen' | 'wechsel';
  quelle?: string;
  kandidat?: Kandidat;
  box: string;
  effective_from: string;
  pruefung: Pruefung | null;
  vergleich_bestaetigt: boolean;
}

export interface AntragErgebnis {
  urteil: Urteil;
  grund: Grund | null;
  text: string;
  hinweis: string | null;
  vergleichsquelle: boolean;
  zeitraeume: Zeitraum[] | null;
}

export interface ZeitraumErgebnis {
  gueltig: boolean;
  grund: Grund | null;
  text: string | null;
}

/** Die Rolle einer Box: Heimat-Anlage und die Anlagen, die sie führt. */
export interface Rolle {
  kennzeichen: string;
  heimat_anlage: string;
  fuehrend_fuer: string[];
}

export interface TauschErgebnis {
  urteil: Urteil;
  grund: Grund | null;
  text: string;
  quellen: { kennzeichen: string; zeitraeume: Zeitraum[] }[] | null;
  neu: Rolle | null;
}

export interface BoxLiest {
  kennzeichen: string;
  name: string;
  liest: number;
}

export interface FuehrungsErgebnis {
  box: string | null;
  grund: FuehrungsGrund;
  text: string;
  rollen: { box: string; text: string }[];
}

/** Was eine Box über ihre Software meldet; `supports === null`: kein Block. */
export interface Stand {
  version: string | null;
  release: string | null;
  supports: string[] | null;
}

/** Eine Zeile der Tabelle `edge-capabilities.json`. */
export interface TabellenEintrag {
  code: string;
  name: string;
  ab_release: string | null;
}

export interface FaehigkeitenErgebnis {
  faehigkeiten: { code: string; status: 'vorhanden' | 'fehlt'; nachweis: 'supports' | 'tabelle' }[];
  text: string;
}

/** Eine vorhandene Komponente mit ihrem heutigen Anschluss. */
export interface BestandKomponente {
  kennzeichen: string;
  anlage: string;
  box: string;
  protokoll: string;
  adresse: string;
  geraete_id: number | null;
  in_betrieb_ab: string;
  steuerbar: boolean;
}

export interface Vorschlag {
  kennzeichen: string;
  anlage: string;
  box: string;
  protokoll: string;
  adresse: string;
  geraete_ids: number[];
  komponenten: string[];
  steuerquelle: boolean;
  zeitraeume: Zeitraum[];
}

// ───────────────────────────────────────────────────────────────────────── Hilfen

const ms = (iso: string): number => Date.parse(iso);
const MINUTE_MS = 60_000;

const volleMinute = (iso: string): boolean => ms(iso) % MINUTE_MS === 0;

/** `jetzt` auf die Minute abgerundet (Millisekunden seit 1970). */
const minuteVon = (iso: string): number => Math.floor(ms(iso) / MINUTE_MS) * MINUTE_MS;

const umfasst = (z: Zeitraum, t: string): boolean =>
  ms(z.effective_from) <= ms(t) && (z.effective_to === null || ms(t) < ms(z.effective_to));

/** Reicht der Zeitraum über `t` hinaus (endet nicht vorher)? */
const reichtUeber = (z: Zeitraum, t: string): boolean =>
  z.effective_to === null || ms(z.effective_to) > ms(t);

const ueberschneidet = (a: Zeitraum, b: Zeitraum): boolean =>
  (b.effective_to === null || ms(a.effective_from) < ms(b.effective_to)) &&
  (a.effective_to === null || ms(b.effective_from) < ms(a.effective_to));

function fuelle(vorlage: string, werte: Record<string, string>): string {
  return Object.entries(werte).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), vorlage);
}

function zeit(iso: string, zone: string): string {
  const t = teile(iso, zone);
  return `${t.tag} ${t.stunde}:${t.minute}`;
}

const name = (boxNamen: Record<string, string>, k: string): string => boxNamen[k] ?? k;

function grundText(g: Grund): { urteil: Urteil; text: string } {
  const eintrag = GRUENDE.find((x) => x.code === g);
  if (!eintrag) throw new Error(`unbekannter Grund: ${g}`);
  return eintrag;
}

function abgelehnt(g: Grund, werte: Record<string, string> = {}): AntragErgebnis {
  const { urteil, text } = grundText(g);
  return { urteil, grund: g, text: fuelle(text, werte), hinweis: null, vergleichsquelle: false, zeitraeume: null };
}

/** Der Zeitraum mit dem spätesten Beginn — der, den ein Wechsel beendet. */
function letzter(zeitraeume: Zeitraum[]): Zeitraum | null {
  let l: Zeitraum | null = null;
  for (const z of zeitraeume) {
    if (l === null || ms(z.effective_from) > ms(l.effective_from)) l = z;
  }
  return l;
}

/** Eine ANDERE Quelle auf demselben Erfassungsweg (Protokoll + Adresse). */
const andererGleicherWeg = (o: Quelle, q: Quelle): boolean =>
  !(q.kennzeichen !== '' && q.kennzeichen === o.kennzeichen) &&
  o.protokoll === q.protokoll &&
  o.adresse === q.adresse;

// ───────────────────────────────────────────────────────────────────────── Antrag

/**
 * Darf `antrag.box` die Quelle ab `antrag.effective_from` lesen? Beim Wechsel wird der laufende
 * Zeitraum zum Zeitpunkt BEENDET (Ende alt = Beginn neu) und ein offener für die neue Box
 * begonnen — nie überschrieben. Die Adresse wird so verglichen, wie sie gespeichert ist.
 */
export function pruefeAntrag(
  antrag: Antrag,
  quellen: Quelle[],
  boxNamen: Record<string, string>,
  jetzt: string,
  zeitzone: string = VORGABE_ZEITZONE,
): AntragErgebnis {
  const wechsel = antrag.art === 'wechsel';
  let q: Quelle;
  if (wechsel) {
    const gefunden = quellen.find((x) => x.kennzeichen === antrag.quelle);
    if (!gefunden) throw new Error(`unbekannte Quelle: ${antrag.quelle}`);
    q = gefunden;
  } else {
    const k = antrag.kandidat;
    if (!k) throw new Error('Anlegen ohne Kandidat');
    q = { kennzeichen: '', protokoll: k.protokoll, adresse: k.adresse, netz: k.netz, steuerquelle: false, mehrere_leser: k.mehrere_leser, zeitraeume: [] };
  }
  const t = antrag.effective_from;
  const ziel = antrag.box;

  if (!PROTOKOLLE.some((p) => p.code === q.protokoll)) return abgelehnt('protokoll_unbekannt');
  if (!volleMinute(t)) return abgelehnt('keine_volle_minute');
  if (ms(t) < minuteVon(jetzt)) return abgelehnt('rueckwirkend');
  const l = letzter(q.zeitraeume);
  if (wechsel) {
    if (q.steuerquelle) return abgelehnt('steuerquelle');
    if (l !== null && ms(t) < ms(l.effective_from)) {
      return abgelehnt('spaeterer_wechsel_geplant', {
        zeitpunkt: zeit(l.effective_from, zeitzone),
        box: name(boxNamen, l.box),
      });
    }
    if (l !== null && l.box === ziel && umfasst(l, t)) {
      return abgelehnt('schon_zustaendig', { box: name(boxNamen, ziel) });
    }
  }

  // Eindeutigkeit je Box (§4.3 Nr. 2): an der Ziel-Box liest niemand sonst diesen Weg.
  for (const o of quellen) {
    if (!andererGleicherWeg(o, q)) continue;
    if (o.zeitraeume.some((z) => z.box === ziel && reichtUeber(z, t))) {
      return abgelehnt('adresse_an_box_vergeben', { box: name(boxNamen, ziel), kennzeichen: o.kennzeichen });
    }
  }

  // Doppel-Lesen (E10 = B): gleicher Weg an einer ANDEREN Box.
  let hinweis: string | null = null;
  let vergleichsquelle = false;
  for (const o of quellen) {
    if (!andererGleicherWeg(o, q)) continue;
    for (const z of o.zeitraeume) {
      if (z.box === ziel || !reichtUeber(z, t)) continue;
      const werte = { kennzeichen: o.kennzeichen, box: name(boxNamen, z.box) };
      if (q.netz === null || o.netz === null) return abgelehnt('netzlage_fehlt', werte);
      if (q.netz === o.netz) {
        const einLeser = !q.mehrere_leser || !o.mehrere_leser || q.steuerquelle || o.steuerquelle;
        if (einLeser) return abgelehnt('nur_ein_leser', werte);
        if (!antrag.vergleich_bestaetigt) {
          const { urteil, text } = grundText('vergleich_bestaetigen');
          return { urteil, grund: 'vergleich_bestaetigen', text: fuelle(text, werte), hinweis: null, vergleichsquelle: false, zeitraeume: null };
        }
        vergleichsquelle = true;
        hinweis ??= fuelle(TEXTE.hinweis_vergleichsquelle, werte);
      } else {
        hinweis ??= fuelle(TEXTE.hinweis_anderes_netz, werte);
      }
    }
  }

  // Erreichbarkeit vor Zuständigkeit (E11, §4.4 Nr. 7) — und nur von GENAU dieser Box.
  const p = antrag.pruefung;
  const klasse = p === null ? null : fehlerklasse(p.ergebnis, 'box');
  if (p === null || p.box !== ziel || (p.ergebnis !== 'ok' && klasse === null)) {
    return abgelehnt('pruefung_fehlt', { box: name(boxNamen, ziel) });
  }
  if (klasse !== null) {
    return {
      urteil: 'abgelehnt',
      grund: 'pruefung_gescheitert',
      text: fuelle(klasse.text, { box: name(boxNamen, ziel), adresse: q.adresse }),
      hinweis: null,
      vergleichsquelle: false,
      zeitraeume: null,
    };
  }

  const danach = q.zeitraeume.map((z) =>
    z === l && reichtUeber(z, t) ? { box: z.box, effective_from: z.effective_from, effective_to: t } : z,
  );
  danach.push({ box: ziel, effective_from: t, effective_to: null });
  return {
    urteil: 'erlaubt',
    grund: null,
    text: fuelle(TEXTE.erlaubt, { zeitpunkt: zeit(t, zeitzone), box: name(boxNamen, ziel) }),
    hinweis,
    vergleichsquelle,
    zeitraeume: danach,
  };
}

// ────────────────────────────────────────────────────────────────────── Zeiträume

/**
 * Die Speicher-Regel (IP-2: Ausschluss überlappender Zeiträume): darf `neu` zu `bestehend`
 * hinzukommen? Sie beendet nichts von selbst.
 */
export function pruefeZeitraum(
  bestehend: Zeitraum[],
  neu: Zeitraum,
  boxNamen: Record<string, string>,
): ZeitraumErgebnis {
  const nein = (g: Grund, werte: Record<string, string> = {}): ZeitraumErgebnis => ({
    gueltig: false,
    grund: g,
    text: fuelle(grundText(g).text, werte),
  });
  if (!volleMinute(neu.effective_from) || (neu.effective_to !== null && !volleMinute(neu.effective_to))) {
    return nein('keine_volle_minute');
  }
  if (neu.effective_to !== null && ms(neu.effective_to) <= ms(neu.effective_from)) return nein('leerer_zeitraum');
  const b = bestehend.find((x) => ueberschneidet(x, neu));
  if (b) return nein('ueberschneidung', { box: name(boxNamen, b.box) });
  return { gueltig: true, grund: null, text: null };
}

/** Welche Box liest zum Zeitpunkt `t` — die Herkunft je Wert; `null`: keine. */
export function zustaendigeBox(zeitraeume: Zeitraum[], t: string): string | null {
  return zeitraeume.find((z) => umfasst(z, t))?.box ?? null;
}

// ───────────────────────────────────────────────────────────────────── Box-Tausch

/**
 * Box tauschen (E7 = A): ab `zeitpunkt` übernimmt `neu` Heimat-Anlage, Rolle und ALLE
 * Zuständigkeiten von `alt` — die laufende wird geteilt, eine geplante wechselt ganz. Was davor
 * liegt, bleibt; nichts wird gelöscht, nie rückwirkend.
 */
export function boxTausch(
  quellen: Quelle[],
  alt: Rolle,
  neu: string,
  zeitpunkt: string,
  jetzt: string,
  boxNamen: Record<string, string>,
  zeitzone: string = VORGABE_ZEITZONE,
): TauschErgebnis {
  for (const g of ['keine_volle_minute', 'rueckwirkend'] as const) {
    const trifft = g === 'keine_volle_minute' ? !volleMinute(zeitpunkt) : ms(zeitpunkt) < minuteVon(jetzt);
    if (trifft) return { urteil: 'abgelehnt', grund: g, text: grundText(g).text, quellen: null, neu: null };
  }
  const danach = quellen.map((q) => ({
    kennzeichen: q.kennzeichen,
    zeitraeume: q.zeitraeume.flatMap((z): Zeitraum[] => {
      if (z.box !== alt.kennzeichen || !reichtUeber(z, zeitpunkt)) return [z];
      if (ms(z.effective_from) >= ms(zeitpunkt)) return [{ ...z, box: neu }];
      return [
        { box: z.box, effective_from: z.effective_from, effective_to: zeitpunkt },
        { box: neu, effective_from: zeitpunkt, effective_to: z.effective_to },
      ];
    }),
  }));
  return {
    urteil: 'erlaubt',
    grund: null,
    text: fuelle(TEXTE.ausgebaut, { zeitpunkt: zeit(zeitpunkt, zeitzone), box: name(boxNamen, neu) }),
    quellen: danach,
    neu: { kennzeichen: neu, heimat_anlage: alt.heimat_anlage, fuehrend_fuer: [...alt.fuehrend_fuer] },
  };
}

// ────────────────────────────────────────────────────────────────── führende Box

function anzahl(n: number): string {
  if (n === 0) return TEXTE.anzahl_null;
  if (n === 1) return TEXTE.anzahl_eins;
  return fuelle(TEXTE.anzahl_viele, { n: String(n) });
}

/**
 * Die führende Box einer Anlage (E3 = A): die ausdrücklich gewählte, sonst die Box des Speichers,
 * sonst die einzige Box — sonst keine, und das Portal fragt. Nie geraten.
 */
export function fuehrendeBox(
  boxen: BoxLiest[],
  speicherBox: string | null,
  gespeichert: string | null,
): FuehrungsErgebnis {
  let box: string | null;
  let grund: FuehrungsGrund;
  if (gespeichert !== null) [box, grund] = [gespeichert, 'gespeichert'];
  else if (speicherBox !== null) [box, grund] = [speicherBox, 'speicher'];
  else if (boxen.length === 1) [box, grund] = [boxen[0].kennzeichen, 'einzige'];
  else [box, grund] = [null, 'keine_wahl'];
  const rollen = boxen.map((b) => ({
    box: b.kennzeichen,
    text: fuelle(b.kennzeichen === box ? TEXTE.rolle_fuehrt : TEXTE.rolle_fuehrt_nicht, { anzahl: anzahl(b.liest) }),
  }));
  const fuehrende = boxen.find((b) => b.kennzeichen === box);
  const text = box === null ? TEXTE.keine_wahl : fuelle(TEXTE.fuehrt, { box: fuehrende?.name ?? box });
  return { box, grund, text, rollen };
}

// ─────────────────────────────────────────────────────────────────── Fähigkeiten

/**
 * Welche Fähigkeiten hat eine Box (E12 = A)? Meldet sie `supports[]`, entscheidet allein die
 * Meldung (auch eine leere; fremde Wörter werden verworfen). Sonst die Tabelle: vorhanden, wenn
 * das Release der Box im Register nicht vor `ab_release` liegt. Ein Stand ohne Release beweist
 * nichts. `register`: die Releases in der Ordnung des Registers (`release_seq`), älteste zuerst.
 */
export function faehigkeiten(
  stand: Stand,
  tabelle: TabellenEintrag[],
  register: string[],
): FaehigkeitenErgebnis {
  const status = tabelle.map((e) => {
    if (stand.supports !== null) {
      return { code: e.code, vorhanden: stand.supports.includes(e.code), nachweis: 'supports' as const };
    }
    const ist = stand.release === null ? -1 : register.indexOf(stand.release);
    const ab = e.ab_release === null ? -1 : register.indexOf(e.ab_release);
    return { code: e.code, vorhanden: ist >= 0 && ab >= 0 && ist >= ab, nachweis: 'tabelle' as const };
  });
  const fehlend = tabelle.filter((_, i) => !status[i].vorhanden).map((e) => e.name);
  const gezeigt = stand.release ?? stand.version;
  const kopf = gezeigt === null ? TEXTE.software_unbekannt : fuelle(TEXTE.software, { stand: gezeigt });
  const rest =
    fehlend.length === 0 ? TEXTE.alle_faehigkeiten : fuelle(TEXTE.update_noetig, { liste: fehlend.join(', ') });
  return {
    faehigkeiten: status.map((s) => ({
      code: s.code,
      status: s.vorhanden ? ('vorhanden' as const) : ('fehlt' as const),
      nachweis: s.nachweis,
    })),
    text: `${kopf} · ${rest}`,
  };
}

// ─────────────────────────────────────────────────────────────────────── Bestand

/**
 * Die Vorschlagsliste der Bestands-Übernahme (§4.4 Nr. 8, A12): Komponenten gruppiert nach Box +
 * Protokoll + Adresse, in der Reihenfolge ihres ersten Auftretens; Kennzeichen ab
 * `naechsteNummer`; zuständig die heutige Box ab Reihenbeginn. Das ist der EINZIGE Weg, auf dem
 * ein Zeitraum in der Vergangenheit beginnt — er beschreibt, was die Box ohnehin gelesen hat.
 */
export function vorschlagsliste(komponenten: BestandKomponente[], naechsteNummer: number): Vorschlag[] {
  const gruppen = new Map<string, BestandKomponente[]>();
  for (const k of komponenten) {
    const schluessel = `${k.box} ${k.protokoll} ${k.adresse}`;
    gruppen.set(schluessel, [...(gruppen.get(schluessel) ?? []), k]);
  }
  return [...gruppen.values()].map((g, i) => {
    const erste = g[0];
    const beginn = g.reduce((b, k) => (ms(k.in_betrieb_ab) < ms(b) ? k.in_betrieb_ab : b), erste.in_betrieb_ab);
    const ids = [...new Set(g.flatMap((k) => (k.geraete_id === null ? [] : [k.geraete_id])))].sort((a, b) => a - b);
    return {
      kennzeichen: `DQ-${naechsteNummer + i}`,
      anlage: erste.anlage,
      box: erste.box,
      protokoll: erste.protokoll,
      adresse: erste.adresse,
      geraete_ids: ids,
      komponenten: g.map((k) => k.kennzeichen),
      steuerquelle: g.some((k) => k.steuerbar),
      zeitraeume: [{ box: erste.box, effective_from: beginn, effective_to: null }],
    };
  });
}
