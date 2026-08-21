/**
 * Die REGELN des VpPicker - Filtern, Gruppieren, Tastatur-Arithmetik, Ansagen.
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab.
 * Damit ist jede Regel der Auswahl ohne DOM prüfbar - dasselbe Muster wie
 * `src/befehleFilter.ts`, `src/historieZeit.ts` und `src/komponentenAssistent.ts`.
 *
 * ⚠ Die TASTATUR ist hier ein Rechen-Gegenstand, kein Nebeneffekt. Der
 * Eigenbau darf dem nativen Select in nichts nachstehen (Konzept
 * `vp-picker-system`), und „nichts nachstehen" ist nur prüfbar, wenn die
 * Bewegung eine Funktion ist: `naechster`, `ersteAktive`, `tippSprung`.
 */
import { hervorheben, normalisiereSuche, passt, suchBegriffe, type TextTeil } from './suche';

/** Der Zustands-Punkt vor einer Zeile (z. B. die Gesundheit einer Anlage). */
export type VpPunkt = 'ok' | 'warn' | 'off' | 'info';

/** Eine Auswahl-Zeile. `value` ist, was der Aufrufer zurückbekommt. */
export interface VpOption {
  value: string;
  /** Die HAUPTZEILE - das, was der Mensch liest und wonach er sucht. */
  label: string;
  /** Die NEBENZEILE (Ort, „30 kW · Hybrid", eine Kennung). Optional. */
  sub?: string | null;
  /** Der Gruppen-Schlüssel (z. B. die Marke). Ohne ihn steht die Zeile oben. */
  group?: string | null;
  /** Ein Zustands-Punkt vor der Zeile. */
  dot?: VpPunkt | null;
  /** Wählbar? Eine gesperrte Zeile bleibt SICHTBAR und nennt ihren Grund. */
  disabled?: boolean;
  /** ⚠ Der Grund der Sperre - eine Sperre ohne Grund ist ein Rätsel. */
  disabledHint?: string | null;
  /**
   * Zusätzlich DURCHSUCHTER Text, der nicht angezeigt wird (Modell-Code,
   * Familie, Kennung). Er macht die Suche tolerant, ohne die Zeile zu füllen.
   */
  keywords?: string | null;
}

/** Eine Gruppen-Überschrift (Reihenfolge + Beschriftung gibt der Aufrufer). */
export interface VpGruppe {
  key: string;
  label: string;
}

/** Eine gefundene Zeile samt hervorgehobenen Fundstellen. */
export interface VpTreffer {
  option: VpOption;
  label: TextTeil[];
  sub: TextTeil[] | null;
}

/** Ein Eintrag der gerenderten Liste: Überschrift ODER Zeile. */
export type VpZeile =
  | { art: 'gruppe'; key: string; label: string }
  | { art: 'option'; key: string; treffer: VpTreffer };

/**
 * Ab wie vielen Zeilen die Suche von selbst erscheint.
 *
 * Darunter ist sie Ballast: sieben Zeilen liest man schneller, als man tippt -
 * und ein leeres Suchfeld über drei Einträgen sieht aus, als fehlte etwas.
 */
export const SUCHE_AB = 8;

export type SuchModus = 'auto' | 'immer' | 'nie';

export function sucheSichtbar(anzahl: number, modus: SuchModus = 'auto'): boolean {
  if (modus === 'immer') return true;
  if (modus === 'nie') return false;
  return anzahl >= SUCHE_AB;
}

/** Was durchsucht wird: Hauptzeile, Nebenzeile, Gruppe und die Stichwörter. */
function heuhaufen(o: VpOption, gruppenLabel: string | null): string {
  return normalisiereSuche(
    [o.label, o.sub ?? '', gruppenLabel ?? o.group ?? '', o.keywords ?? ''].join(' '),
  );
}

/**
 * Der Rang eines Treffers: was mit der Eingabe BEGINNT, steht oben.
 *
 * Dieselbe Ordnung wie die Modell-Suche - wer tippt, meint fast immer den
 * Namen und nicht eine Nebenangabe, und ein Präfix schlägt eine Fundstelle
 * mitten im Wort.
 */
