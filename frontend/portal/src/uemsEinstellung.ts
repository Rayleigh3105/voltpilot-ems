/**
 * Die Regeln der EINSTELLUNGS-FASSUNGEN je Quelle (UEMS AP-04 IP-11, E4 = A,
 * E5 = A; Vertrag `docs/contracts/v2/quelle-einstellung.md`) — der TS-Zwilling
 * von `services/api .../uems/QuelleEinstellungRegeln`, gepinnt von DERSELBEN
 * Datei `quelle-einstellung-vectors.json`.
 *
 * Er kennt, was die Geräteseite (IP-12) braucht: die Form eines Werts je Art
 * und seinen Text („600/5 A"), wie sich eine neue Fassung zwischen die
 * bestehenden legt (beendet die zu ihrem Beginn gültige genau dort), die
 * Folgen-Sätze (§5.7, A5) und die Anzeige (Status, Zustellung). Die Ableitung
 * aus der Verbindung einer Komponente kennt er NICHT — die ist Server-Wissen.
 *
 * Die Wirkung (E5) steht in jedem Satz: nur ab „gültig ab“, kein gespeicherter
 * Wert ändert sich, nichts wird neu berechnet; ein falsch erfasster Zeitraum
 * wird über eine Korrektur berichtigt.
 */
import { teile } from './uemsZustand';

export const ZEITZONE = 'Europe/Berlin';
/** Betragsgrenze jeder Zahl eines Werts (einschließlich). */
export const ZAHL_GRENZE = 1_000_000_000;
export const EINHEIT_MAX_ZEICHEN = 32;

export type ArtCode =
  | 'wandler_strom'
  | 'wandler_spannung'
  | 'skalierung'
  | 'offset'
  | 'vorzeichen_umgekehrt'
  | 'impulswertigkeit'
  | 'zaehlerkonstante';

export interface ArtDef {
  art: ArtCode;
  kundenwort: string;
  felder: string[];
  text: string;
}

/** Das geschlossene Vokabular der Arten (AP-04 §4.4), in der Reihenfolge des Vertrags. */
export const ARTEN: ArtDef[] = [
  { art: 'wandler_strom', kundenwort: 'Wandlerverhältnis Strom', felder: ['primaer_a', 'sekundaer_a'], text: '{primaer_a}/{sekundaer_a} A' },
  { art: 'wandler_spannung', kundenwort: 'Spannungswandler', felder: ['primaer_v', 'sekundaer_v'], text: '{primaer_v}/{sekundaer_v} V' },
  { art: 'skalierung', kundenwort: 'Skalierung', felder: ['faktor'], text: '×{faktor}' },
  { art: 'offset', kundenwort: 'Offset', felder: ['wert', 'einheit'], text: '{wert} {einheit}' },
  { art: 'vorzeichen_umgekehrt', kundenwort: 'Vorzeichen umgekehrt', felder: ['umgekehrt'], text: '{umgekehrt}' },
  { art: 'impulswertigkeit', kundenwort: 'Impulswertigkeit', felder: ['impulse_je_kwh'], text: '{impulse_je_kwh} Impulse je kWh' },
  { art: 'zaehlerkonstante', kundenwort: 'Zählerkonstante', felder: ['je_kwh'], text: '{je_kwh} je kWh' },
];

export const WANDLER_ARTEN: ArtCode[] = ['wandler_strom', 'wandler_spannung'];

export type AnwendungsArt = 'angewendet' | 'dokumentiert';
export type Herkunft = 'bestand' | 'verbindung' | 'eintrag';
export type Zustellung = 'verbindung' | 'ausstehend';
export type Status = 'geplant' | 'gueltig' | 'beendet';

export const ANWENDUNGEN: AnwendungsArt[] = ['angewendet', 'dokumentiert'];
export const HERKUENFTE: Herkunft[] = ['bestand', 'verbindung', 'eintrag'];
export const ZUSTELLUNGEN: Zustellung[] = ['verbindung', 'ausstehend'];
export const STATUS: Status[] = ['geplant', 'gueltig', 'beendet'];

export type FehlerCode =
  | 'wert_ungueltig'
  | 'zeitpunkt_ungueltig'
  | 'vor_beginn'
  | 'nach_ende'
  | 'tatsaechlich_ungueltig'
  | 'beginn_belegt'
  | 'unveraendert';

