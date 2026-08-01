/**
 * Render-only pieces of the Fahrplan "Warum"-layer (design report
 * vp-fahrplan-why-design §8): the day-story PHASE BAND over the schedule
 * chart, the PHASE CARD (Zeitraum, was, why, phase-€) and the SLOT PANEL
 * (role + why-sentence + context + binding chips) on tap. All derivation is
 * the pure src/fahrplanWhy.ts - these components only render it. Role colors
 * come from the shipped chartTheme() tokens (green solar / cyan grid / BLUE
 * discharge / grey idle / orange curtail), so band and chart always agree -
 * red stays reserved for costs/warnings and never marks a discharge.
 * On phones the panel renders as a bottom sheet (CSS), tap targets ≥ 44 px.
 */

import { chartTheme, type ChartTheme } from '../chartTheme';
import { Icon } from '../../designsystem/components/core/Icon';
import type { PlanWordingKind } from '../schedule';
import {
  bandLabel,
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
import { useContainerWidth } from '../useContainerWidth';
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

/** Rough px per label character (0.7rem bold) + segment padding, for fitting. */
const BAND_LABEL_CHAR_PX = 6.5;
const BAND_LABEL_PAD_PX = 14;

/**
 * The tappable day-story band: one flex segment per phase, width ∝ duration,
 * role-colored; idle phases render dim. Identity never rides on color alone -
 * a segment carries its label only when it truly FITS (measured against the
 * container width - a truncated "V…" helps nobody), every segment always
 * carries the full label via title/aria-label, and the tapped card names it.
 */
export function PhaseBand({
  phases,
  plantKind,
  selected,
  onSelect,
}: {
  phases: PlanPhase[];
  plantKind: PlanWordingKind;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const t = chartTheme();
  const [ref, width] = useContainerWidth();
  const totalSlots = phases.reduce((s, p) => s + p.slotCount, 0) || 1;
  return (
    <div ref={ref} className="vp-fw-band" aria-label="Tagesphasen des Fahrplans">
      {phases.map((p, i) => {
        const dim = p.kind === 'idle';
        const full = roleLabel(p.role, plantKind);
        const short = bandLabel(p.role, plantKind);
        const segPx = width > 0 ? (p.slotCount / totalSlots) * width : 0;
        const lbl =
          short && segPx >= short.length * BAND_LABEL_CHAR_PX + BAND_LABEL_PAD_PX ? short : '';
        return (
          <button
            key={`${p.startIdx}`}
            type="button"
            className={`vp-fw-ph${dim ? ' dim' : ''}${selected === i ? ' sel' : ''}`}
            style={{ flex: `${p.slotCount} 1 0px`, background: dim ? IDLE_BG : roleColor(p.role, t) }}
            title={`${full} · ${phaseRange(p)}`}
            aria-label={`${full}, ${phaseRange(p)}`}
            aria-pressed={selected === i}
            onClick={() => onSelect(i)}
          >
            <span>{lbl}</span>
          </button>
        );
      })}
    </div>
  );
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
