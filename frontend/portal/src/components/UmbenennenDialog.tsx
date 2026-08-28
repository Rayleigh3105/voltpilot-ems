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
import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { ApiError } from '../api';
import { entitiesApi } from '../entitiesApi';
import { CenteredConfirmDialog } from './CenteredConfirmDialog';
import { registerNavigationBlocker, type BlockedNavigation } from '../navigationBlocker';
import './AnlegenFlow.css';
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
  inline = false,
  siteName,
  geraetKennung,
  onClose,
  onSaved,
}: {
  siteId: string;
  target: RenameTarget;
  /** Auf einer Geräteseite bleibt die Eingabe im Seitenkontext statt im Drawer. */
  inline?: boolean;
  siteName?: string;
  geraetKennung?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  // The field carries the ALIAS, not the rendered name: an empty field then
  // honestly means „no own name yet", and the placeholder shows what VoltPilot
  // would call it — the fallback is visible BEFORE typing.
  const [label, setLabel] = useState(target.alias ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<BlockedNavigation | null>(null);
  const changed = label.trim() !== (target.alias ?? '').trim();

  /* Auch die schmale OCPP-Variante verliert Eingaben nie lautlos. */
  useEffect(() => {
    if (!inline || !changed) return undefined;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const unregister = registerNavigationBlocker((navigation) => {
      if (busy) return;
      setPendingNavigation(navigation);
      setDiscardOpen(true);
    });
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [busy, changed, inline]);

  async function save(next: string | null) {
    if (busy) return;
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

  function closeInline() {
    if (busy) return;
    setPendingNavigation(null);
    if (changed) setDiscardOpen(true);
    else onClose();
  }

  function discard() {
    if (busy) return;
    const navigation = pendingNavigation;
    setDiscardOpen(false);
    setPendingNavigation(null);
    onClose();
    if (navigation) window.setTimeout(navigation.resume, 0);
  }

  if (inline) {
    const shownName = target.alias?.trim() || target.derivedLabel;
    return (
      <section className="vp-geraet-edit" data-testid="geraet-bearbeiten" aria-busy={busy}>
        <header className="vp-geraet-edit-head">
          <div>
            <p className="vp-geraet-edit-eyebrow">Bearbeitungsmodus</p>
            <h1>{shownName} bearbeiten</h1>
            <p>In dieser kompakten Bearbeitung ändern Sie nur den Anzeigenamen dieser Komponente.</p>
          </div>
        </header>

        <div className="vp-geraet-edit-grid">
          <section className="vp-geraet-edit-card" aria-labelledby="geraet-rename-allgemein">
            <div className="vp-geraet-edit-cardhead">
              <div>
                <h2 id="geraet-rename-allgemein">Allgemeine Angaben</h2>
                <p>Der Name ist reine Darstellung – Verbindung und Steuerung bleiben unverändert.</p>
              </div>
            </div>
            <div className="vp-rename-inline-field">
              <Input
                label="Anzeigename"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={target.derivedLabel}
                maxLength={200}
                disabled={busy}
                autoFocus
                hint="Leer lassen, um wieder die technische Bezeichnung anzuzeigen."
              />
            </div>
            {target.alias && label !== '' && (
              <div className="vp-rename-reset">
                <Button variant="ghost" onClick={() => setLabel('')} disabled={busy}>
                  Eigenen Namen zurücksetzen
                </Button>
                <span className="vp-note">
                  Nach dem Speichern zeigt VoltPilot wieder „{target.derivedLabel}“.
                </span>
              </div>
            )}
          </section>

          <aside className="vp-geraet-edit-card vp-geraet-edit-identity" aria-labelledby="geraet-rename-identitaet">
            <div className="vp-geraet-edit-cardhead">
              <div>
                <h2 id="geraet-rename-identitaet">Geräteidentität</h2>
                <p>Technische Daten und Gerätezuordnung bleiben unverändert.</p>
              </div>
            </div>
            <dl>
              <div><dt>Geräte-ID</dt><dd className="vp-mono">{geraetKennung || target.derivedLabel}</dd></div>
              <div><dt>Standort</dt><dd>{siteName || 'Dieser Standort'}<small>Feste Zuordnung</small></dd></div>
            </dl>
          </aside>
        </div>

        {error && <div className="vp-alert vp-alert-err" role="alert">{error}</div>}

        <div className="vp-geraet-edit-actions">
          <p aria-live="polite">{changed ? '1 Änderung bereit' : 'Noch keine Änderung'}</p>
          <div>
            <Button variant="ghost" onClick={closeInline} disabled={busy}>Abbrechen</Button>
            <Button onClick={() => void save(label.trim() || null)} disabled={busy || !changed}>
              {busy ? 'Speichere …' : 'Änderungen speichern'}
            </Button>
          </div>
        </div>

        <CenteredConfirmDialog
          open={discardOpen}
          title="Änderung verwerfen?"
          intro="Der neue Anzeigename wurde noch nicht gespeichert."
          consequences={['Die Eingabe geht verloren.', 'Der bisherige Anzeigename bleibt unverändert.']}
          confirmLabel="Änderung verwerfen"
          tone="danger"
          busy={busy}
          onCancel={() => { setDiscardOpen(false); setPendingNavigation(null); }}
          onConfirm={discard}
        />
      </section>
    );
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
