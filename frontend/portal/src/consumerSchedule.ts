/**
 * Verbraucher im Fahrplan (Verbrauchssteuerung Inkrement 2, §14.11) - the
 * pure derivation under the read-only consumer layer of the Fahrplan chart.
 *
 * Source is `GET /api/v1/sites/{id}/consumer-schedule` (the newest
 * co-optimizer run's consumer slots, SHADOW: rows exist only for sites the
 * optimizer co-plans - production stays empty until a site is flagged, and
 * the Fahrplan then renders byte-identical to the pre-consumer view).
 *
 * Rules that are law here:
 *
 * - **reason_code -> German goes through the ONE tested map** (`reasonText`),
 *   never by scanning sentences (D9 discipline). An UNKNOWN code renders
 *   nothing - the vocabulary may grow server-side first.
 * - **Pflichtfenster are marked by WORD + lock symbol, never colour alone**
 *   (§14.11): `isPflicht` keys on the compiled hard-window reasons.
 * - **Alignment is by TIMESTAMP**, never by index: the consumer plan is its
 *   own run and may cover a different horizon than the v1 battery plan. A
 *   plan slot without a consumer slot is a GAP (null), never a fabricated 0;
 *   an OFF consumer slot is a real 0 (the plan says "aus").
 */

export interface ConsumerPlanSlot {
  time: string;
  command: 'on_off' | 'setpoint_kw';
  /** Planned power in kW (both commands persist kW; on_off: rated when on, 0 when off). */
  targetValue: number | null;
  reasonCode: string | null;
  requirementId: string | null;
}

export interface ConsumerEntitySchedule {
  entityId: string;
  name: string | null;
  slots: ConsumerPlanSlot[];
}

export interface ConsumerSchedule {
  planId: string | null;
  generatedAt: string | null;
  slotMinutes: number;
  entities: ConsumerEntitySchedule[];
}

/**
 * The §15 reason vocabulary in customer German - the ONE map every surface
 * uses. Unknown code -> null (never guessed).
 */
export const REASON_TEXT: Record<string, string> = {
  fixed_window: 'Festes Zeitfenster (Pflichtlauf)',
  price_below_threshold: 'Günstiges Preisfenster',
  optimizer_selected_low_cost: 'Von VoltPilot günstig eingeplant',
  flex_deadline: 'Frist rückt näher',
  guard_grid_limit: 'Durch Netzvorgabe begrenzt',
  no_permitted_energy: 'Keine zulässige Energiequelle verfügbar',
};

export function reasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASON_TEXT[code] ?? null;
}

/**
 * Compiled HARD windows (Pflichtlauf / cloud-compiled price window) carry the
 * lock marking; a flexible placement does not - VoltPilot may move it.
 */
export function isPflicht(code: string | null | undefined): boolean {
  return code === 'fixed_window' || code === 'price_below_threshold';
}

/** One consumer as a chart layer, aligned to the battery plan's slot grid. */
export interface ConsumerLayer {
  entityId: string;
  name: string;
  /** kW per plan slot; null = the consumer run does not cover that slot. */
  values: (number | null)[];
  /** Pflicht marking per plan slot (lock + word, never colour alone). */
  pflicht: boolean[];
  /** Reason code per plan slot (for the slot card / tooltip). */
  reasons: (string | null)[];
}

function fallbackName(index: number): string {
  return `Verbraucher ${index + 1}`;
}

/**
 * Align the consumer entities onto the battery plan's slot times. Non-null
 * only where the consumer run really carries the slot.
 */
export function consumerLayers(
  schedule: ConsumerSchedule | null,
  planSlotTimes: string[],
): ConsumerLayer[] {
  if (!schedule || schedule.entities.length === 0) return [];
  const timeIndex = new Map<number, number>();
  planSlotTimes.forEach((t, i) => timeIndex.set(new Date(t).getTime(), i));
  return schedule.entities.map((entity, ei) => {
    const values: (number | null)[] = planSlotTimes.map(() => null);
    const pflicht: boolean[] = planSlotTimes.map(() => false);
    const reasons: (string | null)[] = planSlotTimes.map(() => null);
    for (const slot of entity.slots) {
      const i = timeIndex.get(new Date(slot.time).getTime());
      if (i == null) continue;
      values[i] = slot.targetValue ?? 0;
      pflicht[i] = isPflicht(slot.reasonCode);
      reasons[i] = slot.reasonCode;
    }
    return {
      entityId: entity.entityId,
      name: entity.name?.trim() || fallbackName(ei),
      values,
      pflicht,
      reasons,
    };
  });
}

/** True when at least one aligned layer carries at least one value. */
export function hasConsumerData(layers: ConsumerLayer[]): boolean {
  return layers.some((l) => l.values.some((v) => v != null));
}

/**
 * Distinguishable shades of the ONE Verbraucher hue (the purple consumer
 * role colour) - several consumers stay one semantic family; the NAME (in
 * legend, tooltip and slot card) carries the identity, never colour alone.
 */
export function consumerShade(baseHex: string, index: number): string {
  if (index === 0) return baseHex;
  const m = /^#?([0-9a-f]{6})$/i.exec(baseHex.trim());
  if (!m) return baseHex;
  const n = parseInt(m[1], 16);
  const mix = Math.min(0.28 * index, 0.7); // toward white, deterministic
  const ch = (shift: number) => {
    const c = (n >> shift) & 0xff;
    return Math.round(c + (255 - c) * mix);
  };
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(ch(16))}${hex(ch(8))}${hex(ch(0))}`;
}

/** The slot-click card content for one consumer at one plan slot. */
export interface ConsumerSlotInfo {
  name: string;
  /** "Ziel: 2,2 kW" - the planned power of the slot. */
  ziel: string;
  /** German reason via the tested map; null when off or unknown. */
  grund: string | null;
  pflicht: boolean;
}

export function consumerSlotInfos(
  layers: ConsumerLayer[],
  slotIndex: number,
): ConsumerSlotInfo[] {
  const out: ConsumerSlotInfo[] = [];
  for (const layer of layers) {
    const value = layer.values[slotIndex];
    if (value == null) continue;
    const on = value > 0.049; // the house display deadband
    out.push({
      name: layer.name,
      ziel: on
        ? `Ziel: ${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`
        : 'Aus',
      grund: on ? reasonText(layer.reasons[slotIndex]) : null,
      pflicht: on && layer.pflicht[slotIndex],
    });
  }
  return out;
}
