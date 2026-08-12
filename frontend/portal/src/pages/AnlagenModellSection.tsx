import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';
import {
  api,
  type Device,
  type Site,
  type SiteComponents,
  type SiteComponentTemplate,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
} from '../api';
import {
  COMPONENT_ROLE_ICONS,
  CONTROL_BADGE,
  EDGE_BOX_HINT,
  GUARD_FOOTNOTE,
  componentActions,
  edgeBoxLine,
  plantModel,
  reconnectCandidates,
  type ComponentActions,
  type ComponentHealth,
  type PlantComponent,
  type PlantDevice,
  type RoleGroup,
} from '../komponenten';
import { showTechnicalLayer, type AdoptableSource } from '../rollen';
import { livenessReference } from '../liveness';
import { ZuordnenDialog } from '../components/ZuordnenDialog';
import { SchaltFreigabeDrawer } from '../components/SchaltFreigabeDrawer';
import { freigabeZustand } from '../schaltFreigabe';
import { UmbenennenDialog } from '../components/UmbenennenDialog';
import {
  KomponenteLoeschenDialog,
  ZuordnungAendernDialog,
} from '../components/ZuordnungAendern';
import { ConsumerOverrideDialog } from '../components/ConsumerOverrideDialog';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import { sofortAktionen, SOFORT_LABEL, type SofortAktion } from '../consumers/fulfillment';
import { InfoTip } from '../components/InfoTip';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { fmtNum } from '../format';
import { NO_DATA } from '../nodata';
import { anlageRoute, hashForRoute } from '../nav';
import { EntitaetenSection } from './EntitaetenSection';
import { EigeneVorlagenPanel } from '../components/EigeneVorlagenPanel';
import { KomponenteHinzufuegenDrawer } from '../components/KomponenteHinzufuegenDrawer';
import {
  ablehnungText,
  sollIstText,
  sollIstTon,
  verwaltungsHinweis,
} from '../komponentenAssistent';
import '../components/AnlagenModell.css';
import '../components/KomponenteAssistent.css';

/**
 * Portal v3 · M6 — the Anlagen-Modell, rebuilt to the approved **Variante A**
 * (design `data/vp-anlagenmodell-ux-w7`, Captain-Go 2026-07-29).
 *
 * Die Seite beantwortet EINE Frage — „Kennt VoltPilot meine Anlage richtig, und
 * woher kommt jede Zahl?" — und zwar in dieser Reihenfolge: Kopfsatz (Zustand)
 * → die EINE VoltPilot-Box mit den Geräten, die ihr Messwerte liefern → die
 * Komponenten in Rollen-Gruppen MIT Live-Werten und Herkunft → Fußzeile
 * (Schutz-Satz + wo die Komponenten wieder auftauchen). Die frühere dritte
 * Spalte („Ihre Anlage") ist aufgelöst.
 *
 * Tapping a device highlights the components it measures (the interaction of
 * the old layout, kept). A newly reported device is assigned in one move
 * (`ZuordnenDialog`); an orphaned pin leads straight back into the SAME
 * „Wieder verbinden"-Fluss (PR #271) instead of minting a duplicate.
 *
 * The customer dictionary is Gerät / Komponente / Messwert (D3) — the words
 * Entität / Messpunkt / Quelle live only in the admin/installer panel below,
 * gated by the ONE `showTechnicalLayer()` helper (M7). All derivation is the
 * pure `komponenten.ts`; this file only renders.
 */
