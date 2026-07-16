import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile, type IconCategory } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type Site, type SiteAsset } from '../api';
import {
  AUTOMATIC_MODULES,
  OPTIMIERUNG_INTRO,
  buildLastspitzenUpdate,
  lastspitzenkappungCard,
  marktoptimierungCard,
  parseLastspitzenForm,
  supportsLastspitzenConfig,
  type ModuleCardView,
} from '../moduleSurface';
import {
  optimizerApi,
  type LeistungspreisAbrechnung,
  type OptimizerConfig,
} from '../optimizerApi';
import {
  SPEICHERSCHONUNG_OPTIONS,
  presetOf,
  type SpeicherschonungPreset,
} from '../speicherschonung';
import { InfoTip } from './InfoTip';

/** Icon + tile hue per module card (visual only - copy lives in moduleSurface.ts). */
const CARD_ICON: Record<ModuleCardView['id'], { icon: IconName; category: IconCategory }> = {
  marktoptimierung: { icon: 'trending-up', category: 'dynamic' },
  lastspitzenkappung: { icon: 'zap', category: 'industry' },
};

/**
 * The "Optimierung" Anlage subpage (customer module surface, captain
 * 2026-07-16 + Lavish design update): what VoltPilot runs for this Anlage,
 * what it does, and what else is available - outcome language only. The
 * Speicherschonung preset is changeable here for everyone (the "später
 * änderbar" home of the wizard's Nutzung choice); the Lastspitzenkappung
 * contract is editable for platform-admins only, and ONLY once the backend
 * carries the contract fields (probed on the optimizer-config GET - absent
 * fields hide the editor, never a guessed PUT). Customers see calm read-only
 * state; the available card has NO button (Vertrieb läuft persönlich).
 */
