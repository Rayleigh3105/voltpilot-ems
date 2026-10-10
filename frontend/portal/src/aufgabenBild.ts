/**
 * Nachweisen, Konzept n1 Runde 2 (§6.8, Entscheid 23, PR 5): das reine Bild des Reiters „Aufgaben“ - je Aufgabe eine
 * Zeile mit Kurzwort und Kürzeln, Name, Vertretung, seit wann und Beschluss im Blatt der Aufgabe; die Personen mit der
 * Zahl ihrer Aufgaben. Wer eine Aufgabe hat, sagt die Route am Tag (PA2); hier stehen nur Wörter und Reihenfolge.
 */
import type { EnergiemanagementAufgaben, EnergiemanagementPerson, EnergiemanagementPersonKurz, EnergiemanagementZuordnung } from './api';
import type { Erklaerung } from './components/nachweisen/erklaerung';
import { WOERTER } from './energiemanagement';
import { kuenftige, tagText } from './energiemanagementPortal';

export const KURZZEILE = 'Wer macht was';
export const PERSONEN = 'Personen';

/** Das Kurzwort einer Aufgabe (Vertrag 1.4, `woerter.aufgabe_kurz`); eine „weitere Aufgabe“ heißt wie ihr Wortlaut. */
export function aufgabeKurz(aufgabe: string, wortlaut?: string | null): string {
  if (aufgabe === 'weitere' && wortlaut) return wortlaut;
  return WOERTER.aufgabe_kurz[aufgabe] ?? WOERTER.aufgabe[aufgabe] ?? aufgabe;
}

export type AufgabeZeile = {
  aufgabe: string;
  kurz: string;
  wort: string;
  /** Die Personen der laufenden Zuordnungen am Tag, in ihrer Reihenfolge. */
  personen: EnergiemanagementPersonKurz[];
  laufend: EnergiemanagementZuordnung[];
  spaeter: EnergiemanagementZuordnung[];
  /** Der Satz der Route, wenn niemand die Aufgabe hat („… - keine Person festgelegt.“). */
  ohnePerson: string | null;
};

/**
 * Die Zeilen des Reiters in der Reihenfolge des Vokabulars; „weitere“ nur, wenn eine läuft oder kommt. Eine Aufgabe ohne
 * Person bleibt sichtbar (ihr Satz kommt von der Route) - fehlend ist keine Null.
 */
export function aufgabenZeilen(stand: EnergiemanagementAufgaben): AufgabeZeile[] {
  return stand.aufgaben
    .filter((a) => a.aufgabe !== 'weitere' || a.laufend.length > 0 || kuenftige(stand.zuordnungen, a.aufgabe, stand.tag).length > 0)
    .map((a) => ({
      aufgabe: a.aufgabe,
      kurz: aufgabeKurz(a.aufgabe, a.laufend[0]?.aufgabe_wortlaut),
      wort: a.wort,
      personen: a.laufend.map((z) => z.person),
      laufend: a.laufend,
      spaeter: kuenftige(stand.zuordnungen, a.aufgabe, stand.tag),
      ohnePerson: a.satz,
    }));
}

/**
 * Wer nicht unternehmensweit liest, bekommt von der Route keine Aufgabe (ohne Hinweis, ohne Anzahl) - das Vokabular hat
 * aber immer welche. Leer heißt deshalb „nicht sichtbar“, nie „alle besetzt“ (Review P5-1).
 */
export const AUFGABEN_NICHT_SICHTBAR = 'Die Aufgaben sieht, wer das ganze Unternehmen sieht.';

/**
 * Die Status-Zeile: „● jede Aufgabe hat eine Person“ - oder wie viele keine haben (offen, kein Warnton: keine Frist).
 * Ohne Zeilen keine Antwort (`null`): eine leere Liste ist nie „jede Aufgabe hat eine Person“.
 */
