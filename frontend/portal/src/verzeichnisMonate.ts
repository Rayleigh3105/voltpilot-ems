/**
 * Das Verzeichnis nach Monaten (Konzept Nachweisen n1, Runde 2, §6.9): die Einträge des Lesers `…/verzeichnis` als
 * Zeitleiste, neueste zuerst, je Zeile Datum, Titel und die Person, die entschieden hat. Das Thema (die Gruppe des
 * Vertrags) ist ein Filter statt der Gliederung. Gleichartiges derselben Person vom selben Tag wird eine Zeile
 * („Kennzahlen und Kriterien · 7 Einträge“); Prüfsumme, wer eingetragen hat und der Ort des Originals stehen im Eintrag.
 *
 * Reines Modul: kein React, kein Netz. Keine Zahl über das Ganze, kein Urteil (G4).
 */
import type { EnergiemanagementVerzeichnis, EnergiemanagementVerzeichnisZeile } from './api';

/** Die Arten, deren Zeilen eine Fassung eines Dokuments sind (Vertrag `dokument_art`). */
const DOKUMENT_ARTEN = new Set([
  'energiepolitik', 'anwendungsbereich', 'kontext', 'rechtliche_anforderungen', 'risiken_chancen', 'bestellung', 'verfahren',
  'betrieb', 'beschaffung', 'kommunikation', 'auslegung', 'kompetenz',
]);

/**
 * Arten, die am selben Tag oft zu mehreren entstehen: von derselben Person werden sie eine Zeile, mit ihrem Wort.
 * Entscheidungen mit eigenem Gewicht (Fassung eines Dokuments, Stand eines Berichts, Audit, Feststellung, Wirksamkeit,
 * Vermerk) bleiben einzeln.
 */
const BUENDEL_WORT: Readonly<Record<string, string>> = {
  kennzahl_fassung: 'Kennzahlen',
  kriterien_fassung: 'Kriterien',
  einstufung_fassung: 'Einstufungen',
  bezugsbasis_fassung: 'Bezugsbasen',
  messmittel_angabe: 'Messmittel',
  messbedarf: 'Messbedarfe',
  aufgabe: 'Aufgaben',
};

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export const OHNE_TAG = 'Ohne Tag';

export interface VerzeichnisEintrag {
  key: string;
  /** ISO-Tag; `null`, wo die Quelle keinen nennt. */
  tag: string | null;
  titel: string;
  /** Bei einem Bündel: „7 Einträge“. */
  unter: string | null;
  /** Wer entschieden hat, sonst wer eingetragen hat. */
  person: string | null;
  zeilen: EnergiemanagementVerzeichnisZeile[];
}

export interface VerzeichnisMonat {
  key: string;
  titel: string;
  eintraege: VerzeichnisEintrag[];
}

