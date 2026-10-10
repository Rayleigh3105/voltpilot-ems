import { useRef } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { Site } from '../api';
import type { AnlegeRueckkehr } from '../anlegeNurMessen';
import { hashForRoute, type Route } from '../nav';
import { AnlageFlow } from './AnlageFlow';

/**
 * "Anlage anlegen" as a right drawer - the SAME one-flow as the first-run
 * wizard (captain decision 5: Anlage + Adresse + Anlagentyp, Geräte-ID,
 * Speicher optional), hosted for existing customers. Closing mid-flow is
 * dead-end-free: whatever exists so far (the Anlage, a claimed device) is
 * kept, the host reloads, and every skipped step is reachable again under
 * Technik & Einstellungen.
 */
export function AnlageAnlegenDrawer({
  open,
  onClose,
  onChanged,
  existingSites,
  standortId,
  rueckkehr,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Fired on close when the flow created an Anlage - host reloads/selects. Im Modus
   * „nur messen“ trägt das Ende ein Ziel („Zu den Messstellen“): ein Wirt, der selbst
   * navigiert, nimmt es; sonst führt der Drawer nach dem Schließen dorthin.
   */
  onChanged: (createdSiteId: string, ziel?: Route) => void;
  /**
   * The customer's existing Anlagen - powers the "gleicher Standort wie …"
   * reuse affordance in the Anlage step (the flow still starts fresh at
   * step 1; these are location suggestions only).
   */
  existingSites?: Site[];
  /**
   * Vorbelegter Standort der neuen Anlage: Knopf „Messanlage anlegen“ im Assistenten
   * „Messen & Auswerten“ oder „Hinzufügen › Anlage“ im Aufbau eines Standorts.
   * Ohne ihn entscheidet der Server (bei genau einem Standort belegt er selbst vor).
   */
  standortId?: string | null;
  /** Das Ende im Modus „nur messen“: ein Knopf zurück zum Wirt statt „Zu den Messstellen“. */
  rueckkehr?: AnlegeRueckkehr | null;
}) {
  // The reload is DEFERRED to close: reloading the host's site list mid-flow
  // would re-render an empty-state host into the full page and unmount this
  // drawer while the customer is still on the Gerät/Speicher step.
  const createdSiteId = useRef<string | null>(null);

  function close(ziel?: Route) {
    const created = createdSiteId.current;
    createdSiteId.current = null;
    onClose();
    if (created) onChanged(created, ziel);
    // Derselbe Weg wie „Messstellen ansehen“ im Assistenten „Messen & Auswerten“;
    // hat der Wirt schon dorthin navigiert, ändert sich nichts.
    if (ziel) window.location.hash = hashForRoute(ziel);
  }

  return (
    <Modal
      open={open}
      onClose={() => close()}
      title="Anlage anlegen"
      icon={
        <IconTile category="solar" size={40}>
          <Icon name="sun" size={20} />
        </IconTile>
      }
    >
      {open && (
        <AnlageFlow
          // Always a NEW Anlage here (never the wizard's resume-at-Gerät):
          // existing customers add their next Anlage with this drawer.
          sites={[]}
          existingSites={existingSites}
          standortId={standortId}
          rueckkehr={rueckkehr}
          waitForFirstData={false}
          onSiteCreated={(s: Site) => {
            createdSiteId.current = s.id;
          }}
          onDone={close}
        />
      )}
    </Modal>
  );
}
