import type { ReactNode } from 'react';
import type { HeroMoney, HeroRing } from '../../cockpitWidgets';
import { SteuerungFormel } from '../SteuerungFormel';
import { SwapText } from '../SwapNumber';
import { SpeicherKarte } from './SpeicherKarte';
import { Statement } from './Statement';
import './ErgebnisKarte.css';

/**
 * **Die Cockpit-Erlöskarte im C-Kleid** (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.7 + §3.10 (7); Captain-Entscheide
 * **E2 = (b)** „die Leseprinzipien gelten auch für die Cockpit-Karte" und
 * **E11 = (a)** „das Widget ‚Erlöse' entfällt, die Karte trägt Netto +
 * Speicher", beide vom 03.09.2026).
 *
 * Sie ist die EINE Fassung für Telefon UND Schreibtisch: `MobileMoneyCard`
 * und die Bilanz-Leiste der Bühne rendern beide dieses Bauteil, damit die
 * zwei Breiten über dieselbe Stunde nie Verschiedenes behaupten.
 *
 * Vier Dinge, in dieser Reihenfolge (§3.7) —
 *
 *   Label 12/700 Versalien · Zahl 48 (375: 36)/800 · Zeitraum-Segment 14/600 ·
 *   DIESELBE Speicher-Sektion wie auf der Erlöse-Seite · die zwei Ringe.
 *
 * ⚠ **KEINE zweite Ableitung.** Jede Zahl, jedes Wort und jeder Ton kommt aus
 *   `cockpitHero()` bzw. `speicherAussage()` — derselben Ableitung, die die
 *   Erlöse-Seite in der Langform zeigt. Dieses Bauteil rechnet nichts.
 *
 * ⚠ **DER SATZ FEHLT HIER ABSICHTLICH** — eine argumentierte Abweichung vom
 *   Auftragstext („Satz ≤ 8 Wörter"): §3.10 misst die C-Cockpit-Karte bei
 *   **32 Wörtern**, und genau 32 ist die Obergrenze der Abnahme. Der Mockup
 *   (`rvC-375-cockpit.png`) trägt deshalb keinen Satz — im Cockpit sagt der
 *   KONTEXT schon, worüber gesprochen wird, während die Erlöse-Seite ihn als
 *   Einstieg in eine ganze Welt braucht. Ein Satz hier kostete vier Wörter
 *   und beantwortete eine Frage, die niemand gestellt hat.
 *
 * ⚠ **KEIN PROVENIENZ-ABZEICHEN** (Mockup `rvC-375-cockpit.png`): „Zwischen-
 *   stand" und „Kein Abzug" sind die ZWEI Chips, die §3.7 misst — ein drittes
 *   sprengte das Budget (§2 Prinzip 5). Die Bewertung steht eine Ebene tiefer,
 *   auf der Erlöse-Seite, über derselben Zahl.
 *
 * ⚠ **DIE EINORDNUNG BLEIBT WEG, bis es einen Gleiche-Stunde-Vergleich gibt**
 *   (§2 Prinzip 5, E3): `cockpitHero()` liefert keinen Vortagsanker, und ein
 *   Vergleich „gegen den vollen Vortag" wäre um 11 Uhr eine Falschaussage.
 *
 * ⚠ **EIN RAHMEN JE KARTE** (§2 Prinzip 3): die Speicher-Sektion läuft hier
 *   als `variant="sektion"` — ohne eigenen Rahmen, ohne eigene Fläche. Eine
 *   Karte in der Karte war Befund B2 der Runde.
 */
export interface CockpitErgebnisProps {
  money: HeroMoney;
  /** Das Zeitraum-Segment (`PeriodTabs variant="seg"`); ohne Wahl bleibt es weg. */
  periodSeg?: ReactNode;
  /** Die zwei Kennzahlen-Ringe; leer = keine. */
  rings?: HeroRing[];
  /** Warum gerade KEIN Ring dasteht (V13); null = es gibt Ringe. */
  ringsNote?: string | null;
  /** Wohin „Speicher-Daten fehlen ›" führt; ohne Ziel bleibt es ruhiger Text. */
  nachtragHref?: string;
}

