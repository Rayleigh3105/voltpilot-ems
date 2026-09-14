/**
 * Der „Gesamtwert" — die REINE Hälfte des Assistenten für berechnete Messwerte
 * (Konzept `vp-helfer-konzept-h1`, Captain-Rahmenentscheide). Der Kunde stellt
 * aus mehreren gemessenen Werten seiner Anlage EINEN neuen Wert zusammen: eine
 * **gewichtete Summe** mit Vorzeichen und optionalem Faktor. Danach verhält er
 * sich überall wie ein gemessener Wert — zunächst nur Anzeige.
 *
 * Diese Datei ist die EINE Stelle, an der aus der Auswahl Regeln, Vorschläge und
 * Sätze werden — ohne DOM, ohne Uhr (die Uhr kommt als Parameter), ohne Netz
 * (das `eigeneAuswertung.ts`/`komponenten.ts`-Muster). `components/GesamtwertDialog`
 * rendert nur.
 *
 * ## ⚠ Kein zweites Modell, keine zweite Wahrheit
 *
 * Im Datenmodell IST der Gesamtwert eine berechnete Messstelle (`art = berechnet`,
 * Formel-Typ „gewichtete Summe", AP-10). Die Rechen- und Ableitungsregeln leben
 * schon im Zwilling `uemsMessstelleFormel.ts` (`formelGroesse`, `gewichteteSumme`)
 * und stützen sich auf den Größen-Katalog aus `uemsMessstelle.ts`. Diese Datei
 * baut daraus nur den Assistenten-Fluss — sie erfindet keine zweite Rechnung.
 *
 * ## ⚠ Die Ehrlichkeitsregel
 *
 * Fehlt oder veraltet EIN Term, ist das Ergebnis `null` („unvollständig"), NIE
 * eine heimlich kleinere Teilsumme (`gewichteteSumme`). Eine Einheit kommt vom
 * Server bzw. dem Katalog, nie geraten. Das Kundenwort steht als EINE Konstante
 * in `glossar.ts` (`GESAMTWERT`).
 */
import { fmtNum } from './format';
import { GESAMTWERT } from './glossar';
import type { Groesse } from './uemsMessstelle';
import {
  erzeugungsHakenErlaubt,
  formelGroesse,
  gewichteteSumme,
  normiere,
  richtungMitErzeugungsHaken,
  type Summand,
  type Term as FormelTerm,
} from './uemsMessstelleFormel';

export { GESAMTWERT };

/** Wie viele Werte ein Gesamtwert höchstens summiert — eine ehrliche Grenze. */
export const MAX_TERME = 12;

/** Die Länge eines Namens (Server-Deckel des Messstellen-Namens). */
export const MAX_NAME = 80;

/** Ab wann ein gemessener Wert als „veraltet" gilt (dieselbe 5-Minuten-Sicht wie die Box). */
export const FRISCH_MS = 5 * 60 * 1000;

/** Die fünf Schritte des Assistenten, in Reihenfolge — der Stepper liest sie. */
export const SCHRITTE = ['Werte', 'Rechnen', 'Name', 'Vorschau', 'Fertig'] as const;
export type Schritt = 1 | 2 | 3 | 4 | 5;

// ---------------------------------------------------------------------------
// Die wählbaren Quell-Werte (aus dem Messwert-Baum + Messkanal-Größe + Live)
// ---------------------------------------------------------------------------

/** Wie frisch der zuletzt gemessene Wert ist — der Status-Punkt am Wert. */
export type Frische = 'frisch' | 'alt' | 'keine';

/**
 * Ein wählbarer Quell-Wert: EIN Messwert (Kanal) einer Komponente, angereichert
 * um seine Vertrags-Größe (aus den Messkanälen) und seinen zuletzt gemessenen
 * Wert (aus dem Tagesverlauf). Der Assistent bietet nur zueinander passende
 * Größen zur Summe an — keine Äpfel-und-Birnen-Summe.
 */
