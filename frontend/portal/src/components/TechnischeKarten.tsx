import { useState } from 'react';
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
  type SiteEntities,
  type SiteEntity,
  type SiteTopology,
} from '../api';
import { commandLabel } from '../channels';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { entitiesApi, type EntityTypeDef } from '../entitiesApi';
import { deviceName } from '../entityLabel';
import {
  actuateCommands,
  guardRows,
  hasDrift,
  healthLabel,
  measureChannels,
  parseChannelList,
  syncVerdict,
} from '../entities';
import {
  type AdoptableSource,
  type Role,
  type RoleBox,
  ROLE_LABELS,
  assignToRole,
  assignableCapabilities,
  isAutoAssigned,
  resetAssignments,
  roleBoxes,
  rolePillsFor,
  setPrimaryAssignment,
  suggestEntityType,
} from '../rollen';
import { InfoTip } from '../components/InfoTip';
import { fmtNum } from '../format';

/**
 * Anlagen-Zentrale Stufe 3 (PR 3a) — die AUFGELÖSTE Installateur-Ansicht.
 *
 * Bis hierher lag die technische Sicht als eigener `<details>`-Block
 * („Installateur-Ansicht (technisch)") UNTER der Zentrale und zeigte dieselben
 * Dinge ein zweites Mal: jede Komponente einmal als Kunden-Zeile in ihrer
 * Geräte-Karte und einmal als Entitäts-Karte darunter. Die Konsolidierungs-
 * Landkarte (§9) löst sie in DREI Wohnorte auf, und dieses Bauteil trägt sie:
 *
 * 1. {@link TechnischeZeile} — der technische Rumpf der Entitäts-Karte, jetzt
 *    IN der Komponenten-Zeile ihrer Geräte-Karte (Typ, Soll/Ist, Rollen,
 *    Regeln, „Steuert", Guards) samt „Technisch bearbeiten"/„Entfernen".
 * 2. {@link RollenZuordnung} — die Karte „Rollen &amp; Zuordnung", unverändert,
 *    unter der Liste.
 * 3. {@link AdoptDrawer} — die technische Übernahme, jetzt an der Karte
 *    „Neues Gerät gefunden"; {@link EntityDrawer} ist die Admin-Tür von
 *    „＋ Hinzufügen".
 *
 * ⚠ Es gibt KEINEN zweiten Gate-Ort: der Wirt (`AnlagenModellSection`) prüft
 * `rollen.showTechnicalLayer()` EINMAL und rendert nichts hiervon ohne ihn
 * (M7 — eine künftige Installateur-Rolle steckt dort ein und nirgends sonst).
 * Alle Ableitungen bleiben die reinen `entities.ts` / `rollen.ts`.
 */

