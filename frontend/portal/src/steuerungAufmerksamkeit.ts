/**
 * Das ABZEICHEN an „Steuerung" — Steuerung Stufe 8 („Umzüge", Konzept
 * `data/vp-steuerung-konzept-b3` §3.1 + §5 Stufe 8).
 *
 * **Der behobene Befund ist die BEDEUTUNG, nicht der Ort.** Bis hierher zählte
 * das Abzeichen die AKTIVEN ANWENDUNGEN (`surface.modes.length`) — eine Zahl,
 * die sich fast nie ändert und über die nichts zu tun ist. Ein Abzeichen ist
 * aber eine Aufforderung: es sagt „hier ist etwas, das Sie ansehen sollten".
 * Seit dieser Stufe zählt es genau das — die Dinge, die AUFMERKSAMKEIT
 * brauchen. `ebenenNav.ts` hatte den Wechsel schon als Argument-Wechsel im
 * Aufrufer vorgesehen; hier ist er.
 *
 * **Die drei Quellen** (§3.1) und was sie beweisen:
 *  - **laufender Handeingriff** — die Anlage weicht gerade von ihrer Automatik
 *    ab, weil ein Mensch es wollte. Die Anlagen-PAUSE zählt als EINE Sache,
 *    egal wie viele Komponenten sie betrifft: sie ist EIN Eingriff.
 *  - **Regel bremst die Automatik** — eine Kunden-Regel hält eine Komponente
 *    und der Fahrplan kommt dort gerade nicht zum Zug (Stufe 3, `flow_claim` →
 *    `entity-strategies`). Gezählt wird die REGEL, nicht die Komponente: zwei
 *    Komponenten derselben Regel sind EINE Sache, die man ansehen kann.
 *  - **offene Vorschläge** — hier NICHT gezählt, und das ist eine bewusste,
 *    dokumentierte Grenze (siehe unten).
 *
 * ⚠ **Die Vorschläge fehlen ABSICHTLICH, und zwar aus Kosten- UND
 * Ehrlichkeitsgründen.** Ein Vorschlag entsteht aus dem Fahrplan, den
 * Verbrauchern und den serverseitig gemerkten Ablehnungen (`vorschlaege.ts`) —
 * die Schale müsste also die halbe Steuerungs-Seite laden, nur um eine Zahl zu
 * malen, und zwar bei JEDEM Anlagen-Wechsel. Die Alternative wäre ein
 * Abzeichen, das erst NACH dem Besuch der Seite erscheint — das wäre schlimmer
 * als keines, weil es genau dann fehlt, wenn es hinführen soll. Die Schale
 * übergibt deshalb `vorschlaege: null` = „nicht bewertet", und `null` trägt
 * hier NIE zur Zahl bei. Der Eingang existiert trotzdem, damit ein späterer,
 * billiger Zähler (eine Server-Zahl) ihn ohne Umbau füllen kann.
 *
 * Rein + deterministisch (das `betriebsart.ts`/`ebenenNav.ts`-Muster): kein
 * React, kein Netz, jede zeitabhängige Entscheidung nimmt ihr `now`.
 */

/** Ein laufender Handeingriff, so schmal wie diese Ableitung ihn braucht. */
export interface AufmerksamkeitEingriff {
  /** Wann er endet (RFC-3339). Ein abgelaufener zählt nicht. */
  endsAt: string;
  /** null = die ganze Anlage (die Pause), sonst die Komponente. */
  entityId?: string | null;
}

/** Ein Anspruch einer Regel auf eine Komponente (Stufe 3). */
export interface AufmerksamkeitAnspruch {
  flowId: string;
  /**
   * Seit wann die Regel DIREKT beansprucht. `null`/absent = ein delegierter
   * Anspruch (er übergibt gerade an den Fahrplan) oder ein älteres Backend —
   * dann bremst nichts, und es wird auch nichts behauptet.
   */
  claimedAt?: string | null;
}

export interface AufmerksamkeitInput {
  /**
   * Läuft die Anlagen-Pause? Sie ist EIN Eingriff, auch wenn sie alles
   * betrifft.
   */
  automationPaused?: boolean | null;
  eingriffe?: readonly AufmerksamkeitEingriff[] | null;
  /** Ansprüche je Komponente (`GET /sites/{id}/entity-strategies`). */
  ansprueche?: Readonly<Record<string, readonly AufmerksamkeitAnspruch[]>> | null;
  /**
   * Die Zahl offener Vorschläge, oder `null` = NICHT bewertet (siehe der
   * Kopf-Kommentar). Eine 0 heisst „bewertet, es gibt keine".
   */
  vorschlaege?: number | null;
  now: Date;
}

