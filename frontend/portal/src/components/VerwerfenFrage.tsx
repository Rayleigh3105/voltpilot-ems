import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';

/**
 * „Eingaben verwerfen?“ (Anlage-Flow a1, F8): Escape, ✕ oder ein Klick daneben schlossen „Anlage
 * anlegen“ und „Standort anlegen“ sofort - alle Eingaben waren weg. Jetzt fragt die Fläche nach, mit
 * „Weiter ausfüllen“ als Hauptknopf. Selbst ein Blatt im EINEN Überlagerungs-Stapel: Escape trifft
 * nur sie und heißt „weiter ausfüllen“, nie „verwerfen“.
 */
export function VerwerfenFrage({
  open,
  satz,
  onVerwerfen,
  onWeiter,
}: {
  open: boolean;
  /** Was verloren ginge, z. B. „Adresse und Name gehen verloren.“ */
  satz: string;
  onVerwerfen: () => void;
  onWeiter: () => void;
}) {
  return (
    <Modal
      open={open}
      blatt
      onClose={onWeiter}
      title="Eingaben verwerfen?"
      footer={
        <>
          <Button variant="ghost" onClick={onVerwerfen}>
            Verwerfen
          </Button>
          <Button variant="primary" onClick={onWeiter}>
            Weiter ausfüllen
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{satz}</p>
    </Modal>
  );
}
