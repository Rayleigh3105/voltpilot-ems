import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  ApiError,
  type EntityStrategy,
  type Site,
  type SiteEntities,
  type SiteEntity,
  type SiteTopology,
} from '../api';
import { channelLabel, commandLabel } from '../channels';
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
  parseChannelList,
  syncVerdict,
} from '../entities';
import {
  type AdoptableSource,
  type Role,
  type RoleBox,
  ROLE_LABELS,
  adoptableSources,
  adoptedSources,
  assignToRole,
  assignableCapabilities,
  inverterSetup,
  isAutoAssigned,
  resetAssignments,
  roleBoxes,
  rolePillsFor,
  setPrimaryAssignment,
  sourceRoleLabel,
  suggestEntityType,
} from '../rollen';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { InfoTip } from '../components/InfoTip';
import { fmtNum } from '../format';

/**
 * The U2 "Geräte" area (design data/vp-ems-ui-overhaul/report.md §3) - the
 * first-class per-Anlage entity screen, promoted into the tab bar (U1). Three
 * sections, top to bottom:
 *   1. Ihre Geräte - the entity cards + their assigned role pills (topology) +
 *      strategy chips (which active flows touch each entity).
 *   2. Rollen & Zuordnung - the AE0-mockup role boxes over the AE1 backend:
 *      one box per role with member chips, Σ aggregate, maßgeblich ✓ on the
 *      primary, and "＋ zuordnen". Customers write via the RLS-fenced
 *      /sites/{id}/topology-roles (a role never widens control).
 *   3. Vom Gerät gemeldet - the adoption bridge: edge-reported sources with no
 *      entity yet, adoptable in one click (admin-only first increment).
 * Plus the honest plumbing links + the edge-local commissioning view.
 *
 * All copy/verdicts are the pure src/rollen.ts + src/entities.ts.
 */
