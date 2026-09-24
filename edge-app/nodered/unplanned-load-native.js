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
 * It never performs I/O. Production passes the exported
 * CERTIFIED_NATIVE_CAPABILITIES catalog; a model+firmware that is not in it can
 * never hand a battery over, so the mode simply never engages there.
 */

/**
 * DEYE_REMOTE_PR978_FIRMWARE - the firmware CONDITION the Deye pilot certificate
 * is keyed on, and it is deliberately NOT an operator-typed string.
 *
 * ⚠ ON THIS FAMILY THE ONLY TRUSTWORTHY STATEMENT ABOUT THE FIRMWARE IS THE ONE
 * THE DEVICE MADE. `inverter-control-routing.js classifyDeyeCapability` reads the
 * "Customized register" block 1100..1121 (Deye MODBUS protocol V105.1+) and
 * classifies the PR #978 register layout - mode selector 1104, strategy 1105,
 * SIGNED power setpoint 1109 - as `layout: 'pr978', supported: true`; the sticky
 * per-device decision (`deyeUpdateSticky`) holds that verdict across restarts.
 * That verdict IS this key. Two consequences that are the whole point:
 *   - a Deye whose firmware carries no remote block, or the older v105_1 layout
 *     (AC-side setpoint 1111), never produces this key and therefore never
 *     matches - it keeps the proven 10-second follower;
 *   - a firmware UPDATE that removes the block (it has happened in the field,
 *     photovoltaikforum 247695) stops matching BY ITSELF, with nobody editing a
 *     catalog.
 */
const DEYE_REMOTE_PR978_FIRMWARE = 'remote-pr978';

/**
 * THE CAPABILITY VOCABULARY (K4b, 24.09.2026 - concept "Der Wechselrichter
 * regelt, die Box setzt Absicht und Grenzen" §3/§4). The core publishes an
 * INTENT word (`battery_native_intent` on edge/setpoint); a certificate entry
 * releases exactly ONE capability word, and each word realises exactly one
 * intent:
 *   native_charge_block_discharge_auto -> cover_load       (E-down: Verbrauch decken)
 *   native_surplus_charge              -> surplus_charge   (E-up: nur aus Überschuss laden)
 *   native_self_consumption            -> self_consumption (E: Eigenverbrauch; E~ only
 *                                         with `windowLimits`, because a throttled
 *                                         charge IS a window narrower than the device's
 *                                         natural one)
 * Two additive entry fields answer the remaining questions of §4:
 *   windowLimits: true = the device can bound its charge/discharge power INSIDE its
 *                 own mode ("Grenzen im Eigenmodus"). Without it only the intent's
 *                 natural window is executable.
 *   persistent:   true = the lever is an EEPROM/flash write; it counts against the
 *                 core's day budget (concept §6.6, F12: <= 20 per day).
 * ⚠ The vocabulary is not a release. Production still carries ONLY the Deye
 * pilot's cover_load entry - the Deye charge side is K5, SMA/Fronius/Huawei are K9.
 */
const NATIVE_CAPABILITY_FOR_INTENT = Object.freeze({
  cover_load: 'native_charge_block_discharge_auto',
  surplus_charge: 'native_surplus_charge',
  self_consumption: 'native_self_consumption',
});
const NATIVE_INTENTS = Object.freeze(Object.keys(NATIVE_CAPABILITY_FOR_INTENT));

/**
 * K5 (concept §9 "Deye Überschuss-Übergabe"): the Deye remote tier has TWO
 * hand-over candidates for the charge side, and a certificate names WHICH one
 * was measured (additive entry field `candidate`):
 *   grid_zero  - "netzseitig Ziel 0": 1104 <- 2 with the grid target 1109 = 0;
 *                the inverter regulates its own grid meter (the Herzogau CT sees
 *                the Fronius too). Kept alive by the ordinary RAM heartbeat
 *                (1101 watchdog), so "the box died" still ends it within 60 s.
 *   own_config - "Eigenkonfiguration": 1100 <- 0, the device's own Work-Mode /
 *                Time-of-Use configuration regulates - the same bytes as the
 *                E-down pilot, but behind the EXTENDED precondition (Work Mode,
 *                Energy Pattern, Solar Sell, the ACTIVE ToU program).
 * The bytes live in the adapter (deye-charge-side.js); a certificate only
 * attests them, exactly like every other entry here.
 */