export interface Quellwert {
  /** Die Komponente (Server-Bindung des Terms) + ihr Messwert-Kanal. */
  entityId: string;
  channel: string;
  /** Der Kunden-Name des Messwerts (aus dem Verlauf-Baum, nie ein Roh-Kürzel). */
  name: string;
  /** „Deye SUN-30K" — die eine Geräte-Zeile der Komponente, oder null. */
  geraet: string | null;
  /** Die Vertrags-Größe des Kanals (z. B. Wirkleistung) — aus den Messkanälen. */
  groesse: string | null;
  richtung: string | null;
  einheit: string | null;
  wertart: string | null;
  /** Der zuletzt gemessene Wert, oder null (nie eine erfundene 0). */
  wert: number | null;
  /** Der Zeitpunkt dieses Werts (ISO), für die Frische — oder null. */
  stand: string | null;
}

/** Der Status-Punkt eines Quell-Werts: frisch → grün, alt → gelb, keiner → grau. */
export function frischeVon(stand: string | null, wert: number | null, jetzt: number): Frische {
  if (wert == null || !stand) return 'keine';
  const t = Date.parse(stand);
  if (!Number.isFinite(t)) return 'alt';
  return jetzt - t <= FRISCH_MS ? 'frisch' : 'alt';
}

/** Der Punkt-Zustand des Pickers (`VpPunkt`) zu einer Frische. */
export function punkt(frische: Frische): 'ok' | 'warn' | 'off' {
  return frische === 'frisch' ? 'ok' : frische === 'alt' ? 'warn' : 'off';
}

/** Trägt dieser Quell-Wert überhaupt eine Vertrags-Größe? Nur dann ist er summierbar. */
export function summierbar(q: Quellwert): boolean {
  return !!q.groesse && !!q.wertart;
}

/**
 * Passt der Quell-Wert `q` zu den schon gewählten `gewaehlt`? Eine Summe trägt
 * nur EINE Größe und EINE Wertart (Vertrag §2, `formelGroesse`) — ist noch nichts
 * gewählt, passt jeder summierbare Wert; sonst nur, wer Größe und Wertart teilt.
 * Die Einheit darf abweichen (W neben kW) — sie wird normiert.
 */
export function passt(q: Quellwert, gewaehlt: Quellwert[]): boolean {
  if (!summierbar(q)) return false;
  const anker = gewaehlt.find(summierbar);
  if (!anker) return true;
  return q.groesse === anker.groesse && q.wertart === anker.wertart;
}

/** Der Grund, warum ein Wert gerade nicht summierbar ist — nie eine stumme Sperre. */
export function sperrgrund(q: Quellwert, gewaehlt: Quellwert[]): string | null {
  if (passt(q, gewaehlt)) return null;
  if (!summierbar(q)) return 'Für diesen Wert steht noch keine Messgröße fest.';
  return 'Andere Messgröße — passt nicht in dieselbe Summe.';
}

// ---------------------------------------------------------------------------
// Der Term im Entwurf (ein gewählter Quell-Wert + Vorzeichen + Faktor)
// ---------------------------------------------------------------------------

/** Ein Term des Entwurfs: der gewählte Quell-Wert, sein Vorzeichen und Faktor. */
export interface TermEntwurf {
  quelle: Quellwert;
  vorzeichen: '+' | '-';
  faktor: number;
  /**
   * AP-08-Haken: ein richtungsloser Kanal (der Gen-Port ohne Katalog-Richtung) zählt mit
   * gesetztem Haken als Erzeugung. Nur bei `hakenAnwendbar(quelle)` sinnvoll; sonst ignoriert.
   */
  giltAlsErzeugung?: boolean;
}

/** Ein frischer Term aus einem gewählten Quell-Wert — Vorgabe „+" und Faktor 1. */
export function termAus(quelle: Quellwert): TermEntwurf {
  return { quelle, vorzeichen: '+', faktor: 1 };
}

