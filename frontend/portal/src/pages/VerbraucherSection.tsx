/**
 * Steuerbare Verbraucher (docs/verbrauchssteuerung.md §14, Increment 1;
 * activation since Inkrement 4). The customer surface for controllable
 * consumers: list them, add one (connected to a reported device OR as a
 * draft), and configure a rule with the guided Regelbaukasten. On an
 * environment WITHOUT the activation flags the builder stores a policy DRAFT
 * and every consumer honestly reads "Steuerung noch nicht aktiviert" -
 * byte-identical to Increment 1; with the flags on, the review page's
 * "Speichern & aktivieren" really activates (validate → compile → rollout),
 * and the row states/pause/resume follow the server-derived truth.
 *
 * All rule LOGIC is the pure, unit-tested `src/consumers/*` (validate / questions
 * / policy / activation / vorlagen); the React below only renders those
 * derivations. No internal vocabulary reaches the customer (the copy guard
 * scans this file).
 */
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import type { EntityStrategy, Site } from '../api';
import { ApiError, api } from '../api';
import { consumersApi, type CreateConsumerBody } from '../consumers/consumersApi';
import type {
  Consumer,
  ConsumerOptions,
  ControlKind,
} from '../consumers/types';
import {
  consumerQuestions,
  standardStepCount,
  type ConditionDraft,
  type ConsumerContext,
  type ConsumerDraft,
  type Intent,
  type Question,
} from '../consumers/questions';
import { buildPolicyDocument, policySentence, reviewFacts } from '../consumers/policy';
import { validatePolicy, isValid, type ConsumerFinding } from '../consumers/validate';
import { consumerStatusLine, type ConsumerRuntimeStatus } from '../consumers/status';
import { activationBadge, conflictNote, saveButtonLabel } from '../consumers/activation';
import {
  fulfilmentSummary,
  overrideLine,
  sofortAktionen,
  SOFORT_LABEL,
  taskLine,
  type ConsumerFulfilment,
  type ManualOverride,
  type SofortAktion,
} from '../consumers/fulfillment';
import { ConsumerOverrideDialog } from '../components/ConsumerOverrideDialog';
import {
  CONSUMER_TEMPLATE_PREFILL,
  parseVerbraucherParams,
  templateConsumer,
} from '../consumers/vorlagen';
import './Verbraucher.css';