const DEYE_NATIVE_CANDIDATE = Object.freeze({ GRID_ZERO: 'grid_zero', OWN_CONFIG: 'own_config' });

/**
 * The bytes the two candidates were built with (deye-charge-side.js plans them
 * from DEYE_REMOTE_REG and the DEFAULT 60-s watchdog). A released entry records
 * exactly these - certificateMatchesPlan refuses the moment the adapter drifts
 * (and an operator-tuned watchdog is such a drift: the pilot measured 60 s).
 */
const DEYE_CHARGE_SIDE_BYTES = Object.freeze({
  grid_zero: Object.freeze({
    // 1101 watchdog FIRST, 1109 <- 0 BEFORE the side switch (neutral in the old
    // battery-side meaning AND the grid target of the new one), 1104 <- 2,
    // 1115 <- 999 (1000 would throttle the own PV to 0 in grid mode), 1100 LAST.
    chargeBlockWrites: Object.freeze([
      { addr: 0x044d, value: 60 }, { addr: 0x0455, value: 0 }, { addr: 0x0450, value: 2 },
      { addr: 0x045b, value: 999 }, { addr: 0x044c, value: 1 },
    ]),
    readbackChecks: Object.freeze([
      { addr: 0x044d, expect: 60 }, { addr: 0x0455, expect: 0 }, { addr: 0x0450, expect: 2 },
      { addr: 0x045b, expect: 999 }, { addr: 0x044c, expect: 1 },
    ]),
  }),
  own_config: Object.freeze({
    chargeBlockWrites: Object.freeze([{ addr: 0x044c, value: 0 }]),
    readbackChecks: Object.freeze([{ addr: 0x044c, expect: 0 }]),
  }),
});

/**
 * The placeholder a prepared entry carries until a pilot window proved it. A
 * release with this text (or an empty one) THROWS at load time - a certificate
 * without its evidence must not even build.
 */
const DEYE_CHARGE_SIDE_BENCH_PLACEHOLDER =
  '<Prüfnachweis: Datum, Fall (F11/F1/F2/F5), Lauf-ID und Messwerte aus GET /api/native/pilot>';

/**
 * releaseDeyeChargeSide - builds ONE prepared Deye charge-side certificate for
 * the pilot (deye / sun-30k-sg01hp3 / probed PR-978 layout). It exists so the
 * release after a pilot window is a ONE-LINE step in the catalog below (see
 * edge-app/nodered/DEYE-LADESEITE-PILOT.md, "Was danach freigeschaltet wird").
 *
 * windowLimits is false for both candidates: no volatile charge/discharge LIMIT
 * inside the Deye's own regulation is known (0x006C/0x006D are EEPROM installer
 * registers and are never written), so E~ (a throttled charge) stays the box's.
 */
function releaseDeyeChargeSide(candidate, intent, benchRecord) {
  const bytes = Object.prototype.hasOwnProperty.call(DEYE_CHARGE_SIDE_BYTES, candidate)
    ? DEYE_CHARGE_SIDE_BYTES[candidate] : null;
  if (!bytes) throw new Error('releaseDeyeChargeSide: unbekannter Kandidat ' + candidate);
  if (intent !== 'surplus_charge' && intent !== 'self_consumption') {
    throw new Error('releaseDeyeChargeSide: nur Ladeseiten-Absichten, nicht ' + intent);
  }
  if (typeof benchRecord !== 'string' || benchRecord.trim() === '' ||
      benchRecord === DEYE_CHARGE_SIDE_BENCH_PLACEHOLDER) {
    throw new Error('releaseDeyeChargeSide: ohne Prüfnachweis keine Freigabe');
  }
  return Object.freeze({
    brand: 'deye', model: 'sun-30k-sg01hp3', firmware: DEYE_REMOTE_PR978_FIRMWARE,
    capability: NATIVE_CAPABILITY_FOR_INTENT[intent],
    candidate,
    certified: true, readback: true, watchdog: true,
    interlockLifted: 'deye',
    windowLimits: false, persistent: false,
    chargeBlockWrites: bytes.chargeBlockWrites.map((w) => ({ ...w })),
    readbackChecks: bytes.readbackChecks.map((r) => ({ ...r })),
    // The way back is the ordinary remote plan (1100 <- 1 last), as for E-down.
    releaseWrites: [{ addr: 0x044c, value: 1 }],
    releaseReadbackChecks: [{ addr: 0x044c, expect: 1 }],
    watchdogSpec: { timeoutS: 60, note: 'geräteeigener Totmann 1101 (DEYE_REMOTE_WATCHDOG_DEFAULT_S)' },
    benchRecord,
  });
}

