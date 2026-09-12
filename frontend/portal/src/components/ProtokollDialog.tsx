/**
 * Das ÄNDERUNGSPROTOKOLL in einem Dialog (UEMS AP-04 IP-21) — die EINE Hülle,
 * aus der beide Wirte es öffnen: die Messstelle und das Gerät.
 *
 * Kein eigenes Gestaltungssystem: der zentrierte `Modal` des Hauses, darin die
 * `ProtokollListe`. Er LIEST nur — von hier aus lässt sich nichts ändern.
 */
import { Modal } from '../../designsystem/components/shell/Modal';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { ProtokollListe, useProtokoll, type ProtokollZiel } from './ProtokollListe';

/** Die EINE Beschriftung — im Menü, im Kopf des Dialogs und auf der Geräteseite. */
export const PROTOKOLL_LABEL = 'Änderungsprotokoll';

export function ProtokollDialog({
  open,
  titel,
  ziel,
  onClose,
}: {
  open: boolean;
  /** Das Objekt, dessen Protokoll gezeigt wird — es steht im Kopf. */
  titel: string;
  /** null, solange nichts gewählt ist; dann wird auch nichts geladen. */
  ziel: ProtokollZiel | null;
  onClose: () => void;
}) {
  const state = useProtokoll(open ? ziel : null);
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${PROTOKOLL_LABEL}: ${titel}`}
      icon={
        <IconTile category="primary" size={40}>
          <Icon name="history" size={20} />
        </IconTile>
      }
    >
      <ProtokollListe state={state} />
    </Modal>
  );
}
