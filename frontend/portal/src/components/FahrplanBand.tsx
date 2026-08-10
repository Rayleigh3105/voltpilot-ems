import type { PlantKind, SchedulePlan } from '../api';
import { eurAmount } from '../format';
import {
  curtailmentPlannedLine,
  curtailmentToday,
  planHourBars,
  planSentence,
  planStreifenSkala,
  planStreifenTicks,
  savingsTodayEur,
  todaySlots,
} from '../schedule';
import { phases } from '../fahrplanWhy';
import { filmRows, speicherKurzzeile } from '../fahrplanFilm';
import { PROVENIENZ } from '../historieWelten';
import { energyLabel } from '../anlage';
import { fahrplanZeile } from '../cockpitWidgets';
import type { MiniPoint } from '../miniChart';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { MobileRowCard } from './CockpitBlocks';
import { MiniBarSpark } from './MiniChart';
import { Skeleton } from './States';
import './FahrplanBand.css';

/** Der ehrliche Leerzustand — wortgleich mit der Fahrplan-Seite. */
export const KEIN_PLAN_TEXT = 'Für heute liegt noch kein Fahrplan vor.';

/**
 * Die kurze Speicher-Fahrplan-Karte (vp-cockpit-unten-ux-n3 PR 4, Konzept
 * §4b, Captain-Entscheid D7): das frühere Band trug den VOLLEN 24-h-Chart
 * (Preislinie, SoC, Netzlade-Flächen) — genau die Schwere, gegen die der
 * Umbau der unteren Hälfte lief, und eine zweite Plan-Visualisierung neben
 * der Fahrplan-Seite. Jetzt erzählt die Karte den Tag KURZ, in der Grammatik
 * des Fahrplan-Films (Wort trägt, Farbe verstärkt); der volle Chart lebt nur
 * noch auf der Fahrplan-Seite — einen Klick über „Fahrplan ›".
 *
 * Reine Komposition, nichts neu gerechnet:
 * - Erzählzeile = `speicherKurzzeile` (die `filmKurzfassung` wörtlich; eine
 *   laufende Ruhe nennt via `naechsterEinsatz` den Blick nach vorn) mit dem
 *   „Geplant"-Abzeichen — EINE Provenienz-Grammatik mit dem Preis-Streifen.
 *   Ohne Warum-Ebene bleibt `planSentence` (zeichengleich zur Band-Regel).
 * - Ministreifen = die 24 Stundenbalken (`planHourBars`) auf ALLEN Breiten,
 *   der Jetzt-Balken UMRANDET statt einer Positionslinie.
 * - Geld = „Geplanter Vorteil heute: X €" (`savingsTodayEur`, entfällt
 *   ehrlich ohne belegte Zahl) · Abregel-Zeile (`curtailmentPlannedLine`,
 *   PLAN-Wortlaut) unverändert.
 * - Zustände wie zuvor: lädt → Skeleton · Fehler → Hinweis · kein Plan →
 *   {@link KEIN_PLAN_TEXT} (ruhige Leere, kein Fehlerton ohne Befund).
 */