/**
 * Darf am Quell-Wert `q` der Haken „gilt als Erzeugung" (AP-08) angeboten werden? NUR für einen
 * Kanal, der eine Vertrags-Größe trägt (summierbar), aber KEINE Katalog-Richtung (`richtung ==
 * null` — der Gen-Port). Der Normalfall (PV 1/2/3 mit Richtung `Erzeugung`) braucht ihn nie.
 */
export function hakenAnwendbar(q: Quellwert): boolean {
  return summierbar(q) && erzeugungsHakenErlaubt(q.richtung);
}

/** Der Entwurf des Assistenten — dieselben Angaben, jede darf noch fehlen. */
export interface Entwurf {
  /** Die vom Kunden zum Bearbeiten geöffnete Messstelle, oder null (neu). */
  id: string | null;
  name: string;
  terme: TermEntwurf[];
}

export function leererEntwurf(): Entwurf {
  return { id: null, name: '', terme: [] };
}

// ---------------------------------------------------------------------------
// Ableitung: Größe, Einheit, Live-Wert
// ---------------------------------------------------------------------------

/**
 * Ein Entwurfs-Term als Formel-Term (für die Größen-Ableitung des Zwillings). Die Richtung ist die
 * WIRKSAME Richtung: ein richtungsloser Kanal mit gesetztem AP-08-Haken zählt als Erzeugung
 * (`richtungMitErzeugungsHaken`), sonst die Katalog-Richtung des Quell-Werts.
 */
function alsFormelTerm(t: TermEntwurf): FormelTerm {
  const richtung = richtungMitErzeugungsHaken(t.quelle.richtung, t.giltAlsErzeugung ?? false);
  return {
    groesse: t.quelle.groesse ?? '',
    richtung: richtung ?? '',
    einheit: t.quelle.einheit ?? '',
    wertart: t.quelle.wertart ?? '',
    vorzeichen: t.vorzeichen,
  };
}

/**
 * Die abgeleitete Hauptgröße des Gesamtwerts (Größe · Richtung · Einheit · Wertart),
 * oder null, wenn noch kein Term steht oder die Größen gemischt sind. Reiner
 * Durchgriff auf den Zwilling `formelGroesse` — dieselbe Ableitung wie der Server.
 */
export function abgeleiteteGroesse(terme: TermEntwurf[]): Groesse | null {
  if (terme.length === 0) return null;
  return formelGroesse(terme.map(alsFormelTerm)).hauptgroesse;
}

/** Trägt die Auswahl gemischte Größen (Äpfel + Birnen)? Dann kein gültiger Gesamtwert. */
export function groessenGemischt(terme: TermEntwurf[]): boolean {
  if (terme.length === 0) return false;
  return formelGroesse(terme.map(alsFormelTerm)).fehler != null;
}

/** Die Anzeige-Einheit des Gesamtwerts (aus der abgeleiteten Größe), oder ''. */
export function zielEinheit(terme: TermEntwurf[]): string {
  return abgeleiteteGroesse(terme)?.einheit ?? '';
}

/**
 * Ist der Gesamtwert eine reine Erzeugungs-Leistung (Wirkleistung · Erzeugung)?
 * Genutzt für den Namensvorschlag „Gesamt-PV" (`nameVorschlag`).
 */
export function istPvErzeugung(terme: TermEntwurf[]): boolean {
  const g = abgeleiteteGroesse(terme);
  return g?.groesse === 'Wirkleistung' && g?.richtung === 'Erzeugung';
}

/** Das Ergebnis der Live-Vorschau — Zahl (oder null), Einheit und die Lücken. */
export interface Vorschau {
  wert: number | null;
  einheit: string;
  unvollstaendig: boolean;
  /** Die Namen der Terme, die gerade fehlen/veraltet sind — genannt, nie verschwiegen. */
  fehlende: string[];
}