/** Die Codes der Regeln mit ihrem HTTP-Status, in Prüfreihenfolge. */
export const FEHLER: { code: FehlerCode; status: number }[] = [
  { code: 'wert_ungueltig', status: 400 },
  { code: 'zeitpunkt_ungueltig', status: 400 },
  { code: 'vor_beginn', status: 422 },
  { code: 'nach_ende', status: 422 },
  { code: 'tatsaechlich_ungueltig', status: 422 },
  { code: 'beginn_belegt', status: 409 },
  { code: 'unveraendert', status: 400 },
];

/** Die Kundensätze mit ihren Platzhaltern — dieselben Zeichen wie `texte` der Vektor-Datei. */
export const TEXTE: Record<string, string> = {
  werte_bleiben: 'Werte vor dem {ab} bleiben unverändert.',
  zeitraum_mit:
    'Der Zeitraum vom {von} bis {bis} ist mit {wert} erfasst. Berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.',
  zeitraum_ohne:
    'Der Zeitraum vom {von} bis {bis} ist ohne diese Einstellung erfasst. Berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.',
  frueher_wandler:
    'Wenn der Wandler schon früher getauscht wurde, ist der Zeitraum dazwischen falsch erfasst — berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.',
  frueher_einstellung:
    'Wenn die Einstellung schon früher geändert wurde, ist der Zeitraum dazwischen falsch erfasst — berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.',
  dokumentiert: 'VoltPilot rechnet nichts um — das Gerät wendet die Einstellung selbst an.',
  zustellung_ausstehend:
    'Die Zustellung an die VoltPilot-Box steht noch aus; bis dahin erfasst sie wie bisher. Bereits erfasste Werte berechnet VoltPilot nie neu.',
  mit_verbindung:
    'Die VoltPilot-Box wendet die Einstellung mit der Verbindung der Komponente an. Bereits erfasste Werte berechnet VoltPilot nie neu.',
  anwendung_dokumentiert: 'im Gerät eingestellt — dokumentiert',
  anwendung_ausstehend: 'angewendet — Zustellung ausstehend',
  anwendung_verbindung: 'angewendet — mit der Verbindung zugestellt',
  automatisch: 'automatisch',
  ja: 'ja',
  nein: 'nein',
  zeitpunkt_tag: '{tag}',
  zeitpunkt_minute: '{tag}, {stunde}:{minute} Uhr',
};

type Wert = Record<string, unknown>;

// ------------------------------------------------------------------ Werte

const istObjekt = (w: unknown): w is Wert => typeof w === 'object' && w !== null && !Array.isArray(w);

const zahl = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= ZAHL_GRENZE;

const positiv = (n: unknown): boolean => zahl(n) && n > 0;

const gleicheFelder = (w: Wert, felder: string[]): boolean => {
  const ist = Object.keys(w).sort();
  const soll = [...felder].sort();
  return ist.length === soll.length && ist.every((f, i) => f === soll[i]);
};

const artDef = (art: string): ArtDef | undefined => ARTEN.find((a) => a.art === art);

/** Hat `wert` genau die Form, die `art` verlangt? */
export function wertGueltig(art: string, wert: unknown): boolean {
  const a = artDef(art);
  if (!a || !istObjekt(wert)) return false;
  switch (a.art) {
    case 'wandler_strom':
    case 'wandler_spannung':
      return gleicheFelder(wert, a.felder) && positiv(wert[a.felder[0]]) && positiv(wert[a.felder[1]]);
    case 'skalierung':
      return (
        (gleicheFelder(wert, ['faktor']) && zahl(wert.faktor) && wert.faktor !== 0) ||
        (gleicheFelder(wert, ['automatisch']) && wert.automatisch === true)
      );
    case 'offset':
      return (
        gleicheFelder(wert, a.felder) &&
        zahl(wert.wert) &&
        typeof wert.einheit === 'string' &&
        wert.einheit.length <= EINHEIT_MAX_ZEICHEN
      );
    case 'vorzeichen_umgekehrt':
      return gleicheFelder(wert, ['umgekehrt']) && typeof wert.umgekehrt === 'boolean';
    case 'impulswertigkeit':
    case 'zaehlerkonstante':
      return gleicheFelder(wert, a.felder) && positiv(wert[a.felder[0]]);
  }
}

/** „1.000", „12,5", „-2", „0,001" — Tausenderpunkt, Dezimalkomma, keine überflüssige Null. */
export function zahlText(n: number): string {
  const plain =
    n === 0 ? '0' : n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  const negativ = plain.startsWith('-');
  const ohne = negativ ? plain.slice(1) : plain;
  const [ganz, rest = ''] = ohne.split('.');
  let g = '';
  for (let i = 0; i < ganz.length; i++) {
    if (i > 0 && (ganz.length - i) % 3 === 0) g += '.';
    g += ganz[i];
  }
  return `${negativ ? '-' : ''}${g}${rest ? `,${rest}` : ''}`;
}