const CERTIFIED_NATIVE_CAPABILITIES = Object.freeze([
  /**
   * THE PILOT (captain decision 2026-08-26: "kein separater Prüfstand - der
   * Deye-Pilot IST der Prüfstand").
   *
   * WHAT THIS ENTRY IS BOUND TO, and it is as narrow as the detection allows:
   *   brand    'deye'
   *   model    'sun-30k-sg01hp3' - the CATALOG MODEL ID the core publishes on
   *            edge/inverter/config (inverter.go deyeModels(): label
   *            "SUN-30K-SG01HP3-EU", family hybrid_3p, 30 kW). NOT the family:
   *            every other SG01HP3/SG04LP3 size keeps the follower until its own
   *            entry exists.
   *   firmware the PROBED PR-978 remote layout (see above), never a typed string.
   *
   * THE EVIDENCE this release stands on is in-repo and read-only:
   *   - the live capability probe of the owner's SUN-30K-SG01HP3-EU (2026-07-27,
   *     logger 192.168.254.210:8899, serial 1127365518, slave 1): FC03 of
   *     0x044C..0x0461 answered 1100=0x0000, 1101=0xFFFF, 1104=0x0000,
   *     1105=0x0002, 1121=0x0000 -> the PR #978 layout (DEYE_REMOTE_REG header
   *     in inverter-control-routing.js, edge-app/AGENTS.md "Deye REMOTE MODE");
   *   - that same device is the First-Light-certified pilot driving the plan on
   *     the REMOTE path today, so the hand-over register 1100 is one VoltPilot
   *     already writes every tick on exactly this inverter.
   *
   * WHAT IT DOES NOT RELEASE: the supervision. guards/nativemode.go keeps taking
   * the battery back at the reserve floor, on a threatened billing peak, on a
   * lost measurement or readback, at the end of the slot, on plant rest and when
   * the mode is never confirmed. And the adapter still refuses at RUNTIME when
   * the device's own Time-of-Use configuration cannot cover the house - see
   * `deyeNativePrecondition` in inverter-control-routing.js.
   */
  Object.freeze({
    brand: 'deye', model: 'sun-30k-sg01hp3', firmware: DEYE_REMOTE_PR978_FIRMWARE,
    capability: 'native_charge_block_discharge_auto',
    certified: true, readback: true, watchdog: true,
    // The interlock below is lifted PER ENTRY and only together with the record
    // that names what was measured - never by deleting the branch.
    interlockLifted: 'deye',
    // Disabling remote mode IS the hand-over: the inverter then runs its OWN
    // configuration (Work Mode + Time-of-Use), which is its self-consumption
    // loop. It touches no installer setting, so there is nothing to restore.
    // These bytes MUST equal what nativeSelfConsumption plans for this tier -
    // `certificateMatchesPlan` refuses when they drift apart.
    chargeBlockWrites: [{ addr: 0x044c, value: 0 }],
    readbackChecks: [{ addr: 0x044c, expect: 0 }],
    // ⚠ THE RETURN IS THE ORDINARY REMOTE PLAN, not a second copy of it. The full
    // take-back sequence (1101 watchdog FIRST, 1104, 1105, 1109, 1100 LAST) is
    // owned by deyeRemoteControl/controlRelease; writing it out here would be a
    // second source of truth for an order that is already load-bearing there. So
    // the certificate names the DECISIVE register of the transition - the enable
    // that ends the native mode - and its proof.
    releaseWrites: [{ addr: 0x044c, value: 1 }],
    releaseReadbackChecks: [{ addr: 0x044c, expect: 1 }],
    // The device's own dead-man's switch (1101). On this path "stop writing" IS
    // the failsafe: the inverter leaves remote mode by itself with nothing
    // changed - which is also why the native mode costs no watchdog of ours.
    watchdogSpec: { timeoutS: 60, note: 'geräteeigener Totmann 1101 (DEYE_REMOTE_WATCHDOG_DEFAULT_S)' },
    benchRecord: 'Pilot-Freigabe 2026-08-26 (Captain-Entscheid "der Pilot ist der Prüfstand"): '
      + 'Live-Sonde 2026-07-27 SUN-30K-SG01HP3-EU, PR-978-Remote-Layout; '
      + 'Beobachtungs-Checkliste in edge-app/nodered/UNPLANNED-LOAD-BENCH.md',
  }),
  // ⚠ K5 - DIE DEYE-LADESEITE IST NOCH NICHT FREIGEGEBEN. Erst nach einem
  // bestandenen Pilotfenster (der Captain löst jedes aus) wird GENAU die Zeile
  // des belegten Kandidaten einkommentiert und der Platzhalter durch den
  // Prüfnachweis ersetzt - Drehbuch: edge-app/nodered/DEYE-LADESEITE-PILOT.md.
  // releaseDeyeChargeSide('grid_zero', 'self_consumption', '<Prüfnachweis: Datum, Fall (F11/F1/F2/F5), Lauf-ID und Messwerte aus GET /api/native/pilot>'),
  // releaseDeyeChargeSide('grid_zero', 'surplus_charge', '<Prüfnachweis: Datum, Fall (F11/F1/F2/F5), Lauf-ID und Messwerte aus GET /api/native/pilot>'),
  // releaseDeyeChargeSide('own_config', 'self_consumption', '<Prüfnachweis: Datum, Fall (F11/F1/F2/F5), Lauf-ID und Messwerte aus GET /api/native/pilot>'),
  // releaseDeyeChargeSide('own_config', 'surplus_charge', '<Prüfnachweis: Datum, Fall (F11/F1/F2/F5), Lauf-ID und Messwerte aus GET /api/native/pilot>'),
]);