/** Der Soll/Ist-Stand der ENTITÄTS-Registry (nicht der Komponenten-Fassung). */
export function RegistryDrift({ data }: { data: SiteEntities }) {
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

/**
 * Der technische Rumpf EINER Komponente, in ihrer eigenen Zeile.
 *
 * ⚠ Bewusst NICHT wiederholt: der Kunden-Name, der Zustandspunkt und die
 * „Misst"-Kanäle — die stehen längst in der Zeile darüber (`ComponentRow`), und
 * dieselbe Tatsache zweimal auf derselben Zeile war genau die Doppelung, die
 * diese Stufe beseitigt. Hier steht nur, was der Kunden-Blick NICHT trägt.
 */
export function TechnischeZeile({
  entity,
  siteId,
  strategies,
  topology,
  onEdit,
  onChanged,
}: {
  entity: SiteEntity;
  siteId: string;
  strategies: EntityStrategy[];
  topology: SiteTopology | null;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // ⚠ Einheitsmodell Stufe 6: EIN Haus-Dialog statt zweier nativer Rückfragen
  // hintereinander - die zweite beschrieb die kWp-Folge in einem
  // `\n\n`-Fließtext, den niemand liest.
  const [ask, setAsk] = useState(false);
  const [purge, setPurge] = useState(false);
  const verdict = syncVerdict(entity.syncStatus);
  const actuates = actuateCommands(entity);
  const guards = guardRows(entity);
  const pills = topology ? rolePillsFor(entity.id, topology) : [];

  // Composed rows keep their measurement point by default (re-adoption
  // re-composes it). Purging deletes the point outright, releases its kWp from
  // the aggregate and frees its source pin (the duplicate-CLEANUP lever,
  // vp-vier-erzeuger-p9).
  const composedPoint = entity.role === 'pv-generation' || entity.role === 'grid-meter';

  async function remove() {
    setAsk(false);
    setBusy(true);
    try {
      await entitiesApi.remove(siteId, entity.id, { purgePoint: composedPoint && purge });
      onChanged();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="vp-tech-zeile" data-testid="tech-zeile">
      <div className="vp-tech-kopf">
        {/* R2 auf der technischen Fläche: nie der Alias ALLEIN. Trägt die
            Komponente einen Kunden-Namen, sagt diese Zeile, dass es einer IST,
            und stellt die technische Identität daneben - sonst kann ein
            Betreiber im Support-Ticket „Dach Süd" nicht von einem Typ
            unterscheiden. */}
        <span className="vp-tech-typ">
          {entity.label && <span className="vp-entity-alias">Eigener Name · </span>}
          {entity.typeLabel}
          {entity.control && <span className="vp-entity-control"> · steuerbar</span>}
        </span>
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

      {/* Der Frische-Beleg gehört zur technischen Sicht: die Kunden-Zeile sagt
          den Zustand als Punkt, hier steht der Zeitpunkt. */}
      <div className="vp-entity-health">
        {healthLabel(entity.observed)}
        {entity.observed?.lastTelemetryAt && entity.observed.health !== 'ok' && (
          <span className="vp-muted">
            {' '}
            · zuletzt {new Date(entity.observed.lastTelemetryAt).toLocaleString('de-DE')}
          </span>
        )}
      </div>

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

      <div className="vp-entity-actions">
        <Button variant="ghost" onClick={onEdit}>
          <Icon name="pencil" size={14} /> Technisch bearbeiten
        </Button>
        <Button
          variant="ghost"
          className="vp-btn-danger"
          onClick={() => {
            setPurge(false);
            setAsk(true);
          }}
          disabled={busy}
        >
          <Icon name="trash" size={14} /> Entfernen
        </Button>
      </div>

      <ConfirmDialog
        open={ask}
        title="Komponente entfernen?"
        intro={`„${entity.label ?? entity.typeLabel}" verschwindet aus dem Anlagen-Modell.`}
        consequences={[
          'Die aufgezeichneten Messwerte bleiben erhalten.',
          composedPoint
            ? 'Der Messpunkt bleibt bestehen — eine erneute Übernahme stellt die Komponente wieder her.'
            : 'Die Zuordnung zum gemeldeten Gerät wird gelöst.',
        ]}
        confirmLabel="Entfernen"
        tone="danger"
        busy={busy}
        onCancel={() => setAsk(false)}
        onConfirm={() => void remove()}
        extra={
          composedPoint ? (
            <label className="vp-entity-purge">
              <input
                type="checkbox"
                checked={purge}
                onChange={(e) => setPurge(e.target.checked)}
              />
              <span>
                Messpunkt endgültig löschen — die kWp verlassen die Anlagen-Summe, und das
                gemeldete Gerät wird für eine neue Zuordnung frei.
              </span>
            </label>
          ) : undefined
        }
      />
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
export function RollenZuordnung({
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

export type DrawerState = { mode: 'create' } | { mode: 'edit'; entity: SiteEntity };

/** Admin create/edit drawer incl. guard config (the registry Soll). */
export function EntityDrawer({
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
export function AdoptDrawer({
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
  // Prefill via the ONE deviceName chain - never a raw stored string (the
  // Pilsting ghost-name bug, vp-vier-erzeuger-p9).
  const [label, setLabel] = useState(
    deviceName({ edgeLabel: source.label, brand: source.brand, model: source.model }) ?? '',
  );
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
