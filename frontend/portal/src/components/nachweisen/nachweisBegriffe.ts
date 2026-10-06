/**
 * Die Erklär-Blätter von Nachweisen (Konzept Nachweisen n1, Runde 2, §7 und Entscheid 24): die Begriffe, die der
 * Überblick und das Verzeichnis hinter ihrem i-Knopf erklären. Klartext, Abgrenzung und das Normwort stehen hier; „Bei
 * Ihnen:“ bildet die Fläche aus den eigenen Daten (ohne Daten entfällt die Zeile - nie ein erfundenes Beispiel).
 *
 * ⚠ Das Normwort steht nur im Feld `fachwort` und zuletzt im Blatt (Entscheid 18). Die weiteren Begriffe (Fassung,
 * Freigabe, Wirksamkeit …) bringen die Nachweisen-PRs zu ihren Flächen mit.
 */
import type { EnergiemanagementVerzeichnis } from '../../api';
import type { NachweisStand } from '../../nachweisStand';
import { standTag } from '../../wiedervorlage';
import type { Erklaerung } from './erklaerung';

export const NACHWEIS: Erklaerung = {
  frage: 'Was ist ein Nachweis?',
  klartext: 'Ein festgehaltener Beleg: wer was wann entschieden hat - und wo das Original liegt.',
  nichtVerwechseln: 'kein Urteil. Ob es genügt, beurteilt, wer Sie prüft.',
  fachwort: 'dokumentierte Information',
};

export const TEIL: Erklaerung = {
  frage: 'Was ist ein Teil?',
  klartext: 'Ein Thema, zu dem ein Energiemanagement etwas festhält.',
  nichtVerwechseln: 'keine Checkliste zum Abhaken; ein festgehaltener Teil ist kein „erfüllt“.',
  fachwort: 'Abschnitte der Norm',
};

export const VERZEICHNIS: Erklaerung = {
  frage: 'Was ist das Verzeichnis?',
  klartext: 'Die Liste aller festgehaltenen Einträge, neueste zuerst.',
  nichtVerwechseln: 'keine Ablage: die Originale liegen bei Ihnen.',
};

export const TRIFFT_NICHT_ZU: Erklaerung = {
  frage: 'Was heißt „trifft zurzeit nicht zu“?',
  klartext: 'Sie halten fest, dass ein Teil bei Ihnen gerade keine Rolle spielt - mit Grund und der Person, die es entschieden hat.',
  nichtVerwechseln: 'kein Urteil von VoltPilot. Trifft es wieder zu, heben Sie den Vermerk auf.',
};

/** Die Arten des Verzeichnisses, die eine Fassung eines Dokuments sind. */
const DOKUMENT_ARTEN = new Set([
  'energiepolitik', 'anwendungsbereich', 'kontext', 'rechtliche_anforderungen', 'risiken_chancen', 'bestellung', 'verfahren',
  'betrieb', 'beschaffung', 'kommunikation', 'auslegung', 'kompetenz',
]);

/**
 * „Bei Ihnen:“ zum Nachweis: die jüngste Fassung der Energiepolitik, sonst die jüngste eines Dokuments - mit der Person,
 * die entschieden hat, und dem Tag. Ohne solche Zeile `null`.
 */
export function nachweisBeiIhnen(v: EnergiemanagementVerzeichnis): string | null {
  const fassungen = v.gruppen
    .flatMap((g) => g.zeilen)
    .filter((z) => DOKUMENT_ARTEN.has(z.art) && z.tag && z.entschieden_von)
    .sort((a, b) => (b.tag ?? '').localeCompare(a.tag ?? ''));
  const z = fassungen.find((x) => x.art === 'energiepolitik') ?? fassungen[0];
  if (!z?.tag || !z.entschieden_von) return null;
  return `${z.titel}, Fassung ${z.nr ?? 1} - entschieden von ${z.entschieden_von} am ${standTag(z.tag)}.`;
}

/** „Bei Ihnen:“ zum Teil: wie viele Teile es gibt und, bis zu vier, welche noch offen sind. */
export function teilBeiIhnen(s: NachweisStand): string {
  const offen = s.teile.filter((t) => t.zustand === 'offen').map((t) => t.kurz);
  const n = s.teile.length;
  if (offen.length === 0) return `${n} Teile; zu jedem ist etwas festgehalten.`;
  if (offen.length > 4) return `${n} Teile, zu ${offen.length} ist noch nichts festgehalten.`;
  const liste = offen.length === 1 ? offen[0] : `${offen.slice(0, -1).join(', ')} und ${offen[offen.length - 1]}`;
  return `${n} Teile, zu ${offen.length === 1 ? 'einem' : zahlWort(offen.length)} ist noch nichts festgehalten: ${liste}.`;
}

/** „Bei Ihnen:“ zum Verzeichnis: wie viele Einträge seit wann. */
export function verzeichnisBeiIhnen(v: EnergiemanagementVerzeichnis): string | null {
  const tage = v.gruppen.flatMap((g) => g.zeilen).map((z) => z.tag).filter((t): t is string => !!t).sort();
  if (tage.length === 0) return null;
  const n = v.gruppen.reduce((s, g) => s + g.zeilen.length, 0);
  return `${n} ${n === 1 ? 'Eintrag' : 'Einträge'} seit dem ${standTag(tage[0])}.`;
}

const ZAHL_WORT = ['null', 'einem', 'zwei', 'drei', 'vier'];
const zahlWort = (n: number) => ZAHL_WORT[n] ?? String(n);