/** „600/5 A", „×10", „automatisch", „-2 °C" — `null` für einen ungültigen Wert. */
export function wertText(art: string, wert: unknown): string | null {
  if (!wertGueltig(art, wert)) return null;
  const a = artDef(art) as ArtDef;
  const w = wert as Wert;
  if (a.art === 'skalierung' && 'automatisch' in w) return TEXTE.automatisch;
  if (a.art === 'offset') {
    const z = zahlText(w.wert as number);
    return w.einheit === '' ? z : `${z} ${w.einheit as string}`;
  }
  if (a.art === 'vorzeichen_umgekehrt') return w.umgekehrt ? TEXTE.ja : TEXTE.nein;
  return a.felder.reduce((t, f) => t.split(`{${f}}`).join(zahlText(w[f] as number)), a.text);
}

/** Dieselben Felder mit denselben Werten — Zahlen nach ihrem Wert. */
export function gleicherWert(a: unknown, b: unknown): boolean {
  if (!istObjekt(a) || !istObjekt(b) || !gleicheFelder(a, Object.keys(b))) return false;
  return Object.keys(a).every((f) => a[f] === b[f]);
}

// ------------------------------------------------------------------ Fassung

export interface Bestehende {
  id: string;
  wert: Wert;
  anwendung: AnwendungsArt;
  gueltigAb: string;
  gueltigBis: string | null;
}

export interface Neu {
  art: string;
  wert: unknown;
  anwendung: AnwendungsArt;
  gueltigAb: string;
  tatsaechlichAb: string | null;
}

/**
 * `beginn`: Beginn der Quelle — der Einbau bzw. die Speisung der Komponente;
 * `ende`: ihr Ende (`null` = offen).
 */
export interface Eingang {
  beginn: string;
  ende: string | null;
  bestehende: Bestehende[];
  neu: Neu;
  jetzt: string;
}

export interface Urteil {
  fehler: FehlerCode | null;
  beendet: { id: string; gueltigBis: string } | null;
  gueltigAb: string | null;
  gueltigBis: string | null;
  rueckwirkend: boolean | null;
  vorgaenger: Bestehende | null;
}

const MINUTE_MS = 60_000;
const ms = (iso: string): number => Date.parse(iso);

const abgelehnt = (fehler: FehlerCode): Urteil => ({
  fehler,
  beendet: null,
  gueltigAb: null,
  gueltigBis: null,
  rueckwirkend: null,
  vorgaenger: null,
});

/** Die Fassung, die zu `t` gilt (`ab <= t < bis`); `null`, wenn keine. */
export function gueltigZu(fassungen: Bestehende[], t: string): Bestehende | null {
  return (
    fassungen.find(
      (b) => ms(b.gueltigAb) <= ms(t) && (b.gueltigBis === null || ms(t) < ms(b.gueltigBis)),
    ) ?? null
  );
}

/**
 * Legt eine neue Fassung zwischen die bestehenden derselben Quelle und Art —
 * Prüfreihenfolge: Wert → Zeitpunkt auf der Minute → vor Beginn → am oder nach
 * dem Ende → tatsächlich-Zeitpunkt → Beginn belegt → unverändert. Die neue
 * beendet die zu ihrem Beginn gültige genau dort und gilt bis zum Beginn der
 * nächsten späteren (höchstens bis zum Ende der Quelle).
 */
export function neueFassung(e: Eingang): Urteil {
  const { neu } = e;
  if (!wertGueltig(neu.art, neu.wert)) return abgelehnt('wert_ungueltig');
  const aufMinute = (iso: string) => ms(iso) % MINUTE_MS === 0;
  if (!aufMinute(neu.gueltigAb) || (neu.tatsaechlichAb !== null && !aufMinute(neu.tatsaechlichAb))) {
    return abgelehnt('zeitpunkt_ungueltig');
  }
  const ab = ms(neu.gueltigAb);
  if (ab < ms(e.beginn)) return abgelehnt('vor_beginn');
  if (e.ende !== null && ab >= ms(e.ende)) return abgelehnt('nach_ende');
  if (
    neu.tatsaechlichAb !== null &&
    (ms(neu.tatsaechlichAb) >= ab || ms(neu.tatsaechlichAb) < ms(e.beginn))
  ) {
    return abgelehnt('tatsaechlich_ungueltig');
  }
  if (e.bestehende.some((b) => ms(b.gueltigAb) === ab)) return abgelehnt('beginn_belegt');
  const vorgaenger = gueltigZu(e.bestehende, neu.gueltigAb);
  if (vorgaenger && gleicherWert(vorgaenger.wert, neu.wert) && vorgaenger.anwendung === neu.anwendung) {
    return abgelehnt('unveraendert');
  }
  let bis: string | null = null;
  for (const b of e.bestehende) {
    if (ms(b.gueltigAb) > ab && (bis === null || ms(b.gueltigAb) < ms(bis))) bis = b.gueltigAb;
  }
  if (e.ende !== null && (bis === null || ms(bis) > ms(e.ende))) bis = e.ende;
  const jetztMinute = Math.floor(ms(e.jetzt) / MINUTE_MS) * MINUTE_MS;
  return {
    fehler: null,
    beendet: vorgaenger ? { id: vorgaenger.id, gueltigBis: neu.gueltigAb } : null,
    gueltigAb: neu.gueltigAb,
    gueltigBis: bis,
    rueckwirkend: ab < jetztMinute,
    vorgaenger,
  };
}