/** „30.04.“ - der Tag im Datumsblock; das Jahr steht im Monat darüber. */
export function tagBlock(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

/** „30.04.2029“ */
export function tagVoll(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

export const personDerZeile = (z: EnergiemanagementVerzeichnisZeile) => z.entschieden_von ?? z.eingetragen_von;

/**
 * Der Titel einer Zeile, wie ihn eine Person liest: der Name des Dokuments mit der Fassung erst ab Fassung 2 („Fassung 1“
 * bleibt still, §0.3 Regel 3), die Bekanntmachung als „Energiepolitik bekannt gemacht“, ein neuer Stand mit seiner Nummer.
 */
export function eintragTitel(z: EnergiemanagementVerzeichnisZeile): string {
  if (DOKUMENT_ARTEN.has(z.art)) return z.nr && z.nr > 1 ? `${z.titel}, Fassung ${z.nr}` : z.titel;
  if (z.art === 'bekanntmachung') {
    const m = /^(.*?): bekannt gemacht/u.exec(z.titel);
    return m ? `${m[1]} bekannt gemacht` : z.titel;
  }
  if (z.art === 'berichtsstand' && z.nr && z.nr > 1) return `${z.titel}, Stand ${z.nr}`;
  return z.titel;
}

const namenListe = (w: string[]) => (w.length <= 1 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} und ${w[w.length - 1]}`);
const eintraegeWort = (n: number) => (n === 1 ? '1 Eintrag' : `${n} Einträge`);

/** Passt eine Zeile zur Suche? Titel, Kennzeichen, Thema und Personen, ohne Groß und klein. */
function passt(z: EnergiemanagementVerzeichnisZeile, suche: string): boolean {
  if (!suche) return true;
  const s = suche.toLocaleLowerCase('de-DE');
  return [z.titel, eintragTitel(z), z.kennzeichen, z.gruppe_wort, z.entschieden_von ?? '', z.eingetragen_von ?? '']
    .some((t) => t.toLocaleLowerCase('de-DE').includes(s));
}

/** Alle Zeilen des Verzeichnisses (über die Gruppen), die zur Suche passen. */
export function verzeichnisZeilen(v: EnergiemanagementVerzeichnis, suche = ''): EnergiemanagementVerzeichnisZeile[] {
  return v.gruppen.flatMap((g) => g.zeilen).filter((z) => passt(z, suche.trim()));
}

/**
 * Die Monate, neueste zuerst; im Monat die Einträge neueste zuerst (am selben Tag in der Reihenfolge der Route), Zeilen
 * ohne Tag am Ende. Bündel: dieselbe Person am selben Tag, Arten aus `BUENDEL_WORT`, ab zwei Zeilen.
 */
export function verzeichnisMonate(v: EnergiemanagementVerzeichnis, suche = ''): VerzeichnisMonat[] {
  const zeilen = verzeichnisZeilen(v, suche)
    .map((z, i) => ({ z, i }))
    .sort((a, b) => (b.z.tag ?? '').localeCompare(a.z.tag ?? '') || a.i - b.i)
    .map((x) => x.z);
  const eintraege: VerzeichnisEintrag[] = [];
  const buendel = new Map<string, VerzeichnisEintrag>();
  for (const z of zeilen) {
    const person = personDerZeile(z);
    const art = BUENDEL_WORT[z.art] ? 'buendel' : null;
    const key = art && z.tag ? `${z.tag}/${person ?? ''}` : null;
    const offen = key ? buendel.get(key) : undefined;
    if (offen) {
      offen.zeilen.push(z);
      continue;
    }
    const e: VerzeichnisEintrag = { key: `${z.gruppe}/${z.art}/${z.kennzeichen}/${z.nr ?? ''}/${z.tag ?? ''}/${eintraege.length}`, tag: z.tag, titel: eintragTitel(z), unter: null, person, zeilen: [z] };
    eintraege.push(e);
    if (key) buendel.set(key, e);
  }
  for (const e of eintraege) {
    if (e.zeilen.length < 2) continue;
    e.titel = namenListe([...new Set(e.zeilen.map((z) => BUENDEL_WORT[z.art]))]);
    e.unter = eintraegeWort(e.zeilen.length);
  }
  const monate: VerzeichnisMonat[] = [];
  for (const e of eintraege) {
    const key = e.tag ? e.tag.slice(0, 7) : 'ohne';
    const titel = e.tag ? `${MONATE[Number(e.tag.slice(5, 7)) - 1]} ${e.tag.slice(0, 4)}` : OHNE_TAG;
    const m = monate.find((x) => x.key === key);
    if (m) m.eintraege.push(e);
    else monate.push({ key, titel, eintraege: [e] });
  }
  return monate;
}

/** Wie viele Einträge das Verzeichnis zeigt: „77 Einträge“ (eine Zahl der Zeilen, kein Urteil). */
export function eintraegeZahl(v: EnergiemanagementVerzeichnis): string {
  return eintraegeWort(v.gruppen.reduce((n, g) => n + g.zeilen.length, 0));
}