export function aufgabenStatus(zeilen: readonly Pick<AufgabeZeile, 'ohnePerson'>[]): { zeichen: 'festgehalten' | 'offen'; text: string } | null {
  if (!zeilen.length) return null;
  const ohne = zeilen.filter((z) => z.ohnePerson).length;
  if (!ohne) return { zeichen: 'festgehalten', text: 'jede Aufgabe hat eine Person' };
  return { zeichen: 'offen', text: ohne === 1 ? '1 Aufgabe ohne Person' : `${ohne} Aufgaben ohne Person` };
}

/** Am Rechner neben den Kürzeln: der Name - bei mehreren „3 Personen“ (Desktop-Mock r2d-T1). */
export const personenWort = (personen: readonly EnergiemanagementPersonKurz[]) =>
  personen.length === 1 ? personen[0].name : personen.length > 1 ? `${personen.length} Personen` : '';

/** „seit 01.03.2029“ oder „ab 01.05.2029“ - wann eine Zuordnung am Tag gilt. */
export const seitWort = (z: Pick<EnergiemanagementZuordnung, 'gilt_ab' | 'gilt_bis'>, tag: string) =>
  `${z.gilt_ab > tag ? 'ab' : 'seit'} ${tagText(z.gilt_ab)}${z.gilt_bis ? ` bis ${tagText(z.gilt_bis)}` : ''}`;

export type PersonZeile = { person: EnergiemanagementPerson; aufgaben: number; vertretungen: number };

/**
 * Die Personen mit der Zahl ihrer laufenden Aufgaben am Tag (als Person) und ihrer Vertretungen: wer Aufgaben hat zuerst,
 * dann wer nur vertritt, dann die übrigen aktiven, beendete zuletzt (Desktop-Mock r2d-T1); sonst die Folge der Route.
 */
export function personenZeilen(personen: readonly EnergiemanagementPerson[], stand: Pick<EnergiemanagementAufgaben, 'aufgaben'>): PersonZeile[] {
  const laufend = stand.aufgaben.flatMap((a) => a.laufend);
  return personen
    .map((p) => ({
      person: p,
      aufgaben: laufend.filter((z) => z.person.id === p.id).length,
      vertretungen: laufend.filter((z) => z.vertretung?.id === p.id).length,
    }))
    .sort((a, b) => rang(a) - rang(b));
}

function rang(z: PersonZeile): number {
  if (z.person.zustand !== 'aktiv') return 3;
  return z.aufgaben ? 0 : z.vertretungen ? 1 : 2;
}

/** Rechts in der Zeile einer Person: „7 Aufgaben“, „1 Aufgabe“, nur Vertretung „Vertretung“, sonst nichts. */
export function personFakt(z: Pick<PersonZeile, 'aufgaben' | 'vertretungen' | 'person'>): string {
  if (z.person.zustand !== 'aktiv') return 'beendet';
  if (z.aufgaben) return z.aufgaben === 1 ? '1 Aufgabe' : `${z.aufgaben} Aufgaben`;
  return z.vertretungen ? 'Vertretung' : '';
}

/** „Was ist eine Aufgabe im Energiemanagement?“ - das Beispiel aus den eigenen Daten: eine Aufgabe mit Vertretung. */
export function erklaerungAufgabe(zeilen: readonly AufgabeZeile[], tag: string): Erklaerung {
  const z = zeilen.flatMap((x) => x.laufend.map((l) => ({ x, l }))).find(({ l }) => l.vertretung);
  return {
    frage: 'Was ist eine Aufgabe im Energiemanagement?',
    klartext: 'Was eine Person im Energiemanagement übernimmt - mit Vertretung und Datum.',
    beiIhnen: z ? `${z.x.kurz}: ${z.l.person.name} ${seitWort(z.l, tag)}, Vertretung ${z.l.vertretung!.name}.` : null,
    nichtVerwechseln: 'Kein Recht im Portal.',
    fachwort: 'Rollen und Befugnisse',
  };
}