// ------------------------------------------------------------------ Folgen

/** „15.01.2027, 09:00 Uhr" — und um Mitternacht nur der Tag, „01.02.2027"; in Europe/Berlin. */
export function zeitpunktText(iso: string): string {
  const t = teile(iso, ZEITZONE);
  if (t.stunde === '00' && t.minute === '00') return TEXTE.zeitpunkt_tag.split('{tag}').join(t.tag);
  return TEXTE.zeitpunkt_minute
    .split('{tag}')
    .join(t.tag)
    .split('{stunde}')
    .join(t.stunde)
    .split('{minute}')
    .join(t.minute);
}

/**
 * Die Folgen-Karte (AP-04 §5.7, A5) als Kundensätze: was unverändert bleibt,
 * welcher Zeitraum womit erfasst ist, und wie die Fassung wirkt.
 */
export function folgen(
  art: string,
  herkunft: Herkunft,
  neu: { wert: unknown; anwendung: AnwendungsArt; gueltigAb: string; tatsaechlichAb: string | null },
  vorgaenger: { wert: Wert; anwendung: AnwendungsArt } | null,
): string[] {
  const saetze = [TEXTE.werte_bleiben.split('{ab}').join(zeitpunktText(neu.gueltigAb))];
  if (neu.tatsaechlichAb !== null) {
    const vorlage =
      vorgaenger === null
        ? TEXTE.zeitraum_ohne
        : TEXTE.zeitraum_mit.split('{wert}').join(wertText(art, vorgaenger.wert) ?? '');
    saetze.push(
      vorlage
        .split('{von}')
        .join(zeitpunktText(neu.tatsaechlichAb))
        .split('{bis}')
        .join(zeitpunktText(neu.gueltigAb)),
    );
  } else {
    saetze.push(WANDLER_ARTEN.includes(art as ArtCode) ? TEXTE.frueher_wandler : TEXTE.frueher_einstellung);
  }
  if (neu.anwendung === 'dokumentiert') saetze.push(TEXTE.dokumentiert);
  else if (herkunft === 'eintrag') saetze.push(TEXTE.zustellung_ausstehend);
  else saetze.push(TEXTE.mit_verbindung);
  return saetze;
}

// ------------------------------------------------------------------ Anzeige

/** geplant (beginnt später) · gueltig · beendet (ab `bis`). */
export function status(gueltigAb: string, gueltigBis: string | null, jetzt: string): Status {
  if (ms(jetzt) < ms(gueltigAb)) return 'geplant';
  return gueltigBis !== null && ms(jetzt) >= ms(gueltigBis) ? 'beendet' : 'gueltig';
}

/**
 * `verbindung`: die VoltPilot-Box wendet die Fassung heute mit der Verbindung
 * an; `ausstehend`: angewendet eingetragen, die Zustellung steht aus; `null`:
 * dokumentiert.
 */
export function zustellung(anwendung: AnwendungsArt, herkunft: Herkunft): Zustellung | null {
  if (anwendung !== 'angewendet') return null;
  return herkunft === 'eintrag' ? 'ausstehend' : 'verbindung';
}

/** „angewendet — Zustellung ausstehend" bzw. „im Gerät eingestellt — dokumentiert". */
export function anwendungText(anwendung: AnwendungsArt, herkunft: Herkunft): string {
  const z = zustellung(anwendung, herkunft);
  if (z === null) return TEXTE.anwendung_dokumentiert;
  return z === 'ausstehend' ? TEXTE.anwendung_ausstehend : TEXTE.anwendung_verbindung;
}
