import type { PlantKind, SchedulePlan } from '../api';
import { eurAmount } from '../format';
import {
  curtailmentPlannedLine,
  curtailmentToday,
  planHourBars,
  planSentence,
  savingsTodayEur,
  todaySlots,
  type ChargeKind,
} from '../schedule';
import { phases } from '../fahrplanWhy';
import { filmRows, speicherKurzzeile } from '../fahrplanFilm';
import { PROVENIENZ } from '../historieWelten';
import { energyLabel } from '../anlage';
import { fahrplanZeile } from '../cockpitWidgets';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { MobileRowCard } from './CockpitBlocks';
import { Skeleton } from './States';
import './FahrplanBand.css';

/** The bar CSS class per charge kind (matches .vp-plan-mini tokens). */
const BAR_CLASS: Record<ChargeKind, string> = {
  solarladen: 'ch',
  netzladen: 'grid',
  entladen: 'dis',
  ruhe: 'idle',
};

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
 * Der 24-Stunden-Ministreifen (auf allen Breiten): ein Balken je Stunde in
 * der Fahrplan-Farbsprache, der Balken der LAUFENDEN Stunde umrandet — die
 * Stunden-Achse darunter macht ihn ohne Legende lesbar.
 */
function MiniBars({ slots, now }: { slots: SchedulePlan['slots']; now: Date }) {
  const bars = planHourBars(slots, now);
  const maxKw = Math.max(1, ...bars.map((b) => b.kw ?? 0));
  const nowHour = now.getHours();
  return (
    <div className="vp-fpk-ribbon">
      <div className="vp-plan-mini" role="img" aria-label="Batterie-Fahrplan heute">
        {bars.map((b) => {
          const pct = b.kw && b.kw > 0 ? Math.max(12, Math.round((b.kw / maxKw) * 100)) : 0;
          const cls = BAR_CLASS[b.kind];
          return (
            <i
              key={b.hour}
              className={`${cls}${b.hour === nowHour ? ' now' : ''}`}
              style={cls === 'idle' ? undefined : { height: `${pct}%` }}
            />
          );
        })}
      </div>
      <div className="vp-fpk-hours" aria-hidden="true">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}
