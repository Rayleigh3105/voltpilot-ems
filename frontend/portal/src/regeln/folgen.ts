/**
 * Die **FOLGEN-KARTE** — die Auswirkungsvorschau vor jeder Entscheidung
 * (Konzept `vp-steuerung-konzept-b3` §3.5, Leitprinzip Regel 2: *„Bei jeder
 * Entscheidung, die der Kunde trifft, bekommt er die Risiken mit."*).
 *
 * Sie ist EIN Muster für drei Anlässe (Regel aktivieren · Betriebsmodell
 * wechseln · Handeingriff) mit denselben fünf Blöcken:
 *
 *   1. **Das passiert**             — was die Anlage danach tut
 *   2. **Auswirkung auf den Fahrplan** — was VoltPilot dafür nicht mehr tut
 *   3. **Risiko**                   — der Vorrang-Hinweis (§3.6, Variante 1)
 *   4. **Das bleibt gleich**        — was KEINE Regel aushebelt
 *   5. **Ende / Rücknahme**         — der Weg zurück
 *
 * Gerendert wird sie im Haus-Muster `ConfirmDialog` (Drawer + Folgenliste) —
 * es entsteht KEIN zweiter Rückfrage-Dialog.
 *
 * ⚠ **DIE ZAHL WIRD NICHT ERFUNDEN.** In dieser Stufe trägt Block 2 bewusst
 * keinen Euro-Betrag: die belastbare Zahl bräuchte ein zweites, regelfreies
 * Solve (die Kundenroute des What-if, Konzept §3.8/Stufe 7). Bis dahin steht
 * dort wörtlich, dass es nicht abschätzbar ist, PLUS der Grund — nie eine
 * geschätzte Ersparnis. Das ist Leitprinzip Regel 2 im Wortlaut: „wo keine Zahl
 * belastbar ist, ehrlich ‚nicht abschätzbar' statt erfunden."
 *
 * ⚠ **Block 3 ist nach der beanspruchten Sache getrennt** — siehe
 * {@link VORRANG_FOLGEN}: „Ihre Regel geht vor" gilt heute für ein GERÄT, auf
 * dem SPEICHER gewinnt der Fahrplan. Ein pauschaler Satz wäre auf der Hälfte
 * der Regeln eine Zusage, die die Anlage nicht hält.
 *
 * PURE + unit-getestet (`folgen.test.ts`); die Fläche rendert nur.
 */
import type { EditorEntity, FlowDocument } from '../flows/model';
import { VORRANG_FOLGEN, type VorrangArt } from './satz';
import { beanspruchtSpeicher } from './zustand';

/** Ein Block der Karte: Überschrift + eine oder mehrere Zeilen. */
export interface FolgenBlock {
  key: 'passiert' | 'fahrplan' | 'risiko' | 'gleich' | 'ende';
  titel: string;
  zeilen: string[];
}

export interface FolgenKarte {
  titel: string;
  /** Der EINE Satz über der Liste („Das passiert"). */
  intro: string;
  bloecke: FolgenBlock[];
  /** Die Beschriftung des bestätigenden Knopfes. */
  bestaetigen: string;
}

export const BLOCK_TITEL: Record<FolgenBlock['key'], string> = {
  passiert: 'Das passiert',
  fahrplan: 'Auswirkung auf den Fahrplan',
  risiko: 'Risiko',
  gleich: 'Das bleibt gleich',
  ende: 'Ende / Rücknahme',
};

/**
 * Der ehrliche Platzhalter für Block 2, **mit seinem Grund**. Eine Zahl ohne
 * Grund wäre ein Rätsel; „nicht abschätzbar" ohne Grund wäre eine Ausrede.
 */
export const NICHT_ABSCHAETZBAR =
  'Nicht abschätzbar: Was Ihre Regel den Fahrplan kostet, rechnet VoltPilot '
  + 'noch nicht mit. Sobald es so weit ist, steht die Zahl hier — und in der '
  + 'Regel-Zeile, solange es passiert.';

