/**
 * The guided Wenn/Dann + Zeitplan rule-builder (U3, report §4.4 rung 2). A
 * form-shaped surface that PROJECTS onto a normal FlowDocument via the shared
 * guidedBuilder emitter - "Profi-Ansicht öffnen" shows exactly that document on
 * the canvas. Everything the builder produces round-trips through
 * parseGuidedFlow, so a rule stays builder-editable.
 *
 * Pure render + local form state; the emit is `buildGuidedFlow`. All rule logic
 * lives in src/flows/guidedBuilder.ts (unit-tested).
 */
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  actionTargets,
  buildGuidedFlow,
  readableEntities,
  type Combinator,
  type Direction,
  type GuidedAction,
  type GuidedCondition,
  type GuidedRule,
  type ScheduleDays,
} from '../flows/guidedBuilder';
import type { EditorEntity, FlowDocument } from '../flows/model';

type CondKind = 'entity' | 'price' | 'schedule';

interface CondForm {
  kind: CondKind;
  entityId: string;
  channel: string;
  direction: Direction;
  threshold: string;
  from: string;
  to: string;
  days: ScheduleDays;
}

type ActionKind = 'onoff' | 'setpoint' | 'notify';

function emptyCond(readable: EditorEntity[]): CondForm {
  const first = readable[0];
  return {
    kind: 'schedule',
    entityId: first?.id ?? '',
    channel: first?.measure[0] ?? '',
    direction: 'above',
    threshold: '',
    from: '11:00',
    to: '15:00',
    days: 'alle',
  };
}

