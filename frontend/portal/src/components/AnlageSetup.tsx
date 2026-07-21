import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type Site, type SiteEntities } from '../api';
import { entitiesApi } from '../entitiesApi';
import { adoptableSources } from '../rollen';
import {
  ADOPT_FAILED_MSG,
  ADOPT_FORBIDDEN_MSG,
  UNGUIDED_HINT,
  adoptedBridge,
  guidedAdoptions,
  setupPath,
  type AdoptedBridge,
  type AdoptionPlan,
  type SetupStep,
} from '../setupPath';
import { AddDeviceDrawer } from './DeviceDrawers';
import { TextSkeleton } from './States';
import './AnlageSetup.css';

/**
 * M5 (#533) — **das Cockpit einer leeren Anlage IST der Einrichtungspfad**
 * (report `data/vp-anlagen-face-k9/report.md` §3 „Neu / leer" + §4):
 * 1 Gerät verbinden ✓ → 2 Geräte übernehmen → 3 Steuerung wählen.
 * Keine Platzhalter-Karten, keine leeren Diagramme — es gibt nichts zu zeigen,
 * also wird der Weg gezeigt.
 *
 * Jede Ableitung liegt im reinen, unit-getesteten `src/setupPath.ts`; hier wird
 * gerendert und mit den BESTEHENDEN Endpunkten gesprochen:
 *  - Schritt 1 = der unveränderte `AddDeviceDrawer` (Geräte-ID beanspruchen),
 *  - Schritt 2 = die U2-Adoptionsbrücke (`api.siteEntities` → `entitiesApi.adopt`),
 *    hier **kundenseitig und katalog-geführt** (F6): der Typ wird aus Rolle +
 *    Marke vorgeschlagen, gefragt wird nur, was NUR der Kunde weiß (kWp, MaStR,
 *    Anschlussleistung) — **keine freie Typ- oder Guard-Eingabe**. Die
 *    Admin-Brücke in „Geräte" bleibt unverändert.
 *  - Schritt 3 = der M2-Werkzeugkasten („Modus hinzufügen") — M5 baut ihn NICHT
 *    nach, es führt hin.
 *
 * Nach einer Übernahme erscheint die Brücke „«Wallbox» übernommen — Regel dafür
 * anlegen?" und der Pfad bleibt sichtbar (`onStay`), bis der Kunde weitergeht.
 */
