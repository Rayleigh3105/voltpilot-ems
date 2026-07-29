import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { ApiError, type EntityLocalSetup, type SiteEntity, type SiteSource } from '../api';
import { entitiesApi } from '../entitiesApi';
import {
  assignChoices,
  currentChoice,
  deleteConsequences,
  swapNote,
  type AssignChoice,
  type ComponentHealth,
  type PlantComponent,
} from '../komponenten';
import { ADOPT_FORBIDDEN_MSG } from '../setupPath';

/**
 * Die BEREINIGUNG an der Komponente selbst (vp-bereinigung-ui-k3).
 *
 * Vorher führte der einzige Weg zurück über den „Wieder verbinden"-Fluss eines
 * NEU gemeldeten Geräts (PR #271) — auf einer voll verpinnten Anlage gibt es
 * kein neues Gerät, also war die Bereinigung schlicht nicht erreichbar („Wie
 * kann ich das Gerät was nichts misst löschen, ich bekomme es nicht weg."). Die
 * beiden Hebel hängen deshalb jetzt an der Komponente:
 *
 *  - {@link ZuordnungAendernDialog}: welches gemeldete Gerät diese Komponente
 *    misst — inklusive geführtem TAUSCH, wenn das Wunschgerät schon zu einer
 *    anderen Komponente gehört. Der Tausch läuft SERVERSEITIG in einem Zug
 *    (eine Transaktion), damit niemand halb getauscht stranden kann.
 *  - {@link KomponenteLoeschenDialog}: die Komponente wirklich entfernen, mit
 *    einer Folgenliste in Kundendeutsch (inkl. kWp-Hinweis).
 *
 * Beides sind reine Render-Flächen: jede Ableitung/Formulierung lebt in
 * `komponenten.ts` (`assignChoices` / `swapNote` / `deleteConsequences`).
 */

const HEALTH_TONE: Record<ComponentHealth, 'ok' | 'warn' | 'off'> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  unknown: 'off',
};

/** 401/403/404 = die Kundenroute fehlt (älteres Backend) → ehrlicher Hinweis. */
function messageFor(e: unknown, fallback: string): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 401 || status === 403) return ADOPT_FORBIDDEN_MSG;
  return e instanceof ApiError && e.message ? e.message : fallback;
}

export function ZuordnungAendernDialog({
  siteId,
  component,
  entities,
  localSetup,
  sources,
  onClose,
  onSaved,
}: {
  siteId: string;
  component: PlantComponent;
  entities: SiteEntity[];
  localSetup: EntityLocalSetup[];
  sources?: SiteSource[] | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const choices = assignChoices(component, entities, localSetup, sources);
  const own = currentChoice(choices);
  const [picked, setPicked] = useState<string>(own?.sourceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen: AssignChoice | undefined = choices.find((c) => c.sourceId === picked);
  const note = chosen ? swapNote(chosen, own) : null;

  async function save() {
    if (!chosen || chosen.current) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // `swap` gilt nur, wenn das Zielgerät belegt ist — sonst ist es ein
      // gewöhnliches Verbinden. Der Server tauscht beide Zuordnungen in EINER
      // Transaktion; einen Zwischenschritt gibt es bewusst nicht.
      await entitiesApi.repin(siteId, component.entityId, chosen.sourceId, {
        swap: chosen.heldByLabel != null,
      });
      onSaved();
    } catch (e) {
      setError(messageFor(e, 'Die Zuordnung konnte nicht geändert werden.'));
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="Zuordnung ändern"
      icon={<Icon name="link" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={save} disabled={busy || !chosen || chosen.current}>
            Übernehmen
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <p className="vp-note" style={{ marginTop: 0 }}>
          Welches Gerät misst <strong>„{component.label}“</strong>?
        </p>

        {choices.length === 0 ? (
          <p className="vp-note">
            Ihr Gerät meldet gerade kein passendes Messgerät. Sobald sich eines meldet, können Sie
            es hier zuordnen.
          </p>
        ) : (
          <div className="vp-zuo-list" role="radiogroup" aria-label="Gerät wählen">
            {choices.map((c) => (
              <label
                key={c.sourceId}
                className={`vp-zuo-opt${picked === c.sourceId ? ' picked' : ''}`}
              >
                <input
                  type="radio"
                  name="vp-zuo-choice"
                  value={c.sourceId}
                  checked={picked === c.sourceId}
                  onChange={() => setPicked(c.sourceId)}
                />
                <span className="vp-zuo-body">
                  <span className="vp-zuo-name">
                    <span className={`vp-health-dot vp-health-${HEALTH_TONE[c.health]}`} />
                    {c.label}
                    {c.current && <em className="vp-zuo-tag">aktuell zugeordnet</em>}
                  </span>
                  <span className="vp-zuo-sub">
                    {c.valueLabel ? `misst gerade ${c.valueLabel}` : 'meldet gerade keinen Wert'}
                    {c.heldByLabel && ` · gehört derzeit zu „${c.heldByLabel}“`}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {note && (
          <div className="vp-alert vp-alert-warn" role="status">
            {note}
          </div>
        )}

        <p className="vp-note vp-zuordnen-hint">
          Die Zuordnung ist reine Darstellung — sie ändert nie die Steuerung.
        </p>

        {error && (
          <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 0 }}>
            {error}
          </div>
        )}
      </div>
    </Drawer>
  );
}

export function KomponenteLoeschenDialog({
  siteId,
  component,
  entities,
  localSetup,
  onClose,
  onDeleted,
}: {
  siteId: string;
  component: PlantComponent;
  entities: SiteEntity[];
  localSetup: EntityLocalSetup[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const entity = entities.find((e) => e.id === component.entityId);
  const pinned = assignChoices(component, entities, localSetup).find((c) => c.current);
  const { lines, kwpNote } = deleteConsequences(component, entity, pinned?.label ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await entitiesApi.removeComponent(siteId, component.entityId);
      onDeleted();
    } catch (e) {
      setError(messageFor(e, 'Die Komponente konnte nicht entfernt werden.'));
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="Komponente löschen"
      icon={<Icon name="trash" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="ghost" className="vp-btn-danger" onClick={remove} disabled={busy}>
            Endgültig löschen
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <p style={{ marginTop: 0 }}>
          Soll <strong>„{component.label}“</strong> wirklich entfernt werden?
        </p>
        <ul className="vp-loesch-list">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
          {kwpNote && <li>{kwpNote}</li>}
        </ul>
        {error && (
          <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 0 }}>
            {error}
          </div>
        )}
      </div>
    </Drawer>
  );
}
