'use strict';

/**
 * Pure planner for the optional native "block charge, leave autonomous
 * discharge enabled" path.  It never performs I/O.  Production deliberately
 * passes the exported, empty CERTIFIED_NATIVE_CAPABILITIES catalog until a
 * model+firmware has completed UNPLANNED-LOAD-BENCH.md.
 */
const CERTIFIED_NATIVE_CAPABILITIES = Object.freeze([]);

function exactCapability(selection, catalog = CERTIFIED_NATIVE_CAPABILITIES) {
  if (!selection || !selection.brand || !selection.model || !selection.firmware) return null;
  // Deye remains explicitly bench-gated even if an accidentally broad catalog
  // entry is supplied. A future release must remove this interlock together
  // with committed model/firmware evidence.
  if (String(selection.brand).toLowerCase() === 'deye') return null;
  return catalog.find((c) =>
    c.brand === selection.brand && c.model === selection.model &&
    c.firmware === selection.firmware &&
    c.capability === 'native_charge_block_discharge_auto' &&
    c.certified === true && c.readback === true && c.watchdog === true &&
    Array.isArray(c.chargeBlockWrites) && Array.isArray(c.readbackChecks) &&
    Array.isArray(c.releaseWrites) && Array.isArray(c.releaseReadbackChecks) &&
    c.watchdogSpec && typeof c.watchdogSpec === 'object') || null;
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

module.exports = { CERTIFIED_NATIVE_CAPABILITIES, exactCapability, nativeWritePlan };
