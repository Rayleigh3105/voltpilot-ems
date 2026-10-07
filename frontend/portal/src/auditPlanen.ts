/**
 * „Audit planen“ als geführtes Blatt (Konzept Nachweisen n1 Runde 2, §6.10, Mocks AU1/AU2): die Vorschläge des Blatts.
 * Nichts davon entscheidet - die Frist kommt von der Route (IA4), was vorbelegt ist, ändert die Person im Schritt
 * „Prüfen“, und die Route prüft den ganzen Körper (IA1).
 */
import type { InternesAuditprogramm } from './api';
import { tagText } from './energiemanagementPortal';

export type UnabhaengigWahl = 'team' | 'aussen' | 'eigen';

/** Tag + n Monate, Monatsende geklemmt (wie die Route rechnet). */
function plusMonate(iso: string, n: number): string {
  const gesamt = Number(iso.slice(5, 7)) - 1 + n;
  const jahr = Number(iso.slice(0, 4)) + Math.floor(gesamt / 12);
  const monat = ((gesamt % 12) + 12) % 12;
  const letzter = new Date(Date.UTC(jahr, monat + 1, 0)).getUTCDate();
  return new Date(Date.UTC(jahr, monat, Math.min(Number(iso.slice(8, 10)), letzter))).toISOString().slice(0, 10);
}

/**
 * Was das Blatt vorschlägt: den Titel „Internes Audit {Jahr}“, den spätesten Tag (die Frist der Route), als Termin die
 * Frist selbst, solange sie noch kommt, und „woran“ des letzten Audits - geprüft wird meist an denselben Vorgaben.
 */
export function planVorschlag(p: InternesAuditprogramm): { titel: string; termin: string | null; spaetestens: string | null; woran: string } {
  const frist = p.naechstes.faellig_am;
  const kommt = !!frist && frist >= p.tag;
  const letztes = [...p.audits].filter((a) => a.zustand !== 'abgesagt').sort((a, b) => b.termin.localeCompare(a.termin))[0];
  return {
    titel: `Internes Audit ${(kommt ? frist! : p.tag).slice(0, 4)}`,
    termin: kommt ? frist : null,
    spaetestens: kommt ? frist : null,
    woran: letztes?.woran ?? '',
  };
}

/** Die Chips unter „Wann?“: die Frist, einen Monat davor (wenn der noch kommt), „Anderer Tag“; ohne kommende Frist keine. */
export function wannOptionen(p: InternesAuditprogramm): { wert: string; label: string; tag: string | null }[] {
  const frist = p.naechstes.faellig_am;
  if (!frist || frist < p.tag) return [];
  const vorher = plusMonate(frist, -1);
  return [
    ...(vorher >= p.tag ? [{ wert: 'vorher', label: tagText(vorher), tag: vorher }] : []),
    { wert: 'frist', label: tagText(frist), tag: frist },
    { wert: 'anders', label: 'Anderer Tag', tag: null },
  ];
}

/** Die Antwort-Karte als Wortlaut der Unabhängigkeit - in den Worten des Kunden, mit den Namen der Prüfenden. */
export function unabhaengigSatz(wahl: UnabhaengigWahl, namen: string[], eigen: string): string {
  const wer = namen.length ? namen.join(' und ') : '';
  if (wahl === 'eigen') return eigen.trim();
  if (!wer) return '';
  const mehr = namen.length > 1;
  if (wahl === 'team') return `${wer} ${mehr ? 'gehören' : 'gehört'} nicht zum Energieteam und ${mehr ? 'prüfen' : 'prüft'} keine eigene Arbeit.`;
  return `${wer} ${mehr ? 'prüfen' : 'prüft'} von außen.`;
}
