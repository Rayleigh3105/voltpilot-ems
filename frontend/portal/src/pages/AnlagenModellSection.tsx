import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';
import { api, type Site, type SiteEntities, type SiteSource, type SiteTopology } from '../api';
import {
  COMPONENT_ROLE_ICONS,
  plantModel,
  type ComponentHealth,
  type PlantComponent,
  type PlantDevice,
  type PlantEffect,
} from '../komponenten';
import { showTechnicalLayer, type AdoptableSource } from '../rollen';
import { ZuordnenDialog } from '../components/ZuordnenDialog';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { EntitaetenSection } from './EntitaetenSection';
import '../components/AnlagenModell.css';

/**
 * Portal v3 · M6 — the Anlagen-Modell (concept tab 7). ONE picture of "so ist
 * Ihre Anlage verschaltet": three columns — **Geräte** (physical boxes) →
 * **Komponenten** (the roles) → **Ihre Anlage** (what the cockpit makes of it).
 * Tapping a device highlights the components it feeds; a newly reported device
 * is assigned in one move (`ZuordnenDialog`). Health dots sit on the device,
 * where people look for them.
 *
 * The customer dictionary is Gerät / Komponente / Messwert (D3) — the words
 * Entität / Messpunkt / Quelle live only in the admin/installer panel below,
 * gated by the ONE `showTechnicalLayer()` helper (M7). All derivation is the
 * pure `komponenten.ts`; this file only renders.
 */
