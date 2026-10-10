'use strict';

/**
 * Netzseitiger Drossel-Slot (Konzept vp-deye-netzseitig-drossel-k2, Paket P3):
 * der PRODUKTIVPFAD der netzseitigen Fernsteuerung des Deye (Register 1100-1121,
 * PR-978-Lage). In einem Fahrplan-Slot mit Abregelung (Negativpreis / Null-
 * Export) regelt der Wechselrichter den NETZANSCHLUSS selbst auf das Ziel und
 * drosselt dafuer seine EIGENE PV - die Groesse, die der Fronius-Abregelweg
 * strukturell nicht erreicht.
 *
 * ⚠ EINE QUELLE, ZWEI LAUFZEITEN (das Muster von deye-charge-side.js):
 * inverter-control-routing.js `require`t diese Datei, build-flows.js bettet sie
 * WOERTLICH in den Plan-Knoten ein (embedModule). Sie `require`t deshalb selbst
 * nichts: jede Register-Tatsache kommt als `ctx` vom Aufrufer.
 *
 * ⚠ DIE AUFTEILUNG. Der KERN entscheidet, OB ein Slot netzseitig gefahren wird
 * (guards/gridtarget.go: Eintrittsregel, Aufsicht, jede Ruecknahme mit Grund)
 * und veroeffentlicht eine ABSICHT - `battery_mode: "grid_target"` und
 * `grid_target_kw` auf edge/setpoint. DIESE Datei haelt, was nur Layer 1 wissen
 * kann: die Registerfolge und die FREIGABE des genauen Modells. Die Antwort an
 * den Kern ist ein BELEG, kein Gehorsam: die Rueckmeldung traegt die Rollen
 * `power_control_mode` (liest 2) und `grid_power` (das Ziel steht) - daran,
 * nicht an einem Wort, erkennt der Kern die Uebernahme.
 *
 * ⚠ DIE REIHENFOLGE IST DIE SICHERHEIT (Konzept §2.9, Captain-Entscheide E2/E5):
 *
 *   1. 1101 Totmann        scharf, BEVOR sich irgendetwas bewegen kann
 *   2. 1109 <- 0           der NEUTRALSCHRITT, solange der Kern die Uebernahme
 *                          nicht belegt sieht (`grid_target_neutralize`): in der
 *                          ALTEN, batterieseitigen Bedeutung ist 0 neutral - ohne
 *                          ihn wuerde ein stehender Entlade-Befehl +1000 beim
 *                          Umschalten fuer einen Moment als 30-kW-BEZUGS-Ziel
 *                          gelesen
 *   3. 1115 <- 999         VOR dem Umschalten (E5): 1000 und darueber heisst auf
 *                          diesem Register laut Feldbericht "eigene PV auf 0".
 *                          Am HV-30K Herzogau zog 1000 die PV NICHT auf 0
 *                          (08.10.2026) - geschrieben wird trotzdem 999, die
 *                          Aussage gilt fuer ein Geraet, nicht fuer die Familie
 *   4. 1104 <- 2           das eigentliche Umschalten auf die Netzseite
 *   5. 1109 <- Ziel        NICHT negiert: unser Kontrakt und das Register meinen
 *                          netzseitig beide - = Einspeisung
 *   6. 1100 <- 1           ZULETZT
 *
 * Die RUECKKEHR ist der gewoehnliche Fernsteuer-Plan, keine zweite Folge: das
 * Ziel ist 0 (hoechstens +50 W), und 0 ist in der batterieseitigen Bedeutung
 * wieder neutral - `1104 <- 1` kann also keinen alten Wert falsch lesen. Der
 * TOTMANN aendert sich nicht: 1101 wird jeden Takt neu getreten; verstummt die
 * Box, verlaesst der Deye die Fernsteuerung nach 60 s von selbst.
 */

// Das Wort auf edge/setpoint (battery_mode) UND in native_capabilities.intents.
const GRID_TARGET_MODE = 'grid_target';

// Nie ein Ziel ueber +50 W (unser Kontrakt: + = Bezug): ein positiver Netz-
// Sollwert ist ein BEZUGS-Ziel, und der Deye luede die Batterie aus dem Netz.
// EEG-Sicherheit durch Konstruktion (Konzept §1.9 (4)) - der Kern klemmt
// dieselbe Grenze (guards.ClampGridTarget), diese hier gilt unabhaengig davon.
const GRID_TARGET_MAX_KW = 0.05;

