// AE4 - Geld-/Wert-Ansicht profil-bedingt (V1-lite).
//
// The Anlagen-Seite money view (AnlageHero + earnings) is a PROFILE-CONDITIONAL
// LENS, not a new attribution engine (adaptive-ems-ui-v1-spec.md §5 "Geld in V1:
// bestehende Ansicht wiederverwenden - kein E15"). The AE7 usage profile
// (arbitrage | peak | private) carries an emphasis map; its `money` level decides
// only WHERE and HOW-prominent the EXISTING components render:
//
//   arbitrage → prominent  (heutiges Produkt, unverändert)
//   peak      → secondary  (Nachweis: Live/Peak führt, Geld darunter, gedämpft)
//   private   → minimal    (aus dem Hero genommen, erreichbar über ein Detail)
//
// This is the ONE pure decision the render layer consults. It never touches the
// money math; it only maps an emphasis level onto a layout. An un-migrated site
// (no profile / no v2 entities) resolves to `prominent` = byte-identical to today.

/** How prominently the money view renders on the Anlagen-Seite. */
export type MoneyPresentation = 'prominent' | 'secondary' | 'hidden';

export interface MoneyLayout {
  /** The resolved presentation for the money view. */
  presentation: MoneyPresentation;
  /**
   * Render the full money zone (hero + Ertrag chart + Energie + the page-wide
   * period controls). True for prominent + secondary; false when hidden.
   */
  showFullMoney: boolean;
  /**
   * De-emphasised "Nachweis" framing: the money hero still renders but muted and
   * below the live/peak content (peak profile).
   */
  nachweis: boolean;
  /**
   * The money hero is taken out of the hero slot; a quiet detail affordance keeps
   * it reachable (private profile). Never destroys access, only de-emphasises.
   */
  hiddenFromHero: boolean;
}

/**
 * Map an AE7 `emphasis.money` level onto the money presentation.
 * `null`/`undefined`/unknown resolve to `prominent` - the fallback that keeps
 * an un-migrated (or profile-less) site byte-identical to today.
 */
export function moneyPresentation(emphasisMoney: string | null | undefined): MoneyPresentation {
  switch (emphasisMoney) {
    case 'secondary':
      return 'secondary';
    // The AE7 map emits 'minimal' for the private profile; 'hidden' is the other
    // de-emphasised level. Both take money out of the hero.
    case 'minimal':
    case 'hidden':
      return 'hidden';
    case 'prominent':
    default:
      return 'prominent';
  }
}

/** The full layout decision for the money view. */
export function moneyLayout(emphasisMoney: string | null | undefined): MoneyLayout {
  const presentation = moneyPresentation(emphasisMoney);
  return {
    presentation,
    showFullMoney: presentation !== 'hidden',
    nachweis: presentation === 'secondary',
    hiddenFromHero: presentation === 'hidden',
  };
}