export function EntitaetenSection({ site, isAdmin = false }: { site: Site; isAdmin?: boolean }) {
  const [data, setData] = useState<SiteEntities | null>(null);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]>>({});
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [catalog, setCatalog] = useState<EntityTypeDef[] | null>(null);
  const [drawer, setDrawer] = useState<{ mode: 'create' } | { mode: 'edit'; entity: SiteEntity } | null>(
    null,
  );
  const [adopt, setAdopt] = useState<AdoptableSource | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    api.siteEntities(site.id).then(
      (d) => active && setData(d),
      () => active && setError(true),
    );
    // Topology + strategies fail soft (a v1/un-migrated site simply lacks them).
    api.topology(site.id).then(
      (t) => active && setTopology(t),
      () => active && setTopology(null),
    );
    api.entityStrategies(site.id).then(
      (s) => active && setStrategies(s ?? {}),
      () => active && setStrategies({}),
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Admin only: the type catalog for the create/adopt palette (fail-soft).
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

  const localSetup = data?.localSetup ?? [];
  const reported = adoptableSources(localSetup);
  const alreadyAdopted = adoptedSources(localSetup);
  const inverters = inverterSetup(localSetup);
  const hasGemeldet = reported.length > 0 || alreadyAdopted.length > 0 || inverters.length > 0;

  return (
    <div className="vp-entities">
      {/* Section 1 — Ihre Geräte */}
      <Card>
        <div className="vp-entities-head">
          <div>
            <h2 style={{ margin: 0 }}>Ihre Geräte</h2>
            <p className="vp-note" style={{ marginTop: 'var(--vp-space-1)' }}>
              Alle Mess- und Steuer-Einheiten dieser Anlage - was sie können, welche Rolle sie
              spielen und welche Steuerung auf sie wirkt.
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
            title="Noch keine Geräte"
            description={
              isAdmin
                ? 'Legen Sie oben eine Entität an, übernehmen Sie ein vom Gerät gemeldetes Gerät oder führen Sie den v2-Bootstrap aus.'
                : 'Für diese Anlage sind noch keine Geräte eingerichtet. Sobald Ihr Gerät sich meldet, erscheinen sie hier.'
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
                  topology={topology}
                  strategies={strategies[e.id] ?? []}
                  siteId={site.id}
                  onEdit={() => setDrawer({ mode: 'edit', entity: e })}
                  onDeleted={reload}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Section 2 — Rollen & Zuordnung */}
      <RollenZuordnung
        siteId={site.id}
        topology={topology}
        onChanged={setTopology}
      />

      {/* Section 3 — Vom Gerät gemeldet (adoption bridge) */}
      {hasGemeldet && (
        <VomGeraetGemeldet
          reported={reported}
          adopted={alreadyAdopted}
          inverters={inverters}
          isAdmin={isAdmin}
          onAdopt={setAdopt}
        />
      )}

      {/* Bottom — honest plumbing links */}
      <Card className="vp-plumbing">
        <h3 className="vp-entity-subhead" style={{ marginTop: 0 }}>
          Physische Verbindung
        </h3>
        <p className="vp-note" style={{ marginTop: 0 }}>
          Wechselrichter, Zähler und weitere Quellen werden direkt am Gerät eingerichtet - über die
          Geräteseite <strong>„Meine Anlage"</strong> (Adresse <code>:8484</code> im lokalen Netz).
          VoltPilot übernimmt die dort gemeldeten Geräte oben unter „Vom Gerät gemeldet".
        </p>
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
      {isAdmin && adopt && (
        <AdoptDrawer
          siteId={site.id}
          source={adopt}
          catalog={catalog ?? []}
          onClose={() => setAdopt(null)}
          onAdopted={() => {
            setAdopt(null);
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
  topology,
  strategies,
  siteId,
  onEdit,
  onDeleted,
}: {
  entity: SiteEntity;
  isAdmin: boolean;
  topology: SiteTopology | null;
  strategies: EntityStrategy[];
  siteId: string;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const verdict = syncVerdict(entity.syncStatus);
  const measures = measureChannels(entity);
  const actuates = actuateCommands(entity);
  const guards = guardRows(entity);
  const pills = topology ? rolePillsFor(entity.id, topology) : [];

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

      {pills.length > 0 && (
        <div className="vp-role-pills" aria-label="Rollen">
          {pills.map((p) => (
            <span key={p.role} className={`vp-role-pill vp-role-${p.role}`}>
              {p.label}
              {p.primary && <span className="vp-role-pill-star" title="maßgeblich"> ✓</span>}
            </span>
          ))}
        </div>
      )}

      {strategies.length > 0 && (
        <div className="vp-strategy-chips">
          <span className="vp-entity-caps-label">Steuerung</span>
          {strategies.map((s) => (
            <a key={s.flowId} className="vp-strategy-chip" href={`#/anlage/${siteId}/steuerung`}>
              <Icon name="settings" size={12} /> {s.flowName}
            </a>
          ))}
        </div>
      )}

      <div className="vp-entity-health">
        {healthLabel(entity.observed)}
        {entity.observed?.lastTelemetryAt && entity.observed.health !== 'ok' && (
          <span className="vp-muted">
            {' '}
            · zuletzt {new Date(entity.observed.lastTelemetryAt).toLocaleString('de-DE')}
          </span>
        )}
      </div>

      {/* Plain-German capability names; the raw channel/command identifier is
          kept as the chip's title (support/debug) but never in the copy. An
          unknown channel falls back to its raw name (channels.ts). */}
      {measures.length > 0 && (
        <div className="vp-entity-caps">
          <span className="vp-entity-caps-label">Misst</span>
          {measures.map((c) => (
            <span key={c} className="vp-chip-static" title={c}>
              {channelLabel(c)}
            </span>
          ))}
        </div>
      )}
      {actuates.length > 0 && (
        <div className="vp-entity-caps">
          <span className="vp-entity-caps-label">Steuert</span>
          {actuates.map((c) => (
            <span key={c} className="vp-chip-static" title={c}>
              {commandLabel(c)}
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

/** One member value formatted (kW, or % for SoC). */
function memberValue(value: number | null, unit: string | null, isSoc: boolean): string {
  if (value == null) return '—';
  if (isSoc) return `${fmtNum(value, '%', 0)}`;
  return fmtNum(value, unit ?? 'kW', 2);
}

/**
 * Section 2: the "Rollen & Zuordnung" screen over the AE1 topology backend. One
 * box per role, member chips, Σ + maßgeblich, "＋ zuordnen". Writes go through
 * the RLS-fenced customer endpoint; the recomputed read-model is lifted back up
 * (onChanged) so the whole area stays in sync.
 */
function RollenZuordnung({
  siteId,
  topology,
  onChanged,
}: {
  siteId: string;
  topology: SiteTopology | null;
  onChanged: (t: SiteTopology) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<Role | null>(null);

  if (!topology || topology.entities.length === 0) {
    // A v1 / un-migrated site: no entity graph yet - the calm fallback.
    return null;
  }

  const boxes = roleBoxes(topology);
  const auto = isAutoAssigned(topology);

  async function apply(assignments: Parameters<typeof api.setTopologyRoles>[1]) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setTopologyRoles(siteId, assignments);
      onChanged(next);
      setPicker(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Die Zuordnung konnte nicht gespeichert werden.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="vp-rollen">
      <div className="vp-entities-head">
        <div>
          <h2 style={{ margin: 0 }}>Rollen &amp; Zuordnung</h2>
          <p className="vp-note" style={{ marginTop: 'var(--vp-space-1)' }}>
            Welche Messung zählt wozu - PV-Erzeugung, Speicher, Netz, Verbraucher. VoltPilot ordnet
            automatisch zu; hier können Sie es anpassen.{' '}
            <InfoTip label="Was bedeutet die Zuordnung?">
              Die Rolle bestimmt nur, wie eine Messung in der Übersicht dargestellt und
              zusammengefasst wird. Sie verändert nie die Steuerung.
            </InfoTip>
          </p>
        </div>
        {!auto && (
          <Button variant="ghost" onClick={() => apply(resetAssignments(topology))} disabled={busy}>
            Automatisch zuordnen
          </Button>
        )}
      </div>

      {auto && (
        <p className="vp-rollen-auto">
          <Icon name="check" size={14} /> Automatisch zugeordnet
        </p>
      )}
      {error && (
        <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 0 }}>
          {error}
        </div>
      )}

      <div className="vp-role-boxes">
        {boxes.map((box) => (
          <RoleBoxCard
            key={box.role}
            box={box}
            busy={busy}
            picking={picker === box.role}
            assignable={picker === box.role ? assignableCapabilities(topology, box.role) : []}
            onOpenPicker={() => setPicker(picker === box.role ? null : box.role)}
            onAssign={(entityId, channel) => apply(assignToRole(entityId, channel, box.role))}
            onSetPrimary={(entityId, channel) =>
              apply(setPrimaryAssignment(entityId, channel, box.role))
            }
          />
        ))}
      </div>
    </Card>
  );
}

function RoleBoxCard({
  box,
  busy,
  picking,
  assignable,
  onOpenPicker,
  onAssign,
  onSetPrimary,
}: {
  box: RoleBox;
  busy: boolean;
  picking: boolean;
  assignable: ReturnType<typeof assignableCapabilities>;
  onOpenPicker: () => void;
  onAssign: (entityId: string, channel: string) => void;
  onSetPrimary: (entityId: string, channel: string) => void;
}) {
  const showPrimary = box.members.filter((m) => !m.isSoc).length > 1;
  return (
    <div className={`vp-role-box vp-role-${box.role}`}>
      <div className="vp-role-box-head">
        <span className="vp-role-box-name">{box.label}</span>
        {box.sumKw != null && (
          <span className="vp-role-sum">
            Σ {fmtNum(box.sumKw, 'kW', 2)}
            {box.socPct != null && <span className="vp-role-soc"> · {fmtNum(box.socPct, '%', 0)}</span>}
          </span>
        )}
      </div>
      <ul className="vp-role-members">
        {box.members.map((m) => (
          <li key={m.entityId + m.channel} className={`vp-role-member${m.primary ? ' primary' : ''}`}>
            <span className="vp-role-member-main">
              <span className="vp-role-member-name">
                {m.entityLabel}
                {/* One device can feed a role with SEVERAL measurements (a
                    hybrid inverter: Ladestand + Batterieleistung). Naming the
                    measurement is what keeps those rows apart (G5). */}
                {m.needsChannelLabel && (
                  <span className="vp-role-member-chan"> · {m.channelLabel}</span>
                )}
              </span>
              <span className="vp-muted">{memberValue(m.value, m.unit, m.isSoc)}</span>
            </span>
            {m.primary && !m.isSoc && (
              <span className="vp-massgeblich" title="maßgebliche Messung">
                maßgeblich ✓
              </span>
            )}
            {!m.primary && !m.isSoc && showPrimary && (
              <button
                type="button"
                className="vp-role-member-action"
                disabled={busy}
                onClick={() => onSetPrimary(m.entityId, m.channel)}
              >
                maßgeblich setzen
              </button>
            )}
          </li>
        ))}
      </ul>
      {picking ? (
        <div className="vp-role-picker">
          {assignable.length === 0 ? (
            <p className="vp-note" style={{ margin: 0 }}>
              Keine weitere Messung verfügbar.
            </p>
          ) : (
            assignable.map((c) => (
              <button
                key={c.entityId + c.channel}
                type="button"
                className="vp-role-picker-item"
                disabled={busy}
                onClick={() => onAssign(c.entityId, c.channel)}
              >
                {c.entityLabel} · {c.channelLabel}
                {c.currentRole && (
                  <span className="vp-muted"> ({ROLE_LABELS[c.currentRole]})</span>
                )}
              </button>
            ))
          )}
          <button type="button" className="vp-role-add" onClick={onOpenPicker}>
            Abbrechen
          </button>
        </div>
      ) : (
        <button type="button" className="vp-role-add" onClick={onOpenPicker} disabled={busy}>
          <Icon name="plus" size={14} /> zuordnen
        </button>
      )}
    </div>
  );
}

/**
 * Section 3: the adoption bridge. Edge-reported sources with no entity yet are
 * adoptable in one click (admin-only first increment - VoltPilot richtet ein);
 * customers see the honest read-only hint.
 */
function VomGeraetGemeldet({
  reported,
  adopted,
  inverters,
  isAdmin,
  onAdopt,
}: {
  reported: AdoptableSource[];
  adopted: SiteEntities['localSetup'];
  inverters: SiteEntities['localSetup'];
  isAdmin: boolean;
  onAdopt: (s: AdoptableSource) => void;
}) {
  return (
    <Card className="vp-gemeldet">
      <h2 style={{ margin: 0 }}>Vom Gerät gemeldet</h2>
      <p className="vp-note" style={{ marginTop: 'var(--vp-space-1)' }}>
        Was Ihr Gerät vor Ort erkannt hat. VoltPilot zeigt es zum Abgleich und übernimmt es nur auf
        Wunsch - nie automatisch.
      </p>

      {inverters.map((i) => (
        <div key={i.id} className="vp-gemeldet-item vp-gemeldet-inverter">
          <Icon name="cpu" size={16} />
          <span className="vp-gemeldet-main">
            <span className="vp-gemeldet-name">{i.label ?? i.brand ?? 'Wechselrichter'}</span>
            <span className="vp-muted">Wechselrichter · vor Ort eingerichtet</span>
          </span>
        </div>
      ))}

      {adopted.map((a) => (
        <div key={a.id} className="vp-gemeldet-item">
          <Icon name={a.role === 'consumer' ? 'zap' : 'sun'} size={16} />
          <span className="vp-gemeldet-main">
            <span className="vp-gemeldet-name">{a.label ?? sourceRoleLabel(a.role)}</span>
            <span className="vp-muted">{sourceRoleLabel(a.role)} · übernommen</span>
          </span>
          <Badge variant="ok" dot>
            Übernommen
          </Badge>
        </div>
      ))}

      {reported.map((s) => (
        <div key={s.id} className="vp-gemeldet-item vp-gemeldet-new">
          <Icon name={s.role === 'consumer' ? 'zap' : 'sun'} size={16} />
          <span className="vp-gemeldet-main">
            <span className="vp-gemeldet-name">{s.summary}</span>
            <span className="vp-muted">{s.roleLabel} · noch nicht übernommen</span>
          </span>
          {isAdmin ? (
            <Button variant="outline" size="sm" onClick={() => onAdopt(s)}>
              Als Entität übernehmen
            </Button>
          ) : (
            <span className="vp-gemeldet-hint">VoltPilot richtet ein</span>
          )}
        </div>
      ))}

      {!isAdmin && reported.length > 0 && (
        <p className="vp-note vp-gemeldet-note">
          Ein neu erkanntes Gerät wird von VoltPilot als Entität übernommen - sprechen Sie uns an.
        </p>
      )}
    </Card>
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
  const creatable = catalog.filter((t) => !t.composed);
  const [entityType, setEntityType] = useState(editEntity?.entityType ?? creatable[0]?.type ?? '');
  const [label, setLabel] = useState(editEntity?.label ?? '');
  const [maxPowerKw, setMaxPowerKw] = useState(
    editEntity?.guards?.limits?.max_consumption_kw != null
      ? String(editEntity.guards.limits.max_consumption_kw)
      : '',
  );
  const [channelsText, setChannelsText] = useState(
    editEntity ? measureChannels(editEntity).join(', ') : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedType = catalog.find((t) => t.type === entityType) ?? null;
  const composedEdit = editing && selectedType?.composed;
  // A creatable MEASURE-ONLY type (modbus-generic): its channels are
  // per-entity, creator-declared (MB-M1) - the drawer edits the channel list
  // instead of a rated power (there is nothing to command).
  const measureOnly = !!selectedType && !selectedType.composed && !selectedType.controllable;

  async function submit() {
    setBusy(true);
    setError(null);
    const power = maxPowerKw.trim() === '' ? undefined : Number(maxPowerKw.replace(',', '.'));
    if (!measureOnly && power !== undefined && (Number.isNaN(power) || power < 0)) {
      setError('Bitte geben Sie eine gültige Leistung in kW an.');
      setBusy(false);
      return;
    }
    let capabilities: SiteEntity['capabilities'] | undefined;
    if (measureOnly && !composedEdit) {
      const channels = parseChannelList(channelsText);
      if (channels === null || channels.length === 0) {
        setError('Bitte geben Sie mindestens einen Messkanal an - klein geschrieben, '
          + 'z. B. leistung_kw oder wasser_temp_c.');
        setBusy(false);
        return;
      }
      capabilities = { measure: channels.map((channel) => ({ channel })), actuate: [] };
    }
    try {
      if (editing) {
        await entitiesApi.update(siteId, editEntity!.id, {
          label: label.trim() || null,
          maxPowerKw: composedEdit || measureOnly ? undefined : power ?? null,
          capabilities,
        });
      } else {
        await entitiesApi.create(siteId, {
          entityType,
          label: label.trim() || undefined,
          maxPowerKw: measureOnly ? undefined : power,
          capabilities,
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
        ) : measureOnly ? (
          <>
            <Input
              label="Messkanäle (kommagetrennt)"
              value={channelsText}
              onChange={(e) => setChannelsText(e.target.value)}
              placeholder="z. B. leistung_kw, wasser_temp_c"
            />
            <p className="vp-note" style={{ marginTop: 0 }}>
              Diese Kanäle kann ein „Modbus lesen“-Baustein aufzeichnen (Diagramm, Historie).
              Weisen Sie dem Gerät unter Geräte → Rollen &amp; Zuordnung eine Rolle zu, wenn es
              im Energiefluss erscheinen soll.
            </p>
          </>
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

/**
 * Admin adoption drawer (§3.3): prefilled from the report + the type catalog.
 * Consumers ask a rated power; producers ask kWp + the MaStR SEE # (the master
 * data only the customer knows - the ErzeugerSourcesPanel job moves here).
 */
function AdoptDrawer({
  siteId,
  source,
  catalog,
  onClose,
  onAdopted,
}: {
  siteId: string;
  source: AdoptableSource;
  catalog: EntityTypeDef[];
  onClose: () => void;
  onAdopted: () => void;
}) {
  const suggested = source.suggestedType ?? suggestEntityType(source.role, source.brand);
  const adoptable = catalog.filter((t) => t.type !== 'battery-hybrid');
  const initial =
    suggested && adoptable.some((t) => t.type === suggested)
      ? suggested
      : adoptable[0]?.type ?? '';
  const [entityType, setEntityType] = useState(initial);
  const [label, setLabel] = useState(source.label ?? '');
  const [maxPowerKw, setMaxPowerKw] = useState('');
  const [kwp, setKwp] = useState('');
  const [see, setSee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = catalog.find((t) => t.type === entityType) ?? null;
  const isProducer = entityType === 'producer';
  const isConsumer = selected?.category === 'consumer';

  async function submit() {
    setBusy(true);
    setError(null);
    const power = !isConsumer || maxPowerKw.trim() === '' ? undefined : Number(maxPowerKw.replace(',', '.'));
    const capacity = !isProducer || kwp.trim() === '' ? undefined : Number(kwp.replace(',', '.'));
    if (power !== undefined && (Number.isNaN(power) || power < 0)) {
      setError('Bitte geben Sie eine gültige Leistung in kW an.');
      setBusy(false);
      return;
    }
    if (capacity !== undefined && (Number.isNaN(capacity) || capacity < 0)) {
      setError('Bitte geben Sie eine gültige Leistung in kWp an.');
      setBusy(false);
      return;
    }
    try {
      await entitiesApi.adopt(siteId, {
        sourceId: source.id,
        entityType,
        label: label.trim() || undefined,
        maxPowerKw: power,
        capacityKwp: capacity,
        registryUnitId: isProducer ? see.trim() || undefined : undefined,
      });
      onAdopted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Das Gerät konnte nicht übernommen werden.');
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="Gerät übernehmen"
      icon={<Icon name="cpu" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={submit} disabled={busy || !entityType}>
            Übernehmen
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <p className="vp-note" style={{ marginTop: 0 }}>
          Ihr Gerät meldet: <strong>{source.summary}</strong> ({source.roleLabel}).
        </p>
        <label className="vp-field">
          <span>Als Typ übernehmen</span>
          <select
            className="vp-select"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
          >
            {adoptable.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Bezeichnung"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="z. B. Wallbox Carport"
        />
        {isConsumer && (
          <Input
            label="Rated Leistung (kW)"
            value={maxPowerKw}
            onChange={(e) => setMaxPowerKw(e.target.value)}
            placeholder="z. B. 11"
            inputMode="decimal"
          />
        )}
        {isProducer && (
          <>
            <Input
              label="Anlagenleistung (kWp)"
              value={kwp}
              onChange={(e) => setKwp(e.target.value)}
              placeholder="z. B. 27"
              inputMode="decimal"
            />
            <Input
              label="MaStR-Nummer der Quelle (optional)"
              value={see}
              onChange={(e) => setSee(e.target.value)}
              placeholder="SEE…"
            />
          </>
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