export function CockpitErgebnis({
  money,
  periodSeg,
  rings = [],
  ringsNote,
  nachtragHref,
}: CockpitErgebnisProps) {
  const speicher = money.speicher ?? null;
  return (
    <div className="vp-c-ck">
      <Statement
        label={money.label}
        betrag={money.value}
        kosten={money.kosten}
      >
        {periodSeg && <div className="vp-c-ck-seg">{periodSeg}</div>}
      </Statement>

      {/* Wenig Sonne (Konzept k1 E6 = A): was die Sonne trotzdem gedeckt hat —
          „Unterm Strich" bleibt rot, wenn es Kosten sind. */}
      {money.winterSatz && <p className="vp-c-note vp-c-ck-winter">{money.winterSatz}</p>}

      {speicher?.hatAussage && (
        <SpeicherKarte aussage={speicher} nachtragHref={nachtragHref} variant="sektion">
          {/* Dieselbe Rechnung wie auf der Erlöse-Seite und am Rechner — der
              Chip erklärt sich überall gleich (Captain 01.09.2026). */}
          {money.formel && <SteuerungFormel input={money.formel} />}
        </SpeicherKarte>
      )}

      {rings.length > 0 ? (
        <p className="vp-c-ck-ringe">
          {rings.map((r) => (
            <ErgebnisRing key={r.id} ring={r} />
          ))}
        </p>
      ) : (
        /* V13: der Satz hält den Platz und sagt, warum er leer ist — nie ein
           Ring mit einer erfundenen 0. */
        ringsNote && <p className="vp-c-note">{ringsNote}</p>
      )}
    </div>
  );
}

/**
 * Ein Kennzahlen-Ring im C-Kleid: derselbe SVG-Donut wie bisher, aber mit
 * einem 14-px-Label auf der Skala (§3.7). Reines SVG, keine Abhängigkeit.
 *
 * ## ⚠ DER BOGEN GLEITET ÜBER `stroke-dashoffset`, NICHT ÜBER `stroke-dasharray`
 *
 * Bewegungs-Programm P3, §5 Zeile F. Bis hierher trug der Bogen sein Mass als
 * ZWEIER-Liste (`dasharray: "an aus"`) — CSS kann eine Liste zwar
 * interpolieren, aber beide Zahlen laufen gegenläufig und der Rundungs-Deckel
 * (`toFixed(2)`) macht daraus einen unruhigen Übergang. Als EINE Zahl
 * (`dasharray` = ganzer Umfang, `dashoffset` = was fehlt) ist es genau eine
 * Grösse, die über 300 ms in `--vp-ease-inout` wandert. Der Kreis sieht in
 * jedem Frame identisch aus wie vorher — geprüft im Browser-Beweis.
 *
 * ## ⚠ DIE ZAHL ZÄHLT NICHT
 *
 * Sie wechselt über {@link SwapText} (alt nach oben aus, neu von unten ein) —
 * und der BOGEN füllt sich beim Erscheinen NICHT von Null: eine Transition
 * läuft beim ersten Rendern nicht, der Ring steht also sofort auf seinem Wert
 * (Captain-Antwort 3, „Kein Count-up, kein Wachsen von Null").
 */
export function ErgebnisRing({ ring }: { ring: HeroRing }) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const on = (ring.pct / 100) * C;
  return (
    <span className="vp-c-ck-ring">
      <svg viewBox="0 0 64 64" role="img" aria-label={`${ring.label}: ${ring.valueText}`}>
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--vp-flow-base)" strokeWidth={6} />
        <circle
          className="vp-c-ck-ring-bogen"
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke={ring.hue}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={C.toFixed(2)}
          strokeDashoffset={(C - on).toFixed(2)}
          transform="rotate(-90 32 32)"
        />
        <SwapText
          value={ring.valueText}
          x="32"
          y="36"
          textAnchor="middle"
          fontWeight={700}
          fontSize={14}
          fill="var(--vp-c-fg, #1e293b)"
          fontFamily="'Plus Jakarta Sans', Inter, sans-serif"
        />
      </svg>
      <span className="vp-c-ck-ring-label">{ring.label}</span>
    </span>
  );
}