/**
 * SIMULATOR_NATIVE_CAPABILITIES is deliberately NOT part of the production
 * catalog, and it never becomes one.
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
    windowLimits: true, persistent: false,
    // The bytes below MUST equal what the adapter plans for this tier - the
    // simulator's control_enable + setpoint pair (see sunspecNative).
    chargeBlockWrites: [{ addr: 41, value: 0 }, { addr: 40, value: 0 }],
    readbackChecks: [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }],
    releaseWrites: [{ addr: 41, value: 1 }],
    releaseReadbackChecks: [{ addr: 41, expect: 1 }],
    watchdogSpec: { timeoutS: 0, note: 'simulator: none - the sim never reverts by itself' },
    benchRecord: 'software-only: edge-app/nodered/native-selfregulation.e2e.test.js',
  }),
  // K4b: the charge side of the same stand-in. The hand-over bytes are the SAME
  // (41 <- 0, 40 <- 0: the sim's own regulation); what makes the intent is the
  // window the adapter writes FIRST into the sim's limit registers 43/44
  // (edge/sim/sim-model.js). Software only, like the entry above.
  Object.freeze({
    simulatorOnly: true,
    brand: 'generic_modbus', model: 'sunspec-sim', firmware: 'sim',
    capability: 'native_surplus_charge',
    certified: true, readback: true, watchdog: true,
    windowLimits: true, persistent: false,
    chargeBlockWrites: [{ addr: 41, value: 0 }, { addr: 40, value: 0 }],
    readbackChecks: [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }],
    releaseWrites: [{ addr: 41, value: 1 }],
    releaseReadbackChecks: [{ addr: 41, expect: 1 }],
    watchdogSpec: { timeoutS: 0, note: 'simulator: none - the sim never reverts by itself' },
    benchRecord: 'software-only: edge-app/nodered/native-selfregulation.e2e.test.js',
  }),
  Object.freeze({
    simulatorOnly: true,
    brand: 'generic_modbus', model: 'sunspec-sim', firmware: 'sim',
    capability: 'native_self_consumption',
    certified: true, readback: true, watchdog: true,
    windowLimits: true, persistent: false,
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
 * ⚠ THE DEYE INTERLOCK STANDS - it is LIFTED PER ENTRY, never deleted. Deye is
 * refused even by a COMPLETE catalog entry unless that entry carries BOTH
 * `interlockLifted: 'deye'` AND a non-empty `benchRecord` naming the evidence.
 * The reason it exists is unchanged: a Deye remote/ToU write path is not by
 * itself evidence that the firmware holds charge off while autonomous discharge,
 * reserve enforcement, export prevention and the watchdog all stay correct.
 *
 * Since 2026-08-26 EXACTLY ONE entry carries the lift - the pilot
 * (deye / sun-30k-sg01hp3 / the probed PR-978 remote layout), on the captain's
 * decision "kein separater Prüfstand - der Deye-Pilot IST der Prüfstand". Every
 * other Deye model, and the same model on a firmware without the remote block,
 * still hits this branch and keeps the proven 10-second follower. A wildcard or
 * accidentally broad entry can still never lift it silently, because the lift is
 * a property of the ENTRY, not of the manufacturer.
 */
