import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type TopologyRoleAssignment } from '../api';
import { entitiesApi } from '../entitiesApi';
import { suggestEntityType, type AdoptableSource } from '../rollen';
import { ADOPT_FORBIDDEN_MSG } from '../setupPath';

/**
 * Portal v3 · M6 — the ONE-MOVE assignment dialog ("Zuordnen ist ein Zug, kein
 * Formular", concept tab 7). A newly reported Gerät ("Neues Gerät gefunden") is
 * turned into a Komponente in a single submit: it derives the guided type from
 * the reported role+brand (never a free type picker — F6/D3), asks only what
 * ONLY the customer knows (a producer's kWp/MaStR, a Verbraucher's rated
 * power), and then performs the existing adoption + role assignment together.
 *
 * The role is PRESENTATION only and never widens control — the dialog says so.
 */

/** The guided type → its role + measure channel + what the customer must add. */
interface Guided {
  entityType: string;
  /** The customer name for what this device measures ("Was misst dieses Gerät?"). */
  what: string;
  role: string;
  channel: string;
  /** 'producer' asks kWp (+ MaStR), 'consumer' a rated power, 'meter' nothing. */
  ask: 'producer' | 'consumer' | 'meter';
}

/** Resolve the guided component from a reported source (via the rollen.ts truth). */
export function guidedFor(source: AdoptableSource): Guided | null {
  const type = source.suggestedType ?? suggestEntityType(source.role, source.brand);
  switch (type) {
    case 'producer':
      return { entityType: 'producer', what: 'PV-Erzeugung', role: 'pv', channel: 'pv_power_kw', ask: 'producer' };
    case 'grid-meter':
      return { entityType: 'grid-meter', what: 'Netzanschluss', role: 'grid', channel: 'power_kw', ask: 'meter' };
    case 'wallbox':
      return { entityType: 'wallbox', what: 'Wallbox', role: 'consumer', channel: 'power_kw', ask: 'consumer' };
    case 'generic-load':
      return { entityType: 'generic-load', what: 'Verbraucher', role: 'consumer', channel: 'power_kw', ask: 'consumer' };
    default:
      return null;
  }
}

export function ZuordnenDialog({
  siteId,
  source,
  onClose,
  onAssigned,
}: {
  siteId: string;
  source: AdoptableSource;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const guided = guidedFor(source);
  const [label, setLabel] = useState(source.label ?? '');
  const [kwp, setKwp] = useState('');
  const [see, setSee] = useState('');
  const [maxPowerKw, setMaxPowerKw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!guided) return;
    setBusy(true);
    setError(null);
    const power =
      guided.ask === 'consumer' && maxPowerKw.trim() !== ''
        ? Number(maxPowerKw.replace(',', '.'))
        : undefined;
    const capacity =
      guided.ask === 'producer' && kwp.trim() !== '' ? Number(kwp.replace(',', '.')) : undefined;
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
      // 1) Adoption composes the entity AND its default role in one call.
      const adopted = await entitiesApi.adopt(siteId, {
        sourceId: source.id,
        entityType: guided.entityType,
        label: label.trim() || undefined,
        maxPowerKw: power,
        capacityKwp: capacity,
        registryUnitId: guided.ask === 'producer' ? see.trim() || undefined : undefined,
      });
      // 2) Confirm the role assignment (the guided default already matches, so
      //    this is a presentation-level confirmation). Best-effort: adoption is
      //    the source of truth, so a topology hiccup must not fail a completed
      //    assignment — the honest failure message belongs to the adopt call.
      const assignment: TopologyRoleAssignment = {
        entityId: adopted.id,
        channel: guided.channel,
        role: guided.role,
        primary: false,
      };
      await api.setTopologyRoles(siteId, [assignment]).catch(() => undefined);
      onAssigned();
    } catch (e) {
      // The customer adopt twin may be absent (older backend) — then the call
      // is 401/403/404 and the honest "VoltPilot richtet das ein" hint applies,
      // never a raw status.
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401 || status === 403 || status === 404) {
        setError(ADOPT_FORBIDDEN_MSG);
      } else {
        setError(e instanceof ApiError ? e.message : 'Das Gerät konnte nicht zugeordnet werden.');
      }
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="Gerät zuordnen"
      icon={<Icon name="plus" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={submit} disabled={busy || !guided}>
            Fertig
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <p className="vp-note" style={{ marginTop: 0 }}>
          Ihr Gerät meldet: <strong>{source.summary}</strong>.
        </p>

        {guided ? (
          <>
            <div className="vp-zuordnen-what">
              <span className="vp-note">Was misst dieses Gerät?</span>
              <strong>{guided.what}</strong>
            </div>
            <Input
              label="Name der Komponente"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={guided.what}
            />
            {guided.ask === 'producer' && (
              <>
                <Input
                  label="Anlagenleistung (kWp)"
                  value={kwp}
                  onChange={(e) => setKwp(e.target.value)}
                  placeholder="z. B. 27"
                  inputMode="decimal"
                />
                <Input
                  label="MaStR-Nummer (optional)"
                  value={see}
                  onChange={(e) => setSee(e.target.value)}
                  placeholder="SEE…"
                />
              </>
            )}
            {guided.ask === 'consumer' && (
              <Input
                label="Anschlussleistung (kW, optional)"
                value={maxPowerKw}
                onChange={(e) => setMaxPowerKw(e.target.value)}
                placeholder="z. B. 11"
                inputMode="decimal"
              />
            )}
            <p className="vp-note vp-zuordnen-hint">
              Die Zuordnung ist reine Darstellung — sie ändert nie die Steuerung. Steuer-Rechte
              hängen am Gerät, nicht an der Rolle.
            </p>
          </>
        ) : (
          <p className="vp-note">
            Dieses Gerät kann VoltPilot für Sie einrichten — sprechen Sie uns an.
          </p>
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
