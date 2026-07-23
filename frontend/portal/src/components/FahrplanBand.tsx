import type { PlantKind, SchedulePlan } from '../api';
import { eurAmount } from '../format';
import {
  curtailmentToday,
  planHourBars,
  planSentence,
  savingsTodayEur,
  todaySlots,
  type ChargeKind,
} from '../schedule';
import { phaseArcSentence, phases } from '../fahrplanWhy';
import { energyLabel } from '../anlage';
import { ScheduleChart } from '../ScheduleChart';
import { useContainerWidth } from '../useContainerWidth';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { Skeleton } from './States';

/** Below this container width the compact mini bars replace the full chart. */
const FULL_CHART_MIN_WIDTH = 620;

/** The bar CSS class per charge kind (matches .vp-plan-mini tokens). */
const BAR_CLASS: Record<ChargeKind, string> = {
  solarladen: 'ch',
  netzladen: 'grid',
  entladen: 'dis',
  ruhe: 'idle',
};

/**
 * The promoted Batterie-Fahrplan band (captain decision 2): the full-width 24h
 * plan chart (price line, grid-charge cyan, Jetzt marker, SoC) on desktop, a
 * real compact mini-widget (24 hourly bars + Jetzt marker) on phone - both
 * capped by container width, not the viewport, so it stays right inside the
 * dashboard column. One plain-German summary sentence names what the plan does;
 * the planned saving and any negative-price curtailment are the honest
 * takeaways. "Ganzer Fahrplan im Detail →" opens the full subpage.
 */
export function FahrplanBand({
  plan,
  plantKind,
  now,
  loading,
  failed,
  onOpen,
}: {
  plan: SchedulePlan | null;
  plantKind: PlantKind;
  now: Date;
  loading: boolean;
  failed: boolean;
  onOpen: () => void;
}) {
  const [ref, width] = useContainerWidth();
  const slots = plan?.slots ?? [];
  const hasPlan = slots.length > 0;
  // Day-story arc (why-layer, D4: the cockpit band stays calm - arc sentence
  // only, no phase band here). Plans without persisted slot roles fall back
  // to the classic planSentence - byte-identical to before.
  const whyPhases = phases(todaySlots(slots, now), plan?.slotMinutes ?? 15);
  const arc = whyPhases.length > 0 ? phaseArcSentence(whyPhases, plantKind) : null;
  const sentence = arc ?? planSentence(slots, plantKind, now);
  const saved = savingsTodayEur(slots, now);
  const curtail = curtailmentToday(slots, now);

  return (
    <div ref={ref} style={{ minWidth: 0 }}>
    <Card padding="lg" radius="lg" className="vp-fp-band" style={{ minWidth: 0 }}>
      <div className="vp-fp-head">
        <span className="vp-card-label">
          <Icon name="battery-charging" size={14} /> Batterie-Fahrplan · heute
        </span>
        <button type="button" className="vp-linklike" onClick={onOpen}>
          Ganzer Fahrplan im Detail →
        </button>
      </div>

      {loading ? (
        <Skeleton height={140} radius="var(--vp-radius-md)" />
      ) : failed ? (
        <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
          Der Fahrplan konnte gerade nicht geladen werden.
        </p>
      ) : !hasPlan ? (
        <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
          Noch kein Fahrplan. Sobald Ihre Anlage einen Speicher meldet und Börsenpreise
          vorliegen, plant VoltPilot alle 15 Minuten einen kostenoptimalen Tag - er
          erscheint dann automatisch hier.
        </p>
      ) : (
        <>
          {width >= FULL_CHART_MIN_WIDTH ? (
            <ScheduleChart plan={plan!} />
          ) : (
            <MiniBars slots={slots} now={now} />
          )}
          <p className="vp-fp-summary">
            {sentence && <span className="s">{sentence}</span>}{' '}
            {saved != null && saved > 0.005 && (
              <>
                Heute <b>+{eurAmount(saved)}</b> geplant.
              </>
            )}
          </p>
          {curtail && (
            <p className="vp-fp-curtail">
              <Icon name="sun" size={13} /> Heute {energyLabel(curtail.curtailedKwh)} abgeregelt
              {curtail.avoidedLossEur > 0.005
                ? ` - rund ${eurAmount(curtail.avoidedLossEur)} Verlust bei negativen Preisen vermieden.`
                : '.'}
            </p>
          )}
        </>
      )}
    </Card>
    </div>
  );
}

/** The compact 24-hour bar strip with a "Jetzt" marker (phone-calm resolution). */
function MiniBars({ slots, now }: { slots: SchedulePlan['slots']; now: Date }) {
  const bars = planHourBars(slots, now);
  const maxKw = Math.max(1, ...bars.map((b) => b.kw ?? 0));
  const nowLeft = ((now.getHours() + now.getMinutes() / 60) / 24) * 100;
  return (
    <div className="vp-plan-mini-wrap">
      <div className="vp-plan-mini" role="img" aria-label="Batterie-Fahrplan heute">
        {bars.map((b) => {
          const pct = b.kw && b.kw > 0 ? Math.max(12, Math.round((b.kw / maxKw) * 100)) : 0;
          const cls = BAR_CLASS[b.kind];
          return (
            <i
              key={b.hour}
              className={cls}
              style={cls === 'idle' ? undefined : { height: `${pct}%` }}
            />
          );
        })}
      </div>
      <span className="vp-plan-mini-now" style={{ left: `${nowLeft}%` }} aria-hidden="true" />
    </div>
  );
}
