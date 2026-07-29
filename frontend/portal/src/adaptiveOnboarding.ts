/**
 * Pure logic of the AE5 adaptive onboarding step (spec
 * data/vp-ems-replatform/adaptive-ems-ui-v1-spec.md §2/§3/§10): after the
 * Anlage's entities exist, the customer/admin picks WHICH STARTER FLOW VoltPilot
 * should seed, and on finish the site gets that auto-start flow. This module
 * holds every word- and decision-related bit so the wizard step stays
 * unit-testable without a DOM.
 *
 * **F5 (Projektion #529/#534, report §6.5): this pre-pick is the auto-start
 * TEMPLATE chooser and nothing else.** It rides the KEPT `usage_profile_override`
 * column (the mechanism `POST .../flows/auto-start` reads), but no portal
 * surface is derived from a winning profile any more - the Anlagen-Seite is a
 * projection of the ACTIVE MODES (`surface.ts`). Copy must therefore promise a
 * starting point, never a view/"Fokus"; `adaptiveOnboarding.test.ts` pins that.
 *
 * It CONSUMES AE7 (profile derivation) and E1b (entities) - it does not
 * re-derive them; `deriveDefault`/`effectiveProfile` live in usageProfile.ts.
 */
import type { AutoStartOutcome, EntityTypeDef } from './entitiesApi';
import { isUsageProfile, type UsageProfile } from './usageProfile';
import type { SiteEntity, SiteUsageProfile } from './api';

/**
 * The profile the customer picks: a SETTABLE profile, or auto-derive.
 * `private` is NOT selectable - self-consumption is base behaviour (report
 * vp-nacht-bezug-e7 §3.3), so a household picks "Automatisch" (which derives
 * `private` and seeds no starter).
 */
export type ProfileChoice = Exclude<UsageProfile, 'private'> | 'auto';

/** One selectable profile card in the wizard (auto + the three profiles). */
export interface ProfileOption {
  value: ProfileChoice;
  label: string;
  sentence: string;
}

/**
 * The choices offered in the "Womit sollen wir starten?" step, "auto" first
 * (the default, ONE truth - the flow/entities decide). Copy is plain German,
 * no internals.
 *
 * M1/F5 (Projektion #529, report §6.5): this pre-pick is now ONLY the
 * auto-start TEMPLATE chooser. It no longer steers the portal surface - since
 * M0/M1 the Anlagen-Seite is a projection of the ACTIVE MODES (`surface.ts`),
 * not of one winning usage profile - so the copy promises a starting point,
 * never a "Fokus" the portal would then apply.
 *
 * Eigenverbrauch is NOT offered as a choice (report vp-nacht-bezug-e7 §3.3):
 * self-consumption is the platform's base behaviour, so a household picks
 * "Automatisch" (derives `private`, seeds no starter). Only the two contract-
 * near use cases (Markt, Lastspitzen) are explicit.
 */
export const PROFILE_OPTIONS: ProfileOption[] = [
  {
    value: 'auto',
    label: 'Automatisch',
    sentence: 'VoltPilot schlägt den Start passend zu Ihrer Anlage vor (empfohlen).',
  },
  {
    value: 'arbitrage',
    label: 'Markterlös',
    sentence: 'Speicher am Strommarkt vermarkten - wir starten mit der Marktoptimierung.',
  },
  {
    value: 'peak',
    label: 'Lastspitzen',
    sentence: 'Gewerbe mit Leistungsmessung - wir starten mit der Lastspitzenkappung.',
  },
];

/** German label for a derived/effective profile (for the "abgeleitet:" hint). */
export function profileLabel(profile: string | null | undefined): string {
  switch (profile) {
    case 'arbitrage':
      return 'Markterlös';
    case 'peak':
      return 'Lastspitzen';
    case 'private':
      return 'Eigenverbrauch';
    default:
      return 'Eigenverbrauch';
  }
}

/**
 * The initial choice for a loaded profile: "auto" when no override is stored,
 * else the stored override. Null/failed load defaults to "auto".
 */
export function initialProfileChoice(profile: SiteUsageProfile | null): ProfileChoice {
  const override = profile?.override;
  return isUsageProfile(override) ? override : 'auto';
}

/**
 * Whether the picked choice differs from what is currently stored, so the
 * wizard only writes on a real change (never pins the default override).
 */
export function profileChoiceChanged(
  choice: ProfileChoice,
  profile: SiteUsageProfile | null,
): boolean {
  return choice !== initialProfileChoice(profile);
}

/** The override value to PUT for a choice: null clears (auto-derive), else the profile. */
export function overrideForChoice(choice: ProfileChoice): string | null {
  return choice === 'auto' ? null : choice;
}

/**
 * The one-line German summary of what the auto-start seeding did, shown on the
 * finish screen. Reuses the backend's own message when present, else composes a
 * calm sentence from the outcome (never surfaces the raw reason code).
 */
export function autoStartSummary(outcome: AutoStartOutcome | null): string | null {
  if (!outcome) return null;
  if (outcome.created && outcome.name) {
    return `Start-Flow „${outcome.name}" angelegt - im Flow-Editor verfeinerbar.`;
  }
  switch (outcome.reason) {
    case 'already_has_flow':
      return 'Für diese Anlage besteht bereits ein Flow.';
    case 'no_battery':
      return 'Ein Start-Flow wird angelegt, sobald ein Speicher hinterlegt ist.';
    default:
      return null;
  }
}

/**
 * The consumer types a customer/admin can add in the wizard entity step
 * (wallbox / heating-rod / generic-load - the controllable Verbraucher; PV,
 * Speicher and Netz come from the Register/Gerät steps + the bootstrap). Only
 * non-composed catalog types are directly creatable.
 */
export function creatableConsumerTypes(catalog: EntityTypeDef[]): EntityTypeDef[] {
  return catalog.filter((t) => t.category === 'consumer' && !t.composed);
}

/**
 * The role a wizard-shown entity belongs to (plain German group label), so the
 * "Ihre Geräte" mini-list reads as PV / Speicher / Netz / Verbraucher instead
 * of raw type strings.
 */
export function entityGroupLabel(entity: SiteEntity): string {
  switch (entity.role) {
    case 'pv':
      return 'Erzeuger';
    case 'storage':
      return 'Speicher';
    case 'grid':
      return 'Netz';
    case 'consumer':
      return 'Verbraucher';
    default:
      return entity.typeLabel;
  }
}

/** One-line summary of the entities recognised for the Anlage (null = none yet). */
export function entitiesRecognisedSummary(entities: SiteEntity[]): string | null {
  if (entities.length === 0) return null;
  const groups = new Set(entities.map(entityGroupLabel));
  const n = entities.length;
  return `${n} ${n === 1 ? 'Gerät' : 'Geräte'} erkannt: ${[...groups].join(', ')}.`;
}
