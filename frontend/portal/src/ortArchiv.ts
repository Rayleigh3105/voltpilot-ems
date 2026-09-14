import type { ArchivSperrgrund, OrtAktionen, OrtLoeschGrund } from './api';
import { datumText, type Tag } from './uemsOrtsbaum';

/**
 * Archivieren, Wiederherstellen und Löschen im Ortsbaum (UEMS AP-02 IP-15, Z1–Z3, E1) — rein.
 *
 * Geurteilt wird NICHT hier: der Server legt je Knoten `aktionen` in `GET …/orte` (dieselben
 * Regeln und Sätze wie die Schreibrouten, `OrtAktionen.java`). Dieses Modul macht daraus das
 * Menü und die Folgenlisten in Kundensprache. Die Linie dahinter (Captain 13./14.09.2026):
 * informieren statt bevormunden — ein gesperrtes Archivieren bleibt als Eintrag stehen und
 * erklärt Grund und Weg (Z1), statt still zu verschwinden. Löschen mit Historie ist dagegen
 * KEIN Knopf, sondern ein Hinweis: dafür gibt es keinen Weg, nur die Auskunft (E1).
 */

export type ArchivObjektArt = 'standort' | 'gebaeude' | 'bereich';

/** Ein Eintrag im Menü eines Knotens. `knopf: false` ist ein Hinweis ohne Handlung. */
export type MenueEintrag =
  | { art: 'archivieren'; knopf: true; text: string }
  | { art: 'archivieren_gesperrt'; knopf: true; text: string; grund: string }
  | { art: 'wiederherstellen'; knopf: true; text: string }
  | { art: 'wiederherstellen_gesperrt'; knopf: false; text: string }
  | { art: 'loeschen'; knopf: true; text: string }
  | { art: 'loeschen_gesperrt'; knopf: false; text: string };

export const KNOPF_ARCHIVIEREN = 'Archivieren …';
export const KNOPF_ARCHIVIEREN_GESPERRT = 'Archivieren nicht möglich …';
export const KNOPF_WIEDERHERSTELLEN = 'Wiederherstellen …';
export const KNOPF_LOESCHEN = 'Löschen …';

/**
 * Das Menü eines Knotens aus seinen `aktionen`. Ohne `aktionen` (mit Stichtag) gibt es keins.
 * Wiederherstellen mit belegtem Namen öffnet trotzdem: umbenannt wird im selben Dialog (§4.2).
 */
export function menueEintraege(aktionen: OrtAktionen | null | undefined): MenueEintrag[] {
  if (!aktionen) return [];
  const out: MenueEintrag[] = [];
  const a = aktionen.archivieren;
  if (a) {
    out.push(
      a.erlaubt
        ? { art: 'archivieren', knopf: true, text: KNOPF_ARCHIVIEREN }
        : { art: 'archivieren_gesperrt', knopf: true, text: KNOPF_ARCHIVIEREN_GESPERRT, grund: sperreKurz(a.gruende) },
    );
  }
  const w = aktionen.wiederherstellen;
  if (w && (w.erlaubt || w.grund === 'name_belegt')) {
    out.push({ art: 'wiederherstellen', knopf: true, text: KNOPF_WIEDERHERSTELLEN });
  } else if (w?.grund === 'eltern_archiviert' && w.text) {
    out.push({ art: 'wiederherstellen_gesperrt', knopf: false, text: w.text });
  }
  const l = aktionen.loeschen;
  if (l) {
    out.push(
      l.erlaubt
        ? { art: 'loeschen', knopf: true, text: KNOPF_LOESCHEN }
        : { art: 'loeschen_gesperrt', knopf: false, text: l.text ?? loeschenHinweis(l.gruende) },
    );
  }
  return out;
}

/** „1 Messstelle ist hier aktiv“ — die Zeile unter „Archivieren nicht möglich …“ (A7). */
export function sperreKurz(gruende: ArchivSperrgrund[]): string {
  const teile: string[] = [];
  const messstellen = gruende.filter((g) => g.art === 'messstelle_aktiv').length;
  const anlagen = gruende.filter((g) => g.art === 'anlage_aktiv');
  const geplant = gruende.filter((g) => g.art === 'geplante_zuordnung').length;
  if (anlagen.length === 1) teile.push(`die Anlage ${anlagen[0].name} ist aktiv`);
  if (anlagen.length > 1) teile.push(`${anlagen.length} Anlagen sind aktiv`);
  if (messstellen === 1) teile.push('1 Messstelle ist hier aktiv');
  if (messstellen > 1) teile.push(`${messstellen} Messstellen sind hier aktiv`);
  if (geplant === 1) teile.push('eine Zuordnung ist geplant');
  if (geplant > 1) teile.push(`${geplant} Zuordnungen sind geplant`);
  const satz = aufzaehlung(teile);
  return satz ? satz.charAt(0).toUpperCase() + satz.slice(1) : 'Etwas steht im Weg';
}

/** Z1: je Sperrgrund, wer im Weg steht und was der Weg ist. */
export function wege(gruende: ArchivSperrgrund[]): { wer: string; weg: string }[] {
  return gruende.map((g) => {
    switch (g.art) {
      case 'messstelle_aktiv':
        return { wer: `${g.kennzeichen ?? ''} ${g.name}`.trim(), weg: 'Messstelle umziehen oder stilllegen' };
      case 'anlage_aktiv':
        return { wer: `Anlage ${g.name}`, weg: 'einem anderen Standort zuordnen oder archivieren' };
      case 'geplante_zuordnung':
        return {
          wer: g.name,
          weg: g.ab ? `die geplante Zuordnung ab ${datumText(g.ab)} aufheben` : 'die geplante Zuordnung aufheben',
        };
      default:
        return { wer: g.name, weg: '' };
    }
  });
}

