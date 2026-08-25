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
 * ⚠ **DIE ZAHL WIRD NICHT ERFUNDEN.** Seit Stufe 7 KANN Block 2 einen
 * Euro-Betrag tragen — aber nur den, den der SERVER aus zwei echten
 * Solver-Läufen über EINE Eingabe geliefert hat (`vorschau.vorschauSatz`).
 * Fehlt er, steht dort wörtlich, dass es nicht abschätzbar ist, PLUS der
 * Grund — nie eine geschätzte Ersparnis. Das ist Leitprinzip Regel 2 im
 * Wortlaut: „wo keine Zahl belastbar ist, ehrlich ‚nicht abschätzbar' statt
 * erfunden."
 *
 * ⚠ **Block 3 ist nach der beanspruchten Sache getrennt** — siehe
 * {@link VORRANG_FOLGEN}: „Ihre Regel geht vor" gilt heute für ein GERÄT, auf
 * dem SPEICHER gewinnt der Fahrplan. Ein pauschaler Satz wäre auf der Hälfte
 * der Regeln eine Zusage, die die Anlage nicht hält.
 *
 * PURE + unit-getestet (`folgen.test.ts`); die Fläche rendert nur.
 */
import type { EditorEntity, FlowDocument } from '../flows/model';
import { VORSCHAU_LAEUFT, vorrangMitZahl, vorschauSatz, type VorschauErgebnis }
  from '../vorschau';
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
  /**
   * Die SERVER-Vorschau (Stufe 7). Absent/null = die Karte bleibt bei ihrer
   * ehrlichen Stufe-2-Fassung — es entsteht dadurch KEINE geschätzte Zahl.
   */
  vorschau?: VorschauErgebnis | null;
  /**
   * Die Anfrage ist unterwegs. Sie schlägt `vorschau` NICHT — sie füllt nur
   * die Lücke, solange es noch keine gibt (siehe {@link VORSCHAU_LAEUFT}).
   */
  vorschauLaeuft?: boolean;
  /** Siehe `SatzOptionen.untergrenze` — der Knopf ist schwächer als die Tat. */
  vorschauUntergrenze?: boolean;
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
        // Stufe 7: der Server-Satz, wenn es einen gibt; sonst unverändert die
        // ehrliche Fassung mit ihrem Grund.
        zeilen: [vorschauSatz(input.vorschau ?? null, { untergrenze: input.vorschauUntergrenze })
          ?? (input.vorschauLaeuft ? VORSCHAU_LAEUFT : null)
          ?? (input.hatFahrplan === false ? KEIN_FAHRPLAN : NICHT_ABSCHAETZBAR)],
      },
      {
        key: 'risiko',
        titel: BLOCK_TITEL.risiko,
        // §3.6 / Captain-Entscheid S2: Variante 2 „sobald die Vorschau eine
        // Zahl hat", sonst Variante 1. Variante 2 IST Variante 1 mit der Zahl -
        // es gibt keinen dritten Wortlaut.
        zeilen: [vorrangMitZahl(VORRANG_FOLGEN[input.art], input.vorschau ?? null,
          { untergrenze: input.vorschauUntergrenze })
          ?? VORRANG_FOLGEN[input.art]],
      },
      { key: 'gleich', titel: BLOCK_TITEL.gleich, zeilen: [...BLEIBT_GLEICH] },
      { key: 'ende', titel: BLOCK_TITEL.ende, zeilen: [RUECKNAHME_REGEL] },
    ],
    bestaetigen: 'Regel aktivieren',
  };
}

// ---------------------------------------------------------------------------
// Anlass 2 · Betriebsmodell wechseln (Steuerung Stufe 5)
// ---------------------------------------------------------------------------

/** Block 4 einer Modell-Umstellung — was KEIN Betriebsmodell anfasst. */
export const WECHSEL_BLEIBT_GLEICH: string[] = [
  'Ihre Regeln bleiben unverändert — ein Betriebsmodell schaltet keine ab.',
  'Netzvorgaben (§ 14a), Einspeisegrenze, Abregelung und der Geräteschutz gelten weiter.',
  'Umgang mit dem Speicher, Notstrom-Reserve und Ihre Einstellungen bleiben, wie sie sind.',
];

/** Block 5 — der Rückweg. */
export const WECHSEL_RUECKNAHME =
  'Sie können jederzeit zurückwechseln; auch das gilt ab dem nächsten Fahrplan.';

/**
 * Der Satz über den laufenden Slot. Er steht in JEDER Wechsel-Karte, weil er
 * die häufigste Rückfrage nach dem Umschalten beantwortet („warum tut sich
 * nichts?"): der Optimierer plant alle 15 Minuten neu, und was gerade läuft,
 * läuft aus.
 */
export const WECHSEL_SLOT =
  'Der laufende Viertelstunden-Slot läuft aus — VoltPilot bricht nichts mitten '
  + 'im Slot ab.';

export interface WechselFolgenInput {
  /** Das Modell, das ENDET; null = es lief keins (der Grundmodus). */
  von: string | null;
  /** Das Modell, das BEGINNT. */
  nach: string;
  /**
   * Was das endende Modell BISHER gebracht hat — eine GEMESSENE Zahl, kein
   * Ausblick. Null, wenn es keine gibt; dann wird auch keine genannt.
   */
  belegVon?: string | null;
  /**
   * Warum das neue Modell noch nicht voll läuft (der Server-Satz der Karte).
   * Er gehört in Block 3: eine Umstellung auf ein Modell, das ohne einen
   * fehlenden Wert nichts tut, muss das VORHER sagen.
   */
  risikoNach?: string | null;
  /**
   * Die SERVER-Vorschau (Stufe 7) — absent/null lässt die Karte bei ihrer
   * ehrlichen Stufe-5-Fassung.
   */
  vorschau?: VorschauErgebnis | null;
  /** Die Anfrage ist unterwegs (siehe {@link VORSCHAU_LAEUFT}). */
  vorschauLaeuft?: boolean;
  /** Siehe `SatzOptionen.untergrenze` — der Knopf ist schwächer als die Tat. */
  vorschauUntergrenze?: boolean;
}

