/**
 * Reine Hilfen des ADAPTIVEN Assistenten-Schritts (AE5, spec
 * `data/vp-ems-replatform/adaptive-ems-ui-v1-spec.md` §2/§3/§10): die
 * Geräte-Liste des Schritts und der Admin-Zusatz „Verbraucher anlegen".
 *
 * ⚠ **Der AE7-Vorwahl-Block ist mit Stufe 2 des Anwendungs-Programms ERSATZLOS
 * entfallen** (`PROFILE_OPTIONS`, `ProfileChoice`, `profileLabel`,
 * `initialProfileChoice`, `profileChoiceChanged`, `overrideForChoice`,
 * `autoStartSummary` — samt `api.setUsageProfileOverride` und dem
 * `if (admin)`-Auto-Start). Er schrieb `usage_profile_override`, eine Spalte,
 * die seit F5 keine Kundenfläche mehr liest, und sein Starter wurde nur für
 * einen Admin gesät — für einen KUNDEN war die Wahl damit fast wirkungslos.
 * Der Schritt heißt jetzt „Anwendungen": die Preset-Karten schreiben
 * `site.profil`, die Regal-Schalter gehen über `PUT /profiles`, und der SERVER
 * öffnet dabei das Tor und sät den Starter — für jeden Kunden. Die Spalte
 * bleibt lesbar, das Portal SCHREIBT sie nicht mehr (`migration.test.ts` wacht).
 */
import type { EntityTypeDef } from './entitiesApi';
import type { SiteEntity } from './api';

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