/** Was das Abzeichen zählt, und woraus es sich zusammensetzt. */
export interface Aufmerksamkeit {
  /** Die Zahl fürs Abzeichen; 0 = kein Abzeichen. */
  anzahl: number;
  eingriffe: number;
  bremsen: number;
  /** Nur wenn `vorschlaege` bewertet wurde, sonst 0. */
  vorschlaege: number;
  /** Ein Satz je gezählter Sorte, in fester Reihenfolge — nie eine erfundene. */
  gruende: string[];
}

const LEER: Aufmerksamkeit = {
  anzahl: 0,
  eingriffe: 0,
  bremsen: 0,
  vorschlaege: 0,
  gruende: [],
};

/** Ein Zeitpunkt, oder null — ein unlesbarer Stempel ist kein Ende. */
function zeit(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function wort(n: number, eins: string, viele: string): string {
  return n === 1 ? eins : `${n} ${viele}`;
}

/**
 * Die Aufmerksamkeits-Zahl einer Anlage.
 *
 * Ehrlichkeitsregeln, jede gegen einen konkreten Fehlgriff:
 *  - **Ein ABGELAUFENER Eingriff zählt nicht** — die Antwort kann ihn noch
 *    tragen (sie ist Sekunden alt), aber er wirkt nicht mehr; ein Abzeichen
 *    dafür schickte den Kunden auf eine Seite, auf der nichts steht. Ein
 *    unlesbarer Stempel zählt aus demselben Grund nicht.
 *  - **Die Pause ist EIN Eingriff, nicht viele.** Sie steht als eigenes Feld
 *    neben den Zeilen; sie doppelt zu zählen (Feld + Zeile) wäre eine Zahl,
 *    die der Kunde auf der Seite nicht wiederfindet.
 *  - **Gezählt wird die REGEL, nicht die Komponente.** Eine Regel, die
 *    Speicher UND Wallbox hält, ist EINE Sache, die man ansehen kann.
 *  - **Ohne Beleg wird nichts behauptet:** ein delegierter (oder von einem
 *    älteren Backend gar nicht datierter) Anspruch bremst nichts.
 *  - **`null` trägt nie bei** — weder eine fehlende Antwort noch ein nicht
 *    bewerteter Vorschlags-Zähler erzeugen eine Zahl.
 */
export function aufmerksamkeit(input: AufmerksamkeitInput | null | undefined): Aufmerksamkeit {
  if (!input) return LEER;
  const jetzt = input.now.getTime();

  let eingriffe = 0;
  for (const e of input.eingriffe ?? []) {
    const ende = zeit(e?.endsAt);
    if (ende == null || ende <= jetzt) continue;
    // Die Pause hat ihr eigenes Feld; ihre Zeile (entityId === null) darf sie
    // nicht ein zweites Mal zählen.
    if (input.automationPaused && (e.entityId ?? null) === null) continue;
    eingriffe += 1;
  }
  if (input.automationPaused) eingriffe += 1;

  const flows = new Set<string>();
  for (const liste of Object.values(input.ansprueche ?? {})) {
    for (const a of liste ?? []) {
      if (!a?.flowId) continue;
      if (zeit(a.claimedAt) == null) continue;
      flows.add(a.flowId);
    }
  }
  const bremsen = flows.size;

  const roh = input.vorschlaege;
  const vorschlaege =
    typeof roh === 'number' && Number.isFinite(roh) && roh > 0 ? Math.trunc(roh) : 0;

  const gruende: string[] = [];
  if (eingriffe > 0) {
    gruende.push(
      eingriffe === 1 ? 'Ein Handeingriff läuft' : `${eingriffe} Handeingriffe laufen`,
    );
  }
  if (bremsen > 0) {
    gruende.push(
      bremsen === 1
        ? 'Eine Regel bremst die Automatik'
        : `${bremsen} Regeln bremsen die Automatik`,
    );
  }
  if (vorschlaege > 0) {
    gruende.push(wort(vorschlaege, 'Ein Vorschlag wartet', 'Vorschläge warten'));
  }

  return {
    anzahl: eingriffe + bremsen + vorschlaege,
    eingriffe,
    bremsen,
    vorschlaege,
    gruende,
  };
}

/**
 * Der Titel des Abzeichens (`title=`/`aria-label`) — er NENNT, was es zählt.
 * Ein nacktes „2" an einer Seitenleiste ist ein Rätsel; genau das war der alte
 * Zustand. `null` = kein Abzeichen, also auch kein Titel.
 */
export function aufmerksamkeitTitel(a: Aufmerksamkeit): string | null {
  if (a.anzahl <= 0 || a.gruende.length === 0) return null;
  return a.gruende.join(' · ');
}
