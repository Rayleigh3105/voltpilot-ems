'use strict';

/**
 * The CERTIFICATE side of the native self-regulation ("Selbstregel-Modus"): in a
 * slot the cloud marked worth covering from the battery, hand the SETPOINT back
 * to the inverter's own self-consumption loop instead of writing a recomputed
 * watt value every 10 s.
 *
 * ⚠ THE DIVISION OF LABOUR, and it is what keeps this file small:
 *   - the ADAPTER (inverter-control-routing.js `nativeSelfConsumption`) knows the
 *     REGISTERS of its control tier and always computes the intended sequence as
 *     `planned` - the concrete artefact a bench session verifies, exactly like
 *     every other uncertified write plan in this repo;
 *   - THIS file is the RELEASE POINT: without an exact (manufacturer, model,
 *     firmware) entry no write is executable, full stop.
 *
 * The certificate ATTESTS the adapter's bytes, it does not redefine them. Bench
 * criterion 1 of UNPLANNED-LOAD-BENCH.md is "charge-block and safe-default
 * release write bytes plus independent readback bytes for BOTH transitions", so
 * a certificate carries exactly those bytes - and `certificateMatchesPlan` below
 * refuses when they and the shipped adapter have drifted apart. Two sources for
 * one truth would otherwise be a silent way for a firmware-specific bench result
 * to bless a sequence nobody measured.
 *
 * It never performs I/O. Production deliberately passes the exported, EMPTY
 * CERTIFIED_NATIVE_CAPABILITIES catalog until a model+firmware has completed the
 * bench gate, so on every device shipped today the mode simply never engages.
 */
const CERTIFIED_NATIVE_CAPABILITIES = Object.freeze([]);

/**
 * SIMULATOR_NATIVE_CAPABILITIES is the ONE non-empty catalog in this repo, and it
 * is deliberately not part of the production one.
 *
 * ⚠ IT CERTIFIES A PIECE OF SOFTWARE, NEVER A DEVICE. The entry names the
 * generic SunSpec/`modbus_tcp` profile, which is not real SunSpec at all: it is
 * the compact register block of `edge/sim/sunspec-sim.js` (FRONIUS.md §"Anderes
 * Modell"), so it can only ever match the simulator. It exists so the whole
 * chain - core intent -> adapter primitive -> single write -> state readback ->
 * proof -> take-back - is provable end to end WITHOUT hardware, which is the
 * only way this feature could be reviewed before a bench session exists.
 *
 * It is wired ONLY into the flow's SIMULATOR tab, whose inverter selection is a
 * fixed literal in build-flows.js and can therefore never be a customer device.
 * The auto tab passes the production catalog.
 */
const SIMULATOR_NATIVE_CAPABILITIES = Object.freeze([
  Object.freeze({
    simulatorOnly: true,
    brand: 'generic_modbus', model: 'sunspec-sim', firmware: 'sim',
    capability: 'native_charge_block_discharge_auto',
    certified: true, readback: true, watchdog: true,
    // The bytes below MUST equal what the adapter plans for this tier - the
    // simulator's control_enable + setpoint pair (see sunspecNative).
    chargeBlockWrites: [{ addr: 41, value: 0 }, { addr: 40, value: 0 }],
    readbackChecks: [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }],
    releaseWrites: [{ addr: 41, value: 1 }],
    releaseReadbackChecks: [{ addr: 41, expect: 1 }],
    watchdogSpec: { timeoutS: 0, note: 'simulator: none - the sim never reverts by itself' },
    benchRecord: 'software-only: edge-app/nodered/native-selfregulation.e2e.test.js',
  }),
]);

/**
 * exactCapability - the gate. An entry matches only on an EXACT
 * (brand, model, firmware) triple AND only when it is complete: a bench that did
 * not record BOTH transitions' bytes and readbacks did not answer criterion 1,
 * so it cannot release anything.
 *
 * ⚠ THE DEYE INTERLOCK. Deye stays refused even if a broad catalog entry is
 * supplied by accident - its remote/ToU write path is not evidence that the
 * firmware holds charge off while autonomous discharge, reserve enforcement,
 * export prevention and the watchdog all stay correct. Since 2026-08-26 the
 * interlock is LIFTABLE, but only by an explicit, per-entry mechanism, never by
 * deleting this branch: the certificate must carry `interlockLifted: 'deye'`
 * AND a non-empty `benchRecord` naming the session that measured it. That way a
 * future release lifts it TOGETHER WITH its committed evidence, and a wildcard
 * entry can still never do it silently.
 */