function rang(o: VpOption, begriffe: string[]): number {
  const label = normalisiereSuche(o.label);
  if (begriffe.some((b) => label.startsWith(b))) return 0;
  if (begriffe.some((b) => label.includes(b))) return 1;
  const sub = normalisiereSuche(o.sub ?? '');
  if (sub !== '' && begriffe.some((b) => sub.includes(b))) return 2;
  return 3;
}

export interface VpSuche {
  /** Die Liste, wie sie gerendert wird (Überschriften eingemischt). */
  zeilen: VpZeile[];
  /** Wie viele ZEILEN (ohne Überschriften) übrig sind. */
  anzahl: number;
  /** Wie viele es INSGESAMT gibt. */
  gesamt: number;
  /** Der Satz, wenn nichts passt - nie ein stiller leerer Bereich. */
  leer: string | null;
}

/**
 * Filtern + Gruppieren in EINEM Durchgang.
 *
 * ⚠ Ohne Eingabe bleibt die REIHENFOLGE des Aufrufers unangetastet (nur die
 * Gruppen werden gebündelt). Eine Liste, die sich beim Öffnen umsortiert,
 * nimmt jedem seine Ortskenntnis.
 *
 * ⚠ Eine GESPERRTE Zeile wird mitgefiltert und mitgezeigt: sie ist die
 * Antwort auf „warum kann ich das nicht wählen?" und darf nicht verschwinden.
 */
export function suche(
  optionen: VpOption[],
  query: string,
  gruppen: VpGruppe[] = [],
  leerText?: (q: string) => string,
): VpSuche {
  const begriffe = suchBegriffe(query);
  const labelVon = new Map(gruppen.map((g) => [g.key, g.label]));
  const passend =
    begriffe.length === 0
      ? optionen
      : optionen.filter((o) => passt(heuhaufen(o, labelVon.get(o.group ?? '') ?? null), begriffe));

  if (passend.length === 0) {
    const q = query.trim();
    return {
      zeilen: [],
      anzahl: 0,
      gesamt: optionen.length,
      leer:
        leerText?.(q)
        ?? (q === ''
          ? 'Hier gibt es noch nichts zur Auswahl.'
          : `Nichts passt zu „${q}“. Oft reicht ein Teil des Namens.`),
    };
  }

  const sortiert =
    begriffe.length === 0
      ? passend
      : [...passend].sort((a, b) => {
          const d = rang(a, begriffe) - rang(b, begriffe);
          return d !== 0 ? d : a.label.localeCompare(b.label, 'de');
        });

  // Gruppen in der Reihenfolge des Aufrufers, danach alles Ungruppierte oben.
  const zeilen: VpZeile[] = [];
  const ohneGruppe = sortiert.filter((o) => !o.group);
  const alsZeile = (o: VpOption): VpZeile => ({
    art: 'option',
    key: o.value,
    treffer: {
      option: o,
      label: hervorheben(o.label, begriffe),
      sub: o.sub ? hervorheben(o.sub, begriffe) : null,
    },
  });
  ohneGruppe.forEach((o) => zeilen.push(alsZeile(o)));

  const reihenfolge = gruppen.length > 0
    ? gruppen.map((g) => g.key)
    // Ohne erklärte Reihenfolge: die des ersten Vorkommens - nie alphabetisch
    // umsortiert, siehe oben.
    : [...new Set(sortiert.map((o) => o.group).filter((g): g is string => !!g))];

  for (const key of reihenfolge) {
    const drin = sortiert.filter((o) => o.group === key);
    if (drin.length === 0) continue;
    zeilen.push({ art: 'gruppe', key, label: labelVon.get(key) ?? key });
    drin.forEach((o) => zeilen.push(alsZeile(o)));
  }

  return { zeilen, anzahl: sortiert.length, gesamt: optionen.length, leer: null };
}

/** Die Indizes der WÄHLBAREN Zeilen (ohne Überschriften, ohne Gesperrte). */
export function waehlbare(zeilen: VpZeile[]): number[] {
  const out: number[] = [];
  zeilen.forEach((z, i) => {
    if (z.art === 'option' && !z.treffer.option.disabled) out.push(i);
  });
  return out;
}

/**
 * Die Bewegung mit Pfeiltasten.
 *
 * ⚠ Sie LÄUFT NICHT UM - wie das native Select. Ein Umlauf am Listenende
 * wirkt auf einer langen Liste wie ein Sprung ins Nichts, und Home/End sind
 * der ausdrückliche Weg an die Ränder.
 */
