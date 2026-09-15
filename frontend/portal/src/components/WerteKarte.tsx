/**
 * Die TAGES- und MONATSKARTE einer Messstelle mit ihrer Liste (UEMS AP-08
 * IP-11) — die erste Fläche, auf der ein Kunde liest, wie belastbar seine
 * Zahl ist.
 *
 * Diese Datei RENDERT nur. Jede Zahl, jedes Zustandswort, der Verlauf, die
 * Kennzeichen, die Beschriftung der Stunden und die Tagesdauer kommen aus der
 * reinen `src/uemsWerteKarte.ts` — und dort aus dem Ergebnis-Vertrag bzw. von
 * der Route. Kein Satz wird hier formuliert, keine Zahl gerundet.
 *
 * Mobil zuerst (375 px): die Zahl steht groß, Zustand und Verlauf daneben als
 * Abzeichen, die sich umbrechen; ein Kennzeichen wird nie gekürzt.
 *
 * Die Fassung („vorläufig“ · „endgültig“) steht im Kopf neben dem Titel der
 * Periode, IMMER in beiden Fällen — getrennt von Zustand und Verlauf, weil sie
 * etwas anderes sagt: ob die Zahl feststeht, nicht ob sie vollständig ist.
 * Nicht in die Abzeichen-Reihe verschieben: dort sähe „vorläufig“ neben
 * „Verlauf 85 %“ wie dieselbe Kategorie aus (Captain 14.09.2026: Variante A,
 * `docs/agents/root/uems-tageskarte.md` Falle 7).
 *
 * Hat die Zahl zwei oder mehr Versionen (AP-08 IP-18), steht unten der
 * Einstieg zu „Versionen“ — was vorher dastand, wer, wann und warum.
 *
 * Die ANZAHL der Lücken steht IM Abzeichen des Verlaufs („Verlauf 85 % · 1 Lücke“),
 * nicht als eigenes Abzeichen: eine Lücke sagt etwas über den Verlauf, nicht über
 * die Menge — als eigenes Abzeichen neben „vollständig“ läse sie sich wie ein
 * Widerspruch (Captain 15.09.2026, `docs/agents/root/uems-tageskarte.md` Falle 9).
 * Ein noch nicht gebildeter Schritt sagt das in einem Satz unter dem Strich (Falle 10).
 */
import type { ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { TRENNER } from '../uemsErgebnis';
import type { Karte, Zeile } from '../uemsWerteKarte';
import './WerteKarte.css';

export function WerteKarte({
  karte,
  versionen,
  grund = null,
  testId = 'werte-karte',
}: {
  karte: Karte;
  versionen?: ReactNode;
  /**
   * Der Satz eines Schritts ohne Zahl: an der Kennzahl der Kundensatz (§5.8, UEMS AP-11 IP-13), an der
   * Messstelle „noch nicht gerechnet“ (`karte().grund` aus `uemsWerteKarte.ts`, Captain 15.09.2026).
   */
  grund?: string | null;
  /** Die Karte eines gewählten Schritts im Verlauf trägt eine eigene Kennung (AP-13 IP-4) — die der Periode bleibt eindeutig. */
  testId?: string;
}) {
  return (
    <section className="vp-wk-karte" aria-label={karte.titel} data-testid={testId}>
      <div className="vp-wk-kopf">
        <span className="vp-wk-titel">{karte.titel}</span>
        {karte.fassung && (
          <Badge
            variant={karte.fassungWert === 'endgueltig' ? 'ok' : 'warn'}
            className="vp-wk-fassung"
            data-testid="werte-fassung"
            data-fassung={karte.fassungWert ?? undefined}
          >
            {karte.fassung}
          </Badge>
        )}
        {karte.tagesdauer && <Badge variant="tint">{karte.tagesdauer}</Badge>}
      </div>
      <div className="vp-wk-zahl">{karte.zahl}</div>
      {(karte.zustand || karte.abdeckung || karte.luecken) && (
        <div className="vp-wk-abzeichen">
          {karte.zustand && <Badge variant={karte.zustandTon}>{karte.zustand}</Badge>}
          {/* Die Anzahl der Lücken gehört zum Verlauf, nicht als eigenes Abzeichen neben „vollständig“ (Falle 9). */}
          {(karte.abdeckung || karte.luecken) && (
            <Badge variant={karte.abdeckungTon} data-testid="werte-verlauf">
              {[karte.abdeckung, karte.luecken].filter((t): t is string => !!t).join(TRENNER)}
            </Badge>
          )}
        </div>
      )}
      <Kennzeichen saetze={karte.kennzeichen} />
      {grund && (
        <p className="vp-wk-grund" data-testid="werte-grund">
          {grund}
        </p>
      )}
      {versionen}
    </section>
  );
}

export function WerteListe({ titel, zeilen }: { titel: string; zeilen: Zeile[] }) {
  return (
    <section className="vp-wk-liste" aria-label={titel}>
      <h4 className="vp-wk-liste-titel">{titel}</h4>
      <ol>
        {zeilen.map((z) => (
          <li key={z.schluessel} className="vp-wk-zeile" data-testid="werte-zeile">
            <span className="vp-wk-zeile-name">{z.beschriftung}</span>
            <span className="vp-wk-zeile-zahl">{z.zahl}</span>
            {(z.zustand || z.grund || z.abdeckung || z.tagesdauer) && (
              <span className={`vp-wk-zeile-info is-${z.zustandTon}`}>
                {[z.zustand, z.grund, z.abdeckung, z.tagesdauer].filter((t): t is string => t !== null).join(TRENNER)}
              </span>
            )}
            <Kennzeichen saetze={z.kennzeichen} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Kennzeichen({ saetze }: { saetze: string[] }) {
  if (saetze.length === 0) return null;
  return (
    <ul className="vp-wk-kennzeichen">
      {saetze.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}