function parseNum(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function buildCondition(f: CondForm): GuidedCondition | null {
  if (f.kind === 'schedule') {
    return { kind: 'schedule', from: f.from, to: f.to, days: f.days };
  }
  const threshold = parseNum(f.threshold);
  if (threshold === null) return null;
  if (f.kind === 'price') {
    return { kind: 'price', direction: f.direction, threshold };
  }
  if (!f.entityId || !f.channel) return null;
  return { kind: 'entity', entityId: f.entityId, channel: f.channel, direction: f.direction, threshold };
}

export function GuidedRuleBuilder({
  entities,
  siteId,
  onCancel,
  onBuild,
  busy = false,
}: {
  entities: EditorEntity[];
  /** Stamped onto the emitted document so it validates clean before the save. */
  siteId?: string;
  onCancel: () => void;
  /** Emit the rule as a document + its name (ready to create + save). */
  onBuild: (name: string, doc: FlowDocument) => void;
  busy?: boolean;
}) {
  const readable = readableEntities(entities);
  const targets = actionTargets(entities);

  const [name, setName] = useState('Neue Automation');
  const [conds, setConds] = useState<CondForm[]>([emptyCond(readable)]);
  const [combinator, setCombinator] = useState<Combinator>('and');
  const [actionKind, setActionKind] = useState<ActionKind>('onoff');
  const [actionEntity, setActionEntity] = useState(targets[0]?.id ?? '');
  const [setpointValue, setSetpointValue] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const setCond = (i: number, patch: Partial<CondForm>) =>
    setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = () => {
    setError('');
    const conditions: GuidedCondition[] = [];
    for (const f of conds) {
      const c = buildCondition(f);
      if (!c) {
        setError('Bitte alle Bedingungen vollständig ausfüllen (Schwelle als Zahl).');
        return;
      }
      conditions.push(c);
    }
    if (conditions.length === 0) {
      setError('Mindestens eine Bedingung (WENN) ist nötig.');
      return;
    }
    let action: GuidedAction;
    if (actionKind === 'notify') {
      if (!message.trim()) {
        setError('Bitte eine Nachricht für die Benachrichtigung eingeben.');
        return;
      }
      action = { kind: 'notify', message: message.trim() };
    } else {
      if (!actionEntity) {
        setError('Bitte ein Gerät wählen, das geschaltet werden soll.');
        return;
      }
      if (actionKind === 'setpoint') {
        const value = parseNum(setpointValue);
        if (value === null) {
          setError('Bitte einen Sollwert als Zahl (kW) eingeben.');
          return;
        }
        action = { kind: 'setpoint', entityId: actionEntity, value, ttlS: 300 };
      } else {
        action = { kind: 'onoff', entityId: actionEntity, ttlS: 300 };
      }
    }
    const rule: GuidedRule = { conditions, combinator, action };
    const finalName = name.trim() || 'Neue Automation';
    onBuild(finalName, buildGuidedFlow(rule, finalName, siteId));
  };

  return (
    <div className="vp-guided">
      <div className="vp-guided-field">
        <label htmlFor="guided-name">Name der Automation</label>
        <input
          id="guided-name"
          className="vp-select"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <h4 className="vp-guided-head">WENN</h4>
      {conds.map((f, i) => (
        <div key={i} className="vp-guided-cond">
          {i > 0 && (
            <div className="vp-guided-comb">
              <button
                type="button"
                className={combinator === 'and' ? 'active' : ''}
                onClick={() => setCombinator('and')}
              >
                UND
              </button>
              <button
                type="button"
                className={combinator === 'or' ? 'active' : ''}
                onClick={() => setCombinator('or')}
              >
                ODER
              </button>
            </div>
          )}
          <div className="vp-guided-row">
            <select
              className="vp-select"
              aria-label="Art der Bedingung"
              value={f.kind}
              onChange={(e) => setCond(i, { kind: e.target.value as CondKind })}
            >
              <option value="entity">Messwert eines Geräts</option>
              <option value="price">Börsenpreis</option>
              <option value="schedule">Zeitfenster</option>
            </select>

            {f.kind === 'entity' && (
              <>
                <select
                  className="vp-select"
                  aria-label="Gerät"
                  value={f.entityId}
                  onChange={(e) => {
                    const ent = readable.find((x) => x.id === e.target.value);
                    setCond(i, { entityId: e.target.value, channel: ent?.measure[0] ?? '' });
                  }}
                >
                  {readable.map((ent) => (
                    <option key={ent.id} value={ent.id}>{ent.label}</option>
                  ))}
                </select>
                <select
                  className="vp-select"
                  aria-label="Messkanal"
                  value={f.channel}
                  onChange={(e) => setCond(i, { channel: e.target.value })}
                >
                  {(readable.find((x) => x.id === f.entityId)?.measure ?? []).map((ch) => (
                    <option key={ch} value={ch}>{ch}</option>
                  ))}
                </select>
              </>
            )}

            {(f.kind === 'entity' || f.kind === 'price') && (
              <>
                <select
                  className="vp-select"
                  aria-label="Richtung"
                  value={f.direction}
                  onChange={(e) => setCond(i, { direction: e.target.value as Direction })}
                >
                  <option value="above">über</option>
                  <option value="below">unter</option>
                </select>
                <input
                  className="vp-select vp-guided-num"
                  aria-label="Schwelle"
                  inputMode="decimal"
                  placeholder={f.kind === 'price' ? 'ct/kWh' : 'Wert'}
                  value={f.threshold}
                  onChange={(e) => setCond(i, { threshold: e.target.value })}
                />
              </>
            )}

            {f.kind === 'schedule' && (
              <>
                <input
                  className="vp-select"
                  type="time"
                  aria-label="Von"
                  value={f.from}
                  onChange={(e) => setCond(i, { from: e.target.value })}
                />
                <input
                  className="vp-select"
                  type="time"
                  aria-label="Bis"
                  value={f.to}
                  onChange={(e) => setCond(i, { to: e.target.value })}
                />
                <select
                  className="vp-select"
                  aria-label="Tage"
                  value={f.days}
                  onChange={(e) => setCond(i, { days: e.target.value as ScheduleDays })}
                >
                  <option value="alle">alle Tage</option>
                  <option value="werktage">Werktage</option>
                  <option value="wochenende">Wochenende</option>
                </select>
              </>
            )}

            {conds.length > 1 && (
              <button
                type="button"
                className="vp-guided-x"
                aria-label="Bedingung entfernen"
                onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
      {conds.length < 3 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConds((cs) => [...cs, { ...emptyCond(readable), kind: 'entity' }])}
        >
          ＋ Bedingung
        </Button>
      )}

      <h4 className="vp-guided-head">DANN</h4>
      <div className="vp-guided-row">
        <select
          className="vp-select"
          aria-label="Aktion"
          value={actionKind}
          onChange={(e) => setActionKind(e.target.value as ActionKind)}
        >
          <option value="onoff">Gerät ein/aus</option>
          <option value="setpoint">Sollwert setzen</option>
          <option value="notify">Benachrichtigung</option>
        </select>
        {actionKind !== 'notify' && (
          <select
            className="vp-select"
            aria-label="Zielgerät"
            value={actionEntity}
            onChange={(e) => setActionEntity(e.target.value)}
          >
            {targets.length === 0 && <option value="">– kein steuerbares Gerät –</option>}
            {targets.map((ent) => (
              <option key={ent.id} value={ent.id}>{ent.label}</option>
            ))}
          </select>
        )}
        {actionKind === 'setpoint' && (
          <input
            className="vp-select vp-guided-num"
            aria-label="Sollwert (kW)"
            inputMode="decimal"
            placeholder="kW"
            value={setpointValue}
            onChange={(e) => setSetpointValue(e.target.value)}
          />
        )}
        {actionKind === 'notify' && (
          <input
            className="vp-select"
            aria-label="Nachricht"
            placeholder="Nachricht"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        )}
      </div>

      {error && <p className="vp-flowed-notice error" role="status">{error}</p>}

      <p className="vp-note vp-guided-note">
        VoltPilot prüft und simuliert die Regel vor dem Ausrollen; Sicherheits-, Netz- und
        Vertragsgrenzen bleiben immer unantastbar.
      </p>

      <div className="vp-guided-foot">
        <Button size="sm" onClick={submit} disabled={busy}>Weiter zur Prüfung</Button>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>Abbrechen</Button>
      </div>
    </div>
  );
}