/** Block 2, wenn gar kein Fahrplan vorliegt — dann gibt es nichts zu beeinflussen. */
export const KEIN_FAHRPLAN =
  'Nicht abschätzbar: Für diese Anlage liegt gerade kein Fahrplan vor.';

/** Block 4 — was KEINE Regel aushebelt (die Schutz-Zeile der Seite, in Kurzform). */
export const BLEIBT_GLEICH: string[] = [
  'Netzvorgaben Ihres Netzbetreibers (§ 14a) und die Einspeisegrenze.',
  'Der Geräteschutz Ihrer Anlage — Mindestpausen, Nennleistung, Ladestand-Grenzen.',
  'Ihre anderen Regeln und ihre Fristen.',
];

/** Block 5 für eine Regel — der Rückweg ist immer derselbe. */
export const RUECKNAHME_REGEL =
  'Sie können die Regel jederzeit wieder ausschalten; sie bleibt dabei gespeichert.';

/** Welche Sache eine Regel beansprucht — der Schlüssel für Block 3. */
export function vorrangArt(
  doc: FlowDocument | null,
  entities: EditorEntity[],
): VorrangArt {
  return beanspruchtSpeicher(doc, entities) ? 'speicher' : 'geraet';
}

export interface RegelFolgenInput {
  /** Der Name der Regel, wie er auf der Karte steht. */
  name: string;
  /** Der Klartext-Satz der Regel; null = außerhalb des Baukastens. */
  satz: string | null;
  /** Was sie beansprucht (Speicher oder Gerät). */
  art: VorrangArt;
  /**
   * Ob für diese Anlage überhaupt ein Fahrplan vorliegt. Ohne einen gibt es
   * nichts zu beeinflussen, und die Karte sagt genau das statt des allgemeinen
   * „noch nicht berechenbar".
   */
  hatFahrplan?: boolean;
}

/**
 * Die Folgen-Karte einer REGEL-Aktivierung. Sie steht IMMER vor „Aktivieren" —
 * auch dann, wenn wenig zu sagen ist: eine Entscheidung ohne Vorschau ist genau
 * das, was das Leitprinzip abschafft.
 */
export function regelFolgen(input: RegelFolgenInput): FolgenKarte {
  const was = input.satz
    ? input.satz
    : `Die Regel „${input.name}" wird aktiv und steuert ab sofort mit.`;
  return {
    titel: `„${input.name}" aktivieren`,
    intro: was,
    bloecke: [
      {
        key: 'passiert',
        titel: BLOCK_TITEL.passiert,
        zeilen: [
          'Die Regel läuft ab sofort auf Ihrem Gerät und greift, sobald ihre '
          + 'Bedingung erfüllt ist.',
        ],
      },
      {
        key: 'fahrplan',
        titel: BLOCK_TITEL.fahrplan,
        zeilen: [input.hatFahrplan === false ? KEIN_FAHRPLAN : NICHT_ABSCHAETZBAR],
      },
      {
        key: 'risiko',
        titel: BLOCK_TITEL.risiko,
        zeilen: [VORRANG_FOLGEN[input.art]],
      },
      { key: 'gleich', titel: BLOCK_TITEL.gleich, zeilen: [...BLEIBT_GLEICH] },
      { key: 'ende', titel: BLOCK_TITEL.ende, zeilen: [RUECKNAHME_REGEL] },
    ],
    bestaetigen: 'Regel aktivieren',
  };
}

/**
 * Die Karte als FLACHE Folgenliste für den Haus-`ConfirmDialog`: jede Zeile
 * trägt ihre Block-Überschrift vorangestellt, damit die fünf Blöcke auch in
 * einer schlichten Aufzählung unterscheidbar bleiben. Der erste Block ist der
 * `intro` des Dialogs und erscheint deshalb NICHT ein zweites Mal in der Liste.
 */
export function folgenZeilen(karte: FolgenKarte): string[] {
  return karte.bloecke
    .filter((b) => b.key !== 'passiert')
    .flatMap((b) => b.zeilen.map((z, i) => (i === 0 ? `${b.titel}: ${z}` : z)));
}
