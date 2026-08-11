/**
 * Die zwei EINSCHÜBE der steuerbaren Verbraucher (docs/verbrauchssteuerung.md
 * §14; Einheitsmodell Stufe 5a).
 *
 *  - `VerbraucherAnlegenDrawer` — die Komponente anlegen (verbunden ODER als
 *    Entwurf). Er ist der „Komponente anlegen"-Ausweg der Rezept-Galerie, damit
 *    ein Rezept nie in einer Sackgasse endet.
 *  - `VerbraucherRegelDrawer` — der geführte Regelbaukasten: Absicht wählen,
 *    Fragenbaum beantworten, prüfen, speichern (bzw. aktivieren).
 *
 * Beide lagen bis Stufe 5a auf der eigenen Seite „Verbraucher". Die SEITE ist
 * aufgelöst (die Regeln wohnen in der Regeln-Kapsel der Steuerung, die Geräte im
 * Anlagen-Modell); die zwei Einschübe sind WÖRTLICH dieselben geblieben und
 * werden jetzt von der Steuerung gehostet.
 *
 * Alle Regel-LOGIK ist das reine, unit-getestete `src/consumers/*` (validate /
 * questions / policy / activation); hier wird nur gerendert. Kein internes
 * Vokabular erreicht den Kunden (der Copy-Wächter scannt diese Datei).
 */
import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import type { EntityStrategy, Site } from '../api';
import { ApiError } from '../api';
import { consumersApi, type CreateConsumerBody } from '../consumers/consumersApi';
import type { Consumer, ConsumerOptions, ControlKind } from '../consumers/types';
import {
  consumerQuestions,
  consumerHasMeasurement,
  standardStepCount,
  type ConditionDraft,
  type ConsumerContext,
  type ConsumerDraft,
  type Intent,
  type Question,
} from '../consumers/questions';
import { buildPolicyDocument, policySentence, reviewFacts } from '../consumers/policy';
import { validatePolicy, isValid, type ConsumerFinding } from '../consumers/validate';
import { conflictNote, saveButtonLabel } from '../consumers/activation';
import './Verbraucher.css';

// --- Part A: create wizard --------------------------------------------------

export function VerbraucherAnlegenDrawer({
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
                  {s.measuresPower === true ? ' · misst Leistung' : ''}
                  {s.measuresPower === false
                    ? ' · ohne Leistungsmessung (Energie wird angenommen)' : ''}
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

export function VerbraucherRegelDrawer({
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
    hasMeasurementChannel: consumerHasMeasurement(consumer),
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

