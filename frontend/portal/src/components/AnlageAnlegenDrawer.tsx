import { loescheEntwurf, meinEntwurfSchluessel } from '../anlageEntwurf';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { Site } from '../api';
import { hashForRoute, type Route } from '../nav';
import { AnlageFlow } from './AnlageFlow';
import { VerwerfenFrage } from './VerwerfenFrage';

/**
 * "Anlage anlegen" as a right drawer - the SAME one-flow as the first-run
 * wizard (captain decision 5: Anlage + Adresse + Anlagentyp, Geräte-ID,
 * Speicher optional), hosted for existing customers. Closing mid-flow is
 * dead-end-free: whatever exists so far (the Anlage, a claimed device) is
 * kept, the host reloads, and every skipped step is reachable again under
 * Anlage › Aufbau und Einstellungen.
 */
export function AnlageAnlegenDrawer({
  open,
  onClose,
  onChanged,
  existingSites,
  standortId,
  zurueck = false,
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
  zurueck?: boolean;
}) {
  // The reload is DEFERRED to close: reloading the host's site list mid-flow
  // would re-render an empty-state host into the full page and unmount this
  // drawer while the customer is still on the Gerät/Speicher step.
  const createdSiteId = useRef<string | null>(null);
  // F8 (Anlage-Flow a1): wer getippt hat und noch nichts gespeichert ist, wird vor dem Schließen gefragt.
  const [eingaben, setEingaben] = useState(false);
  const [frage, setFrage] = useState(false);
  useEffect(() => {
    if (open) {
      setEingaben(false);
      setFrage(false);
    }
  }, [open]);

  function schliessenWunsch() {
    if (eingaben) setFrage(true);
    else close();
  }

  function close(ziel?: Route) {
    setFrage(false);
    // Schließen ist ein bewusstes Ende: kein Entwurf (F9) wartet beim nächsten „Anlage anlegen“.
    loescheEntwurf(meinEntwurfSchluessel());
    const created = createdSiteId.current;
    createdSiteId.current = null;
    onClose();
    if (created) onChanged(created, ziel);
    // Derselbe Weg wie „Messstellen ansehen“ im Assistenten „Messen & Auswerten“;
    // hat der Wirt schon dorthin navigiert, ändert sich nichts.
    if (ziel) window.location.hash = hashForRoute(ziel);
  }

  return (
    <>
    <Modal
      open={open}
      onClose={schliessenWunsch}
      title="Anlage anlegen"
      icon={
        <IconTile category="solar" size={40}>
          <Icon name="sun" size={20} />
        </IconTile>
      }
    >
      {open && (
        // Jede Eingabe in einem Schritt (auch in einem Dialog darüber) zählt als „noch nicht gespeichert“.
        <div onInput={() => setEingaben(true)}>
        <AnlageFlow
          wirt="dialog"
          // Always a NEW Anlage here (never the wizard's resume-at-Gerät):
          // existing customers add their next Anlage with this drawer.
          sites={[]}
          existingSites={existingSites}
          standortId={standortId}
          zurueck={zurueck}
          onSiteCreated={(s: Site) => {
            createdSiteId.current = s.id;
            // Was bis hier getippt war, ist gespeichert.
            setEingaben(false);
          }}
          onDone={close}
        />
        </div>
      )}
    </Modal>
    <VerwerfenFrage
      open={frage}
      satz="Was Sie in diesem Schritt eingetragen haben, geht verloren. Was schon gespeichert ist, bleibt."
      onVerwerfen={() => close()}
      onWeiter={() => setFrage(false)}
    />
    </>
  );
}
