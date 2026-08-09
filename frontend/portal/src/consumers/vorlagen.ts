/**
 * D7 (docs/verbrauchssteuerung.md §19 Inkrement 4): the two consumer templates
 * of the automation gallery ("Wallbox nur bei PV-Überschuss", "Heizstab-
 * Zeitplan") open the Verbraucher-REGELBAUKASTEN prefilled instead of emitting
 * a raw flow - a consumer rule belongs to the consumer surface, where the
 * cycle guard, grid policy and enforcement questions live.
 *
 * PURE + unit-tested. The deep link travels as hash QUERY PARAMS (the
 * settingsNav/historieHash pattern - `parseRoute` strips them, the page reads
 * them itself): `#/anlage/{id}/verbraucher?vorlage=…` opens the builder
 * prefilled, `?verbraucher=…` opens the builder for THAT consumer (the
 * origin-badge edit path from the Automationen capsule).
 */
import type { ConsumerDraft } from './questions';

/**
 * Prefill per gallery template id (LOCKSTEP with
 * `flows/customerTemplates.ts` CUSTOMER_TEMPLATES - pinned by vorlagen.test).
 * Only the intent-defining fields are set; every remaining question stays the
 * builder's default and is asked normally.
 */
export const CONSUMER_TEMPLATE_PREFILL: Record<string, Partial<ConsumerDraft>> = {
  'pv-surplus-consumer': {
    intent: 'react',
    // The local PV-surplus signal (D1: local signals stay reactive at edge)
    // with a small hysteresis so a passing cloud does not flap the device.
    conditions: [
      { signal: 'site.pv_surplus_kw', operator: 'gt', value: 2, resetValue: 1.5 },
    ],
    target: { kind: 'on_off', value: true },
    // "Nur bei Überschuss" is an opportunity, never a Pflichtlauf.
    enforcement: 'opportunistic',
    gridEnergyPolicy: 'avoid',
  },
  'schedule-consumer': {
    intent: 'schedule',
    recurrence: { days: 'daily', from: '11:00', to: '15:00' },
    target: { kind: 'on_off', value: true },
  },
};

/** Whether a gallery template is a consumer rule (→ Regelbaukasten, not editor). */
export function isConsumerRuleTemplate(templateId: string): boolean {
  return templateId in CONSUMER_TEMPLATE_PREFILL;
}

/** The consumer TYPE a template fits best (pure preference, never a gate). */
const TEMPLATE_PREFERRED_TYPE: Record<string, string> = {
  'pv-surplus-consumer': 'wallbox',
  'schedule-consumer': 'heating-rod',
};

/**
 * Pick the consumer a template's builder opens for: the preferred type when
 * the site has one, else the first consumer, else null (the page then opens
 * the create wizard - a rule needs a consumer first).
 */
export function templateConsumer<T extends { id: string; type: string }>(
  templateId: string,
  consumers: T[],
): T | null {
  const preferred = TEMPLATE_PREFERRED_TYPE[templateId];
  return consumers.find((c) => c.type === preferred) ?? consumers[0] ?? null;
}

/** Deep link: open the Verbraucher page with the builder prefilled from a template. */
export function verbraucherVorlageHash(siteId: string, templateId: string): string {
  return `#/anlage/${siteId}/verbraucher?vorlage=${encodeURIComponent(templateId)}`;
}

/** Deep link: open the Verbraucher page with the builder for ONE consumer. */
export function verbraucherRegelHash(siteId: string, consumerId: string): string {
  return `#/anlage/${siteId}/verbraucher?verbraucher=${encodeURIComponent(consumerId)}`;
}

export interface VerbraucherParams {
  vorlage: string | null;
  verbraucher: string | null;
}

/** Read the deep-link params back out of a hash (absent = null, never guessed). */
export function parseVerbraucherParams(hash: string): VerbraucherParams {
  const q = hash.indexOf('?');
  if (q < 0) return { vorlage: null, verbraucher: null };
  const params = new URLSearchParams(hash.slice(q + 1));
  return { vorlage: params.get('vorlage'), verbraucher: params.get('verbraucher') };
}