export function naechster(zeilen: VpZeile[], von: number, schritt: number): number {
  const ziele = waehlbare(zeilen);
  if (ziele.length === 0) return -1;
  if (von < 0) return schritt > 0 ? ziele[0] : ziele[ziele.length - 1];
  const jetzt = ziele.indexOf(von);
  if (jetzt === -1) {
    // Der Anker steht auf einer Überschrift/Gesperrten: zur nächsten in der
    // Richtung, statt an den Anfang zu springen.
    const nach = ziele.find((i) => i > von);
    const vor = [...ziele].reverse().find((i) => i < von);
    if (schritt > 0) return nach ?? ziele[ziele.length - 1];
    return vor ?? ziele[0];
  }
  const ziel = Math.min(Math.max(jetzt + schritt, 0), ziele.length - 1);
  return ziele[ziel];
}

/** Die erste wählbare Zeile (oder die des Wertes, wenn er noch dabei ist). */
export function ersteAktive(zeilen: VpZeile[], wert: string | null): number {
  if (wert != null) {
    const i = zeilen.findIndex(
      (z) => z.art === 'option' && z.key === wert && !z.treffer.option.disabled,
    );
    if (i >= 0) return i;
  }
  const ziele = waehlbare(zeilen);
  return ziele.length > 0 ? ziele[0] : -1;
}

/**
 * Tippen-zum-Springen (ohne sichtbares Suchfeld, wie im nativen Select):
 * die nächste Zeile, deren Hauptzeile mit dem Puffer BEGINNT - ab der
 * aktuellen Position, danach von vorn.
 */
export function tippSprung(zeilen: VpZeile[], puffer: string, von: number): number {
  const p = normalisiereSuche(puffer);
  if (p === '') return -1;
  const ziele = waehlbare(zeilen);
  if (ziele.length === 0) return -1;
  const startIdx = Math.max(0, ziele.indexOf(von));
  for (let k = 1; k <= ziele.length; k += 1) {
    const i = ziele[(startIdx + k) % ziele.length];
    const z = zeilen[i];
    if (z.art === 'option' && normalisiereSuche(z.treffer.option.label).startsWith(p)) return i;
  }
  // Wiederholt getippter gleicher Buchstabe („aaa") bleibt auf der aktuellen
  // Zeile stehen, statt zu wandern - das tut das native Select auch.
  const z = zeilen[von];
  if (z && z.art === 'option' && normalisiereSuche(z.treffer.option.label).startsWith(p)) return von;
  return -1;
}

/** Wie lange ein Tipp-Puffer gilt, bevor er neu beginnt (ms). */
export const TIPP_PUFFER_MS = 900;

/**
 * Die Ansage für Vorlesesoftware - EIN Satz, nie eine Zahlenkolonne.
 *
 * ⚠ Sie behauptet nur, was gezählt wurde: ohne Suche wird die Trefferzahl gar
 * nicht genannt (die Liste steht ja vollständig da).
 */
export function ansage(s: VpSuche, query: string): string {
  if (s.leer) return s.leer;
  if (query.trim() === '') return '';
  return s.anzahl === 1 ? '1 Treffer' : `${s.anzahl} Treffer`;
}

/** Die Beschriftung des Auslösers: der gewählte Wert oder der Platzhalter. */
export function ausloeserText(
  optionen: VpOption[],
  wert: string | string[] | null,
  platzhalter: string,
): string {
  if (Array.isArray(wert)) {
    if (wert.length === 0) return platzhalter;
    const labels = wert
      .map((v) => optionen.find((o) => o.value === v)?.label)
      .filter((l): l is string => !!l);
    return labels.length > 0 ? labels.join(', ') : platzhalter;
  }
  if (wert == null || wert === '') return platzhalter;
  return optionen.find((o) => o.value === wert)?.label ?? platzhalter;
}

/** Mehrfachauswahl: den Wert umschalten (Reihenfolge der Wahl bleibt). */
export function umschalten(werte: string[], wert: string): string[] {
  return werte.includes(wert) ? werte.filter((w) => w !== wert) : [...werte, wert];
}