/**
 * Die Live-Vorschau: die gewichtete Summe der zuletzt gemessenen Term-Werte auf
 * die Anzeige-Einheit. Fehlt EIN Wert, ist das Ergebnis `null` und `fehlende`
 * nennt die Terme (Ehrlichkeitsregel `gewichteteSumme`) — nie eine Teilsumme.
 */
export function vorschau(terme: TermEntwurf[]): Vorschau {
  const einheit = zielEinheit(terme);
  if (terme.length === 0) {
    return { wert: null, einheit, unvollstaendig: true, fehlende: [] };
  }
  const summanden: Summand[] = terme.map((t) => ({
    vorzeichen: t.vorzeichen,
    faktor: t.faktor,
    wert: t.quelle.wert,
    einheit: t.quelle.einheit ?? einheit,
  }));
  const urteil = gewichteteSumme(einheit, summanden);
  return {
    wert: urteil.wert,
    einheit,
    unvollstaendig: urteil.unvollstaendig,
    fehlende: urteil.fehlende.map((i) => terme[i].quelle.name),
  };
}

/**
 * Die Rechenzeile der Vorschau: „PV 1 5,2 + PV 2 4,1 + … = 15,5". Ein fehlender
 * Term steht als „—" (nie als 0), damit die Lücke sichtbar bleibt.
 */
export function rechenzeile(terme: TermEntwurf[]): string {
  if (terme.length === 0) return '';
  const einheit = zielEinheit(terme);
  const teile = terme.map((t, i) => {
    const op = i === 0 ? (t.vorzeichen === '-' ? '− ' : '') : t.vorzeichen === '-' ? ' − ' : ' + ';
    const zahl = t.quelle.wert == null
      ? '—'
      : fmtNum(normiere(t.quelle.wert, t.quelle.einheit ?? einheit, einheit), '', stellen(t.quelle.wert));
    const faktor = t.faktor !== 1 ? `${fmtNum(t.faktor, '', 2)} · ` : '';
    return `${op}${t.quelle.name} ${faktor}${zahl}`;
  });
  const v = vorschau(terme);
  const summe = v.wert == null ? 'unvollständig' : fmtNum(v.wert, '', stellen(v.wert));
  return `${teile.join('')} = ${summe}`;
}

/** Nachkommastellen wie bei der Kachel: grosse Zahlen ohne, kleine mit zwei. */
export function stellen(wert: number): number {
  const a = Math.abs(wert);
  return a >= 100 ? 0 : a >= 10 ? 1 : 2;
}

/** Die Zahl eines Werts mit Einheit — `null` bleibt ein Strich, nie eine erfundene 0. */
export function wertText(wert: number | null | undefined, einheit: string): string {
  if (wert == null || !Number.isFinite(wert)) return '—';
  return fmtNum(wert, einheit, stellen(wert));
}

// ---------------------------------------------------------------------------
// Name-Vorschlag
// ---------------------------------------------------------------------------

/**
 * Der Name-VORSCHLAG (nie erzwungen). Eine reine Erzeugungs-Leistung heisst
 * „Gesamt-PV"; sonst wird aus den ersten Termen ein sprechender Name gebildet.
 * Er wird vorgeschlagen, solange der Kunde den Namen nicht selbst angefasst hat.
 */
export function nameVorschlag(terme: TermEntwurf[]): string {
  if (terme.length === 0) return '';
  if (istPvErzeugung(terme)) return 'Gesamt-PV';
  const namen = terme.map((t) => t.quelle.name);
  const roh = `${GESAMTWERT}: ${namen.slice(0, 3).join(' + ')}${namen.length > 3 ? ' …' : ''}`;
  return roh.length <= MAX_NAME ? roh : roh.slice(0, MAX_NAME).trimEnd();
}

// ---------------------------------------------------------------------------
// Validierung + Fehler-Sätze (genau die Prüfungen, die der Server auch fährt)
// ---------------------------------------------------------------------------

/**
 * Ist der Entwurf speicherbar — und wenn nicht, warum? Genau die Prüfungen des
 * Servers, damit der Assistent keinen „Speichern"-Weg anbietet, der scheitert.
 */
