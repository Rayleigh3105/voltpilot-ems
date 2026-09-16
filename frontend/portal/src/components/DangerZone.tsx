import { useRollen } from '../rollen';
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';

const DANGER = 'var(--vp-industry-end)';

/**
 * Destructive-action section for detail drawers (the entity pattern's delete
 * flow). Collapsed to a single red outline button; expanding it shows the
 * explicit consequence list and - for the most destructive actions - a
 * type-to-confirm input. Nothing happens until the confirm button inside the
 * expanded panel is pressed.
 */
export function DangerZone({
  actionLabel,
  recht,
  standort,
  description,
  consequences,
  confirmLabel,
  typeToConfirm,
  disabledReason,
  variant = 'section',
  busy,
  error,
  onConfirm,
}: {
  /** The collapsed button text, e.g. "Standort löschen". */
  actionLabel: string;
  /** Recht am aktuellen Standort; Plattform-Verwaltung hat ihren eigenen Zaun. */
  recht?: string;
  standort?: string | null;
  /**
   * One German sentence saying what this does. Omit it in the `inline`
   * variant when the surrounding text already says it - repeating it there
   * reads as noise, and the consequence list is the part that must not be
   * skipped.
   */
  description?: string;
  /** The explicit list of consequences shown before confirming. */
  consequences: string[];
  /** The final confirm button text, e.g. "Endgültig löschen". */
  confirmLabel: string;
  /** When set, the user must type this exact value to unlock the confirm. */
  typeToConfirm?: string;
  /** When set, the action is blocked and this explains why (no button shown). */
  disabledReason?: string | null;
  /**
   * `section` (default) is the drawer-footer block with its own separator.
   * `inline` drops the separator + top margin so the SAME confirm flow can sit
   * inside an alert or a row - one consequence component, never a second
   * hand-rolled one next to it (the E3 Nebenwirkungs-Regel).
   */
  variant?: 'section' | 'inline';
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const confirmBlocked = typeToConfirm != null && typed.trim() !== typeToConfirm;
  const inline = variant === 'inline';
  const rollen = useRollen();
  if (recht && !rollen.darf(recht, standort)) return <p className="vp-muted">{rollen.grund}</p>;

  return (
    <div
      style={
        inline
          ? { marginTop: 'var(--vp-space-3)' }
          : {
              marginTop: 'var(--vp-space-6)',
              borderTop: '1px solid var(--vp-border)',
              paddingTop: 'var(--vp-space-4)',
            }
      }
    >
      {description && <p className="vp-note" style={{ marginTop: 0 }}>{description}</p>}

      {disabledReason ? (
        <div className="vp-alert vp-alert-info" style={{ marginTop: 'var(--vp-space-3)' }}>
          {disabledReason}
        </div>
      ) : !open ? (
        <Button
          variant="outline"
          size="sm"
          iconLeft={<Icon name="trash" size={16} />}
          onClick={() => setOpen(true)}
          style={{ color: DANGER, borderColor: DANGER }}
        >
          {actionLabel}
        </Button>
      ) : (
        <div
          style={{
            border: `1px solid ${DANGER}`,
            borderRadius: 'var(--vp-radius-sm)',
            padding: 'var(--vp-space-4)',
          }}
        >
          <p style={{ margin: 0, fontWeight: 600, color: DANGER }}>
            Das wird gelöscht - endgültig:
          </p>
          <ul style={{ margin: 'var(--vp-space-3) 0', paddingLeft: '1.2rem' }}>
            {consequences.map((c) => (
              <li key={c} style={{ fontSize: 'var(--vp-text-sm)', marginBottom: '0.3rem' }}>
                {c}
              </li>
            ))}
          </ul>
          {typeToConfirm != null && (
            <Input
              label={`Zur Bestätigung „${typeToConfirm}" eintippen`}
              placeholder={typeToConfirm}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)}
            />
          )}
          {error && <div className="vp-alert vp-alert-err">{error}</div>}
          <div
            style={{
              display: 'flex',
              gap: 'var(--vp-space-2)',
              justifyContent: 'flex-end',
              marginTop: 'var(--vp-space-4)',
            }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                setTyped('');
              }}
              disabled={busy}
            >
              Abbrechen
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onConfirm}
              disabled={busy || confirmBlocked}
              style={{ background: DANGER, boxShadow: 'none' }}
            >
              {busy ? 'Wird gelöscht…' : confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