// Der Wert fuer 1115 im Netzmodus: nie 1000 oder darueber.
const GRID_TARGET_PV_MAX_PERMILLE = 999;

/**
 * DIE FREIGABEN. Physische Schreibfreigaben sind modellbezogen: ein Eintrag
 * nennt Hersteller, Katalog-Modell-ID (edge/inverter/config `model`), die vom
 * GERAET beantwortete Registerlage (nie ein getippter Firmware-Text) und den
 * Pruefnachweis. Ohne Eintrag plant der Adapter den gewoehnlichen
 * batterieseitigen Sollwert und meldet den Hebel nicht - der Kern fragt dann
 * gar nicht erst.
 */
const GRID_TARGET_RELEASES = Object.freeze([
  Object.freeze({
    brand: 'deye', model: 'sun-30k-sg01hp3', layout: 'pr978',
    benchRecord: 'Netz-Sollwert-Test Herzogau 08.10.2026 11:00:35-11:02:36 (Box edge-2026.09.6, '
      + 'SUN-30K-SG01HP3-EU): Umschalten bei laufender Fernsteuerung bestaetigt, Vorzeichen richtig '
      + '(kein Bezug waehrend des Laufs), Netzpunkt folgte dem 2-kW-Schritt (Ziel -28,0 kW, gemessen '
      + '28,4 kW binnen ~7 s, Plateau 3/3), Fronius unberuehrt, 1115 = 1000 zog die Deye-PV nicht auf 0, '
      + 'Export nie ueber 33 kW, Ruecknahme nach 120 s. Grenze: "Ziel 0" stellt nur den eigenen Anteil '
      + '(eigene PV plus Speicherladung), nicht die Fronius-Einspeisung.',
  }),
]);

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * gridTargetRelease - der Freigabe-Eintrag fuer GENAU diese Auswahl, sonst null.
 *   selection: { brand, model }   layout: die erkannte Registerlage ('pr978')
 */
function gridTargetRelease(selection, layout, releases) {
  const list = Array.isArray(releases) ? releases : GRID_TARGET_RELEASES;
  if (!selection || typeof selection !== 'object') return null;
  const brand = norm(selection.brand);
  const model = norm(selection.model);
  if (!brand || !model || typeof layout !== 'string' || layout === '') return null;
  for (const e of list) {
    if (e.brand === brand && e.model === model && e.layout === layout) return e;
  }
  return null;
}

/**
 * parseGridTarget - die Absicht des Kerns aus dem Sollwert lesen. STRENG: ohne
 * das Wort oder ohne brauchbares Ziel null (der Adapter plant dann den
 * gewoehnlichen batterieseitigen Sollwert). Das Ziel wird hier GEKLEMMT, nie
 * verworfen: ein zu hohes Ziel ist die Null-Einspeisung plus hoechstens 50 W,
 * kein Grund, einen Drossel-Slot ungedrosselt zu lassen.
 */
function parseGridTarget(setpoint) {
  if (!setpoint || typeof setpoint !== 'object') return null;
  if (setpoint.battery_mode !== GRID_TARGET_MODE) return null;
  const kw = setpoint.grid_target_kw;
  if (typeof kw !== 'number' || !isFinite(kw)) return null;
  return {
    targetKw: Math.min(kw, GRID_TARGET_MAX_KW),
    neutralize: setpoint.grid_target_neutralize === true,
  };
}

/**
 * gridTargetUnits - das Ziel in Register-Einheiten (0,1 % der Nennleistung),
 * NICHT negiert. Die +50-W-Klemme gilt auch nach dem Runden: bei 30 kW ist eine
 * Einheit 30 W, 0,05 kW rundete auf 2 Einheiten = 60 W - also abrunden.
 */
function gridTargetUnits(targetKw, ratedKw, ctx) {
  const per = ctx.unitsPerRated;
  const limit = ctx.limit;
  let units = Math.round((targetKw / ratedKw) * per) || 0;
  const maxUnits = Math.floor((GRID_TARGET_MAX_KW / ratedKw) * per);
  if (units > maxUnits) units = maxUnits;
  const clamped = units < -limit;
  if (clamped) units = -limit;
  return { units, raw: units & 0xffff, clamped };
}