function exactCapability(selection, catalog = CERTIFIED_NATIVE_CAPABILITIES,
  capabilityWord = 'native_charge_block_discharge_auto') {
  if (!selection || !selection.brand || !selection.model || !selection.firmware) return null;
  const deye = String(selection.brand).toLowerCase() === 'deye';
  const complete = (c) =>
    c.brand === selection.brand && c.model === selection.model &&
    c.firmware === selection.firmware &&
    c.capability === capabilityWord &&
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
 * exactCapabilities - EVERY complete entry for the triple and word, in catalog
 * order (K5: the Deye charge side may carry one entry per candidate). The gate
 * is exactCapability's, entry for entry; the first element IS exactCapability.
 */
function exactCapabilities(selection, catalog = CERTIFIED_NATIVE_CAPABILITIES,
  capabilityWord = 'native_charge_block_discharge_auto') {
  const out = [];
  for (const c of catalog) {
    if (exactCapability(selection, [c], capabilityWord)) out.push(c);
  }
  return out;
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

/**
 * capabilityForIntent - the capability word an intent needs ("" for a word we do
 * not know: an unknown intent is never mapped to a guess).
 */
function capabilityForIntent(intent) {
  return Object.prototype.hasOwnProperty.call(NATIVE_CAPABILITY_FOR_INTENT, intent)
    ? NATIVE_CAPABILITY_FOR_INTENT[intent] : '';
}

/**
 * nativeLevers - the REPORT side (Layer 1 -> core, `native_capabilities` on the
 * control readback): for which intents does THIS selection have a certified lever
 * whose recorded bytes still match what the adapter plans? `plannedFor(intent)`
 * returns the adapter's { planned, readbacks } for that intent (or null when the
 * tier has no primitive for it); the certificate is checked exactly like the
 * hand-over itself (exactCapability + certificateMatchesPlan), so a report can
 * never promise more than a hand-over would execute.
 *
 * window     = every certified lever can bound its power inside the device's own
 *              mode (false when nothing is certified);
 * persistent = at least one certified lever is a flash/EEPROM write.
 */
function nativeLevers(selection, catalog, plannedFor) {
  const intents = [];
  let window = true;
  let persistent = false;
  for (const intent of NATIVE_INTENTS) {
    // K5: an intent may have several entries (one per Deye candidate); the first
    // whose recorded bytes still match what the adapter plans FOR THAT ENTRY
    // counts. `plannedFor(intent, entry)` - the generic tier ignores the entry.
    let cap = null;
    for (const c of exactCapabilities(selection, catalog, capabilityForIntent(intent))) {
      const p = typeof plannedFor === 'function' ? plannedFor(intent, c) : null;
      if (p && certificateMatchesPlan(c, p.planned, p.readbacks)) { cap = c; break; }
    }
    if (!cap) continue;
    intents.push(intent);
    if (cap.windowLimits !== true) window = false;
    if (cap.persistent === true) persistent = true;
  }
  return { intents, window: intents.length > 0 && window, persistent };
}

module.exports = {
  DEYE_REMOTE_PR978_FIRMWARE,
  DEYE_NATIVE_CANDIDATE,
  DEYE_CHARGE_SIDE_BYTES,
  DEYE_CHARGE_SIDE_BENCH_PLACEHOLDER,
  releaseDeyeChargeSide,
  exactCapabilities,
  NATIVE_CAPABILITY_FOR_INTENT,
  NATIVE_INTENTS,
  capabilityForIntent,
  nativeLevers,
  CERTIFIED_NATIVE_CAPABILITIES,
  SIMULATOR_NATIVE_CAPABILITIES,
  exactCapability,
  certificateMatchesPlan,
  nativeWritePlan,
};
