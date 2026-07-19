import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type Site, type SiteEntities, type SiteEntity } from '../api';
import { entitiesApi, type EntityTypeDef } from '../entitiesApi';
import {
  actuateCommands,
  entitiesSummary,
  guardRows,
  hasDrift,
  healthLabel,
  healthTone,
  isEmpty,
  measureChannels,
  syncVerdict,
} from '../entities';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { InfoTip } from '../components/InfoTip';

/**
 * The "Geräte & Entitäten" Anlage subpage (E1b): every entity of the Anlage
 * with its type, capabilities, health and guard config (read-only for
 * customers), plus the honest Soll/Ist drift and the edge-local commissioning
 * view. Platform-admins additionally create/edit/delete entities incl. guard
 * config (the registry Soll). Building on the measurementPoints seams; the
 * pure copy/verdicts live in src/entities.ts.
 */
export function EntitaetenSection({ site, isAdmin = false }: { site: Site; isAdmin?: boolean }) {
  const [data, setData] = useState<SiteEntities | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [catalog, setCatalog] = useState<EntityTypeDef[] | null>(null);
  const [drawer, setDrawer] = useState<{ mode: 'create' } | { mode: 'edit'; entity: SiteEntity } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    api.siteEntities(site.id).then(
      (d) => active && setData(d),
      () => active && setError(true),
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Admin only: the type catalog for the create palette (fail-soft).
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    entitiesApi.typeCatalog().then(
      (c) => active && setCatalog(c.types),
      () => active && setCatalog(null),
    );
    return () => {
      active = false;
    };
  }, [isAdmin, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <div className="vp-entities">
      <Card>
        <div className="vp-entities-head">
          <div>
            <h2 style={{ margin: 0 }}>Geräte &amp; Entitäten</h2>
            <p className="vp-note" style={{ marginTop: 'var(--vp-space-1)' }}>
              Alle Mess- und Steuer-Einheiten dieser Anlage - was sie können, ob sie Daten
              liefern und mit welcher Konfiguration VoltPilot sie betreibt.
            </p>
          </div>
          {isAdmin && (
            <Button variant="outline" onClick={() => setDrawer({ mode: 'create' })}>
              <Icon name="plus" size={16} /> Entität anlegen
            </Button>
          )}
        </div>

        {!data && !error && <TextSkeleton lines={4} />}
        {error && (
          <ErrorState message="Die Entitäten konnten nicht geladen werden." onRetry={reload} />
        )}
        {data && isEmpty(data) && (
          <EmptyState
            icon="cpu"
            category="primary"
            title="Noch keine Entitäten"
            description={
              isAdmin
                ? 'Legen Sie oben eine Entität an oder führen Sie den v2-Bootstrap für diese Anlage aus.'
                : 'Für diese Anlage sind noch keine Geräte-Entitäten eingerichtet.'
            }
          />
        )}

        {data && !isEmpty(data) && (
          <>
            {entitiesSummary(data) && (
              <p className="vp-entities-summary">{entitiesSummary(data)}</p>
            )}
            <RegistryDrift data={data} />
            <div className="vp-entity-cards">
              {data.entities.map((e) => (
                <EntityCard
                  key={e.id}
                  entity={e}
                  isAdmin={isAdmin}
                  onEdit={() => setDrawer({ mode: 'edit', entity: e })}
                  onDeleted={reload}
                  siteId={site.id}
                />
              ))}
            </div>
            <LocalSetup data={data} />
          </>
        )}
      </Card>

      {isAdmin && drawer && (
        <EntityDrawer
          siteId={site.id}
          catalog={catalog ?? []}
          state={drawer}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** The registry drift banner: pending changes + entities not yet on the device. */
function RegistryDrift({ data }: { data: SiteEntities }) {
  const drifting = data.entities.filter((e) => hasDrift(e.syncStatus));
  const stale = data.staleOnDevice;
  if (data.registry == null) {
    return (
      <div className="vp-alert" style={{ marginTop: 0 }}>
        Diese Anlage wurde noch nicht an das Gerät übertragen.
      </div>
    );
  }
  if (drifting.length === 0 && stale.length === 0) return null;
  return (
    <div className="vp-alert vp-alert-warn" role="status" style={{ marginTop: 0 }}>
      {drifting.length > 0 && (
        <div>
          {drifting.length === 1
            ? 'Eine Änderung wird gerade an das Gerät übertragen.'
            : `${drifting.length} Änderungen werden gerade an das Gerät übertragen.`}
        </div>
      )}
      {stale.length > 0 && (
        <div>
          Das Gerät meldet noch {stale.length}{' '}
          {stale.length === 1 ? 'Entität' : 'Entitäten'}, die hier entfernt wurden - sie
          verschwindet beim nächsten Abgleich.
        </div>
      )}
    </div>
  );
}

function EntityCard({
  entity,
  isAdmin,
  onEdit,
  onDeleted,
  siteId,
}: {
  entity: SiteEntity;
  isAdmin: boolean;
  onEdit: () => void;
  onDeleted: () => void;
  siteId: string;
}) {
  const [busy, setBusy] = useState(false);
  const verdict = syncVerdict(entity.syncStatus);
  const measures = measureChannels(entity);
  const actuates = actuateCommands(entity);
  const guards = guardRows(entity);

  async function remove() {
    if (!window.confirm(`Entität „${entity.label ?? entity.typeLabel}" wirklich entfernen?`)) return;
    setBusy(true);
    try {
      await entitiesApi.remove(siteId, entity.id);
      onDeleted();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="vp-entity-card">
      <div className="vp-entity-card-head">
        <div className="vp-entity-title">
          <span className={`vp-health-dot vp-health-${healthTone(entity.observed)}`} />
          <div>
            <div className="vp-entity-name">{entity.label ?? entity.typeLabel}</div>
            <div className="vp-entity-sub">
              {entity.typeLabel}
              {entity.control && <span className="vp-entity-control"> · steuerbar</span>}
            </div>
          </div>
        </div>
        <Badge variant={verdict.tone === 'pending' ? 'tint' : verdict.tone} dot title={verdict.detail}>
          {verdict.label}
        </Badge>
      </div>

      <div className="vp-entity-health">
        {healthLabel(entity.observed)}
        {entity.observed?.lastTelemetryAt && entity.observed.health !== 'ok' && (
          <span className="vp-muted">
            {' '}
            · zuletzt {new Date(entity.observed.lastTelemetryAt).toLocaleString('de-DE')}
          </span>
        )}
      </div>

      {measures.length > 0 && (
        <div className="vp-entity-caps">
          <span className="vp-entity-caps-label">Misst</span>
          {measures.map((c) => (
            <span key={c} className="vp-chip-static">
              {c}
            </span>
          ))}
        </div>
      )}
      {actuates.length > 0 && (
        <div className="vp-entity-caps">
          <span className="vp-entity-caps-label">Steuert</span>
          {actuates.map((c) => (
            <span key={c} className="vp-chip-static">
              {c}
            </span>
          ))}
        </div>
      )}

      {guards.length > 0 && (
        <dl className="vp-kv-list vp-entity-guards">
          {guards.map((g) => (
            <div key={g.label} className="vp-kv-row">
              <dt>{g.label}</dt>
              <dd>{g.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {isAdmin && (
        <div className="vp-entity-actions">
          <Button variant="ghost" onClick={onEdit}>
            <Icon name="pencil" size={14} /> Bearbeiten
          </Button>
          <Button variant="ghost" className="vp-btn-danger" onClick={remove} disabled={busy}>
            <Icon name="trash" size={14} /> Entfernen
          </Button>
        </div>
      )}
    </div>
  );
}

/** The edge-authoritative commissioning view (never auto-imported). */
function LocalSetup({ data }: { data: SiteEntities }) {
  if (data.localSetup.length === 0) return null;
  return (
    <div className="vp-local-setup">
      <h3 className="vp-entity-subhead">
        Vor Ort eingerichtet
        <InfoTip label="Was heißt vor Ort eingerichtet?">
          Am Gerät (:8484) eingerichtete Wechselrichter und Quellen. VoltPilot zeigt sie zum
          Abgleich, übernimmt sie aber nicht automatisch.
        </InfoTip>
      </h3>
      <ul className="vp-local-setup-list">
        {data.localSetup.map((l) => (
          <li key={l.id}>
            <Icon name={l.kind === 'inverter' ? 'cpu' : 'sun'} size={16} />
            <span>{l.label ?? l.id}</span>
            <span className="vp-muted">{l.kind === 'inverter' ? 'Wechselrichter' : 'Quelle'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type DrawerState = { mode: 'create' } | { mode: 'edit'; entity: SiteEntity };

/** Admin create/edit drawer incl. guard config (the registry Soll). */
function EntityDrawer({
  siteId,
  catalog,
  state,
  onClose,
  onSaved,
}: {
  siteId: string;
  catalog: EntityTypeDef[];
  state: DrawerState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = state.mode === 'edit';
  const editEntity = editing ? state.entity : null;
  // Only non-composed catalog types are creatable directly (composed pilot
  // types come from master data + the bootstrap).
  const creatable = catalog.filter((t) => !t.composed);
  const [entityType, setEntityType] = useState(
    editEntity?.entityType ?? creatable[0]?.type ?? '',
  );
  const [label, setLabel] = useState(editEntity?.label ?? '');
  const [maxPowerKw, setMaxPowerKw] = useState(
    editEntity?.guards?.limits?.max_consumption_kw != null
      ? String(editEntity.guards.limits.max_consumption_kw)
      : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedType = catalog.find((t) => t.type === entityType) ?? null;
  const composedEdit = editing && selectedType?.composed;

  async function submit() {
    setBusy(true);
    setError(null);
    const power = maxPowerKw.trim() === '' ? undefined : Number(maxPowerKw.replace(',', '.'));
    if (power !== undefined && (Number.isNaN(power) || power < 0)) {
      setError('Bitte geben Sie eine gültige Leistung in kW an.');
      setBusy(false);
      return;
    }
    try {
      if (editing) {
        await entitiesApi.update(siteId, editEntity!.id, {
          label: label.trim() || null,
          maxPowerKw: composedEdit ? undefined : power ?? null,
        });
      } else {
        await entitiesApi.create(siteId, {
          entityType,
          label: label.trim() || undefined,
          maxPowerKw: power,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Die Entität konnte nicht gespeichert werden.');
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={editing ? 'Entität bearbeiten' : 'Entität anlegen'}
      icon={<Icon name="cpu" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={submit} disabled={busy || (!editing && !entityType)}>
            {editing ? 'Speichern' : 'Anlegen'}
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        {!editing && (
          <label className="vp-field">
            <span>Typ</span>
            <select
              className="vp-select"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
            >
              {creatable.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {editing && (
          <p className="vp-note" style={{ marginTop: 0 }}>
            Typ: <strong>{editEntity!.typeLabel}</strong>
          </p>
        )}

        <Input
          label="Bezeichnung"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="z. B. Wallbox Carport"
        />

        {composedEdit ? (
          <p className="vp-note">
            Die Konfiguration dieses Typs wird aus den Stammdaten der Anlage abgeleitet und ist
            hier nicht änderbar.
          </p>
        ) : (
          <Input
            label="Rated Leistung (kW)"
            value={maxPowerKw}
            onChange={(e) => setMaxPowerKw(e.target.value)}
            placeholder="z. B. 11"
            inputMode="decimal"
          />
        )}

        {error && (
          <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 0 }}>
            {error}
          </div>
        )}
      </div>
    </Drawer>
  );
}
