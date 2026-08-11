/**
 * Der Deep-Link in den Verbraucher-REGELBAUKASTEN (D7, seit dem
 * Einheitsmodell Stufe 5a auf die STEUERUNG gerichtet).
 *
 * Er reist als Hash-QUERY-Parameter (das `settingsNav`/`historieHash`-Muster —
 * `parseRoute` schneidet sie ab, die Fläche liest sie selbst):
 * `#/anlage/{id}/steuerung?vorlage=…` öffnet den Baukasten vorbefüllt,
 * `?verbraucher=…` öffnet ihn für GENAU diesen Verbraucher (der Weg der
 * Rezept-Karte in ihre eigene Regel). Ein altes Lesezeichen auf
 * `…/verbraucher?…` landet über `nav.ts` `canonicalAnlageHash` auf derselben
 * Adresse — die Parameter reisen dabei mit.
 *
 * Die VORBEFÜLLUNGEN wohnen seit Stufe 5a bei der Galerie, die sie anbietet
 * (`regeln/rezepte.ts`); hier bleiben nur die zwei Vorbefüllungen, an denen die
 * Flow-Vorlagen-Galerie per Lockstep-Test hängt, sowie die Link-Helfer.
 *
 * PURE + unit-getestet.
 */
import type { ConsumerDraft } from './questions';

/**
 * Prefill per Galerie-Vorlagen-Id (LOCKSTEP mit `flows/customerTemplates.ts`
 * CUSTOMER_TEMPLATES — von `vorlagen.test.ts` festgenagelt). Nur die
 * absichtsbestimmenden Felder werden gesetzt; jede weitere Frage bleibt die
 * Vorgabe des Baukastens und wird normal gestellt.
 */
export const CONSUMER_TEMPLATE_PREFILL: Record<string, Partial<ConsumerDraft>> = {
  'pv-surplus-consumer': {
    intent: 'react',
    // Das LOKALE PV-Überschuss-Signal (D1: lokale Signale bleiben am Gerät
    // reaktiv) mit kleiner Hysterese, damit eine Wolke das Gerät nicht flattern
    // lässt.
    conditions: [
      { signal: 'site.pv_surplus_kw', operator: 'gt', value: 2, resetValue: 1.5 },
    ],
    target: { kind: 'on_off', value: true },
    // „Nur bei Überschuss" ist eine Gelegenheit, nie ein Pflichtlauf.
    enforcement: 'opportunistic',
    gridEnergyPolicy: 'avoid',
  },
  'schedule-consumer': {
    intent: 'schedule',
    recurrence: { days: 'daily', from: '11:00', to: '15:00' },
    target: { kind: 'on_off', value: true },
  },
};

/** Ob eine Galerie-Vorlage eine Verbraucher-Regel ist (→ Regelbaukasten). */
export function isConsumerRuleTemplate(templateId: string): boolean {
  return templateId in CONSUMER_TEMPLATE_PREFILL;
}

/** Der Verbraucher-TYP, zu dem ein Rezept am besten passt (Vorliebe, nie ein Tor). */
const TEMPLATE_PREFERRED_TYPE: Record<string, string> = {
  'pv-surplus-consumer': 'wallbox',
  'schedule-consumer': 'heating-rod',
  'price-consumer': 'heating-rod',
  'deadline-consumer': 'wallbox',
};

/**
 * Der Verbraucher, für den ein Rezept den Baukasten öffnet: der bevorzugte Typ,
 * sonst der erste, sonst null (die Fläche öffnet dann den Anlege-Assistenten —
 * eine Regel braucht zuerst eine Komponente).
 */
export function templateConsumer<T extends { id: string; type: string }>(
  templateId: string,
  consumers: T[],
): T | null {
  const preferred = TEMPLATE_PREFERRED_TYPE[templateId];
  return consumers.find((c) => c.type === preferred) ?? consumers[0] ?? null;
}

/** Deep link: die Steuerung mit dem Baukasten aus einem Rezept öffnen. */
export function verbraucherVorlageHash(siteId: string, templateId: string): string {
  return `#/anlage/${siteId}/steuerung?vorlage=${encodeURIComponent(templateId)}`;
}

/** Deep link: die Steuerung mit dem Baukasten EINES Verbrauchers öffnen. */
export function verbraucherRegelHash(siteId: string, consumerId: string): string {
  return `#/anlage/${siteId}/steuerung?verbraucher=${encodeURIComponent(consumerId)}`;
}

export interface VerbraucherParams {
  vorlage: string | null;
  verbraucher: string | null;
}

/** Die Deep-Link-Parameter aus einem Hash lesen (absent = null, nie geraten). */
export function parseVerbraucherParams(hash: string): VerbraucherParams {
  const q = hash.indexOf('?');
  if (q < 0) return { vorlage: null, verbraucher: null };
  const params = new URLSearchParams(hash.slice(q + 1));
  return { vorlage: params.get('vorlage'), verbraucher: params.get('verbraucher') };
}