export function entwurfFehler(entwurf: Entwurf): string | null {
  if (entwurf.terme.length === 0) return 'Wählen Sie mindestens einen Wert, der mitgezählt wird.';
  if (entwurf.terme.length > MAX_TERME) {
    return `Ein ${GESAMTWERT} fasst höchstens ${MAX_TERME} Werte zusammen.`;
  }
  if (groessenGemischt(entwurf.terme)) {
    return 'Diese Werte haben unterschiedliche Messgrößen und lassen sich nicht zusammenzählen.';
  }
  if (entwurf.terme.some((t) => t.faktor === 0)) {
    return 'Ein Faktor darf nicht 0 sein — sonst zählt der Wert gar nicht mit.';
  }
  if (!entwurf.name.trim()) return `Geben Sie Ihrem ${GESAMTWERT} einen Namen.`;
  if (entwurf.name.trim().length > MAX_NAME) return `Der Name ist länger als ${MAX_NAME} Zeichen.`;
  return null;
}

/** Darf der Assistent von Schritt 1 weiter? (mindestens ein Wert, Größen passen zusammen) */
export function schritt1Fertig(terme: TermEntwurf[]): boolean {
  return terme.length > 0 && !groessenGemischt(terme);
}

/**
 * Die richtungslosen Terme (Gen-Port ohne Katalog-Richtung), denen die AP-08-Entscheidung
 * „gilt als Erzeugung" noch fehlt. Ein solcher Term ist NICHT speicherbar: der Server leitet
 * für einen richtungslosen Kanal ohne diesen Haken keine Vertrags-Messgröße ab und lehnt den
 * Term mit 400 ab (`MessstelleFormelService.kanalGroesse` → null). Wer diese Liste vor dem
 * Speichern prüft, sperrt client-seitig mit erklärtem Grund - der 400 wird nie provoziert.
 */
export function richtungsloseOhneEntscheidung(terme: TermEntwurf[]): TermEntwurf[] {
  return terme.filter((t) => hakenAnwendbar(t.quelle) && !(t.giltAlsErzeugung ?? false));
}

/** Der erklärte Grund, wenn ein richtungsloser Term noch keine Erzeugungs-Entscheidung trägt. */
export function richtungsEntscheidungSatz(namen: string[]): string {
  if (namen.length === 0) return '';
  const liste = namen.join(', ');
  return namen.length === 1
    ? `Für „${liste}" steht keine Richtung fest. Bitte entscheiden Sie zuerst, ob seine Leistung als Erzeugung mitzählt.`
    : `Für „${liste}" steht keine Richtung fest. Bitte entscheiden Sie zuerst, ob ihre Leistung als Erzeugung mitzählt.`;
}

// ---------------------------------------------------------------------------
// Die Server-Anfrage (POST /api/v1/messstellen/berechnet)
// ---------------------------------------------------------------------------

/** Ein Term, wie ihn die Anlege-Anfrage trägt (snake_case wie der Vertrag). */
export interface TermAnfrage {
  eingang_art: 'messkanal';
  entity_id: string;
  point_key: string;
  vorzeichen: '+' | '-';
  faktor: number;
  /** AP-08: nur gesetzt für einen richtungslosen Kanal, der als Erzeugung zählen soll. */
  gilt_als_erzeugung?: boolean;
}

/** Der Körper von `POST /api/v1/messstellen/berechnet`. */
export interface AnlegenAnfrage {
  name: string;
  terme: TermAnfrage[];
}

