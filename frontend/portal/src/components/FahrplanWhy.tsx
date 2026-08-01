/**
 * Render-only pieces of the Fahrplan "Warum"-layer (design report
 * vp-fahrplan-why-design §8): the PHASE CARD (Zeitraum, was, why, phase-€) and
 * the SLOT PANEL
 * (role + why-sentence + context + binding chips) on tap. All derivation is
 * the pure src/fahrplanWhy.ts - these components only render it. Role colors
 * come from the shipped chartTheme() tokens (green solar / cyan grid / BLUE
 * discharge / grey idle / orange curtail), so band and chart always agree -
 * red stays reserved for costs/warnings and never marks a discharge.
 * On phones the panel renders as a bottom sheet (CSS), tap targets ≥ 44 px.
 *
 * The former unlabeled PHASE BAND is gone: at 375 px it was colour confetti
 * with no words, and the colour validator shows Grün↔Türkis can never carry
 * identity alone. The named film list (`components/FahrplanJetzt.tsx`
 * `TagesFilm`) replaced it.
 */

import { chartTheme, type ChartTheme } from '../chartTheme';
import { Icon } from '../../designsystem/components/core/Icon';
import type { PlanWordingKind } from '../schedule';
import {
  bindingChips,
  driverLabel,
  phaseEurAmount,
  phaseEurLine,
  phaseEurNote,
  phaseRange,
  phaseWhy,
  roleLabel,
  slotContextRows,
  slotWhy,
  type PlanPhase,
  type SlotRole,
  type WhySlot,
} from '../fahrplanWhy';
import './FahrplanWhy.css';

/** Neutral idle fill (warten/reserve) - dim like the concept, never a chart hue. */
const IDLE_BG = '#EDEFF2';

/** The band/panel color of a role, from the shared chart palette. */
export function roleColor(role: SlotRole, t: ChartTheme): string {
  switch (role) {
    case 'pv_speichern':
      return t.charge;
    case 'guenstig_laden':
      return t.gridCharge;
    case 'eigenverbrauch':
    case 'verkaufen':
    case 'spitze_kappen':
      // ONE colour for ONE action: discharging is BLUE everywhere (bars, band,
      // phase card, KPI). Red is reserved for costs/warnings, and a battery
      // that earns money must never read as a fault.
      return t.battDischarge;
    case 'abregeln':
      return t.pv;
    default:
      return IDLE_BG;
  }
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="vp-fw-close" onClick={onClose} aria-label="Schließen">
      <Icon name="x" size={16} />
    </button>
  );
}

/** The phase card: Zeitraum · was · 1-sentence why · sign-honest phase-€. */
export function PhaseCard({
  phase,
  plantKind,
  onClose,
}: {
  phase: PlanPhase;
  plantKind: PlanWordingKind;
  onClose: () => void;
}) {
  const t = chartTheme();
  const eur = phaseEurAmount(phase);
  const eurNote = phaseEurNote(phase);
  const mode = driverLabel(phase.driver);
  return (
    <div className="vp-fw-panel" role="dialog" aria-label="Erklärung der Phase">
      <CloseButton onClose={onClose} />
      <div className="vp-fw-time">
        Phase · {phaseRange(phase)} · {phase.slotCount} Viertelstunden
      </div>
      <div className="vp-fw-role">
        <i style={{ background: phase.kind === 'idle' ? IDLE_BG : roleColor(phase.role, t) }} />
        {roleLabel(phase.role, plantKind)}
        {mode && <span className="vp-fw-mode">{mode}</span>}
      </div>
      <p className="vp-fw-why">{phaseWhy(phase, plantKind)}</p>
      {eur && (
        <p className="vp-fw-eur">
          Beitrag dieser Phase:{' '}
          <b className={phase.eur != null && phase.eur < 0 ? 'neg' : ''}>{eur}</b>
          {eurNote && <span className="vp-fw-eurnote"> – {eurNote}</span>}
        </p>
      )}
      <p className="vp-fw-foot">
        Tipp: eine Viertelstunde im Diagramm antippen für ihr eigenes Warum.
      </p>
    </div>
  );
}

/** The slot panel: role + 1 why-sentence + context rows + binding chips. */
export function SlotCard({
  slot,
  index,
  slots,
  phases,
  plantKind,
  slotMinutes,
  onClose,
}: {
  slot: WhySlot;
  index: number;
  slots: WhySlot[];
  phases: PlanPhase[];
  plantKind: PlanWordingKind;
  slotMinutes: number;
  onClose: () => void;
}) {
  const t = chartTheme();
  const role = slot.slotRole as SlotRole;
  const why = slotWhy(slot, plantKind);
  const rows = slotContextRows(slot, slots);
  const chips = bindingChips(slot.slotFlags);
  const phase = phases.find((p) => index >= p.startIdx && index <= p.endIdx) ?? null;
  const phaseEur = phase ? phaseEurLine(phase) : null;
  const from = new Date(slot.start);
  const to = new Date(from.getTime() + slotMinutes * 60_000);
  const hm = (d: Date) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="vp-fw-panel" role="dialog" aria-label="Erklärung der Viertelstunde">
      <CloseButton onClose={onClose} />
      <div className="vp-fw-time">
        {hm(from)}–{hm(to)} Uhr
      </div>
      <div className="vp-fw-role">
        <i
          style={{
            background:
              role === 'warten' || role === 'reserve_halten' ? IDLE_BG : roleColor(role, t),
          }}
        />
        {roleLabel(role, plantKind, slot.slotFlags)}
      </div>
      {why && <p className="vp-fw-why">{why}</p>}
      {rows.length > 0 && (
        <dl className="vp-fw-kv">
          {rows.map((r) => (
            <span key={r.label} style={{ display: 'contents' }}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </span>
          ))}
        </dl>
      )}
      {chips.length > 0 && (
        <div className="vp-fw-chips">
          {chips.map((c) => (
            <span key={c} className="vp-fw-chip">
              {c}
            </span>
          ))}
        </div>
      )}
      {phase && (
        <p className="vp-fw-phline">
          Teil der Phase „{roleLabel(phase.role, plantKind)}“ ({phaseRange(phase)})
          {phaseEur ? ` · ${phaseEur}` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * The panel switch: a selected phase renders the phase card, a selected slot
 * its slot panel, neither renders nothing. Selection state lives in the host
 * (FahrplanSection).
 */
export function FahrplanWhyPanel({
  phases,
  slots,
  plantKind,
  slotMinutes,
  selectedPhase,
  selectedSlot,
  onClose,
}: {
  phases: PlanPhase[];
  slots: WhySlot[];
  plantKind: PlanWordingKind;
  slotMinutes: number;
  selectedPhase: number | null;
  selectedSlot: number | null;
  onClose: () => void;
}) {
  if (selectedPhase != null && selectedPhase >= 0 && selectedPhase < phases.length) {
    return <PhaseCard phase={phases[selectedPhase]} plantKind={plantKind} onClose={onClose} />;
  }
  if (selectedSlot != null && selectedSlot >= 0 && selectedSlot < slots.length) {
    return (
      <SlotCard
        slot={slots[selectedSlot]}
        index={selectedSlot}
        slots={slots}
        phases={phases}
        plantKind={plantKind}
        slotMinutes={slotMinutes}
        onClose={onClose}
      />
    );
  }
  return null;
}