export function AnlagenModellSection({ site }: { site: Site }) {
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

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    api.siteEntities(site.id).then(
      (d) => active && setData(d),
      () => active && setError(true),
    );
    // Topology fail-soft (a v1/un-migrated site simply lacks it — the model
    // still renders from the entities + local setup).
    api.topology(site.id).then(
      (t) => active && setTopology(t),
      () => active && setTopology(null),
    );
    // The reported measurement points (`/sources`), fail-soft — they tell a
    // producer component whether its PV is actually flowing (F1 caveat).
    api.siteSources(site.id).then(
      (s) => active && setSources(s),
      () => active && setSources(null),
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const model = useMemo(
    () => (data ? plantModel(data.entities, topology, data.localSetup, sources) : null),
    [data, topology, sources],
  );

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

  return (
    <div className="vp-modell">
      <Card className="vp-modell-card">
        <p className="vp-note vp-modell-intro">
          So ist Ihre Anlage verschaltet: welche Geräte Messwerte liefern, welche Komponenten daraus
          entstehen und was das Cockpit daraus macht. Tippen Sie ein Gerät an, um seine Komponenten
          hervorzuheben.
        </p>

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
          <div className="vp-wire3" role="group" aria-label="Anlagen-Modell">
            {/* Column 1 — Geräte */}
            <section className="vp-wcol" aria-label="Geräte">
              <h3 className="vp-wcol-head">
                <Icon name="cpu" size={16} /> Geräte{' '}
                <span className="vp-wcol-sub">— liefern Messwerte</span>
              </h3>
              {model.devices.map((d) => (
                <DeviceBox
                  key={d.id}
                  device={d}
                  components={model.components}
                  selected={selected === d.id}
                  dim={highlightedDevices != null && !highlightedDevices.has(d.id)}
                  onSelect={() => setSelected(selected === d.id ? null : d.id)}
                />
              ))}
              {model.newlyReported.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="vp-wbox vp-wbox-new"
                  onClick={() => setAssign(s)}
                >
                  <span className="vp-wbox-new-title">
                    <Icon name="plus" size={16} /> Neues Gerät gefunden
                  </span>
                  <span className="vp-wsub">
                    „{s.summary}“ meldet sich — <strong className="vp-wbox-new-cta">jetzt zuordnen</strong>
                  </span>
                </button>
              ))}
              {model.devices.length === 0 && model.newlyReported.length === 0 && (
                <p className="vp-note">Noch kein Gerät gemeldet.</p>
              )}
            </section>

            <div className="vp-wire-arrow" aria-hidden="true">
              <Icon name="chevron-right" size={20} />
            </div>

            {/* Column 2 — Komponenten */}
            <section className="vp-wcol" aria-label="Komponenten">
              <h3 className="vp-wcol-head">
                <Icon name="layers" size={16} /> Komponenten{' '}
                <span className="vp-wcol-sub">— die Rollen</span>
              </h3>
              {model.components.map((c) => (
                <ComponentBox
                  key={c.id}
                  component={c}
                  selected={selected === c.id}
                  highlight={highlightedComponents != null && highlightedComponents.has(c.id)}
                  dim={highlightedComponents != null && !highlightedComponents.has(c.id)}
                  onSelect={() => setSelected(selected === c.id ? null : c.id)}
                />
              ))}
              {model.components.length === 0 && (
                <p className="vp-note">Noch keine Komponente — ordnen Sie ein gemeldetes Gerät zu.</p>
              )}
            </section>

            <div className="vp-wire-arrow" aria-hidden="true">
              <Icon name="chevron-right" size={20} />
            </div>

            {/* Column 3 — Ihre Anlage */}
            <section className="vp-wcol" aria-label="Ihre Anlage">
              <h3 className="vp-wcol-head">
                <Icon name="home" size={16} /> Ihre Anlage{' '}
                <span className="vp-wcol-sub">— was daraus wird</span>
              </h3>
              {model.effects.map((e) => (
                <EffectBox key={e.key} effect={e} />
              ))}
            </section>
          </div>
        )}

        {model && !isEmpty && (
          <p className="vp-note vp-modell-foot">
            Die Zuordnung ändert nie die Steuerung — sie ist Darstellung. Steuer-Rechte hängen am
            Gerät (Guard-Kette), nicht an der Rolle.
          </p>
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

      {assign && (
        <ZuordnenDialog
          siteId={site.id}
          source={assign}
          onClose={() => setAssign(null)}
          onAssigned={() => {
            setAssign(null);
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

/** One physical box in the Geräte column. */
function DeviceBox({
  device,
  components,
  selected,
  dim,
  onSelect,
}: {
  device: PlantDevice;
  components: PlantComponent[];
  selected: boolean;
  dim: boolean;
  onSelect: () => void;
}) {
  const chips = device.componentIds
    .map((id) => components.find((c) => c.id === id))
    .filter((c): c is PlantComponent => c != null);
  return (
    <button
      type="button"
      className={`vp-wbox vp-wbox-device${selected ? ' selected' : ''}${dim ? ' dim' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className={`vp-health-dot vp-health-${HEALTH_TONE[device.health]}`} />
      <span className="vp-wn">{device.label}</span>
      <span className="vp-wsub">{device.summary}</span>
      {chips.length > 0 && (
        <span className="vp-wchips">
          {chips.map((c) => (
            <span key={c.id}>
              {c.control ? 'misst + steuert ' : 'misst '}
              {c.label}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** One Komponente in the middle column. */
function ComponentBox({
  component,
  selected,
  highlight,
  dim,
  onSelect,
}: {
  component: PlantComponent;
  selected: boolean;
  highlight: boolean;
  dim: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`vp-wbox vp-wbox-part vp-part-${component.role}${
        selected || highlight ? ' selected' : ''
      }${dim ? ' dim' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="vp-wn">
        <Icon name={COMPONENT_ROLE_ICONS[component.role] as IconName} size={16} />
        {component.label}
      </span>
      <span className="vp-wsub">{component.summary}</span>
      {/* F1 caveat: a Fronius/producer is read through the inverter, so an empty
          per-device chart is expected, not alarming. */}
      {component.measuredVia && <span className="vp-wmeasured">{component.measuredVia}</span>}
      {component.channels.length > 0 && (
        <span className="vp-wchips">
          {component.channels.map((ch) => (
            <span key={ch.raw} title={ch.raw}>
              {ch.label}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

const EFFECT_ICONS: Record<string, IconName> = {
  cockpit: 'activity',
  steuerung: 'sliders',
  historie: 'history',
  gesundheit: 'shield',
};

/** One "Ihre Anlage" effect card in the right column. */
function EffectBox({ effect }: { effect: PlantEffect }) {
  return (
    <div className={`vp-wbox vp-wbox-effect${effect.tone === 'warn' ? ' warn' : ''}`}>
      <span className="vp-wn">
        <Icon name={EFFECT_ICONS[effect.key] ?? 'activity'} size={16} />
        {effect.title}
      </span>
      <span className="vp-wsub">{effect.summary}</span>
    </div>
  );
}