export function AnlageSetup({
  site,
  deviceCount,
  onOpenSteuerung,
  onOpenGeraete,
  onReload,
  onStay,
}: {
  site: Site;
  deviceCount: number;
  onOpenSteuerung: () => void;
  onOpenGeraete: () => void;
  onReload: (selectSiteId?: string) => void;
  /** Den Pfad sichtbar halten, während der Kunde mitten in der Kette steht. */
  onStay: (stay: boolean) => void;
}) {
  const [data, setData] = useState<SiteEntities | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [claimOpen, setClaimOpen] = useState(false);
  const [adopting, setAdopting] = useState<AdoptionPlan | null>(null);
  const [bridge, setBridge] = useState<AdoptedBridge | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.siteEntities(site.id).then(
      (d) => {
        if (!active) return;
        setData(d);
        setLoading(false);
      },
      () => {
        // Ein älteres Backend / ein Ladefehler darf den Pfad nie blockieren:
        // Schritt 1 und 3 bleiben bedienbar, Schritt 2 sagt ehrlich nichts.
        if (!active) return;
        setData(null);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const localSetup = data?.localSetup ?? [];
  const reported = adoptableSources(localSetup);
  const plans = guidedAdoptions(reported);
  const unguided = reported.length - plans.length;
  const adoptedCount = data?.entities.length ?? 0;

  const view = setupPath({ deviceCount, reported, adoptedCount });

  function runAction(step: SetupStep) {
    switch (step.action?.kind) {
      case 'claim':
        setClaimOpen(true);
        break;
      case 'adopt':
        if (plans[0]) setAdopting(plans[0]);
        break;
      case 'toolbox':
        onStay(false);
        onOpenSteuerung();
        break;
      default:
        break;
    }
  }

  return (
    <div className="vp-setup">
      <Card padding="lg" radius="lg" className="vp-block vp-block-lead" style={{ minWidth: 0 }}>
        <header className="vp-block-head">
          <h3 className="vp-block-title">{view.title}</h3>
          <span className="vp-block-from is-base">Einrichtung</span>
        </header>

        <ol className="vp-setup-steps">
          {view.steps.map((step) => (
            <li key={step.id} className={`vp-setup-step is-${step.state}`}>
              <span className="vp-setup-num" aria-hidden="true">
                {step.state === 'done' ? <Icon name="check" size={15} strokeWidth={3} /> : step.num}
              </span>
              <div className="vp-setup-body">
                <span className="vp-setup-title">{step.title}</span>
                <p className="vp-setup-line">{step.line}</p>

                {step.id === 'uebernehmen' && step.state === 'current' && plans.length > 0 && (
                  <ul className="vp-setup-reported">
                    {plans.map((plan) => (
                      <li key={plan.sourceId} className="vp-setup-source">
                        <Icon name={plan.entityType === 'producer' ? 'sun' : 'zap'} size={16} />
                        <span className="vp-setup-source-main">
                          <span className="vp-setup-source-name">{plan.summary}</span>
                          <span className="vp-setup-source-sub">{plan.roleLabel}</span>
                        </span>
                        <Button variant="outline" size="sm" onClick={() => setAdopting(plan)}>
                          {plan.actionLabel}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                {step.id === 'uebernehmen' && step.state === 'current' && unguided > 0 && (
                  <p className="vp-setup-source-hint">{UNGUIDED_HINT}</p>
                )}

                {step.action && (
                  <div className="vp-setup-action">
                    <Button variant="primary" onClick={() => runAction(step)}>
                      {step.action.label}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>

        {loading && data == null && <TextSkeleton lines={1} />}
      </Card>

      {bridge && (
        <div className="vp-setup-bridge" role="status">
          <Icon name="check" size={18} />
          <span className="vp-setup-bridge-main">
            <span className="vp-setup-bridge-text">{bridge.text}</span>
            {bridge.ctaHint && <span className="vp-setup-bridge-hint">{bridge.ctaHint}</span>}
          </span>
          {bridge.cta ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setBridge(null);
                onStay(false);
                onOpenSteuerung();
              }}
            >
              {bridge.cta}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setBridge(null)}>
              Weiter
            </Button>
          )}
        </div>
      )}

      <p className="vp-setup-foot">
        {view.footNote}{' '}
        <button type="button" className="vp-toolbox-cta" onClick={onOpenGeraete}>
          Alle Geräte ansehen
          <Icon name="chevron-right" size={14} />
        </button>
      </p>

      <AddDeviceDrawer
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        sites={[site]}
        onClaimed={() => {
          // Die Anlagen-Seite lädt ihren Status neu (Gerätezahl), der Pfad
          // seine gemeldeten Quellen.
          onReload(site.id);
          reload();
        }}
      />

      {adopting && (
        <GuidedAdoptDrawer
          siteId={site.id}
          plan={adopting}
          onClose={() => setAdopting(null)}
          onAdopted={(label) => {
            setAdopting(null);
            setBridge(
              adoptedBridge({ entityType: adopting.entityType, label, typeLabel: adopting.typeLabel }),
            );
            // Der Pfad bleibt stehen, bis der Kunde weitergeht — sonst würde die
            // Seite unter der frisch übernommenen Entität wegspringen.
            onStay(true);
            reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * Die KUNDEN-Übernahme (F6): katalog-geführt. Der Typ steht fest (Vorschlag aus
 * Rolle + Marke) und wird nur GEZEIGT; gefragt wird ausschließlich, was nur der
 * Kunde weiß. Keine Guard-Konfiguration — Grenzen setzt VoltPilot.
 */
function GuidedAdoptDrawer({
  siteId,
  plan,
  onClose,
  onAdopted,
}: {
  siteId: string;
  plan: AdoptionPlan;
  onClose: () => void;
  onAdopted: (label: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const num = (raw: string | undefined): number | undefined => {
    const t = (raw ?? '').trim();
    return t === '' ? undefined : Number(t.replace(',', '.'));
  };
  const invalid = (v: number | undefined) => v !== undefined && (!Number.isFinite(v) || v < 0);

  async function submit() {
    setBusy(true);
    setError(null);
    const kwp = num(values.kwp);
    const leistung = num(values.leistung);
    if (invalid(kwp) || invalid(leistung)) {
      setError('Bitte geben Sie eine gültige Leistung an - zum Beispiel 9,8.');
      setBusy(false);
      return;
    }
    try {
      await entitiesApi.adopt(siteId, {
        sourceId: plan.sourceId,
        entityType: plan.entityType,
        label: label.trim() || undefined,
        maxPowerKw: leistung,
        capacityKwp: kwp,
        registryUnitId: (values.mastr ?? '').trim() || undefined,
      });
      onAdopted(label.trim() || plan.typeLabel);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError(status === 401 || status === 403 || status === 404 ? ADOPT_FORBIDDEN_MSG : ADOPT_FAILED_MSG);
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
          <Button onClick={submit} disabled={busy}>
            Übernehmen
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <p className="vp-note" style={{ marginTop: 0 }}>
          Ihr Gerät meldet: <strong>{plan.summary}</strong> ({plan.roleLabel}). VoltPilot übernimmt
          es als <strong>{plan.typeLabel}</strong>.
        </p>
        <Input
          label="Bezeichnung (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={plan.typeLabel}
        />
        {plan.fields.map((f) => (
          <Input
            key={f.id}
            label={f.label}
            value={values[f.id] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            placeholder={f.placeholder}
            inputMode={f.id === 'mastr' ? undefined : 'decimal'}
          />
        ))}
        {error && (
          <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 0 }}>
            {error}
          </div>
        )}
      </div>
    </Drawer>
  );
}
