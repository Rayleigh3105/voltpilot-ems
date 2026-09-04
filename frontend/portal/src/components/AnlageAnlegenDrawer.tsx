import { useRef } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { Site } from '../api';
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
}: {
  open: boolean;
  onClose: () => void;
  /** Fired on close when the flow created an Anlage - host reloads/selects. */
  onChanged: (createdSiteId: string) => void;
  /**
   * The customer's existing Anlagen - powers the "gleicher Standort wie …"
   * reuse affordance in the Anlage step (the flow still starts fresh at
   * step 1; these are location suggestions only).
   */
  existingSites?: Site[];
}) {
  // The reload is DEFERRED to close: reloading the host's site list mid-flow
  // would re-render an empty-state host into the full page and unmount this
  // drawer while the customer is still on the Gerät/Speicher step.
  const createdSiteId = useRef<string | null>(null);

  function close() {
    const created = createdSiteId.current;
    createdSiteId.current = null;
    onClose();
    if (created) onChanged(created);
  }

  return (
    <Modal
      open={open}
      onClose={close}
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