export interface Folge {
  titel: string;
  text: string;
}

/** Z2: die Folgenliste der Rückfrage „… archivieren?“. */
export function archivierenFolgen(
  art: ArchivObjektArt,
  a: NonNullable<OrtAktionen['archivieren']>,
): Folge[] {
  const letzter = a.letzterTag ?? '';
  const archivtag = naechsterTag(letzter);
  const folgen: Folge[] = [
    {
      titel: `${art === 'standort' ? 'Besteht bis' : 'Zuordnung endet am'} ${datumText(letzter)}`,
      text: 'Berichte bis dahin bleiben, wie sie sind.',
    },
    {
      titel: 'Bleibt sichtbar',
      text: `Ausgegraut mit „Archiviert am ${datumText(archivtag)}“; in „Stand am …“ vor dem ${datumText(archivtag)} wie bisher.`,
    },
  ];
  if (a.mitarchiviert.length > 0) {
    const liste = aufzaehlung(a.mitarchiviert.map((m) => `${m.name} (${m.kurzzeichen})`));
    folgen.push({
      titel: a.mitarchiviert.length === 1 ? 'Wird mitarchiviert' : 'Werden mitarchiviert',
      text: `${liste} — ohne aktive Messstelle.`,
    });
  }
  if (art === 'standort') {
    folgen.push({ titel: 'Anlagen und Messstellen bleiben, wie sie sind', text: 'Archiviert wird nur der Standort mit seinen leeren Gebäuden und Bereichen.' });
  }
  folgen.push({
    titel: 'Wiederherstellen jederzeit möglich',
    text: 'Es gilt dann ab dem Tag des Wiederherstellens; die Zeit dazwischen bleibt sichtbar.',
  });
  return folgen;
}

/** Z3: die Folgenliste des Dialogs „… wiederherstellen“. */
export function wiederherstellenFolgen(
  art: ArchivObjektArt,
  kurzzeichen: string,
  archiviertAm: Tag | null,
  ab: Tag,
): Folge[] {
  const folgen: Folge[] = [
    {
      titel: `Gilt wieder ab ${datumText(ab)}`,
      text: archiviertAm
        ? `Die Zeit vom ${datumText(archiviertAm)} bis dahin bleibt sichtbar — sie wird nie aufgefüllt.`
        : 'Die Zeit seit dem Archivieren bleibt sichtbar — sie wird nie aufgefüllt.',
    },
    { titel: `Kurzzeichen ${kurzzeichen} bleibt`, text: 'Alte Berichte und der Export finden es unverändert.' },
  ];
  if (art !== 'bereich') {
    folgen.push({
      titel: 'Mitarchiviertes bleibt archiviert',
      text: art === 'standort' ? 'Gebäude und Bereiche stellen Sie einzeln wieder her.' : 'Bereiche stellen Sie einzeln wieder her.',
    });
  }
  return folgen;
}

/** Die Rückfrage „… löschen?“ (E1): endgültig, das Kurzzeichen bleibt belegt, das Protokoll behält es. */
export function loeschenFolgen(art: 'gebaeude' | 'bereich', name: string, kurzzeichen: string, eltern: string | null): Folge[] {
  const wort = art === 'gebaeude' ? 'Gebäude' : 'Bereich';
  const folgen: Folge[] = [
    { titel: 'Endgültig', text: `An ${name} hing nie eine Messstelle, eine Fläche oder ein Bereich — nichts geht verloren.` },
    { titel: `Kurzzeichen ${kurzzeichen} wird nicht wieder vergeben`, text: 'Ein neuer Ort bekommt ein neues.' },
  ];
  if (eltern) folgen.push({ titel: 'Das Protokoll behält es', text: `Bei ${eltern} steht: „${wort} ${name} gelöscht“.` });
  return folgen;
}

/** „Archiviert am 30.06.2027“ — der Archivtag eines Knotens im Baum. */
export function archiviertAmText(tag: Tag): string {
  return `Archiviert am ${datumText(tag)}`;
}

/** Falls der Server keinen Satz mitgibt: die Historie in Worten. */
function loeschenHinweis(gruende: OrtLoeschGrund[]): string {
  const worte: Record<OrtLoeschGrund, string> = {
    hat_messstellen: 'Messstellen',
    hat_anlagen: 'Anlagen',
    hat_flaeche: 'Fläche',
    hat_kinder: 'Bereiche',
    hat_bezugsgroessen: 'Bezugsgrößen',
  };
  const liste = aufzaehlung(gruende.map((g) => worte[g]));
  return `Löschen geht nicht: hier gibt es Historie${liste ? ` (${liste})` : ''}. Alles andere wird archiviert.`;
}

function naechsterTag(tag: Tag): Tag {
  const [y, m, d] = tag.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function aufzaehlung(worte: string[]): string {
  if (worte.length <= 1) return worte.join('');
  return `${worte.slice(0, -1).join(', ')} und ${worte[worte.length - 1]}`;
}
