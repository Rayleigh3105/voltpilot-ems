import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Drawer } from '../../designsystem/components/shell/Drawer';

/**
 * Die Rückfrage im HAUS-MUSTER: ein Drawer mit einer FOLGENLISTE, nicht ein
 * nativer `window.confirm`.
 *
 * Der Unterschied ist nicht Kosmetik. Ein `confirm()` kann genau einen
 * Fließtext zeigen, den niemand liest, ist am Telefon ein System-Popup ohne
 * jeden Zusammenhang zur Seite - und blockiert den Renderer, während er
 * aussteht. Für die GEFÄHRLICHSTE Aktion einer Fläche (den endgültigen Not-Aus
 * eines Rollouts) war das die schwächste Form der Rückfrage, die das Portal
 * kennt, während jede Entitäts-Löschung längst eine aufgezählte Folgenliste
 * bekommt (`DangerZone`).
 *
 * Diese Komponente ist die nicht-destruktive Schwester davon: dieselbe
 * Aufzählung, aber auch für eine Umstellung passend, die man rückgängig machen
 * kann. `tone="danger"` färbt sie für die endgültigen Fälle.
 */
export function ConfirmDialog({
  open,
  title,
  intro,
  consequences,
  confirmLabel,
  cancelLabel = 'Abbrechen',
  tone = 'neutral',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** Ein Satz: was passiert, wenn bestätigt wird. */
  intro: string;
  /**
   * Die Aufzählung - der Teil, der nicht übersprungen werden darf. Sie nennt
   * bei einer Umstellung ausdrücklich auch, was GLEICH bleibt: sonst liest
   * sich jedes Umlegen wie ein Lockern der Regeln.
   */
  consequences: string[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'neutral' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  const danger = tone === 'danger';
  return (
    <Drawer
      open
      onClose={onCancel}
      title={title}
      icon={
        <IconTile category={danger ? 'industry' : 'primary'} size={40}>
          <Icon name={danger ? 'alert-triangle' : 'info'} size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'outline' : 'primary'}
            className={danger ? 'vp-btn-danger' : undefined}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{intro}</p>
      <ul
        style={{ margin: 'var(--vp-space-3) 0', paddingLeft: '1.2rem' }}
        data-testid="confirm-consequences"
      >
        {consequences.map((c) => (
          <li key={c} style={{ fontSize: 'var(--vp-text-sm)', marginBottom: '0.3rem' }}>
            {c}
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