/**
 * deyeGridTargetPlan - die Registerfolge EINES Taktes.
 *   target: parseGridTarget()
 *   ctx:    { reg: { mode, watchdog, powerControlMode, constantPower, pvMaxPower },
 *             writeFc, watchdogS, ratedKw, gridSide, modeOn, reassertS,
 *             unitsPerRated, limit }
 * Liefert { planned, readbacks, units, clamped }.
 *
 * KADENZ wie der gewoehnliche Fernsteuer-Plan: Totmann, Sollwert und Enable
 * jeden Takt (`always` - der Schreibvorgang IST der Totmann-Tritt), die beiden
 * Konfigurations-Register (1104, 1115) bei Aenderung, alle `reassertS` und
 * sofort, wenn eine Rueckmeldung sie nicht haelt. Jeder gesparte Schreibvorgang
 * ist Socket-Zeit auf dem EINEN Logger-Socket.
 */
function deyeGridTargetPlan(target, ctx) {
  const R = ctx.reg;
  const fc = ctx.writeFc;
  const ram = { dwell_s: 0, min_change: 0, always: true, bench_pending: true };
  const ramCfg = { dwell_s: 0, min_change: 0, reassert_s: ctx.reassertS, bench_pending: true };
  const sp = gridTargetUnits(target.targetKw, ctx.ratedKw, ctx);
  const planned = [];
  planned.push(Object.assign({ role: 'remote_watchdog', fc, addr: R.watchdog, value: ctx.watchdogS & 0xffff,
    encode: { kind: 'remote_watchdog_s', seconds: ctx.watchdogS } }, ram));
  if (target.neutralize) {
    planned.push(Object.assign({ role: 'grid_neutral', fc, addr: R.constantPower, value: 0,
      encode: { kind: 'remote_neutral' } }, ram));
  }
  planned.push(Object.assign({ role: 'pv_max_permille', fc, addr: R.pvMaxPower, value: GRID_TARGET_PV_MAX_PERMILLE,
    encode: { kind: 'pv_max_permille', rated_kw: ctx.ratedKw, permille: GRID_TARGET_PV_MAX_PERMILLE } }, ramCfg));
  planned.push(Object.assign({ role: 'power_control_mode', fc, addr: R.powerControlMode, value: ctx.gridSide,
    encode: { kind: 'remote_power_control_mode', enum: 'grid_side' } }, ramCfg));
  planned.push(Object.assign({ role: 'grid_power', fc, addr: R.constantPower, value: sp.raw,
    encode: { kind: 'grid_power_permille', rated_kw: ctx.ratedKw, kw: target.targetKw,
      units: sp.units, limit: ctx.limit, clamped: sp.clamped } }, ram));
  planned.push(Object.assign({ role: 'remote_mode', fc, addr: R.mode, value: ctx.modeOn,
    encode: { kind: 'remote_mode', enum: 'on' } }, ram));
  // Der Neutralschritt bekommt KEINE Rueckmeldung: derselbe Takt ueberschreibt
  // ihn, ein Ruecklesen ergaebe eine garantierte Abweichung auf 1109.
  const readbacks = planned.filter((w) => w.role !== 'grid_neutral').map((w) => {
    const rb = { role: w.role, fc: 3, addr: w.addr, expect: w.value & 0xffff, tolerance: w.role === 'grid_power' ? 1 : 0 };
    if (w.role === 'grid_power') rb.decode = { kind: 'grid_power_permille', rated_kw: ctx.ratedKw };
    return rb;
  });
  return { planned, readbacks, units: sp.units, clamped: sp.clamped };
}

/**
 * withGridTargetLever - haengt den Hebel an die Faehigkeiten-Meldung
 * (`native_capabilities`), wenn die Auswahl ihn freigegeben traegt. Die Meldung
 * bleibt sonst, wie sie war; null bleibt null ("nichts gemeldet" ist ein anderer
 * Satz als "gemeldet: nichts freigegeben").
 */
function withGridTargetLever(report, released) {
  if (!report || !Array.isArray(report.intents) || !released) return report;
  if (report.intents.indexOf(GRID_TARGET_MODE) >= 0) return report;
  return { intents: report.intents.concat([GRID_TARGET_MODE]), window: report.window, persistent: report.persistent };
}

module.exports = {
  GRID_TARGET_MODE,
  GRID_TARGET_MAX_KW,
  GRID_TARGET_PV_MAX_PERMILLE,
  GRID_TARGET_RELEASES,
  gridTargetRelease,
  parseGridTarget,
  gridTargetUnits,
  deyeGridTargetPlan,
  withGridTargetLever,
};
