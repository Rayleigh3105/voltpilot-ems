/**
 * „Komponente umbenennen" — the ONE rename mask (concept `vp-entity-alias-k1`
 * §5: two ways in, no second mask).
 *
 * Entry points: the pencil on every component row of the Anlagen-Modell (the
 * place you MANAGE your plant) and the pencil on the PV-Zusammensetzung rows in
 * the cockpit (the place the wish is born, looking at the list).
 *
 * Its input is a narrow, own type rather than a `PlantComponent`: the two
 * surfaces derive their rows from different server aggregates, and tying the
 * dialog to one of them would either fork it (two truths about one name) or
 * chain it to that aggregate — the `DrawerDevice` precedent from M6.
 */
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { ApiError } from '../api';
import { entitiesApi } from '../entitiesApi';
import './UmbenennenDialog.css';

/** What the dialog needs to know about the thing being named. */
export interface RenameTarget {
  /** The v2 entity whose label is written. */
  entityId: string;
  /** The customer's own name today, or null when they gave none. */
  alias: string | null;
  /** What VoltPilot calls it WITHOUT an own name (placeholder + reset hint). */
  derivedLabel: string;
}

/** The honesty line, verbatim since M6 — the promise the route keeps by construction. */
export const RENAME_HONESTY = 'Der Name ist reine Darstellung — er ändert nie die Steuerung.';

export function UmbenennenDialog({
  siteId,
  target,
  onClose,
  onSaved,
}: {
  siteId: string;
  target: RenameTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  // The field carries the ALIAS, not the rendered name: an empty field then
  // honestly means „no own name yet", and the placeholder shows what VoltPilot
  // would call it — the fallback is visible BEFORE typing.
  const [label, setLabel] = useState(target.alias ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      await entitiesApi.rename(siteId, target.entityId, next);
      onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : 'Der Name konnte nicht gespeichert werden.',
      );
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="Komponente umbenennen"
      icon={<Icon name="pencil" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={() => save(label.trim() || null)} disabled={busy}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <Input
          label="Eigener Name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={target.derivedLabel}
          maxLength={200}
        />
        <p className="vp-note vp-zuordnen-hint">{RENAME_HONESTY}</p>
        {/* R5: clearing means falling BACK, never an empty name — so the offer
            names the name that returns, and only exists when there is one to
            undo. */}
        {target.alias && (
          <div className="vp-rename-reset">
            <Button variant="ghost" onClick={() => save(null)} disabled={busy}>
              Zurücksetzen
            </Button>
            <span className="vp-note">
              Ohne eigenen Namen zeigt VoltPilot wieder „{target.derivedLabel}“.
            </span>
          </div>
        )}
        {error && (
          <div className="vp-alert vp-alert-err" role="alert">
            {error}
          </div>
        )}
      </div>
    </Drawer>
  );
}