/** Der Entwurf als Anlege-Anfrage — die Hauptgröße leitet der Server selbst ab. */
export function alsAnfrage(entwurf: Entwurf): AnlegenAnfrage {
  return {
    name: entwurf.name.trim(),
    terme: entwurf.terme.map((t) => ({
      eingang_art: 'messkanal' as const,
      entity_id: t.quelle.entityId,
      point_key: t.quelle.channel,
      vorzeichen: t.vorzeichen,
      faktor: t.faktor,
      // Nur senden, wenn wirklich gesetzt UND anwendbar (richtungsloser Kanal) — additiv,
      // sonst lässt der Server das Feld weg (fehlend = false).
      ...(t.giltAlsErzeugung && hakenAnwendbar(t.quelle) ? { gilt_als_erzeugung: true } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Der kleine Tages-Verlauf der Vorschau (client-seitig, ehrlich)
// ---------------------------------------------------------------------------

/** Ein Zeitraster-Punkt eines Kanals: Beginn + der (ggf. fehlende) Wert. */
export interface KanalPunkt {
  start: string;
  wert: number | null;
}

/** Ein Punkt des Gesamtwert-Verlaufs: Beginn + Summe (oder null = unvollständig). */
export interface VerlaufPunkt {
  start: string;
  wert: number | null;
}

/**
 * Der Tages-Verlauf des Gesamtwerts, client-seitig aus den Kanal-Verläufen der
 * Terme summiert — dieselbe Regel wie der Server (`GET …/verlauf`): je
 * Zeitraster wird summiert, WENN alle Terme darin einen Wert haben, sonst
 * `null` (nie eine stille Teilsumme). Ausgerichtet über den Zeitraster-Beginn.
 */
export function tagesverlauf(
  terme: TermEntwurf[],
  reihen: Map<string, KanalPunkt[]>,
): VerlaufPunkt[] {
  if (terme.length === 0) return [];
  const einheit = zielEinheit(terme);
  // Die gemeinsamen Zeitraster-Beginn-Zeitpunkte (Schnittmenge über alle Terme):
  // fehlt ein Term in einem Raster ganz, ist die Summe dort ohnehin unvollständig.
  const ersteReihe = reihen.get(schluessel(terme[0].quelle)) ?? [];
  return ersteReihe.map((p) => {
    let summe = 0;
    let vollstaendig = true;
    for (const t of terme) {
      const reihe = reihen.get(schluessel(t.quelle)) ?? [];
      const punktHier = reihe.find((r) => r.start === p.start);
      if (!punktHier || punktHier.wert == null) {
        vollstaendig = false;
        break;
      }
      const w = normiere(punktHier.wert, t.quelle.einheit ?? einheit, einheit);
      summe += (t.vorzeichen === '-' ? -1 : 1) * t.faktor * w;
    }
    return { start: p.start, wert: vollstaendig ? runde(summe) : null };
  });
}

/** Der Reihen-Schlüssel eines Quell-Werts (Komponente + Kanal). */
export function schluessel(q: { entityId: string; channel: string }): string {
  return `${q.entityId}::${q.channel}`;
}

function runde(wert: number): number {
  return Math.round(wert * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Sätze der Fläche
// ---------------------------------------------------------------------------

/** Der Einleitungssatz von Schritt 1. */
export const SCHRITT1_FRAGE = 'Welche Werte gehören zusammen?';
export const SCHRITT1_SUB = 'Wählen Sie die Messwerte, die zusammengezählt werden sollen.';

/** Der Satz, wenn die Anlage (noch) keine summierbaren Werte meldet. */
export const KEINE_WERTE =
  'Ihre Anlage meldet noch keine Messwerte, die sich zusammenzählen lassen. Sobald ein Gerät liefert, können Sie hier einen Gesamtwert anlegen.';

/** Der Satz über der Vorschau, wenn ein Term gerade fehlt. */
export function unvollstaendigSatz(fehlende: string[]): string {
  if (fehlende.length === 0) return '';
  const liste = fehlende.join(', ');
  return fehlende.length === 1
    ? `Gerade unvollständig: „${liste}" liefert keinen aktuellen Wert. Der Gesamtwert bleibt so lange leer, statt eine zu kleine Summe zu zeigen.`
    : `Gerade unvollständig: „${liste}" liefern keinen aktuellen Wert. Der Gesamtwert bleibt so lange leer, statt eine zu kleine Summe zu zeigen.`;
}
