'use strict';

/**
 * Per-component binding of an observed point to the DEVICE it must be read
 * from (Geraeteseite Stufe 3c; report data/vp-geraeteseite-rahmen-r2 §2.3
 * Schicht 3 + §7.4). Pure: no I/O, no clock, no Node-RED.
 *
 * Until Stufe 3c the box polled EVERY selected point against the primary
 * inverter's connection (edge/inverter/config), so a register selected on a
 * second Fronius or on a wallbox was read from the Deye's address. The cloud
 * now names the component per selection (`entity_id`, Stufe 3b), and this
 * module turns that name into the target whose connection the runtime uses.
 *
 * ⚠ THE LEADING RULE: a binding that cannot be resolved is REFUSED, never read
 * against the primary. A wrong value is worse than no value - the whole reason
 * 3a/3b stayed honestly limited until this step existed.
 *
 * The pin itself is NOT invented here. `edge_source_id` is the cloud's
 * measurement_point pin, carried verbatim in the retained per-entity registry
 * (edge/entities/{id}/config, contract docs/contracts/v2/edge-entity.schema.json);
 * the connection behind it comes from the retained edge/sources/config the core
 * already publishes for the read fan-out.
 */

/** Target of the primary inverter (edge/inverter/config). */
const TARGET_PRIMARY = 'primary';
/** Target of OCPP MeterValues: core-fed, it has no connection of its own. */
const TARGET_OCPP = 'ocpp';
/** The reserved source id the box uses for its primary inverter. */
const PRIMARY_PIN = 'inverter';

/**
 * The entity types the cloud COMPOSES from v1 master data and the box itself
 * feeds from the primary's composite sample (core internal/entities/compose.go
 * `composedType`). They carry no pin because they ARE the primary inverter's
 * own channels - so resolving them to the primary is the box's own documented
 * composition, not a guess, and it is byte-for-byte the pre-3c behaviour.
 * ⚠ Keep in lockstep with compose.go; a type added there without being added
 * here is refused (honest) but loses its observation.
 */
const COMPOSED_TYPES = Object.freeze(['battery-hybrid', 'grid-meter', 'house-load']);

/** The one refusal word this layer produces (contract status enum). */
const REASON_UNBOUND = 'binding_unavailable';

function sourceTargetKey(sourceId) { return 'source:' + sourceId; }

function has(map, key) {
  return !!map && Object.prototype.hasOwnProperty.call(map, key) && map[key] != null;
}

/**
 * resolveTarget(selection, point, binding) -> {key, sourceId} | {reason}
 *
 * binding = { entities: {id: {entity_type, edge_source_id}}, sources: {id: source} }
 */
function resolveTarget(selection, point, binding) {
  const context = binding || {};
  // OCPP MeterValues arrive from the core over the local bus; there is no
  // connection to choose, so a binding can neither select nor refuse one.
  // Attribution of an OCPP measurand stays device-wide (see README).
  if (point && point.source_kind === 'ocpp_sampled_value') {
    return { key: TARGET_OCPP, sourceId: null };
  }
  const entityId = selection && selection.entity_id;
  // No component named: the plan belongs to the device as a whole - the exact
  // pre-3c contract, so an older cloud stays byte-for-byte unchanged.
  if (!entityId) return { key: TARGET_PRIMARY, sourceId: null };
  if (!has(context.entities, entityId)) return { reason: REASON_UNBOUND };
  const entity = context.entities[entityId];
  const pin = entity && entity.edge_source_id;
  if (pin === PRIMARY_PIN) return { key: TARGET_PRIMARY, sourceId: null };
  if (pin) {
    // A pin naming a source this box does not (or no longer) publish - a
    // removed source, or a core-owned transport that never reaches Node-RED
    // (Shelly) - is exactly the case that must not fall back to the primary.
    return has(context.sources, pin)
      ? { key: sourceTargetKey(pin), sourceId: pin }
      : { reason: REASON_UNBOUND };
  }
  return COMPOSED_TYPES.includes(entity && entity.entity_type)
    ? { key: TARGET_PRIMARY, sourceId: null }
    : { reason: REASON_UNBOUND };
}

/**
 * parseEntityConfig(raw) -> {entity_id, entity_type, edge_source_id} | null
 * Reads ONE retained edge/entities/{id}/config payload. An empty payload
 * (the core's "entity removed" clear) and anything malformed yield null.
 */
function parseEntityConfig(raw) {
  if (!raw || !raw.length) return null;
  let value;
  try { value = JSON.parse(raw.toString()); } catch (_) { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.entity_id !== 'string' || !value.entity_id) return null;
  return {
    entity_id: value.entity_id,
    entity_type: typeof value.entity_type === 'string' ? value.entity_type : '',
    edge_source_id: typeof value.edge_source_id === 'string' ? value.edge_source_id : '',
  };
}

/**
 * resolveDevice(target, devices) -> {communication, connection} | throws
 *
 * The read-time half of the binding: which {communication, connection} does a
 * PLANNED target read over right now. It THROWS for a bound component whose
 * device this box does not publish (a source removed between plan and poll, or
 * the core-owned Shelly transport that never reaches Node-RED); the caller
 * turns that into a gap in time. Falling back to the primary here would be
 * exactly the wrong-device read Stufe 3c exists to prevent, and it is why the
 * connection is resolved at READ time instead of being baked into the plan.
 */
function resolveDevice(target, devices) {
  const context = devices || {};
  const key = (target && target.key) || TARGET_PRIMARY;
  if (key === TARGET_PRIMARY) {
    const primary = context.inverter;
    if (!primary || !primary.connection || !primary.connection.ip) {
      throw new Error('keine Geräteverbindung');
    }
    return primary;
  }
  const source = target && target.sourceId && has(context.sources, target.sourceId)
    ? context.sources[target.sourceId] : null;
  if (!source || !source.connection || !source.connection.ip) {
    throw new Error('gebundenes Gerät nicht verfügbar');
  }
  return source;
}

/** sourceMap(list) - the retained edge/sources/config array keyed by source id. */
function sourceMap(list) {
  const map = {};
  for (const source of Array.isArray(list) ? list : []) {
    if (source && typeof source.id === 'string' && source.id) map[source.id] = source;
  }
  return map;
}

module.exports = { TARGET_PRIMARY, TARGET_OCPP, PRIMARY_PIN, COMPOSED_TYPES,
  REASON_UNBOUND, sourceTargetKey, resolveTarget, resolveDevice, parseEntityConfig,
  sourceMap };
