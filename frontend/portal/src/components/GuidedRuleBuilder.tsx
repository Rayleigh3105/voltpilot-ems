/**
 * The guided Wenn/Dann + Zeitplan rule-builder (U3, report §4.4 rung 2). A
 * form-shaped surface that PROJECTS onto a normal FlowDocument via the shared
 * guidedBuilder emitter - "Profi-Ansicht öffnen" shows exactly that document on
 * the canvas. Everything the builder produces round-trips through
 * parseGuidedFlow, so a rule stays builder-editable.
 *
 * Pure render + local form state; the emit is `buildGuidedFlow`. All rule logic
 * lives in src/flows/guidedBuilder.ts (unit-tested).
 *
 * Two honesty rules from the 2026-07-24 control audit live here:
 * - **N-1**: „Benachrichtigung" is NOT offered to customers - the notification
 *   has no delivery channel yet, so an activated rule would report "Läuft" and
 *   deliver nothing. It stays available in the technical layer for diagnosis
 *   (`allowDiagnosticActions`).
 * - **B-1**: a plant without a controllable device is a DEAD END, not a form:
 *   the builder says so up front, links to „Anlagen-Modell" and never offers a
 *   primary button that cannot succeed.
 */
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { VpPicker } from './VpPicker';
import { HelpLink } from '../help/HelpProvider';
import {
  UEBERSCHUSS_BLOCKIERT,
  UEBERSCHUSS_HINWEIS,
  UEBERSCHUSS_LABEL,
  UEBERSCHUSS_WEITER,
  hatUeberschuss,
} from '../regeln/ueberschuss';
import { VpTimePicker } from './VpTimePicker';
import { anlageRoute, hashForRoute } from '../nav';
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
import {
  VORBELEGUNG_FRAGE,
  type RezeptId,
  type VorbelegungenView,
} from '../regeln/rezepte';
import { AUFBAU_REITER } from '../ebenenNav';

type CondKind = 'entity' | 'price' | 'schedule' | 'surplus';

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

/**
 * B-2: the price condition is locked until VoltPilot enables the market node
 * for this site - say WHY and BY WHOM instead of a bare "(gesperrt)".
 */
export const PRICE_LOCKED_HINT =
  'Der Börsenpreis wird zusammen mit der Marktoptimierung freigeschaltet - sprechen Sie uns an.';

/**
 * B-1: what the builder says when the plant has nothing it could switch.
 * The customer's next step is a real one, not a retry of the same form.
 */
export const NO_DEVICE_TITLE = 'Für diese Anlage gibt es noch kein schaltbares Gerät';
export const NO_DEVICE_BODY =
  'Eine Wenn/Dann-Regel schaltet ein Gerät - zum Beispiel eine Wallbox oder einen Heizstab. '
  + 'Solange keines Ihrer Geräte als schaltbar hinterlegt ist, kann die Regel nichts tun. '
  + `Unter „${AUFBAU_REITER}" ordnen Sie ein gemeldetes Gerät zu; danach steht es hier zur Auswahl.`;

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

/**
 * Die Umkehrung des Formulars: eine gelesene Regel wird zum Formular-Zustand.
 * Sie ist die zweite Hälfte des Roundtrip-Gesetzes (`parseGuidedFlow` liefert
 * das Modell, hier wird es wieder bedienbar) — es entsteht KEIN zweites Format.
 */
function ruleToForm(rule: GuidedRule, readable: EditorEntity[]): {
  conds: CondForm[];
  combinator: Combinator;
  actionKind: ActionKind;
  actionEntity: string;
  setpointValue: string;
  message: string;
} {
  const conds: CondForm[] = rule.conditions.map((c) => {
    const base = emptyCond(readable);
    if (c.kind === 'schedule') {
      return { ...base, kind: 'schedule', from: c.from, to: c.to, days: c.days };
    }
    if (c.kind === 'price') {
      return { ...base, kind: 'price', direction: c.direction, threshold: String(c.threshold) };
    }
    return {
      ...base,
      kind: 'entity',
      entityId: c.entityId,
      channel: c.channel,
      direction: c.direction,
      threshold: String(c.threshold),
    };
  });
  const a = rule.action;
  return {
    conds: conds.length > 0 ? conds : [emptyCond(readable)],
    combinator: rule.combinator,
    actionKind: a.kind,
    actionEntity: a.kind === 'notify' ? '' : a.entityId,
    setpointValue: a.kind === 'setpoint' ? String(a.value) : '',
    message: a.kind === 'notify' ? a.message : '',
  };
}