function exactCapability(selection, catalog = CERTIFIED_NATIVE_CAPABILITIES) {
  if (!selection || !selection.brand || !selection.model || !selection.firmware) return null;
  const deye = String(selection.brand).toLowerCase() === 'deye';
  const complete = (c) =>
    c.brand === selection.brand && c.model === selection.model &&
    c.firmware === selection.firmware &&
    c.capability === 'native_charge_block_discharge_auto' &&
    c.certified === true && c.readback === true && c.watchdog === true &&
    Array.isArray(c.chargeBlockWrites) && Array.isArray(c.readbackChecks) &&
    Array.isArray(c.releaseWrites) && Array.isArray(c.releaseReadbackChecks) &&
    c.watchdogSpec && typeof c.watchdogSpec === 'object' &&
    // The lift is per-entry, explicit and evidence-bound. Every non-Deye entry
    // is unaffected by it.
    (!deye || (c.interlockLifted === 'deye' && typeof c.benchRecord === 'string' && c.benchRecord !== ''));
  return catalog.find(complete) || null;
}

/**
 * certificateMatchesPlan - the drift check between the bench's recorded bytes and
 * the shipped adapter's intended sequence. Both sides are compared as
 * {addr, value} / {addr, expect} pairs IN ORDER (the order is part of the
 * measurement: which register is written first is exactly what a bench observes).
 *
 * A mismatch is a REFUSAL, not a warning: it means the adapter changed after the
 * session that certified it, so nothing on this device has been measured.
 */
function certificateMatchesPlan(capability, plannedWrites, plannedReadbacks) {
  if (!capability) return false;
  const sameW = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((x, i) => Number(x.addr) === Number(b[i].addr) && Number(x.value) === Number(b[i].value));
  const sameR = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((x, i) => Number(x.addr) === Number(b[i].addr) && Number(x.expect) === Number(b[i].expect));
  return sameW(capability.chargeBlockWrites, plannedWrites) &&
    sameR(capability.readbackChecks, plannedReadbacks);
}

function nativeWritePlan(request, catalog = CERTIFIED_NATIVE_CAPABILITIES) {
  const capability = exactCapability(request?.selection, catalog);
  // A native mode is allowed to latch only when its exact certificate also
  // defines and proves the return to the device's safe configured default.
  // This is still a pure plan: the function performs no write itself.
  if (request?.releaseRequested === true) {
    if (!capability) return { path: 'disabled', writes: [], readback: [], reason: 'native_not_certified' };
    return {
      path: 'release',
      writes: capability.releaseWrites.map((write) => ({ ...write })),
      readback: capability.releaseReadbackChecks.map((check) => ({ ...check })),
      watchdog: { ...capability.watchdogSpec },
      reason: 'native_release',
    };
  }
  if (!request || request.authorized !== true || request.emergencyStop === true ||
      request.firstLightGranted !== true || request.measurementsFresh !== true ||
      request.communicationHealthy !== true || request.readbackHealthy !== true ||
      !Number.isFinite(request.socPct) || !Number.isFinite(request.effectiveFloorSocPct) ||
      request.socPct <= request.effectiveFloorSocPct) {
    return { path: 'disabled', writes: [], readback: [], reason: 'safety_gate' };
  }
  if (!capability) {
    return { path: 'idle_follow', writes: [], readback: [], reason: 'native_not_certified' };
  }
  return {
    path: 'autonomous_discharge',
    writes: capability.chargeBlockWrites.map((write) => ({ ...write })),
    readback: capability.readbackChecks.map((check) => ({ ...check })),
    watchdog: { ...capability.watchdogSpec },
    reason: 'exact_native_capability',
  };
}

module.exports = {
  CERTIFIED_NATIVE_CAPABILITIES,
  SIMULATOR_NATIVE_CAPABILITIES,
  exactCapability,
  certificateMatchesPlan,
  nativeWritePlan,
};