/**
 * Die Folgen-Karte eines BETRIEBSMODELL-WECHSELS (Konzept §3.4/§3.5).
 *
 * ⚠ **Block 2 nennt eine gemessene Zahl, nie eine Vorhersage.** Was der Wechsel
 * KOSTEN wird, weiß erst die Kunden-Vorschau (Stufe 7); bis dahin steht dort,
 * was das endende Modell BISHER gebracht hat — ein Fakt — plus die ehrliche
 * Aussage, dass die Änderung nicht bezifferbar ist. Eine geschätzte Differenz
 * wäre genau die erfundene Zahl, die das Leitprinzip verbietet.
 */
export function wechselFolgen(input: WechselFolgenInput): FolgenKarte {
  const endet = input.von
    ? `„${input.von}" endet.`
    : 'Ihr Speicher fährt bisher den Eigenverbrauchs-Fahrplan.';
  const fahrplan: string[] = [];
  if (input.von) {
    fahrplan.push(
      input.belegVon
        ? `Bisher mit „${input.von}": ${input.belegVon}. Das bleibt in Ihren `
          + 'Erlösen sichtbar.'
        : `Der Beleg von „${input.von}" bleibt in Ihren Erlösen sichtbar.`,
    );
  }
  // Stufe 7: die Server-Zahl, wenn es eine gibt. Sie steht NEBEN dem
  // gemessenen Beleg des endenden Modells, nie an seiner Stelle - eine
  // Vorhersage und eine Messung sind zwei verschiedene Aussagen.
  fahrplan.push(
    vorschauSatz(input.vorschau ?? null, { untergrenze: input.vorschauUntergrenze })
    ?? (input.vorschauLaeuft ? VORSCHAU_LAEUFT : null)
    ?? 'Nicht abschätzbar: Was die Umstellung Ihnen bringt oder kostet, rechnet '
      + 'VoltPilot noch nicht vorher aus.',
  );
  const risiko: string[] = [];
  if (input.risikoNach) risiko.push(input.risikoNach);
  risiko.push(
    'Bis zum nächsten Fahrplan (spätestens in 15 Minuten) ändert sich an Ihrer '
    + 'Anlage nichts.',
  );
  return {
    titel: input.von
      ? `Von „${input.von}" auf „${input.nach}" wechseln`
      : `„${input.nach}" einschalten`,
    intro: `${endet} „${input.nach}" beginnt mit dem nächsten Fahrplan.`,
    bloecke: [
      {
        key: 'passiert',
        titel: BLOCK_TITEL.passiert,
        zeilen: [WECHSEL_SLOT],
      },
      { key: 'fahrplan', titel: BLOCK_TITEL.fahrplan, zeilen: fahrplan },
      { key: 'risiko', titel: BLOCK_TITEL.risiko, zeilen: risiko },
      { key: 'gleich', titel: BLOCK_TITEL.gleich, zeilen: [...WECHSEL_BLEIBT_GLEICH] },
      { key: 'ende', titel: BLOCK_TITEL.ende, zeilen: [WECHSEL_RUECKNAHME] },
    ],
    bestaetigen: input.von ? 'Jetzt wechseln' : 'Einschalten',
  };
}

/**
 * Die Folgen-Karte eines AUSSCHALTENS — der Weg zurück in den Grundmodus.
 *
 * Er fragt trotzdem nach: anders als eine Regel-Rücknahme ändert er, WIE der
 * Speicher fährt, und das ist eine Entscheidung über eine laufende Anlage.
 */
export function ausschaltFolgen(modell: string): FolgenKarte {
  return {
    titel: `„${modell}" ausschalten`,
    intro: `„${modell}" endet. Ihr Speicher fährt danach wieder den `
      + 'Eigenverbrauchs-Fahrplan: möglichst viel eigener Strom im Haus.',
    bloecke: [
      { key: 'passiert', titel: BLOCK_TITEL.passiert, zeilen: [WECHSEL_SLOT] },
      {
        key: 'fahrplan',
        titel: BLOCK_TITEL.fahrplan,
        zeilen: [
          `Der Beleg von „${modell}" bleibt in Ihren Erlösen sichtbar.`,
          'Nicht abschätzbar: Was die Umstellung Ihnen bringt oder kostet, '
          + 'rechnet VoltPilot noch nicht vorher aus.',
        ],
      },
      {
        key: 'risiko',
        titel: BLOCK_TITEL.risiko,
        zeilen: [
          'Bis zum nächsten Fahrplan (spätestens in 15 Minuten) ändert sich an '
          + 'Ihrer Anlage nichts.',
        ],
      },
      { key: 'gleich', titel: BLOCK_TITEL.gleich, zeilen: [...WECHSEL_BLEIBT_GLEICH] },
      {
        key: 'ende',
        titel: BLOCK_TITEL.ende,
        zeilen: ['Sie können es jederzeit wieder einschalten.'],
      },
    ],
    bestaetigen: 'Ausschalten',
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