function parseNum(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function buildCondition(f: CondForm): GuidedCondition | null {
  // Der Solar-Überschuss ist im Flow-Dokument nicht ausdrückbar (es gibt dafür
  // keinen Katalog-Baustein) - hier entsteht deshalb NIE eine Bedingung
  // daraus. `submit` fängt ihn schon vorher ab; das ist der zweite Riegel.
  if (f.kind === 'surplus') return null;
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
  onSolarUeberschuss,
  busy = false,
  lockedKinds = [],
  lockedHint = 'Einrichtung durch VoltPilot',
  allowDiagnosticActions = false,
  initialRule = null,
  initialName,
  vorbelegungen = null,
  onVorbelegung,
}: {
  entities: EditorEntity[];
  /** Stamped onto the emitted document so it validates clean before the save. */
  siteId?: string;
  onCancel: () => void;
  /** Emit the rule as a document + its name (ready to create + save). */
  onBuild: (name: string, doc: FlowDocument) => void;
  /**
   * Der Weg zur Solar-Überschuss-Regel. Fehlt er, wird die Bedingung gar nicht
   * angeboten - ein Eintrag ohne Ziel wäre eine Sackgasse.
   */
  onSolarUeberschuss?: () => void;
  busy?: boolean;
  /**
   * Condition kinds whose catalog node is GATED and not yet enabled for this
   * site (AE7 governance). They stay VISIBLE but unselectable - the server
   * refuses activation with `gated_node_not_enabled`, so offering them
   * silently would build a rule that can never go live.
   */
  lockedKinds?: CondKind[];
  lockedHint?: string;
  /**
   * N-1: may this surface offer diagnostic-only actions (the notification,
   * which has no delivery channel yet)? The customer surfaces pass false; the
   * technical layer passes true. Default false = never promise delivery.
   */
  allowDiagnosticActions?: boolean;
  /**
   * Der EINGANG „mit dieser Regel öffnen" (Einheitsmodell Stufe 5a, 5b.5):
   * eine bestehende, vom Rück-Parser gelesene Regel füllt das Formular vor.
   * Der Rück-Parser gibt für alles außerhalb des Baukasten-Ausschnitts ehrlich
   * `null` — dann öffnet die Fläche den Editor statt hier zu raten.
   */
  initialRule?: GuidedRule | null;
  /** Der bestehende Name der Regel (sonst die Vorgabe). */
  initialName?: string;
  /**
   * Die STARTPUNKTE (Steuerung Stufe 2, Konzept §3.3 „ohne Rezept-Galerie"):
   * die früheren Rezepte als Vorbelegungen ÜBER dem Formular. Absent = keine
   * Reihe — die Fläche entscheidet, ob es welche gibt, nie der Baukasten.
   */
  vorbelegungen?: VorbelegungenView | null;
  /** Ein Startpunkt wurde gewählt — die Fläche füllt vor bzw. öffnet die Maschine. */
  onVorbelegung?: (id: RezeptId) => void;
}) {
  const readable = readableEntities(entities);
  const targets = actionTargets(entities);
  // B-1: without a switchable device AND without the diagnostic action there is
  // no action this builder could emit - that is a dead end, and it is named up
  // front instead of behind a button that answers "Bitte ein Gerät wählen".
  const deadEnd = targets.length === 0 && !allowDiagnosticActions;

  const seed = initialRule ? ruleToForm(initialRule, readable) : null;
  const [name, setName] = useState(initialName?.trim() || 'Neue Regel');
  const [conds, setConds] = useState<CondForm[]>(seed?.conds ?? [emptyCond(readable)]);
  const [combinator, setCombinator] = useState<Combinator>(seed?.combinator ?? 'and');
  const [actionKind, setActionKind] = useState<ActionKind>(
    // Pre-select an action that can actually run: with no switchable device the
    // only remaining one is the diagnostic notification (technical layer only).
    seed?.actionKind ?? (targets.length === 0 && allowDiagnosticActions ? 'notify' : 'onoff'),
  );
  const [actionEntity, setActionEntity] = useState(seed?.actionEntity ?? targets[0]?.id ?? '');
  const [setpointValue, setSetpointValue] = useState(seed?.setpointValue ?? '');
  const [message, setMessage] = useState(seed?.message ?? '');
  const [error, setError] = useState('');

  const setCond = (i: number, patch: Partial<CondForm>) =>
    setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = () => {
    // Ein Knopf, der in eine Ablehnung liefe, wird nicht angeboten: die
    // Überschuss-Bedingung geht ihren eigenen Weg (Stufe 2).
    if (hatUeberschuss(conds.map((c) => c.kind))) {
      setError(UEBERSCHUSS_BLOCKIERT);
      return;
    }
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
    const finalName = name.trim() || 'Neue Regel';
    onBuild(finalName, buildGuidedFlow(rule, finalName, siteId));
  };

  if (deadEnd) {
    return (
      <div className="vp-guided">
        <div className="vp-guided-deadend" role="status">
          <h4>{NO_DEVICE_TITLE}</h4>
          <p>{NO_DEVICE_BODY}</p>
          {siteId && (
            <a
              className="vp-guided-deadend-link"
              href={hashForRoute(anlageRoute(siteId, 'modell'))}
              onClick={onCancel}
            >
              <Icon name="chevron-right" size={14} /> Zum {AUFBAU_REITER} - Gerät zuordnen
            </a>
          )}
        </div>
        <div className="vp-guided-foot">
          <Button variant="outline" size="sm" onClick={onCancel}>Zurück</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="vp-guided">
      <div className="vp-context-help"><HelpLink article="regeln">Hilfe beim Erstellen einer Regel</HelpLink></div>
      {vorbelegungen && onVorbelegung
        && (vorbelegungen.liste.length > 0 || vorbelegungen.hinweis) && (
        <div className="vp-guided-start">
          <h4 className="vp-guided-head">{VORBELEGUNG_FRAGE}</h4>
          {vorbelegungen.liste.length > 0 && (
            <ul className="vp-startpunkte">
              {vorbelegungen.liste.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className="vp-startpunkt"
                    disabled={busy}
                    onClick={() => onVorbelegung(v.id)}
                  >
                    <strong>{v.titel}</strong>
                    <span>{v.ergebnis}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {vorbelegungen.hinweis && (
            <p className="vp-note vp-guided-note">{vorbelegungen.hinweis}</p>
          )}
        </div>
      )}

      <div className="vp-guided-field">
        <label htmlFor="guided-name">Name der Regel</label>
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
            <VpPicker
              className="vp-guided-pick"
              ariaLabel="Art der Bedingung"
              options={[
                { value: 'entity', label: 'Messwert eines Geräts' },
                {
                  value: 'price',
                  label: 'Börsenpreis',
                  disabled: lockedKinds.includes('price'),
                  // Eine gesperrte Zeile bleibt SICHTBAR und nennt ihren Grund
                  // - sie ist die Antwort auf „warum kann ich das nicht?".
                  disabledHint: lockedKinds.includes('price')
                    ? 'Noch nicht freigeschaltet'
                    : null,
                },
                { value: 'schedule', label: 'Zeitfenster' },
                // Steuerung Stufe 2: der Überschuss steht dort, wo der Kunde
                // hinschaut - ausgeführt wird er von der Maschine, die ihn
                // kann (siehe `regeln/ueberschuss.ts`). Ohne Weg dorthin wird
                // er gar nicht erst angeboten.
                ...(onSolarUeberschuss ? [{ value: 'surplus', label: UEBERSCHUSS_LABEL }] : []),
              ]}
              value={f.kind}
              onChange={(v) => setCond(i, { kind: v as CondKind })}
            />

            {f.kind === 'surplus' && (
              <p className="vp-guided-surplus" role="status">
                {UEBERSCHUSS_HINWEIS}
              </p>
            )}

            {f.kind === 'entity' && (
              <>
                <VpPicker
                  className="vp-guided-pick"
                  ariaLabel="Gerät"
                  options={readable.map((ent) => ({ value: ent.id, label: ent.label }))}
                  value={f.entityId}
                  onChange={(v) => {
                    const ent = readable.find((x) => x.id === v);
                    setCond(i, { entityId: v, channel: ent?.measure[0] ?? '' });
                  }}
                  searchPlaceholder="Gerät suchen …"
                />
                <VpPicker
                  className="vp-guided-pick"
                  ariaLabel="Messkanal"
                  options={(readable.find((x) => x.id === f.entityId)?.measure ?? []).map((ch) => ({
                    value: ch,
                    label: ch,
                  }))}
                  value={f.channel}
                  onChange={(v) => setCond(i, { channel: v })}
                />
              </>
            )}

            {(f.kind === 'entity' || f.kind === 'price') && (
              <>
                <VpPicker
                  className="vp-guided-pick"
                  ariaLabel="Richtung"
                  options={[
                    { value: 'above', label: 'über' },
                    { value: 'below', label: 'unter' },
                  ]}
                  value={f.direction}
                  onChange={(v) => setCond(i, { direction: v as Direction })}
                />
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
                <VpTimePicker
                  className="vp-guided-pick"
                  ariaLabel="Von"
                  value={f.from}
                  onChange={(v) => setCond(i, { from: v })}
                />
                <VpTimePicker
                  className="vp-guided-pick"
                  ariaLabel="Bis"
                  value={f.to}
                  onChange={(v) => setCond(i, { to: v })}
                />
                <VpPicker
                  className="vp-guided-pick"
                  ariaLabel="Tage"
                  options={[
                    { value: 'alle', label: 'alle Tage' },
                    { value: 'werktage', label: 'Werktage' },
                    { value: 'wochenende', label: 'Wochenende' },
                  ]}
                  value={f.days}
                  onChange={(v) => setCond(i, { days: v as ScheduleDays })}
                />
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
      {/* B-2: the lock is explained once, always visible - the old hint sat
          inside a branch that only rendered for the very option the lock makes
          unselectable, so nobody ever read it. */}
      {lockedKinds.includes('price') && (
        <p className="vp-note vp-guided-locknote">
          <Icon name="lock" size={13} /> {PRICE_LOCKED_HINT}
          {lockedHint ? ` (${lockedHint})` : ''}
        </p>
      )}
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
        <VpPicker
          className="vp-guided-pick"
          ariaLabel="Aktion"
          options={[
            { value: 'onoff', label: 'Gerät ein/aus' },
            { value: 'setpoint', label: 'Sollwert setzen' },
            // N-1: the notification has no delivery channel - offered only in
            // the technical layer, and labelled for what it is.
            ...(allowDiagnosticActions
              ? [{ value: 'notify', label: 'Benachrichtigung (nur Diagnose)' }]
              : []),
          ]}
          value={actionKind}
          onChange={(v) => setActionKind(v as ActionKind)}
        />
        {actionKind !== 'notify' && (
          <VpPicker
            className="vp-guided-pick"
            ariaLabel="Zielgerät"
            options={targets.map((ent) => ({ value: ent.id, label: ent.label }))}
            value={actionEntity}
            onChange={setActionEntity}
            // Ohne steuerbares Gerät gibt es nichts zu waehlen - das SAGT der
            // Picker, statt eine Pseudo-Zeile anzubieten.
            placeholder="– kein steuerbares Gerät –"
            emptyText={() => 'Diese Anlage hat kein steuerbares Gerät.'}
            searchPlaceholder="Gerät suchen …"
          />
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
          // A-3: a visible label like every neighbouring field, not a
          // placeholder that vanishes as soon as one types.
          <span className="vp-guided-field inline">
            <label htmlFor="guided-message">Nachricht</label>
            <input
              id="guided-message"
              className="vp-select"
              placeholder="z. B. Speicher unter 20 %"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </span>
        )}
      </div>
      {actionKind === 'notify' && (
        <p className="vp-note vp-guided-locknote">
          <Icon name="alert-triangle" size={13} /> Nur Diagnose: die Meldung wird auf dem Gerät
          abgelegt, aber noch nicht zugestellt (keine E-Mail, keine Push-Nachricht).
        </p>
      )}

      {error && <p className="vp-flowed-notice error" role="status">{error}</p>}

      <p className="vp-note vp-guided-note">
        VoltPilot prüft und simuliert die Regel vor dem Ausrollen; Sicherheits-, Netz- und
        Vertragsgrenzen bleiben immer unantastbar.
      </p>

      <div className="vp-guided-foot">
        {onSolarUeberschuss && hatUeberschuss(conds.map((c) => c.kind)) ? (
          <Button size="sm" onClick={onSolarUeberschuss} disabled={busy}>
            {UEBERSCHUSS_WEITER}
          </Button>
        ) : (
          <Button size="sm" onClick={submit} disabled={busy}>Weiter zur Prüfung</Button>
        )}
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>Abbrechen</Button>
      </div>
    </div>
  );
}