export function VerbraucherSection({ site }: { site: Site }): JSX.Element {
  const [options, setOptions] = useState<ConsumerOptions | null>(null);
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  const [status, setStatus] = useState<ConsumerRuntimeStatus[]>([]);
  const [overrides, setOverrides] = useState<ManualOverride[]>([]);
  const [fulfillment, setFulfillment] = useState<Record<string, ConsumerFulfilment>>({});
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]>>({});
  // The Sofortaktion being confirmed (§14.13), or null.
  const [sofort, setSofort] = useState<{ consumer: Consumer; action: SofortAktion } | null>(null);
  const [sofortBusy, setSofortBusy] = useState(false);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [ruleFor, setRuleFor] = useState<Consumer | null>(null);
  const [rulePrefill, setRulePrefill] = useState<Partial<ConsumerDraft> | null>(null);
  // The D7 deep link (?vorlage=/?verbraucher=) is consumed exactly ONCE.
  const deepLinkDone = useRef(false);

  useEffect(() => {
    let alive = true;
    setError(false);
    Promise.all([consumersApi.options(site.id), consumersApi.list(site.id)])
      .then(([opt, list]) => {
        if (!alive) return;
        setOptions(opt);
        setConsumers(list);
      })
      .catch(() => alive && setError(true));
    // Live states fail SOFT: without evidence (older device, endpoint error)
    // the surface stays byte-identical to before.
    consumersApi
      .status(site.id)
      .then((s) => alive && setStatus(s ?? []))
      .catch(() => alive && setStatus([]));
    // Active manual overrides + per-consumer fulfilment ledger, both fail-soft:
    // an older backend / a fresh site simply yields nothing new (§9.4 empty state).
    consumersApi
      .overrides(site.id)
      .then((o) => alive && setOverrides(o ?? []))
      .catch(() => alive && setOverrides([]));
    consumersApi
      .list(site.id)
      .then((list) =>
        Promise.all(
          (list ?? []).map((c) =>
            consumersApi
              .fulfillment(site.id, c.id)
              .then((f) => [c.id, f] as const)
              .catch(() => [c.id, { tasks: [] }] as const),
          ),
        ),
      )
      .then((pairs) => alive && setFulfillment(Object.fromEntries(pairs)))
      .catch(() => alive && setFulfillment({}));
    // Active-flow claims (V-5): fail-soft - without them no conflict is
    // CLAIMED, the server still refuses an activation truthfully.
    api
      .entityStrategies(site.id)
      .then((s) => alive && setStrategies(s ?? {}))
      .catch(() => alive && setStrategies({}));
    return () => {
      alive = false;
    };
  }, [site.id, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  // D7 deep link: a consumer template from the automation gallery opens the
  // Regelbaukasten prefilled; ?verbraucher= (the origin-badge edit path) opens
  // the builder for that consumer. Params are stripped after consumption (the
  // explorer/replaceState pattern) so back/reload does not re-open.
  useEffect(() => {
    if (deepLinkDone.current || !consumers) return;
    const params = parseVerbraucherParams(window.location.hash);
    if (!params.vorlage && !params.verbraucher) {
      deepLinkDone.current = true;
      return;
    }
    deepLinkDone.current = true;
    window.history.replaceState(null, '', window.location.hash.split('?')[0]);
    if (params.verbraucher) {
      const c = consumers.find((x) => x.id === params.verbraucher);
      if (c) setRuleFor(c);
      return;
    }
    const prefill = params.vorlage ? CONSUMER_TEMPLATE_PREFILL[params.vorlage] : undefined;
    if (!prefill) return;
    const c = templateConsumer(params.vorlage as string, consumers);
    if (c) {
      setRulePrefill(prefill);
      setRuleFor(c);
    } else {
      // No consumer yet: a rule needs one first - open the create wizard.
      setWizardOpen(true);
    }
  }, [consumers]);

  /** Pause/resume (Inkrement 4): the stop half works on EVERY environment. */
  const pauseConsumer = async (c: Consumer) => {
    setActionError(null);
    try {
      await consumersApi.pause(site.id, c.id);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Pausieren fehlgeschlagen.');
    }
  };
  const resumeConsumer = async (c: Consumer) => {
    setActionError(null);
    try {
      const out = await consumersApi.resume(site.id, c.id);
      if (!out.activated) setActionError(out.message);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Fortsetzen fehlgeschlagen.');
    }
  };

  // §14.13 Sofortaktionen: a TTL-bound manual intervention (start/stop) or
  // "Automatik fortsetzen" (resume). The server records + audits it and, with
  // the control flag off, honestly reports it was not pushed to the device.
  const runSofort = async (durationMinutes?: number) => {
    if (!sofort) return;
    const { consumer, action } = sofort;
    setActionError(null);
    setSofortBusy(true);
    try {
      const out =
        action === 'resume'
          ? await consumersApi.clearOverride(site.id, consumer.id)
          : await consumersApi.startOverride(site.id, consumer.id, { action, durationMinutes });
      if (!out.pushed && out.message) setActionError(out.message);
      setSofort(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Der Eingriff ist fehlgeschlagen.');
    } finally {
      setSofortBusy(false);
    }
  };

  return (
    <section className="vp-verbraucher">
      <div className="vp-vb-head">
        <div>
          <h2>Verbraucher</h2>
          <p className="vp-vb-intro">
            Wallbox, Heizstab, Pumpe und andere steuerbare Geräte anlegen und festlegen,
            wann sie laufen sollen.
          </p>
        </div>
        <Button
          iconLeft={<Icon name="plus" />}
          onClick={() => setWizardOpen(true)}
          disabled={!options}
        >
          Verbraucher hinzufügen
        </Button>
      </div>

      {error && (
        <ErrorState message="Die Verbraucher konnten nicht geladen werden." onRetry={reload} />
      )}
      {actionError && (
        <p className="vp-vb-error" role="alert">{actionError}</p>
      )}
      {!error && !consumers && <TextSkeleton lines={3} />}
      {!error && consumers && consumers.length === 0 && (
        <EmptyState
          title="Noch keine Verbraucher"
          description="Legen Sie Ihren ersten steuerbaren Verbraucher an."
        />
      )}
      {!error && consumers && consumers.length > 0 && (
        <div className="vp-vb-list">
          {consumers.map((c) => (
            <ConsumerRow
              key={c.id}
              consumer={c}
              status={status.find((s) => s.entityId === c.id)}
              anyReported={status.length > 0}
              override={overrides.find((o) => o.entityId === c.id) ?? null}
              fulfillment={fulfillment[c.id]}
              onConfigure={() => setRuleFor(c)}
              onPause={() => void pauseConsumer(c)}
              onResume={() => void resumeConsumer(c)}
              onSofort={(action) => setSofort({ consumer: c, action })}
            />
          ))}
        </div>
      )}

      {options && (
        <CreateWizard
          site={site}
          options={options}
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onCreated={(created, openRule) => {
            setWizardOpen(false);
            reload();
            if (openRule) setRuleFor(created);
          }}
        />
      )}

      <ConsumerOverrideDialog
        action={sofort?.action ?? null}
        consumerName={sofort?.consumer.name ?? ''}
        effectivePowerKw={sofort ? Number(sofort.consumer.ratedPowerKw) : null}
        busy={sofortBusy}
        onConfirm={(m) => void runSofort(m)}
        onCancel={() => setSofort(null)}
      />

      {options && ruleFor && (
        <RuleBuilder
          site={site}
          options={options}
          consumer={ruleFor}
          prefill={rulePrefill}
          claims={strategies[ruleFor.id]}
          onClose={() => {
            setRuleFor(null);
            setRulePrefill(null);
          }}
          onSaved={() => {
            setRuleFor(null);
            setRulePrefill(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

function ConsumerRow({
  consumer, status, anyReported, override, fulfillment, onConfigure, onPause, onResume, onSofort,
}: {
  consumer: Consumer;
  status?: ConsumerRuntimeStatus;
  anyReported: boolean;
  override: ManualOverride | null;
  fulfillment?: ConsumerFulfilment;
  onConfigure: () => void;
  onPause: () => void;
  onResume: () => void;
  onSofort: (action: SofortAktion) => void;
}): JSX.Element {
  const connectionLabel = consumer.connection === 'connected' ? 'Verbunden' : 'Noch nicht verbunden';
  // The live line renders only once ANY device reported states (Inkrement 3):
  // without evidence the surface is byte-identical to before. A consumer
  // WITHOUT its own entry while others have one honestly reads "Zustand nicht
  // bestätigt" - never a guessed live state.
  const live = anyReported ? consumerStatusLine(status) : null;
  const badge = activationBadge(consumer);
  const banner = overrideLine(override);
  const summary = fulfilmentSummary(fulfillment);
  const connected = consumer.connection === 'connected';
  // §14.13 Sofortaktionen: only for a CONNECTED consumer; resume when an
  // override is running, start+stop otherwise.
  const actions = sofortAktionen({ connected, hasOverride: banner != null });
  return (
    <div className="vp-vb-card">
      <div className="vp-vb-card-main">
        <div className="vp-vb-card-name">{consumer.name}</div>
        <div className="vp-vb-card-sub">
          {consumer.typeLabel} · {controlKindLabel(consumer.controlKind)}
          {consumer.hasDraftPolicy && consumer.controlActivation === 'not_activated'
            ? ' · Regel als Entwurf gespeichert' : ''}
        </div>
        {live && (
          <div className={`vp-vb-live vp-vb-live-${live.tone}`}>
            <span className="vp-dot" /> {live.text}
            {live.reason ? ` · ${live.reason}` : ''}
            {live.unconfirmed ? ' · Ausführung nicht bestätigt' : ''}
          </div>
        )}
        {banner && (
          <div className="vp-vb-live vp-vb-live-warn">
            <span className="vp-dot" /> {banner.text}
          </div>
        )}
        {summary.headline && (
          <div className="vp-vb-heute">
            Heute: {summary.headline}
            {fulfillment && fulfillment.tasks.length > 0 && (
              <ul className="vp-vb-tasks">
                {fulfillment.tasks.map((t) => {
                  const l = taskLine(t);
                  return (
                    <li key={t.requirementId} className={`vp-vb-task vp-vb-task-${l.tone}`}>
                      {l.text}
                      {l.progress ? ` · ${l.progress}` : ''}
                      {l.confirmation ? ` · ${l.confirmation}` : ''}
                      {l.atRisk ? ' · Frist gefährdet' : ''}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="vp-vb-card-actions">
        <Badge variant={connected ? 'ok' : 'off'} dot>
          {connectionLabel}
        </Badge>
        <span className={`vp-vb-not-activated vp-vb-act-${badge.tone}`}>
          <span className="vp-dot" /> {badge.text}
        </span>
        {actions.map((a) => (
          <Button key={a} variant={a === 'stop' ? 'ghost' : 'outline'} size="sm"
            onClick={() => onSofort(a)}>
            {SOFORT_LABEL[a]}
          </Button>
        ))}
        {consumer.controlActivation === 'active' && (
          <Button variant="ghost" size="sm" onClick={onPause}>Pausieren</Button>
        )}
        {consumer.controlActivation === 'paused' && (
          <Button variant="ghost" size="sm" onClick={onResume}>Fortsetzen</Button>
        )}
        <Button variant="outline" size="sm" onClick={onConfigure}>
          {consumer.hasDraftPolicy ? 'Regel bearbeiten' : 'Regel festlegen'}
        </Button>
      </div>
    </div>
  );
}

// --- Part A: create wizard --------------------------------------------------

function CreateWizard({
  site, options, open, onClose, onCreated,
}: {
  site: Site;
  options: ConsumerOptions;
  open: boolean;
  onClose: () => void;
  onCreated: (created: Consumer, openRule: boolean) => void;
}): JSX.Element {
  const [edgeSourceId, setEdgeSourceId] = useState<string>('');
  const [type, setType] = useState<string>(options.types[0]?.type ?? '');
  const [name, setName] = useState('');
  const [ratedPowerKw, setRatedPowerKw] = useState('');
  const [controlKind, setControlKind] = useState<ControlKind>(
    (options.types[0]?.controlKinds[0] as ControlKind) ?? 'on_off',
  );
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<Consumer | null>(null);

  const typeOption = options.types.find((t) => t.type === type) ?? options.types[0];

  // Keep the control kind valid for the chosen type.
  useEffect(() => {
    if (typeOption && !typeOption.controlKinds.includes(controlKind)) {
      setControlKind(typeOption.controlKinds[0] as ControlKind);
    }
  }, [typeOption, controlKind]);

  const reset = () => {
    setEdgeSourceId('');
    setName('');
    setRatedPowerKw('');
    setFormError(null);
    setCreated(null);
  };

  const submit = () => {
    const power = Number(ratedPowerKw.replace(',', '.'));
    if (!Number.isFinite(power) || power <= 0) {
      setFormError('Bitte geben Sie eine Leistung größer als 0 an.');
      return;
    }
    setBusy(true);
    setFormError(null);
    const body: CreateConsumerBody = {
      type,
      name: name.trim() || undefined,
      ratedPowerKw: power,
      controlKind,
    };
    if (edgeSourceId) body.edgeSourceId = edgeSourceId;
    consumersApi
      .create(site.id, body)
      .then((c) => setCreated(c))
      .catch((e) => setFormError(e instanceof ApiError ? e.message : 'Anlegen fehlgeschlagen.'))
      .finally(() => setBusy(false));
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Drawer open={open} onClose={close} title="Verbraucher hinzufügen">
      {created ? (
        <div className="vp-vb-success">
          <p>
            <strong>{created.name}</strong> ist angelegt.
            {created.connection === 'connected' ? '' : ' Zustand: Noch nicht verbunden.'}
          </p>
          <p className="vp-vb-hint">Steuerung noch nicht aktiviert.</p>
          <Button onClick={() => onCreated(created, true)}>
            Jetzt festlegen, wann er laufen soll
          </Button>
          <Button variant="ghost" onClick={() => onCreated(created, false)}>
            Später
          </Button>
        </div>
      ) : (
        <div className="vp-vb-step">
          <div className="vp-vb-field">
            <label htmlFor="vb-source">Verbindung</label>
            <select
              id="vb-source"
              value={edgeSourceId}
              onChange={(e) => setEdgeSourceId(e.target.value)}
            >
              <option value="">Jetzt noch nicht verbinden (Entwurf)</option>
              {options.reportedSources.map((s) => (
                <option key={s.sourceId} value={s.sourceId}>
                  {s.label ?? s.sourceId}
                  {s.brand ? ` · ${s.brand}` : ''}
                </option>
              ))}
            </select>
            <span className="vp-vb-hint">
              Ein gefundenes Gerät auswählen oder ohne Verbindung als Entwurf anlegen.
            </span>
          </div>

          <div className="vp-vb-field">
            <label htmlFor="vb-type">Was ist das?</label>
            <select id="vb-type" value={type} onChange={(e) => setType(e.target.value)}>
              {options.types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={typeOption?.label ?? 'Verbraucher'}
            autoComplete="off"
          />

          <Input
            label="Nennleistung (kW)"
            value={ratedPowerKw}
            onChange={(e) => setRatedPowerKw(e.target.value)}
            inputMode="decimal"
            placeholder="z. B. 11"
            error={formError && !created ? formError : undefined}
          />

          {typeOption && typeOption.controlKinds.length > 1 && (
            <fieldset className="vp-vb-fieldset">
              <legend>Regelbarkeit</legend>
              {typeOption.controlKinds.map((k) => (
                <label key={k} className={`vp-vb-choice ${controlKind === k ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="vb-controlkind"
                    checked={controlKind === k}
                    onChange={() => setControlKind(k as ControlKind)}
                  />
                  <span className="vp-vb-choice-title">{controlKindLabel(k as ControlKind)}</span>
                </label>
              ))}
            </fieldset>
          )}

          <Button onClick={submit} disabled={busy}>
            {busy ? 'Wird angelegt …' : 'Speichern'}
          </Button>
        </div>
      )}
    </Drawer>
  );
}

// --- Part B: rule builder (guided Baukasten) --------------------------------

const INTENT_CARDS: { key: Intent; title: string; line: string }[] = [
  { key: 'react', title: 'Sofort reagieren', line: 'Wenn etwas passiert, soll der Verbraucher reagieren.' },
  { key: 'schedule', title: 'Feste Zeiten', line: 'Der Verbraucher soll zu bestimmten Zeiten laufen.' },
  { key: 'deadline', title: 'Bis zu einer Frist erledigen', line: 'VoltPilot darf den besten Zeitpunkt wählen.' },
  { key: 'cheap', title: 'Günstige Energie nutzen', line: 'Nur bei passendem Preis, PV-Überschuss oder Ladestand.' },
];

function RuleBuilder({
  site, options, consumer, prefill, claims, onClose, onSaved,
}: {
  site: Site;
  options: ConsumerOptions;
  consumer: Consumer;
  prefill?: Partial<ConsumerDraft> | null;
  claims?: EntityStrategy[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const ctx: ConsumerContext = {
    controlKind: consumer.controlKind,
    hasStorage: options.hasStorage,
    hasMeasurementChannel: consumer.type === 'wallbox' || consumer.type === 'heating-rod'
      || consumer.type === 'pump' || consumer.type === 'generic-load',
  };
  const [draft, setDraft] = useState<ConsumerDraft>(
    () => ({ ...initialDraft(consumer), ...(prefill ?? {}) }),
  );
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<null | { kind: 'draft' | 'active'; message: string }>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const activationEnabled = options.policyActivationEnabled === true;
  const conflict = conflictNote(claims, consumer.controlActivation);
  const questions = draft.intent ? consumerQuestions(ctx, draft) : [];
  const total = standardStepCount(ctx, draft);

  const doc = draft.intent
    ? buildPolicyDocument(draft, {
        entityId: consumer.id,
        requirementId: 'r-1',
        ctx,
        controlProfile: {
          control_kind: consumer.controlKind,
          rated_power_kw: consumer.ratedPowerKw,
          ...(consumer.minPowerKw != null ? { min_power_kw: consumer.minPowerKw } : {}),
          ...(consumer.resolutionKw != null ? { resolution_kw: consumer.resolutionKw } : {}),
          ...(consumer.levelsKw ? { levels_kw: consumer.levelsKw } : {}),
          ...(consumer.powerRangesKw ? { power_ranges_kw: consumer.powerRangesKw } : {}),
        },
        name: consumer.name,
      })
    : null;
  const findings: ConsumerFinding[] = doc ? validatePolicy(doc) : [];
  const valid = doc != null && isValid(findings);

  const update = (patch: Partial<ConsumerDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    if (!doc || !valid) return;
    setBusy(true);
    setServerError(null);
    consumersApi
      .savePolicy(site.id, consumer.id, doc)
      .then(() => setSaved({
        kind: 'draft',
        message: 'Steuerung noch nicht aktiviert - VoltPilot sendet noch keine Befehle an das Gerät.',
      }))
      .catch((e) => setServerError(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.'))
      .finally(() => setBusy(false));
  };

  /**
   * Inkrement 4: save the draft, then really activate (validate → compile →
   * atomic activate → rollout). An HONEST refusal (`activated:false`, 409, 503)
   * keeps the draft and shows the server's German reason - the active rule is
   * unchanged then (§11).
   */
  const saveAndActivate = async () => {
    if (!doc || !valid) return;
    setBusy(true);
    setServerError(null);
    try {
      await consumersApi.savePolicy(site.id, consumer.id, doc);
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
      setBusy(false);
      return;
    }
    try {
      const out = await consumersApi.activatePolicy(site.id, consumer.id);
      if (out.activated) {
        setSaved({ kind: 'active', message: out.message });
      } else {
        setServerError(`${out.message} Die Regel ist als Entwurf gespeichert.`);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Aktivieren fehlgeschlagen.';
      setServerError(`${msg} Die Regel ist als Entwurf gespeichert.`);
    } finally {
      setBusy(false);
    }
  };

  /** The real stop path (flag-independent): retire the rule + retract the rollout. */
  const deactivate = async () => {
    setBusy(true);
    setServerError(null);
    try {
      await consumersApi.deactivatePolicy(site.id, consumer.id);
      onSaved();
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : 'Deaktivieren fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  const footer = saved ? (
    <Button onClick={onSaved}>Fertig</Button>
  ) : review ? (
    <>
      <Button variant="ghost" onClick={() => setReview(false)}>Zurück</Button>
      {activationEnabled && (
        <Button variant="ghost" onClick={save} disabled={busy || !valid}>
          Als Entwurf speichern
        </Button>
      )}
      <Button
        onClick={() => (activationEnabled ? void saveAndActivate() : save())}
        disabled={busy || !valid}
      >
        {busy ? 'Wird gespeichert …' : saveButtonLabel(activationEnabled)}
      </Button>
    </>
  ) : (
    <Button onClick={() => setReview(true)} disabled={!valid}>Prüfen</Button>
  );

  // The stop path must be reachable WITHOUT building a new rule: the intent
  // screen of an activated consumer carries "Regel deaktivieren" as its footer.
  const intentFooter = consumer.controlActivation !== 'not_activated' ? (
    <Button variant="ghost" onClick={() => void deactivate()} disabled={busy}>
      Regel deaktivieren
    </Button>
  ) : undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Regel für ${consumer.name}`}
      footer={draft.intent ? footer : intentFooter}
    >
      {saved ? (
        <div className="vp-vb-success">
          <p>
            <strong>
              {saved.kind === 'active' ? 'Regel aktiviert.' : 'Regel als Entwurf gespeichert.'}
            </strong>
          </p>
          <p className="vp-vb-hint">{saved.message}</p>
        </div>
      ) : !draft.intent ? (
        <div className="vp-vb-step">
          <p className="vp-vb-hint">Was soll der Verbraucher tun?</p>
          <div className="vp-vb-cards two" role="radiogroup" aria-label="Absicht">
            {INTENT_CARDS.map((card) => (
              <button
                key={card.key}
                type="button"
                role="radio"
                aria-checked={false}
                className="vp-vb-choice"
                onClick={() => update({ intent: card.key })}
              >
                <span>
                  <span className="vp-vb-choice-title">{card.title}</span>
                  <span className="vp-vb-choice-sub">{card.line}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : review ? (
        <div className="vp-vb-step vp-vb-review">
          <div className="vp-vb-stepcount">Prüfen</div>
          <dl>
            {doc && reviewFacts(doc, consumer.name, activationEnabled).map((f, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          {/* V-5 honestly BEFORE the click - the server would refuse the same way. */}
          {activationEnabled && conflict && (
            <p className="vp-vb-conflict">{conflict}</p>
          )}
          {serverError && <p className="vp-vb-error">{serverError}</p>}
        </div>
      ) : (
        <div className="vp-vb-step">
          <div className="vp-vb-stepcount">{total} {total === 1 ? 'Schritt' : 'Schritte'}</div>
          {questions.filter((q) => q.section === 'standard').map((q) => (
            <QuestionControl
              key={q.id}
              q={q}
              draft={draft}
              options={options}
              consumer={consumer}
              onUpdate={update}
            />
          ))}
          <MoreSettings questions={questions} draft={draft} onUpdate={update} />

          {doc && (
            <div className="vp-vb-preview" aria-live="polite">
              <div className="vp-vb-preview-label">Vorschau</div>
              <p>{policySentence(doc, consumer.name)}</p>
            </div>
          )}
          {!valid && findings.filter((f) => f.severity === 'error').length > 0 && (
            <p className="vp-vb-error">{findings.find((f) => f.severity === 'error')?.message}</p>
          )}
        </div>
      )}
    </Drawer>
  );
}

function QuestionControl({
  q, draft, options, consumer, onUpdate,
}: {
  q: Question;
  draft: ConsumerDraft;
  options: ConsumerOptions;
  consumer: Consumer;
  onUpdate: (patch: Partial<ConsumerDraft>) => void;
}): JSX.Element | null {
  switch (q.kind) {
    case 'conditions':
      return (
        <ConditionsEditor
          conditions={draft.conditions}
          signals={options.signals}
          onChange={(conditions) => onUpdate({ conditions })}
          label={q.label}
        />
      );
    case 'combinator':
      return (
        <RadioGroup
          label={q.label}
          value={draft.combinator}
          onChange={(v) => onUpdate({ combinator: v as 'and' | 'or' })}
          choices={[
            { value: 'and', label: 'Alle Bedingungen müssen zutreffen (UND)' },
            { value: 'or', label: 'Mindestens eine Bedingung muss zutreffen (ODER)' },
          ]}
        />
      );
    case 'price-basis':
      return (
        <div className="vp-vb-note">
          Preis meint den <strong>Börsenpreis</strong> oder Ihren <strong>vollständigen Bezugspreis</strong> -
          wählbar über das Signal der Bedingung.
        </div>
      );
    case 'target':
      return <TargetEditor controlKind={consumer.controlKind} draft={draft} label={q.label} onUpdate={onUpdate} />;
    case 'recurrence':
      return <RecurrenceEditor draft={draft} label={q.label} onUpdate={onUpdate} />;
    case 'runtime':
      return (
        <NumberField
          label={q.label}
          value={draft.runtimeMinutes}
          suffix="Minuten"
          onChange={(v) => onUpdate({ runtimeMinutes: v })}
        />
      );
    case 'contiguous':
      return (
        <RadioGroup
          label={q.label}
          value={draft.contiguous ? 'yes' : 'no'}
          onChange={(v) => onUpdate({ contiguous: v === 'yes' })}
          choices={[
            { value: 'yes', label: 'Am Stück (zusammenhängend)' },
            { value: 'no', label: 'Aufteilbar' },
          ]}
        />
      );
    case 'energy':
      return (
        <NumberField
          label={q.label}
          value={draft.energyKwh}
          suffix="kWh"
          onChange={(v) => onUpdate({ energyKwh: v })}
        />
      );
    case 'enforcement':
      return (
        <RadioGroup
          label={q.label}
          value={draft.enforcement}
          onChange={(v) => onUpdate({ enforcement: v as 'must_run' | 'opportunistic' })}
          choices={[
            { value: 'must_run', label: 'Muss laufen (Pflichtlauf)' },
            { value: 'opportunistic', label: 'Nur wenn günstig (ohne Pflicht)' },
          ]}
        />
      );
    case 'grid-policy':
      return (
        <RadioGroup
          label={q.label}
          value={draft.gridEnergyPolicy}
          onChange={(v) => onUpdate({ gridEnergyPolicy: v as 'allow' | 'avoid' | 'forbid' })}
          choices={[
            { value: 'allow', label: 'Netzstrom erlauben' },
            { value: 'avoid', label: 'Netzstrom möglichst vermeiden' },
            { value: 'forbid', label: 'Kein Netzstrom' },
          ]}
        />
      );
    case 'grid-allowed-note':
      return <div className="vp-vb-note">{q.note}</div>;
    case 'no-measurement-note':
      return <div className="vp-vb-note">{q.note}</div>;
    case 'storage-relation':
      return (
        <RadioGroup
          label={q.label}
          value={draft.storageRelation}
          onChange={(v) => onUpdate({ storageRelation: v as 'consumer_first' | 'storage_first' })}
          choices={[
            { value: 'consumer_first', label: 'Verbraucher zuerst' },
            { value: 'storage_first', label: 'Speicher zuerst' },
          ]}
        />
      );
    case 'storage-discharge':
      return (
        <label className={`vp-vb-choice ${draft.allowStorageDischarge ? 'selected' : ''}`}>
          <input
            type="checkbox"
            checked={draft.allowStorageDischarge}
            onChange={(e) => onUpdate({ allowStorageDischarge: e.target.checked })}
          />
          <span className="vp-vb-choice-title">{q.label}</span>
        </label>
      );
    default:
      return null;
  }
}

function MoreSettings({
  questions, draft, onUpdate,
}: {
  questions: Question[];
  draft: ConsumerDraft;
  onUpdate: (patch: Partial<ConsumerDraft>) => void;
}): JSX.Element | null {
  const more = questions.filter((q) => q.section === 'more');
  if (more.length === 0) return null;
  const localConditions = draft.conditions
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.signal.startsWith('storage.') || c.signal.startsWith('site.'));
  return (
    <details className="vp-vb-more">
      <summary>Weitere Einstellungen ({more.length})</summary>
      <div className="vp-vb-step">
        {localConditions.map(({ c, i }) => (
          <div className="vp-vb-row" key={i}>
            <NumberField
              label={`Rückschaltabstand (${c.signal})`}
              value={c.resetValue ?? null}
              onChange={(v) => {
                const conditions = draft.conditions.slice();
                conditions[i] = { ...conditions[i], resetValue: v ?? undefined };
                onUpdate({ conditions });
              }}
            />
            <NumberField
              label="Höchstalter (Sek.)"
              value={c.maxAgeS ?? null}
              onChange={(v) => {
                const conditions = draft.conditions.slice();
                conditions[i] = { ...conditions[i], maxAgeS: v ?? undefined };
                onUpdate({ conditions });
              }}
            />
          </div>
        ))}
      </div>
    </details>
  );
}

// --- small controls ---------------------------------------------------------

function ConditionsEditor({
  conditions, signals, onChange, label,
}: {
  conditions: ConditionDraft[];
  signals: ConsumerOptions['signals'];
  onChange: (c: ConditionDraft[]) => void;
  label: string;
}): JSX.Element {
  const setRow = (i: number, patch: Partial<ConditionDraft>) => {
    const next = conditions.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const add = () => {
    const first = signals[0];
    onChange([
      ...conditions,
      { signal: first.name, operator: first.valueType === 'boolean' ? 'eq' : 'lt', value: first.valueType === 'boolean' ? true : 0 },
    ]);
  };
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i));

  return (
    <fieldset className="vp-vb-fieldset">
      <legend>{label}</legend>
      {conditions.map((c, i) => {
        const sig = signals.find((s) => s.name === c.signal);
        const boolean = sig?.valueType === 'boolean';
        return (
          <div className="vp-vb-cond-row" key={i}>
            <div className="vp-vb-cond-line">
              <label className="vp-vb-field">
                <span>Signal</span>
                <select
                  value={c.signal}
                  onChange={(e) => {
                    const next = signals.find((s) => s.name === e.target.value);
                    setRow(i, {
                      signal: e.target.value,
                      value: next?.valueType === 'boolean' ? true : 0,
                      operator: next?.valueType === 'boolean' ? 'eq' : c.operator,
                      resetValue: undefined,
                      maxAgeS: undefined,
                    });
                  }}
                >
                  {signals.map((s) => (
                    <option key={s.name} value={s.name}>{s.label}</option>
                  ))}
                </select>
              </label>
              {boolean ? (
                <label className="vp-vb-choice">
                  <input
                    type="checkbox"
                    checked={c.value === true}
                    onChange={(e) => setRow(i, { value: e.target.checked })}
                  />
                  <span>trifft zu</span>
                </label>
              ) : (
                <>
                  <label className="vp-vb-field">
                    <span>Vergleich</span>
                    <select value={c.operator} onChange={(e) => setRow(i, { operator: e.target.value as ConditionDraft['operator'] })}>
                      <option value="lt">unter</option>
                      <option value="lte">höchstens</option>
                      <option value="gt">über</option>
                      <option value="gte">mindestens</option>
                    </select>
                  </label>
                  <NumberField
                    label="Wert"
                    value={typeof c.value === 'number' ? c.value : 0}
                    onChange={(v) => setRow(i, { value: v ?? 0 })}
                  />
                </>
              )}
            </div>
            {conditions.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => remove(i)}>Entfernen</Button>
            )}
          </div>
        );
      })}
      <Button variant="outline" size="sm" iconLeft={<Icon name="plus" />} onClick={add}>
        Bedingung hinzufügen
      </Button>
    </fieldset>
  );
}

function TargetEditor({
  controlKind, draft, label, onUpdate,
}: {
  controlKind: ControlKind;
  draft: ConsumerDraft;
  label: string;
  onUpdate: (patch: Partial<ConsumerDraft>) => void;
}): JSX.Element {
  if (controlKind === 'on_off') {
    return (
      <RadioGroup
        label={label}
        value={draft.target.value === true ? 'on' : 'off'}
        onChange={(v) => onUpdate({ target: { kind: 'on_off', value: v === 'on' } })}
        choices={[
          { value: 'on', label: 'Einschalten' },
          { value: 'off', label: 'Ausschalten' },
        ]}
      />
    );
  }
  const kind = controlKind === 'stepped' ? 'kw' : 'kw';
  const isPercent = draft.target.kind === 'percent';
  return (
    <div className="vp-vb-field">
      <label>{label}</label>
      <div className="vp-vb-row">
        <NumberField
          label={isPercent ? 'Prozent' : 'Leistung (kW)'}
          value={typeof draft.target.value === 'number' ? draft.target.value : null}
          onChange={(v) => onUpdate({ target: { kind: isPercent ? 'percent' : kind, value: v ?? 0 } })}
        />
        <label className="vp-vb-choice">
          <input
            type="checkbox"
            checked={isPercent}
            onChange={(e) => onUpdate({
              target: { kind: e.target.checked ? 'percent' : 'kw', value: typeof draft.target.value === 'number' ? draft.target.value : 0 },
            })}
          />
          <span>als Prozent der Maximalleistung</span>
        </label>
      </div>
    </div>
  );
}

function RecurrenceEditor({
  draft, label, onUpdate,
}: {
  draft: ConsumerDraft;
  label: string;
  onUpdate: (patch: Partial<ConsumerDraft>) => void;
}): JSX.Element {
  const rec = draft.recurrence;
  const set = (patch: Partial<ConsumerDraft['recurrence']>) =>
    onUpdate({ recurrence: { ...rec, ...patch } });
  return (
    <div className="vp-vb-field">
      <label>{label}</label>
      <div className="vp-vb-row">
        <label className="vp-vb-field">
          <span>Tage</span>
          <select value={rec.days} onChange={(e) => set({ days: e.target.value as ConsumerDraft['recurrence']['days'] })}>
            <option value="daily">Täglich</option>
            <option value="weekdays">Werktags</option>
            <option value="weekend">Am Wochenende</option>
          </select>
        </label>
        <label className="vp-vb-field">
          <span>Von</span>
          <input type="time" value={rec.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="vp-vb-field">
          <span>Bis</span>
          <input type="time" value={rec.to === '24:00' ? '00:00' : rec.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
      </div>
    </div>
  );
}

function RadioGroup({
  label, value, choices, onChange,
}: {
  label: string;
  value: string;
  choices: { value: string; label: string }[];
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <fieldset className="vp-vb-fieldset">
      <legend>{label}</legend>
      {choices.map((c) => (
        <label key={c.value} className={`vp-vb-choice ${value === c.value ? 'selected' : ''}`}>
          <input
            type="radio"
            name={`rg-${label}`}
            checked={value === c.value}
            onChange={() => onChange(c.value)}
          />
          <span className="vp-vb-choice-title">{c.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function NumberField({
  label, value, suffix, onChange,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  onChange: (v: number | null) => void;
}): JSX.Element {
  const [text, setText] = useState(value == null ? '' : String(value));
  // Reflect an EXTERNAL value change, but never reformat what the user is
  // actively typing (a German "1," parses to the same number).
  useEffect(() => {
    const parsed = Number(text.replace(',', '.'));
    const shown = text.trim() === '' || !Number.isFinite(parsed) ? null : parsed;
    if (shown !== value) setText(value == null ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      label={suffix ? `${label} (${suffix})` : label}
      value={text}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(',', '.'));
        onChange(e.target.value.trim() === '' || !Number.isFinite(n) ? null : n);
      }}
    />
  );
}

// --- helpers ----------------------------------------------------------------

function initialDraft(consumer: Consumer): ConsumerDraft {
  return {
    intent: null,
    conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }],
    combinator: 'and',
    recurrence: { days: 'daily', from: '13:00', to: '14:00' },
    demandMode: 'runtime',
    runtimeMinutes: 60,
    energyKwh: null,
    contiguous: true,
    target: consumer.controlKind === 'on_off'
      ? { kind: 'on_off', value: true }
      : { kind: 'kw', value: consumer.ratedPowerKw },
    enforcement: 'must_run',
    gridEnergyPolicy: 'allow',
    storageRelation: consumer.storageRelation,
    allowStorageDischarge: consumer.allowStorageDischarge,
  };
}

function controlKindLabel(k: ControlKind): string {
  switch (k) {
    case 'stepped': return 'Feste Stufen';
    case 'continuous': return 'Stufenlos';
    default: return 'Ein/Aus';
  }
}
