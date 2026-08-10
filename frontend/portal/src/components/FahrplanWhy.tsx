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
import {
  CURTAIL_PLAN,
  curtailExecutionNote,
  curtailTruthForSlot,
  type CurtailTruth,
} from '../curtailment';
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
      // Ruhe (warten/Reserve halten) traegt bewusst KEINEN Serienton, damit
      // „hier passiert nichts" nie wie eine Handlung aussieht.
      return t.idle;
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
  curtail = CURTAIL_PLAN,
  onClose,
}: {
  phase: PlanPhase;
  plantKind: PlanWordingKind;
  /**
   * Die Abregel-Beleg-Lage - vom Aufrufer bereits darauf gefiltert, dass diese
   * Phase die LAUFENDE ist. Ein Beleg von jetzt sagt nichts über eine Phase am
   * Vormittag oder am Abend, und „vom Wechselrichter bestätigt" an einer
   * künftigen Phase wäre eine Behauptung über die Zukunft.
   */
  curtail?: CurtailTruth;
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
        <i style={{ background: phase.kind === 'idle' ? t.idle : roleColor(phase.role, t) }} />
        {roleLabel(phase.role, plantKind, null, false, curtail)}
        {mode && <span className="vp-fw-mode">{mode}</span>}
      </div>
      <p className="vp-fw-why">{phaseWhy(phase, plantKind, curtail)}</p>
      {/* Die Ausführungs-Wahrheit der Abregelung - nur mit Beleg. */}
      {curtailExecutionNote(curtail) && (
        <p className="vp-fw-exec">{curtailExecutionNote(curtail)}</p>
      )}
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
  curtail = CURTAIL_PLAN,
  onClose,
}: {
  slot: WhySlot;
  index: number;
  slots: WhySlot[];
  phases: PlanPhase[];
  plantKind: PlanWordingKind;
  slotMinutes: number;
  /** Wie bei {@link PhaseCard}: nur für die LAUFENDE Viertelstunde gesetzt. */
  curtail?: CurtailTruth;
  onClose: () => void;
}) {
  const t = chartTheme();
  const role = slot.slotRole as SlotRole;
  const why = slotWhy(slot, plantKind, curtail);
  const rows = slotContextRows(slot, slots);
  const chips = bindingChips(slot.slotFlags, curtail);
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
              role === 'warten' || role === 'reserve_halten' ? t.idle : roleColor(role, t),
          }}
        />
        {roleLabel(role, plantKind, slot.slotFlags, false, curtail)}
      </div>
      {why && <p className="vp-fw-why">{why}</p>}
      {/* Die Ausführungs-Wahrheit der Abregelung - nur mit Beleg. */}
      {curtailExecutionNote(curtail) && (
        <p className="vp-fw-exec">{curtailExecutionNote(curtail)}</p>
      )}
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
  curtail,
  currentSlotIndex = -1,
  onClose,
}: {
  phases: PlanPhase[];
  slots: WhySlot[];
  plantKind: PlanWordingKind;
  slotMinutes: number;
  selectedPhase: number | null;
  selectedSlot: number | null;
  /** Die Abregel-Beleg-Lage des Geräts; ohne sie bleibt alles Plan-Wortlaut. */
  curtail?: CurtailTruth | null;
  /**
   * Index der LAUFENDEN Viertelstunde in `slots` (-1 = keine). Er ist der
   * Filter, der den Beleg auf das Jetzt begrenzt: eine angetippte Phase vom
   * Vormittag darf nicht mit dem bestätigen, was das Gerät gerade tut.
   */
  currentSlotIndex?: number;
  onClose: () => void;
}) {
  if (selectedPhase != null && selectedPhase >= 0 && selectedPhase < phases.length) {
    const phase = phases[selectedPhase];
    const isCurrent = currentSlotIndex >= phase.startIdx && currentSlotIndex <= phase.endIdx;
    return (
      <PhaseCard
        phase={phase}
        plantKind={plantKind}
        curtail={curtailTruthForSlot(curtail, phase.role, isCurrent)}
        onClose={onClose}
      />
    );
  }
  if (selectedSlot != null && selectedSlot >= 0 && selectedSlot < slots.length) {
    const slot = slots[selectedSlot];
    return (
      <SlotCard
        slot={slot}
        index={selectedSlot}
        slots={slots}
        phases={phases}
        plantKind={plantKind}
        slotMinutes={slotMinutes}
        curtail={curtailTruthForSlot(curtail, slot.slotRole, selectedSlot === currentSlotIndex)}
        onClose={onClose}
      />
    );
  }
  return null;
}
