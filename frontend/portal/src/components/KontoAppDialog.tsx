import { Modal } from '../../designsystem/components/shell/Modal';
import { APP_GROUP_EXPLAIN, APP_GROUP_LABEL } from '../installApp';
import { InstallAppPanel } from './InstallAppPanel';

/**
 * „Als App auf dem Handy" im Konto-Menü (Konzept „Anlage – neu gedacht", E5):
 * die Einrichtung gilt dem GERÄT, nicht der Anlage - deshalb wohnt sie nicht
 * mehr in den Einstellungen einer Anlage. Lazy geladen: das Konto-Menü liegt im
 * Einstiegs-Bündel, dieses Blatt nicht.
 */
export default function KontoAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={APP_GROUP_LABEL}>
      <p className="vp-note" style={{ marginTop: 0 }}>
        {APP_GROUP_EXPLAIN}
      </p>
      <InstallAppPanel />
    </Modal>
  );
}