export function AnlagenModellSection({
  site,
  devices,
  devicesFetchedAt = null,
}: {
  site: Site;
  devices?: Device[];
  /**
   * Bezugszeit der Geräteliste. Die Box-Zeile altert dagegen, nie gegen eine
   * weiterlaufende Wanduhr über einem stehenden Schnappschuss (`liveness.ts`).
   */
  devicesFetchedAt?: number | null;
}) {
  // The ONE technical-layer decision (M7): a platform-admin sees the installer
  // panel added to the same page; a customer never does.
  const showTechnical = showTechnicalLayer();
  const [data, setData] = useState<SiteEntities | null>(null);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [assign, setAssign] = useState<AdoptableSource | null>(null);
  const [rename, setRename] = useState<PlantComponent | null>(null);
  const [freigabe, setFreigabe] = useState<PlantComponent | null>(null);
  // Die zwei Bereinigungs-Hebel AN der Komponente (vp-bereinigung-ui-k3).
  const [repin, setRepin] = useState<PlantComponent | null>(null);
  const [remove, setRemove] = useState<PlantComponent | null>(null);
  /**
   * Sofortaktion AN DER KOMPONENTE (Einheitsmodell Stufe 5a, 5b.7): EIN
   * Mechanismus, ZWEI Orte - derselbe Dialog wie im Kopf der Regeln-Kapsel.
   * Fail-soft: ohne steuerbare Verbraucher (älteres Backend, keine Freigabe)
   * erscheint gar kein Knopf, nie ein wirkungsloser.
   */
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [sofort, setSofort] = useState<{ consumer: Consumer; action: SofortAktion } | null>(null);
  const [sofortBusy, setSofortBusy] = useState(false);
  /**
   * Einheitsmodell Stufe 1: der EINE Anlege-Assistent + der Soll/Ist-Stand.
   * FAIL-SOFT geholt - ein älteres Backend kennt die Route nicht, dann bleibt
   * die Fläche exakt wie vorher (kein Knopf, keine Stand-Zeile).
   */
  const [components, setComponents] = useState<SiteComponents | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Einheitsmodell Stufe 6: aus einer EIGENEN Vorlage ein Gerät machen - der
  // Assistent öffnet dann direkt in der Selbstbau-Tür, vorbefüllt.
  const [vorlage, setVorlage] = useState<SiteComponentTemplate | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    api.siteEntities(site.id).then(
      (d) => active && setData(d),
      () => active && setError(true),
    );
    // Topology fail-soft (a v1/un-migrated site simply lacks it — the model
    // still renders from the entities + local setup, then without live values).
    api.topology(site.id).then(
      (t) => active && setTopology(t),
      () => active && setTopology(null),
    );
    // The reported measurement points (`/sources`), fail-soft — they carry the
    // honest per-inverter PV split the energy flow uses (F1 caveat).
    api.siteSources(site.id).then(
      (s) => active && setSources(s),
      () => active && setSources(null),
    );
    // Der Autoritäts- und Soll/Ist-Stand (Stufe 1), fail-soft.
    api.siteComponents(site.id).then(
      (c) => active && setComponents(c),
      () => active && setComponents(null),
    );
    // Die steuerbaren Verbraucher — nur für die Sofortaktion an der Zeile.
    consumersApi.list(site.id).then(
      (list) => active && setConsumers(list ?? []),
      () => active && setConsumers([]),
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  const runSofort = async (durationMinutes?: number) => {
    if (!sofort) return;
    const { consumer: c, action } = sofort;
    setSofortBusy(true);
    try {
      if (action === 'resume') await consumersApi.clearOverride(site.id, c.id);
      else await consumersApi.startOverride(site.id, c.id, { action, durationMinutes });
      setSofort(null);
    } catch {
      // Die Fläche ist eine ANZEIGE - ein fehlgeschlagener Eingriff darf sie
      // nicht in einen Fehlerzustand kippen; der Dialog schließt einfach.
      setSofort(null);
    } finally {
      setSofortBusy(false);
    }
  };

  const reload = () => setReloadKey((k) => k + 1);

  const model = useMemo(
    () => (data ? plantModel(data.entities, topology, data.localSetup, sources) : null),
    [data, topology, sources],
  );

  // The ONE VoltPilot-Box (Captain-Korrektur): every reported device hangs off
  // it. Without a claimed device nothing is invented.
  const box = useMemo(() => {
    if (!model) return null;
    const at = livenessReference(devicesFetchedAt, Date.now());
    return edgeBoxLine(
      (devices ?? []).filter((d) => d.siteId === site.id),
      model.devices.length,
      at == null ? undefined : new Date(at),
    );
  }, [devices, devicesFetchedAt, site.id, model]);

  const isEmpty =
    model != null &&
    model.devices.length === 0 &&
    model.components.length === 0 &&
    model.newlyReported.length === 0;

  // Which components/devices are highlighted by the current selection.
  const highlightedComponents = useMemo(() => {
    if (!model || selected == null) return null;
    const dev = model.devices.find((d) => d.id === selected);
    if (dev) return new Set(dev.componentIds);
    const comp = model.components.find((c) => c.id === selected);
    if (comp) return new Set([comp.id]);
    return null;
  }, [model, selected]);

  const highlightedDevices = useMemo(() => {
    if (!model || selected == null) return null;
    const comp = model.components.find((c) => c.id === selected);
    if (comp) return new Set(comp.deviceIds);
    const dev = model.devices.find((d) => d.id === selected);
    if (dev) return new Set([dev.id]);
    return null;
  }, [model, selected]);

  /**
   * Einheitsmodell Stufe 1. Der Assistent erscheint NUR auf einer
   * portal-verwalteten Anlage: auf einer box-verwalteten Bestandsanlage würde
   * ein gespeichertes Soll nie wirken, und ein Knopf, der in eine ehrliche
   * Ablehnung läuft, ist schlechter als kein Knopf.
   */
  const portalManaged = components?.componentAuthority === 'portal';
  const komponentenStand = components
    ? {
        text: sollIstText(
          components.components[0]?.syncStatus,
          components.components[0]?.definitionVersion ?? 1,
        ),
        ton: sollIstTon(components.components[0]?.syncStatus),
      }
    : null;
  const ablehnung = ablehnungText(components?.refusedRevision, components?.refusedReason);
  /*
    Einheitsmodell Stufe 2: EIN Satz, der sagt, wo gepflegt wird. Er erscheint
    nur, wenn es etwas zu erklären gibt - eine Anlage, die immer schon im Portal
    entstanden ist, schweigt.
  */
  const verwaltung = components
    ? verwaltungsHinweis(components.componentAuthority, components.adoptedAt)
    : null;

  return (
    <div className="vp-modell">
      <Card className="vp-modell-card">
        {!data && !error && <TextSkeleton lines={5} />}
        {error && (
          <ErrorState message="Das Anlagen-Modell konnte nicht geladen werden." onRetry={reload} />
        )}
        {model && isEmpty && (
          <EmptyState
            icon="layers"
            category="primary"
            title="Noch keine Komponenten"
            description="Sobald Ihr Gerät sich meldet, erscheint hier, wie Ihre Anlage verschaltet ist."
          />
        )}

        {model && !isEmpty && (
          <>
            {/* 1 · Der Kopfsatz ist die Antwort auf „richtig erkannt?". */}
            <p className={`vp-am-headline${model.headline.tone === 'warn' ? ' warn' : ''}`}>
              <span
                className={`vp-health-dot vp-health-${
                  model.headline.tone === 'warn' ? 'warn' : 'ok'
                }`}
              />
              <span>{model.headline.text}</span>
            </p>

            {/* 2 · Die EINE VoltPilot-Box — darunter hängen die Geräte. */}
            <section aria-label="Ihre Geräte">
              {box && (
                <div className="vp-am-box">
                  <span className="vp-am-box-title">
                    <span className={`vp-health-dot vp-health-${HEALTH_TONE[box.health]}`} />
                    <Icon name="wifi" size={16} />
                    {box.label}
                  </span>
                  <span className="vp-am-box-sub">{box.summary}</span>
                  <span className="vp-am-box-hint">{EDGE_BOX_HINT}</span>
                  <div className="vp-am-behind">
                    <h3 className="vp-am-head">
                      <Icon name="cpu" size={16} /> Geräte an Ihrer Box{' '}
                      <span className="vp-am-head-sub">
                        — antippen markiert, was ein Gerät misst
                      </span>
                    </h3>
                    <DeviceStrip
                      model={model}
                      selected={selected}
                      highlightedDevices={highlightedDevices}
                      onSelect={setSelected}
                      onAssign={setAssign}
                    />
                  </div>
                </div>
              )}
              {!box && (
                <>
                  <h3 className="vp-am-head">
                    <Icon name="cpu" size={16} /> Ihre Geräte{' '}
                    <span className="vp-am-head-sub">— antippen markiert, was ein Gerät misst</span>
                  </h3>
                  <DeviceStrip
                    model={model}
                    selected={selected}
                    highlightedDevices={highlightedDevices}
                    onSelect={setSelected}
                    onAssign={setAssign}
                  />
                </>
              )}
            </section>

            {/* 3 · Die Komponenten — mit Live-Werten wie im Cockpit. */}
            <section aria-label="Komponenten">
              <h3 className="vp-am-head spaced">
                <Icon name="layers" size={16} /> Komponenten Ihrer Anlage{' '}
                <span className="vp-am-head-sub">— mit den Werten von jetzt</span>
                {portalManaged && (
                  <button
                    type="button"
                    className="vp-am-add"
                    onClick={() => setAddOpen(true)}
                  >
                    <Icon name="plus" size={14} /> Komponente hinzufügen
                  </button>
                )}
              </h3>
              {/*
                Der Stand der GANZEN Anlage: was das Portal gespeichert hat und
                was die Box davon wirklich anwendet. Eine Ablehnung steht NEBEN
                dem laufenden Stand, nie an seiner Stelle - es läuft weiter die
                zuletzt angewandte Fassung.
              */}
              {verwaltung && <p className="vp-am-stand is-unbekannt">{verwaltung}</p>}
              {komponentenStand && (
                <p className={`vp-am-stand is-${komponentenStand.ton}`}>{komponentenStand.text}</p>
              )}
              {ablehnung && <p className="vp-am-stand is-warn">{ablehnung}</p>}
              {model.groups.map((g) => (
                <RoleGroupCard
                  key={g.role}
                  group={g}
                  selected={selected}
                  highlighted={highlightedComponents}
                  onSelect={setSelected}
                  onRename={setRename}
                  onFreigabe={setFreigabe}
                  actionsFor={(c) =>
                    componentActions(
                      c,
                      data?.entities.find((e) => e.id === c.entityId),
                    )
                  }
                  onRepin={setRepin}
                  onRemove={setRemove}
                  sofortFor={(c) => consumers.find(
                    (x) => x.id === c.entityId && x.connection === 'connected',
                  ) ?? null}
                  onSofort={(consumer, action) => setSofort({ consumer, action })}
                />
              ))}
              {model.components.length === 0 && (
                <p className="vp-note">
                  Noch keine Komponente — ordnen Sie ein gemeldetes Gerät zu.
                </p>
              )}
              {/*
                Einheitsmodell Stufe 6: die EIGENEN Vorlagen dieser Anlage. Sie
                wohnen bei den Komponenten, weil sie aus einer entstehen und zu
                einer führen - und nur dort, wo das Portal die Geräte verwaltet.
              */}
              {portalManaged && (
                <EigeneVorlagenPanel siteId={site.id} onAnlegen={setVorlage} />
              )}
            </section>

            {/* 4 · Die Fußzeile: Schutz-Satz + wo die Komponenten wieder auftauchen. */}
            <div className="vp-am-foot">
              {GUARD_FOOTNOTE}
              <div className="vp-am-links">
                <span>Diese Komponenten begegnen Ihnen überall:</span>
                <a href={hashForRoute(anlageRoute(site.id))}>→ Cockpit</a>
                <a href={hashForRoute(anlageRoute(site.id, 'messwerte'))}>→ Messwerte</a>
                <a href={hashForRoute(anlageRoute(site.id, 'steuerung'))}>→ Steuerung</a>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* The technical/installer view (entity types, raw channels, guard bands,
          Soll/Ist sync, registry) is gated behind the ONE showTechnicalLayer()
          helper (M7). Nothing was deleted; it just no longer frames the
          customer, and only a platform-admin ever sees it. */}
      {showTechnical && (
        <details className="vp-modell-installer">
          <summary>
            <Icon name="settings" size={16} /> Installateur-Ansicht (technisch)
          </summary>
          <EntitaetenSection site={site} isAdmin={showTechnical} />
        </details>
      )}

      <ConsumerOverrideDialog
        action={sofort?.action ?? null}
        consumerName={sofort?.consumer.name ?? ''}
        effectivePowerKw={sofort ? Number(sofort.consumer.ratedPowerKw) : null}
        busy={sofortBusy}
        onConfirm={(m) => void runSofort(m)}
        onCancel={() => setSofort(null)}
      />

      {assign && (
        <ZuordnenDialog
          siteId={site.id}
          source={assign}
          candidates={data ? reconnectCandidates(assign, data.entities) : []}
          onClose={() => setAssign(null)}
          onAssigned={() => {
            setAssign(null);
            reload();
          }}
        />
      )}

      {(addOpen || vorlage) && (
        <KomponenteHinzufuegenDrawer
          siteId={site.id}
          vorlage={vorlage}
          onClose={() => {
            setAddOpen(false);
            setVorlage(null);
          }}
          onSaved={(result) => {
            setComponents(result);
            reload();
          }}
        />
      )}

      {freigabe && (
        <SchaltFreigabeDrawer
          open
          siteId={site.id}
          entityId={freigabe.entityId}
          komponentenName={freigabe.label}
          bereitsFreigegeben={freigabe.schaltbar}
          leistungJetztKw={freigabe.reading?.unit === 'kW' ? freigabe.reading.value : null}
          onClose={() => setFreigabe(null)}
          onChanged={reload}
        />
      )}

      {rename && (
        <UmbenennenDialog
          siteId={site.id}
          target={{
            entityId: rename.entityId,
            alias: rename.alias,
            derivedLabel: rename.derivedLabel,
          }}
          onClose={() => setRename(null)}
          onSaved={() => {
            setRename(null);
            reload();
          }}
        />
      )}

      {repin && data && (
        <ZuordnungAendernDialog
          siteId={site.id}
          component={repin}
          entities={data.entities}
          localSetup={data.localSetup}
          sources={sources}
          onClose={() => setRepin(null)}
          onSaved={() => {
            setRepin(null);
            reload();
          }}
        />
      )}

      {remove && data && (
        <KomponenteLoeschenDialog
          siteId={site.id}
          component={remove}
          entities={data.entities}
          localSetup={data.localSetup}
          onClose={() => setRemove(null)}
          onDeleted={() => {
            setRemove(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

const HEALTH_TONE: Record<ComponentHealth, 'ok' | 'warn' | 'off'> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  // H2: „noch keine Rückmeldung" is grey, never green.
  unknown: 'off',
};

/** The devices behind the box + the "Neues Gerät gefunden" call to action. */
function DeviceStrip({
  model,
  selected,
  highlightedDevices,
  onSelect,
  onAssign,
}: {
  model: ReturnType<typeof plantModel>;
  selected: string | null;
  highlightedDevices: Set<string> | null;
  onSelect: (id: string | null) => void;
  onAssign: (s: AdoptableSource) => void;
}) {
  return (
    <div className="vp-am-devstrip">
      {model.devices.map((d) => (
        <DeviceCard
          key={d.id}
          device={d}
          selected={selected === d.id}
          dim={highlightedDevices != null && !highlightedDevices.has(d.id)}
          onSelect={() => onSelect(selected === d.id ? null : d.id)}
        />
      ))}
      {model.newlyReported.map((s) => (
        <button key={s.id} type="button" className="vp-am-dev new" onClick={() => onAssign(s)}>
          <span className="vp-am-dev-name">
            <Icon name="plus" size={16} /> Neues Gerät gefunden
          </span>
          <span className="vp-am-dev-sub">„{s.summary}“ meldet sich —</span>
          <span className="vp-am-dev-cta">jetzt zuordnen</span>
        </button>
      ))}
      {model.devices.length === 0 && model.newlyReported.length === 0 && (
        <p className="vp-note">Noch kein Gerät gemeldet.</p>
      )}
    </div>
  );
}

/** One physical box behind the VoltPilot-Box. */
function DeviceCard({
  device,
  selected,
  dim,
  onSelect,
}: {
  device: PlantDevice;
  selected: boolean;
  dim: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`vp-am-dev${selected ? ' selected' : ''}${dim ? ' dim' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="vp-am-dev-name">
        <span className={`vp-health-dot vp-health-${HEALTH_TONE[device.health]}`} />
        {device.label}
      </span>
      <span className="vp-am-dev-sub">{device.state}</span>
      <span className="vp-am-dev-sub">{device.summary}</span>
      {device.roles.length > 0 && (
        <span className="vp-am-roledots" aria-hidden="true">
          {device.roles.map((r) => (
            <i key={r} className={`vp-am-roledot vp-am-${r}`} />
          ))}
        </span>
      )}
    </button>
  );
}

/** One role group ("PV-Erzeugung · Σ 44,9 kW") with its component rows. */
function RoleGroupCard({
  group,
  selected,
  highlighted,
  onSelect,
  onRename,
  onFreigabe,
  actionsFor,
  onRepin,
  onRemove,
  sofortFor,
  onSofort,
}: {
  group: RoleGroup;
  selected: string | null;
  highlighted: Set<string> | null;
  onSelect: (id: string | null) => void;
  onRename?: (c: PlantComponent) => void;
  onFreigabe?: (c: PlantComponent) => void;
  actionsFor: (c: PlantComponent) => ComponentActions;
  onRepin: (c: PlantComponent) => void;
  onRemove: (c: PlantComponent) => void;
  /** Der steuerbare Verbraucher hinter dieser Komponente, sonst null. */
  sofortFor: (c: PlantComponent) => Consumer | null;
  onSofort: (consumer: Consumer, action: SofortAktion) => void;
}) {
  return (
    <section className={`vp-am-group vp-am-${group.role}`} aria-label={group.label}>
      <div className="vp-am-group-head">
        <Icon
          name={COMPONENT_ROLE_ICONS[group.role] as IconName}
          size={18}
          className="vp-am-group-icon"
        />
        <span className="vp-am-group-title">{group.label}</span>
        {group.headline && <span className="vp-am-group-sum">{group.headline}</span>}
        {group.note && <span className="vp-am-group-note">{group.note}</span>}
      </div>
      {group.components.map((c) => (
        <ComponentRow
          key={c.id}
          component={c}
          selected={selected === c.id}
          highlight={highlighted != null && highlighted.has(c.id)}
          dim={highlighted != null && !highlighted.has(c.id)}
          onSelect={() => onSelect(selected === c.id ? null : c.id)}
          onRename={onRename}
          onFreigabe={onFreigabe}
          actions={actionsFor(c)}
          onRepin={onRepin}
          onRemove={onRemove}
          sofort={sofortFor(c)}
          onSofort={onSofort}
        />
      ))}
    </section>
  );
}

/** The §14a explanation, once, where the maßgebliche Messung is named. */
const PARAGRAF_14A =
  'Am maßgeblichen Netzanschluss zählt, was Sie beziehen und einspeisen. Verlangt Ihr ' +
  'Netzbetreiber kurzzeitig weniger Bezug (§ 14a EnWG), hält VoltPilot diese Grenze ein.';

/** One Komponente: name, Herkunft, Steuer-Abzeichen, Live-Wert. */
function ComponentRow({
  component,
  selected,
  highlight,
  dim,
  onSelect,
  onRename,
  onFreigabe,
  actions,
  onRepin,
  onRemove,
  sofort,
  onSofort,
}: {
  component: PlantComponent;
  selected: boolean;
  highlight: boolean;
  dim: boolean;
  onSelect: () => void;
  onRename?: (c: PlantComponent) => void;
  onFreigabe?: (c: PlantComponent) => void;
  actions: ComponentActions;
  onRepin: (c: PlantComponent) => void;
  onRemove: (c: PlantComponent) => void;
  sofort: Consumer | null;
  onSofort: (consumer: Consumer, action: SofortAktion) => void;
}) {
  const c = component;
  return (
    <div className={`vp-am-comp${selected || highlight ? ' hl' : ''}${dim ? ' dim' : ''}`}>
      <div className="vp-am-comp-main">
        <span className="vp-am-comp-name">
          {/* The name is the control: a real button (keyboard + touch), because
              the row also hosts a pencil and a Details fold — nesting those in
              one big button would be invalid markup. */}
          <button type="button" className="vp-am-comp-btn" aria-pressed={selected} onClick={onSelect}>
            <span className={`vp-health-dot vp-health-${HEALTH_TONE[c.health]}`} />
            {c.label}
          </button>
          {c.primary && <InfoTip title="Maßgebliche Messung">{PARAGRAF_14A}</InfoTip>}
        </span>
        <span className="vp-am-comp-sub">
          {c.provenance && (
            <span className="vp-am-prov">
              <Icon name="cpu" size={11} />
              {c.provenance}
            </span>
          )}
          {c.control && (
            <span className="vp-am-ctrl">
              <Icon name="shield" size={12} />
              {CONTROL_BADGE}
            </span>
          )}
          {/* Der FREIGABE-Zustand (Einheitsmodell Stufe 4, Anforderung 8): EINE
              Anzeige über alle drei Vertrauens-Stufen - und „gesperrt" ist ein
              ZUSTAND, kein Fehler, deshalb der ruhige Ton. Er steht nur, wo er
              etwas aussagt: an einem Gerät, das schaltet oder es könnte. */}
          {(c.schaltbar || c.freigabeFaehig) && (() => {
            const z = freigabeZustand({ schaltbar: c.schaltbar, quelle: c.freigabeQuelle });
            return (
              <span className={`vp-am-freigabe is-${z.ton}`} title={z.satz}>
                <Icon name={z.ton === 'ok' ? 'zap' : 'shield'} size={12} />
                {z.wort}
              </span>
            );
          })()}
          <span>{c.summary}</span>
        </span>
        {/* Identity churn (vp-vier-erzeuger-p9): the pinned device vanished from
            the report — honest amber state plus the way back into the existing
            „Wieder verbinden"-Fluss, instead of a silent duplicate. */}
        {c.orphaned && (
          <span className="vp-am-orphan">
            <Icon name="alert-triangle" size={14} />
            nicht mehr mit einem gemeldeten Gerät verbunden
            {/* Der Weg zurück steht DIREKT neben der Warnung — vorher hing er am
                „Wieder verbinden"-Dialog eines NEU gemeldeten Geräts, den es auf
                einer voll zugeordneten Anlage gar nicht gibt. */}
            {actions.canRepin && (
              <button type="button" className="vp-am-orphan-btn" onClick={() => onRepin(c)}>
                wieder verbinden
              </button>
            )}
            {actions.canDelete && (
              <button
                type="button"
                className="vp-am-orphan-btn danger"
                onClick={() => onRemove(c)}
              >
                löschen
              </button>
            )}
          </span>
        )}
        {/* F1 caveat: a producer read through the inverter has no own series — a
            plain dot would read „noch keine Daten" forever. */}
        {c.measuredVia && c.reading == null && <span className="vp-am-note">{c.measuredVia}</span>}
      </div>

      {/* Every real component may be named - including the platform-composed
          battery / grid / house rows. The PV ASPECT row is the one exception
          (`renameable: false`): it belongs to its carrier and follows its name. */}
      {onRename && c.renameable && (
        <button
          type="button"
          className="vp-am-pencil"
          aria-label={`„${c.label}“ umbenennen`}
          onClick={() => onRename(c)}
        >
          <Icon name="pencil" size={15} />
        </button>
      )}

      <span className={`vp-am-comp-val${c.reading ? '' : ' none'}`}>
        {c.reading ? fmtNum(c.reading.value, c.reading.unit) : NO_DATA}
        {c.reading?.caption && <small>{c.reading.caption}</small>}
      </span>

      {/* Die Bereinigung wohnt hier: an einer gesunden Komponente ruhig im
          Details-Bereich, an einer verwaisten prominent neben der Warnung. */}
      {(c.channels.length > 0 || sofort != null || (c.freigabeFaehig && onFreigabe != null)
        || (!c.orphaned && (actions.canRepin || actions.canDelete))) && (
        <details className="vp-am-details">
          <summary>
            <Icon name="chevron-right" size={12} /> Details
          </summary>
          {c.channels.length > 0 && (
            <span className="vp-am-chips">
              {c.channels.map((ch) => (
                <span key={ch.raw} title={ch.raw}>
                  {ch.label}
                </span>
              ))}
            </span>
          )}
          {/* Sofortaktion (5b.7): derselbe Mechanismus wie im Kopf der
              Regeln-Kapsel, hier AN der Komponente. Nur für ein verbundenes,
              steuerbares Gerät - nie ein wirkungsloser Knopf. */}
          {sofort && (
            <span className="vp-am-actions">
              {sofortAktionen({ connected: true, hasOverride: false }).map((a) => (
                <button
                  key={a}
                  type="button"
                  className="vp-am-action"
                  onClick={() => onSofort(sofort, a)}
                >
                  <Icon name="zap" size={13} /> {SOFORT_LABEL[a]}
                </button>
              ))}
            </span>
          )}
          {/* Die Freigabe ist ein EIGENER, bewusst getrennter Schritt an der
              fertigen Komponente - nie ein fünfter Schritt des Anlege-Wegs. */}
          {c.freigabeFaehig && onFreigabe && (
            <span className="vp-am-actions">
              <button type="button" className="vp-am-action" onClick={() => onFreigabe(c)}>
                <Icon name="zap" size={13} />
                {c.schaltbar ? 'Steuerung dieses Geräts' : 'Steuern freigeben'}
              </button>
            </span>
          )}
          {!c.orphaned && (actions.canRepin || actions.canDelete) && (
            <span className="vp-am-actions">
              {actions.canRepin && (
                <button type="button" className="vp-am-action" onClick={() => onRepin(c)}>
                  <Icon name="link" size={13} /> Zuordnung ändern
                </button>
              )}
              {actions.canDelete && (
                <button
                  type="button"
                  className="vp-am-action danger"
                  onClick={() => onRemove(c)}
                >
                  <Icon name="trash" size={13} /> Komponente löschen
                </button>
              )}
            </span>
          )}
        </details>
      )}
    </div>
  );
}