export function OptimierungSection({ site, isAdmin = false }: { site: Site; isAdmin?: boolean }) {
  const [battery, setBattery] = useState<SiteAsset | null>(null);
  const [adminConfig, setAdminConfig] = useState<OptimizerConfig | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // The battery asset (Speicherschonung read + edit) - fail-soft: no battery
  // or a failed fetch simply omits the sub-line and the editor.
  useEffect(() => {
    let active = true;
    api.siteAssets(site.id).then(
      (assets) => {
        if (active) setBattery(assets.find((a) => a.type === 'battery') ?? null);
      },
      () => {
        if (active) setBattery(null);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Admin only: the optimizer-config through the tenant switcher. Fail-soft -
  // a missing tenant selection, an older backend or a customer token just
  // leaves the admin editor hidden.
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    optimizerApi.configViaSwitcher(site.id).then(
      (c) => {
        if (active) setAdminConfig(c);
      },
      () => {
        if (active) setAdminConfig(null);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, isAdmin, reloadKey]);

  // The configured Leistungspreis: the admin config is fresher after a save;
  // the SiteDto field (sibling backend task) serves everyone else. Both are
  // optional - absent reads as "not active".
  const leistungspreis =
    adminConfig?.overrides.leistungspreisEurKw ?? site.leistungspreisEurKw ?? null;

  const markt = marktoptimierungCard(
    site.plantKind,
    site.tarifArt,
    battery?.speicherschonung ?? null,
    battery != null,
  );
  const lastspitzen = lastspitzenkappungCard(leistungspreis);
  const adminEditable = isAdmin && supportsLastspitzenConfig(adminConfig?.overrides);

  return (
    <>
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <span className="vp-card-label">Für Ihre Anlage</span>
        <p className="vp-note vp-modul-intro">{OPTIMIERUNG_INTRO}</p>
        <div className="vp-modul-grid">
          <ModulCard card={markt}>
            {battery != null && (
              <SchonungEditor
                siteId={site.id}
                battery={battery}
                onSaved={() => setReloadKey((k) => k + 1)}
              />
            )}
          </ModulCard>
          <ModulCard card={lastspitzen}>
            {adminEditable && adminConfig && (
              <LastspitzenAdminEditor
                siteId={site.id}
                config={adminConfig}
                onSaved={(c) => setAdminConfig(c)}
              />
            )}
          </ModulCard>
        </div>
      </Card>

      <Card padding="lg" radius="lg" style={{ minWidth: 0, marginTop: 'var(--vp-gap)' }}>
        <span className="vp-card-label">Automatisch aktiv</span>
        <div className="vp-modul-auto">
          {AUTOMATIC_MODULES.map((row) => (
            <p className="vp-modul-auto-row" key={row.title}>
              <Icon name="shield" size={16} aria-hidden="true" />
              <span>
                <b>{row.title}:</b> {row.line}{' '}
                <InfoTip title={row.title} label={`${row.title} erklären`}>
                  {row.tip}
                </InfoTip>
              </span>
            </p>
          ))}
        </div>
      </Card>
    </>
  );
}

/** One value card: head (icon, title, state badge), outcome line, detail, editor slot. */
function ModulCard({ card, children }: { card: ModuleCardView; children?: React.ReactNode }) {
  const visual = CARD_ICON[card.id];
  return (
    <div className={`vp-modul-card${card.active ? '' : ' locked'}`}>
      <div className="vp-modul-head">
        <IconTile category={card.active ? visual.category : 'home'} size={36}>
          <Icon name={card.active ? visual.icon : 'lock'} size={18} />
        </IconTile>
        <span className="vp-modul-title">{card.title}</span>
        <Badge variant={card.active ? 'ok' : 'tint'} dot={card.active}>
          {card.stateLabel}
        </Badge>
      </div>
      {card.managedNote && <p className="vp-modul-managed">{card.managedNote}</p>}
      <p className="vp-modul-line">{card.line}</p>
      {card.subLine && <p className="vp-modul-sub">{card.subLine}</p>}
      {children}
    </div>
  );
}

/**
 * Inline Speicherschonung change ("Ändern" under the Marktoptimierung card) -
 * the "später änderbar" home of the wizard's Nutzung choice. Saves through the
 * battery PUT carrying the stored master data unchanged (full-representation),
 * so it is only offered while the battery's required values are present.
 */
function SchonungEditor({
  siteId,
  battery,
  onSaved,
}: {
  siteId: string;
  battery: SiteAsset;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<SpeicherschonungPreset | null>(
    presetOf(battery.speicherschonung),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable =
    battery.capacityKwh != null && battery.maxChargeKw != null && battery.maxDischargeKw != null;
  if (!editable) return null;

  async function save() {
    if (busy || choice == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveBattery(siteId, {
        capacityKwh: battery.capacityKwh as number,
        maxChargeKw: battery.maxChargeKw as number,
        maxDischargeKw: battery.maxDischargeKw as number,
        roundtripEfficiencyPct: battery.roundtripEfficiencyPct,
        deviceId: battery.deviceId,
        speicherschonung: choice,
      });
      setOpen(false);
      onSaved();
    } catch {
      setError('Die Einstellung konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
        <button type="button" className="vp-linklike" onClick={() => setOpen(true)}>
          Umgang mit dem Speicher ändern
        </button>
      </p>
    );
  }

  return (
    <div className="vp-modul-editor">
      <fieldset className="vp-schonung">
        <legend className="vp-schonung-legend">Umgang mit dem Speicher</legend>
        {SPEICHERSCHONUNG_OPTIONS.map((o) => (
          <label
            key={o.value}
            className={'vp-schonung-opt' + (choice === o.value ? ' selected' : '')}
          >
            <input
              type="radio"
              name="optimierung-speicherschonung"
              value={o.value}
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
            />
            <span className="vp-schonung-main">
              <span className="vp-schonung-label">
                {o.label}
                {o.recommended ? ' (empfohlen)' : ''}
              </span>
              <span className="vp-schonung-sentence">{o.sentence}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="vp-modul-editor-actions">
        <Button variant="primary" size="sm" onClick={save} disabled={busy || choice == null}>
          {busy ? 'Speichere…' : 'Speichern'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Abbrechen
        </Button>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </div>
  );
}

/**
 * Platform-admin contract editor for Lastspitzenkappung (renders ONLY when the
 * backend's optimizer-config carries the contract fields - probed, never
 * guessed). Full-representation PUT: the received overrides ride along
 * unchanged, only the peak-shaving fields are set or cleared.
 */
function LastspitzenAdminEditor({
  siteId,
  config,
  onSaved,
}: {
  siteId: string;
  config: OptimizerConfig;
  onSaved: (config: OptimizerConfig) => void;
}) {
  const configured = config.overrides.leistungspreisEurKw ?? null;
  const [open, setOpen] = useState(false);
  const [leistungspreis, setLeistungspreis] = useState(
    configured != null ? String(configured).replace('.', ',') : '',
  );
  const [abrechnung, setAbrechnung] = useState<LeistungspreisAbrechnung>(
    config.overrides.leistungspreisAbrechnung ?? 'jahr',
  );
  const [reserve, setReserve] = useState(
    config.overrides.lastspitzenReserveKw != null
      ? String(config.overrides.lastspitzenReserveKw).replace('.', ',')
      : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function put(body: ReturnType<typeof buildLastspitzenUpdate>) {
    setBusy(true);
    setError(null);
    try {
      const next = await optimizerApi.updateConfigViaSwitcher(siteId, body);
      setOpen(false);
      onSaved(next);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie die Werte.'
          : 'Die Konfiguration konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy) return;
    const parsed = parseLastspitzenForm({ leistungspreis, abrechnung, reserve });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    await put(buildLastspitzenUpdate(config.overrides, parsed.value));
  }

  if (!open) {
    return (
      <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
        <button type="button" className="vp-linklike" onClick={() => setOpen(true)}>
          {configured != null ? 'Konfiguration bearbeiten' : 'Für diese Anlage einrichten'}
        </button>
        {' '}(Portal-Admin)
      </p>
    );
  }

  return (
    <div className="vp-modul-editor">
      <div className="vp-form-stack">
        <Input
          label="Leistungspreis (€/kW) *"
          placeholder="z. B. 120"
          inputMode="decimal"
          value={leistungspreis}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLeistungspreis(e.target.value)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="lsk-abrechnung" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Abrechnung
          </label>
          <select
            id="lsk-abrechnung"
            className="vp-select"
            value={abrechnung}
            onChange={(e) => setAbrechnung(e.target.value as LeistungspreisAbrechnung)}
          >
            <option value="jahr">Jahresleistungspreis</option>
            <option value="monat">Monatsleistungspreis</option>
          </select>
        </div>
        <Input
          label="Reserve (kW)"
          placeholder="optional"
          inputMode="decimal"
          value={reserve}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReserve(e.target.value)}
          hint="Sicherheitsabstand unter der Zielspitze. Leer lassen für den Standard."
        />
      </div>
      <div className="vp-modul-editor-actions">
        <Button variant="primary" size="sm" onClick={save} disabled={busy}>
          {busy ? 'Speichere…' : 'Speichern'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Abbrechen
        </Button>
        {configured != null && (
          <button
            type="button"
            className="vp-linklike"
            onClick={() => void put(buildLastspitzenUpdate(config.overrides, null))}
            disabled={busy}
          >
            Deaktivieren
          </button>
        )}
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </div>
  );
}