export function FahrplanBand({
  plan,
  plantKind,
  now,
  loading,
  failed,
  onOpen,
  compact = false,
  weatherWhy = null,
}: {
  plan: SchedulePlan | null;
  plantKind: PlantKind;
  now: Date;
  loading: boolean;
  failed: boolean;
  onOpen: () => void;
  /**
   * Die Telefon-Fassung (Mobil-Umbau Stufe 2, `<= 720px`): EINE Zeile mit
   * Absprung statt Karte samt Ministreifen — der Fahrplan-Satz stand am Telefon
   * zweimal in Folge (hier und im Preis-Streifen darüber), und der volle Plan
   * ist seit Mobil-Stufe 1 ein Daumen entfernt in der Bottom-Bar.
   */
  compact?: boolean;
  /**
   * Der Wetter-Satz (`weatherWhy`) — er erscheint NUR in der kompakten Zeile
   * und nur, wenn er etwas erklärt (Konzept: die Wetter-Kachel entfällt am
   * Telefon zugunsten dieser einen Notiz).
   */
  weatherWhy?: string | null;
}) {
  const slots = plan?.slots ?? [];
  const hasPlan = slots.length > 0;
  // Die Erzählzeile des Films — DIESELBE Ableitung wie auf der Fahrplan-Seite,
  // Band und Seite können sich nicht widersprechen. Ohne persistierte Rollen
  // bleibt der klassische planSentence.
  const daySlots = todaySlots(slots, now);
  const whyPhases = phases(daySlots, plan?.slotMinutes ?? 15);
  const kurz =
    whyPhases.length > 0
      ? speicherKurzzeile(filmRows(whyPhases, daySlots, plantKind, now))
      : null;
  const sentence = kurz ?? planSentence(slots, plantKind, now);
  const saved = savingsTodayEur(slots, now);
  const curtail = curtailmentToday(slots, now);

  if (compact) {
    // Die Zustände bleiben WÖRTLICH dieselben — nur die Fläche schrumpft.
    if (loading) return <Skeleton height={64} radius="var(--vp-radius-lg)" />;
    const row = failed
      ? { head: 'Der Fahrplan konnte gerade nicht geladen werden.', sub: null }
      : !hasPlan
        ? { head: KEIN_PLAN_TEXT, sub: null }
        : fahrplanZeile({ sentence, savedEur: saved, weatherWhy, eur: eurAmount });
    if (!row) return null;
    return (
      <MobileRowCard
        icon="zap"
        row={row}
        linkLabel="Fahrplan"
        onOpen={onOpen}
        badge={
          hasPlan && !failed
            ? { label: PROVENIENZ.geplant.label, title: PROVENIENZ.geplant.satz }
            : null
        }
      />
    );
  }

  return (
    <Card padding="lg" radius="lg" className="vp-fp-band" style={{ minWidth: 0 }}>
      <div className="vp-fpk-head">
        <h3>Speicher-Fahrplan</h3>
        <button type="button" className="vp-fpk-link" onClick={onOpen}>
          Fahrplan
          <Icon name="chevron-right" size={15} />
        </button>
      </div>

      {loading ? (
        <Skeleton height={96} radius="var(--vp-radius-md)" />
      ) : failed ? (
        <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
          Der Fahrplan konnte gerade nicht geladen werden.
        </p>
      ) : !hasPlan ? (
        <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
          {KEIN_PLAN_TEXT}
        </p>
      ) : (
        <>
          {sentence && (
            <div className="vp-fpk-story">
              <Icon name="zap" size={15} />
              <span className="vp-fpk-story-text">{sentence}</span>
              <span className="vp-fpk-geplant" title={PROVENIENZ.geplant.satz}>
                {PROVENIENZ.geplant.label}
              </span>
            </div>
          )}
          <MiniBars slots={slots} now={now} />
          {saved != null && saved > 0.005 && (
            <p className="vp-fpk-money">
              Geplanter Vorteil heute: <b>+{eurAmount(saved)}</b>
            </p>
          )}
          {/* PLAN, kein Ergebnis: die Ausführung der Abregelung ist
              cloud-seitig nicht belegt (siehe `curtailmentPlannedLine`). */}
          {curtail && (
            <p className="vp-fp-curtail">
              <Icon name="sun" size={13} />{' '}
              {curtailmentPlannedLine(curtail, energyLabel, eurAmount)}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Der 24-Stunden-Ministreifen (auf allen Breiten) — seit Chart-Redesign
 * Stufe 5 der geteilte Mini-Baustein statt eigener CSS-Balken.
 *
 * Was sich dabei ändert, ist nicht die Optik, sondern die EHRLICHKEIT (die
 * drei Befunde aus `vp-charts-filigran-c7` §3b Nr. 15):
 *
 *  - **Eine echte Nulllinie mit RICHTUNGS-WÖRTERN.** Vorher trug die Richtung
 *    allein `align-self` plus die Farbe — und Grün↔Türkis liegt unter der
 *    Normalsicht-Grenze, die Haus-Auflage „Wort + Icon tragen die Identität"
 *    war hier also VERLETZT. Jetzt hängt Laden über und Abgeben unter einer
 *    gezeichneten Null, und „lädt ↑" / „gibt ab ↓" stehen daneben.
 *  - **Keine 12-%-Mindesthöhe.** `Math.max(12, …)` zog jede kleine Stunde auf
 *    ein Achtel der Fläche; der Baustein gibt ihr stattdessen die Strich-Form.
 *  - **Die Stundenskala steht UNTER ihren Ticks.** Vorher `space-between`,
 *    also die Beschriftung NEBEN ihrer Stunde.
 *
 * Dazu die Maßstabs-Zeile (K1): ein 40-px-Streifen kann seine Leistungen nicht
 * beschriften, und genau danach fragt ein Betreiber.
 */
function MiniBars({ slots, now }: { slots: SchedulePlan['slots']; now: Date }) {
  const bars = planHourBars(slots, now);
  const nowHour = now.getHours();
  // Die Richtung wird zum VORZEICHEN - erst damit kann die Nulllinie sie
  // tragen. `ruhe` ist eine gemessene Null (ein Strich auf der Linie), keine
  // Lücke: der Plan sieht für diese Stunde nichts vor, das IST die Aussage.
  const points: MiniPoint[] = bars.map((b) => {
    const kw = b.kw ?? 0;
    const signed = b.kind === 'entladen' ? -kw : b.kind === 'ruhe' ? 0 : kw;
    return {
      key: String(b.hour),
      value: signed,
      label: `${b.hour} Uhr`,
      tone: b.kind,
    };
  });

  return (
    <div className="vp-fpk-ribbon">
      {/* K5: die Richtung trägt Position UND Wort, nie die Farbe allein. */}
      <div className="vp-plan-dirs" aria-hidden="true">
        <span className="vp-plan-dir is-up">lädt ↑</span>
        <span className="vp-plan-dir is-down">gibt ab ↓</span>
      </div>
      <MiniBarSpark
        className="vp-plan-mini"
        points={points}
        size="streifen"
        nowKey={String(nowHour)}
        emphasisKey={String(nowHour)}
        ariaLabel="Batterie-Fahrplan heute"
      />
      <div className="vp-fpk-hours" aria-hidden="true">
        {planStreifenTicks().map((t) => (
          <span key={t.hour} className="vp-fpk-hour" style={{ left: `${t.pct}%` }}>
            {t.hour}
          </span>
        ))}
      </div>
      {/* Die Zahl, die ein 40-px-Balken nicht zeigen kann - plus der
          Formschlüssel, ohne den „Umriss" eine Kodierung ohne Wort wäre. */}
      {planStreifenSkala(bars) && (
        <p className="vp-plan-scale">{planStreifenSkala(bars)}</p>
      )}
    </div>
  );
}
