/**
 * limit-protection.js - die reine RECHNUNG des SCHUTZ-/GRENZBAUSTEINS (P5c,
 * Konzept vp-deye-diybms-luecke-l5 §3.2b „OPTIONAL - Schutz-/Grenzbaustein"
 * und §3.3).
 *
 * Sie liegt aus demselben Grund in einer eigenen Datei wie
 * `lib/soc-derivation.js`: WAS eine Batterie gerade zulaesst, ist eine Aussage
 * ueber SICHERHEIT - und die muss ohne Broker, ohne Node-RED und ohne Uhr
 * vollstaendig pruefbar sein. Die Uhr reist als Parameter herein.
 *
 * WAS SIE RECHNET (beides optional, beides konfigurierbar):
 *
 *   (1) DIE STROM-TREPPE je Richtung: aus dem Ladestand wird der zulaessige
 *       Lade- bzw. Entladestrom. „Der letzte Stuetzpunkt mit Schwelle <= SoC
 *       gewinnt" - eine Treppe, keine Interpolation. Das Ergebnis wird auf das
 *       GERAETE-Maximum geklemmt.
 *
 *   (2) DER ZELLSPANNUNGS-RIEGEL mit Hysterese: Laden sperrt, sobald die
 *       HOECHSTE Zelle die Stopp-Schwelle erreicht, und oeffnet erst wieder an
 *       der Freigabe-Schwelle; Entladen sperrt an der NIEDRIGSTEN Zelle,
 *       spiegelbildlich. Eine gesperrte Richtung ist 0 A.
 *
 * WARUM EIN RIEGEL UND KEIN VERGLEICH: ohne Hysterese schaltet ein Pack an
 * seiner Stopp-Spannung im Sekundentakt - die Spannung faellt, sobald der Strom
 * wegfaellt, und steigt wieder, sobald er zurueckkommt. Der Riegel wird deshalb
 * NUR durch das UEBERSCHREITEN der Stopp-Schwelle zugeschoben und NUR durch das
 * Erreichen der Freigabe-Schwelle geoeffnet; dazwischen gilt der vorige
 * Zustand. Ohne vorigen Zustand gilt „nicht gesperrt" - eine Sperre, die
 * niemand ausgeloest hat, waere erfunden.
 *
 * DIE VORLAGE (docs/contracts/v2/limit-protection-vectors.json) ist VERBATIM
 * der Node-RED-Flow des Kunden vom 09.09.2026. Der Baustein selbst bleibt
 * GENERISCH: Stuetzpunkte, Maxima und Schwellen sind Konfiguration, kein Code.
 *
 * DIE EHRLICHKEITSREGELN, wortgleich mit der SoC-Ableitung nebenan:
 *   1. Was der Baustein nicht sagen KANN, sagt er nicht. Ohne Ladestand keine
 *      Treppe, ohne Zellspannung keine Freigabe - nie eine 0, nie ein „ja".
 *   2. Ein Hartstopp braucht KEINEN Ladestand: die Zellspannung allein beweist
 *      ihn. Die beiden Haelften sind deshalb unabhaengig.
 *   3. Eine gesperrte Richtung meldet BEIDES - `allowed = 0` UND `limit_a = 0`.
 *      Nur eines von beiden zu melden hiesse, den Leser die Sperre erraten zu
 *      lassen.
 *   4. Eine Freigabe reist als ZAHL (0/1): die Telemetrie-Kanaele sind per
 *      Vertrag Zahlen (edge-entity.schema.json $defs.channels).
 *
 * WAS HIER BEWUSST NICHT WOHNT: das SCHREIBEN einer Geraete-Stromgrenze an
 * einen Wechselrichter (der Kundenflow tut das an den Deye, `0x006C`/`0x006D`).
 * Dieser Baustein STELLT die Grenzen BEREIT - als Kanaele fuer die Anzeige und
 * als Kappe fuer den Waechter (guards.Clamp auf der Box). Scharf geschaltet
 * wird ein Schreibpfad ausschliesslich hinter dem Zertifizierungs-Gate
 * (vp-deye-bench-cert / hybrid-control-p2), nicht hier; bis dahin bleibt der
 * Kundenflow der aktive Schreiber (§3.3).
 */
'use strict';

// Der Faktor Millivolt -> Volt lebt genau EINMAL, naemlich dort, wo die
// OCV-Kennlinie ihn schon braucht. Ihn hier ein zweites Mal hinzuschreiben
// waere die zweite Wahrheit ueber dieselbe Einheit.
var cellVolt = require('./soc-derivation.js').cellVolt;

/** Die vier Kanaele, die dieser Baustein fuellt - das geschlossene Vokabular. */
var CHARGE_LIMIT_CHANNEL = 'charge_limit_a';
var DISCHARGE_LIMIT_CHANNEL = 'discharge_limit_a';
var CHARGE_ALLOWED_CHANNEL = 'charge_allowed';
var DISCHARGE_ALLOWED_CHANNEL = 'discharge_allowed';
var OUTPUT_CHANNELS = [
  CHARGE_LIMIT_CHANNEL, DISCHARGE_LIMIT_CHANNEL,
  CHARGE_ALLOWED_CHANNEL, DISCHARGE_ALLOWED_CHANNEL,
];

/** Die EINGAENGE: Rolle -> Vorgabe-Kanal. Der Nutzer darf sie umlegen. */
var DEFAULT_INPUTS = {
  soc: 'soc_pct',
  cell_min: 'cell_min_mv',
  cell_max: 'cell_max_mv',
};

/** Auf welches Raster ein Strom gerundet wird (der Kundenflow: ganze Ampere). */
var DEFAULT_ROUND_A = 1;
var MAX_ROUND_A = 10;

/** Schranken einer Treppe - der Zwilling der Cloud-Pruefung. */
var MIN_STEPS = 1;
var MAX_STEPS = 32;
var MAX_CURRENT_A = 2000;

/** Schranken einer Zellspannungs-Schwelle, in VOLT je Zelle. */
var MIN_CELL_V = 0.5;
var MAX_CELL_V = 5.0;

/** Wie lange ein Riegel-Zustand ohne frische Zellspannung noch gilt. */
var DEFAULT_HOLD_S = 900;

/**
 * Der Strom aus der TREPPE.
 *
 * „Der letzte Stuetzpunkt mit Schwelle <= SoC gewinnt" - die Stufe gilt bis zur
 * naechsten Schwelle, es wird NICHT interpoliert. Ein interpolierter Wert
 * stuende in der Tabelle des Kunden nirgends.
 *
 * UNTERHALB der ersten Schwelle wird auf den ERSTEN Stuetzpunkt GEKLEMMT statt
 * extrapoliert - dieselbe Regel wie bei `socFromVoltage` nebenan, und in der
 * Ladekurve zugleich die physikalisch richtige: eine fast leere Batterie darf
 * mit dem groessten Strom laden.
 *
 * @param {number} socPct der Ladestand in Prozent
 * @param {Array<Array<number>>} steps die Stuetzpunkte [[SoC_%, Ampere], ...]
 * @returns {number|null} Ampere, oder null wenn Eingang/Treppe unbrauchbar sind
 */
function currentFromSoc(socPct, steps) {
  if (typeof socPct !== 'number' || !isFinite(socPct)) return null;
  var pts = normalizeSteps(steps);
  if (pts === null) return null;
  var out = pts[0][1];
  for (var i = 0; i < pts.length; i++) {
    if (pts[i][0] <= socPct) {
      out = pts[i][1];
    } else {
      break;
    }
  }
  return out;
}

/**
 * Der RIEGEL einer Richtung.
 *
 * @param {number|null} volt die massgebliche Zellspannung in VOLT (hoechste
 *     Zelle beim Laden, niedrigste beim Entladen); null = keine Messung
 * @param {{stop_v:number, resume_v:number}} h die beiden Schwellen
 * @param {boolean} charging true = Lade-Riegel (sperrt OBEN), false =
 *     Entlade-Riegel (sperrt UNTEN)
 * @param {boolean|null} previous der vorige Riegel-Zustand; null = keiner
 * @returns {boolean|null} gesperrt ja/nein, oder null wenn nichts zu sagen ist
 */
function latch(volt, h, charging, previous) {
  if (h === null) return null;
  if (volt === null) {
    // Ohne frische Zellspannung gilt der VORIGE Riegel weiter - solange es ihn
    // gibt. Ihn von selbst zu oeffnen waere die gefaehrliche Richtung, ihn von
    // selbst zuzuschieben die erfundene; also bleibt er, wie er war.
    return previous === null ? null : previous;
  }
  if (charging) {
    if (volt >= h.stop_v) return true;
    if (volt <= h.resume_v) return false;
  } else {
    if (volt <= h.stop_v) return true;
    if (volt >= h.resume_v) return false;
  }
  // Im Zwischenband gilt der vorige Zustand; ohne einen ist NICHTS gesperrt -
  // ein Riegel wird nur durch das Ueberschreiten der Stopp-Schwelle
  // zugeschoben.
  return previous === null ? false : previous;
}

/**
 * Die ganze Auswertung EINES Taktes - der eine Einstieg.
 *
 * @param {Object} channels die frischen Kanaele (Ebene 1 + der abgeleitete
 *     Ladestand aus Ebene 2)
 * @param {Object} cfg rohe Konfiguration (wird hier normalisiert)
 * @param {Object|null} state der fortgeschriebene Riegel-Zustand
 *     ({charge_blocked, discharge_blocked, at})
 * @param {number} nowMs die Uhr
 * @returns {{channels:Object, state:Object, blocked:{charge:boolean|null,
 *     discharge:boolean|null}}|{reason:string}}
 */
function evaluate(channels, cfg, state, nowMs) {
  var c = normalize(cfg);
  if (c === null) return { reason: 'Konfiguration unbrauchbar' };
  var ch = channels && typeof channels === 'object' ? channels : {};

  // Ein Riegel-Zustand, der die Haltefrist gerissen hat, gilt NICHT mehr: was
  // ein Pack in einer unbeobachteten Viertelstunde getan hat, weiss niemand.
  var prev = usableState(state, c.hold_s, nowMs);

  var socPct = numberOr(ch[c.inputs.soc]);
  var maxV = cellVolt(numberOr(ch[c.inputs.cell_max]));
  var minV = cellVolt(numberOr(ch[c.inputs.cell_min]));

  var chargeBlocked = latch(maxV, c.hysteresis.charge, true,
    prev === null ? null : prev.charge_blocked);
  var dischargeBlocked = latch(minV, c.hysteresis.discharge, false,
    prev === null ? null : prev.discharge_blocked);

  var out = {};
  fill(out, CHARGE_LIMIT_CHANNEL, CHARGE_ALLOWED_CHANNEL, socPct, c.charge,
    chargeBlocked, c.round_a);
  fill(out, DISCHARGE_LIMIT_CHANNEL, DISCHARGE_ALLOWED_CHANNEL, socPct,
    c.discharge, dischargeBlocked, c.round_a);

  return {
    channels: out,
    blocked: { charge: chargeBlocked, discharge: dischargeBlocked },
    // Der Zustand wird nur fortgeschrieben, wenn es ueberhaupt einen Riegel
    // gibt - sonst waere die Ablage ein Gedaechtnis an nichts.
    state: chargeBlocked === null && dischargeBlocked === null ? null : {
      charge_blocked: chargeBlocked === true,
      discharge_blocked: dischargeBlocked === true,
      at: nowMs,
    },
  };
}

/**
 * Die beiden Kanaele EINER Richtung.
 *
 * Die Reihenfolge ist die Aussage: eine SPERRE gewinnt immer und macht aus
 * jeder Treppe eine 0; ohne Sperre gilt die Treppe; ohne beides fehlt der
 * Kanal.
 */
function fill(out, limitChannel, allowedChannel, socPct, dir, blocked, roundA) {
  if (blocked !== null) {
    out[allowedChannel] = blocked ? 0 : 1;
  }
  if (blocked === true) {
    // Eine Sperre meldet BEIDES. Sie braucht dafuer keinen Ladestand: der
    // Hartstopp steht auf der Zellspannung allein.
    out[limitChannel] = 0;
    return;
  }
  if (dir === null) return;
  var amps = currentFromSoc(socPct, dir.steps);
  if (amps === null) return;
  out[limitChannel] = roundTo(clampAmps(amps, dir.max_a), roundA);
}

function clampAmps(a, maxA) {
  if (a < 0) return 0;
  return a > maxA ? maxA : a;
}

/** Rundet auf ein Raster und beseitigt das Gleitkomma-Rauschen. */
function roundTo(value, step) {
  var s = typeof step === 'number' && isFinite(step) && step > 0 ? step : DEFAULT_ROUND_A;
  var out = Math.round(value / s) * s;
  return Math.round(out * 1e6) / 1e6;
}

/** Der Riegel-Zustand, sofern er die Haltefrist haelt. */
function usableState(state, holdS, nowMs) {
  if (!state || typeof state !== 'object') return null;
  if (typeof state.charge_blocked !== 'boolean'
      || typeof state.discharge_blocked !== 'boolean') {
    return null;
  }
  if (typeof state.at === 'number' && isFinite(state.at)
      && (nowMs - state.at) / 1000 > holdS) {
    return null;
  }
  return state;
}

/**
 * Bringt eine ausgerollte Konfiguration in die Form, mit der gerechnet wird.
 *
 * Eine unbrauchbare Konfiguration ergibt `null` statt aufgefuellter Vorgaben -
 * dieselbe Disziplin wie bei der SoC-Ableitung: die Cloud hat sie geprueft, und
 * was hier trotzdem kaputt ankommt, ist keine Schutzgrenze, die man raten
 * sollte. Ein Schutzbaustein OHNE Treppe UND OHNE Riegel prueft nichts und wird
 * deshalb ebenfalls verworfen.
 */
function normalize(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;

  var inputs = {};
  var raw = cfg.inputs && typeof cfg.inputs === 'object' ? cfg.inputs : {};
  Object.keys(DEFAULT_INPUTS).forEach(function (key) {
    var name = raw[key];
    inputs[key] = typeof name === 'string' && name !== '' ? name : DEFAULT_INPUTS[key];
  });

  var charge = direction(cfg.charge);
  var discharge = direction(cfg.discharge);
  if (charge === false || discharge === false) return null;

  var h = cfg.hysteresis && typeof cfg.hysteresis === 'object' ? cfg.hysteresis : {};
  var chargeH = hysteresis(h.charge_stop_v, h.charge_resume_v, true);
  var dischargeH = hysteresis(h.discharge_stop_v, h.discharge_resume_v, false);
  if (chargeH === false || dischargeH === false) return null;

  if (charge === null && discharge === null && chargeH === null && dischargeH === null) {
    return null;
  }

  return {
    inputs: inputs,
    charge: charge,
    discharge: discharge,
    hysteresis: { charge: chargeH, discharge: dischargeH },
    round_a: typeof cfg.round_a === 'number' && cfg.round_a > 0
      && cfg.round_a <= MAX_ROUND_A ? cfg.round_a : DEFAULT_ROUND_A,
    hold_s: typeof cfg.hold_s === 'number' && cfg.hold_s > 0 ? cfg.hold_s : DEFAULT_HOLD_S,
  };
}

/**
 * Eine Richtung: Treppe samt Geraete-Maximum.
 *
 * @returns {Object|null|false} die geprueften Werte, `null` = diese Richtung
 *     hat keine Treppe (ein legitimer Zustand), `false` = kaputt
 */
function direction(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return false;
  var steps = normalizeSteps(raw.steps);
  if (steps === null) return false;
  var maxA = raw.max_a;
  if (!(typeof maxA === 'number' && isFinite(maxA) && maxA >= 0 && maxA <= MAX_CURRENT_A)) {
    return false;
  }
  return { steps: steps, max_a: maxA };
}

/**
 * Die Stuetzpunkte, geprueft und aufsteigend nach Schwelle - oder null.
 *
 * Anders als eine OCV-Kennlinie darf eine Strom-Treppe FALLEN (die Ladekurve
 * des Kunden faellt von 270 A auf 22 A) und darf ebenso steigen (seine
 * Entladekurve steigt von 74 A auf 342 A). Es gibt hier also bewusst KEINE
 * Monotonie-Regel - nur eine doppelte Schwelle waere zweideutig.
 */
function normalizeSteps(raw) {
  if (!Array.isArray(raw) || raw.length < MIN_STEPS || raw.length > MAX_STEPS) {
    return null;
  }
  var out = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var p = raw[i];
    if (!Array.isArray(p) || p.length < 2) return null;
    var pct = Number(p[0]);
    var amps = Number(p[1]);
    if (!isFinite(pct) || !isFinite(amps)) return null;
    if (pct < 0 || pct > 100) return null;
    if (amps < 0 || amps > MAX_CURRENT_A) return null;
    if (seen[pct]) return null;
    seen[pct] = true;
    out.push([pct, amps]);
  }
  out.sort(function (a, b) { return a[0] - b[0]; });
  return out;
}

/**
 * Ein Riegel: Stopp- und Freigabe-Schwelle in VOLT je Zelle.
 *
 * @returns {Object|null|false} die beiden Schwellen, `null` = kein Riegel fuer
 *     diese Richtung, `false` = kaputt
 */
function hysteresis(stopV, resumeV, charging) {
  if (stopV === undefined && resumeV === undefined) return null;
  if (stopV === null && resumeV === null) return null;
  if (!inCellRange(stopV) || !inCellRange(resumeV)) return false;
  // Die Freigabe liegt beim Laden UNTER dem Stopp und beim Entladen darueber -
  // andersherum waere es keine Hysterese, sondern ein Riegel, der sich selbst
  // im Moment des Zuschiebens wieder oeffnet.
  if (charging && !(resumeV < stopV)) return false;
  if (!charging && !(resumeV > stopV)) return false;
  return { stop_v: stopV, resume_v: resumeV };
}

function inCellRange(v) {
  return typeof v === 'number' && isFinite(v) && v >= MIN_CELL_V && v <= MAX_CELL_V;
}

function numberOr(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

module.exports = {
  CHARGE_LIMIT_CHANNEL: CHARGE_LIMIT_CHANNEL,
  DISCHARGE_LIMIT_CHANNEL: DISCHARGE_LIMIT_CHANNEL,
  CHARGE_ALLOWED_CHANNEL: CHARGE_ALLOWED_CHANNEL,
  DISCHARGE_ALLOWED_CHANNEL: DISCHARGE_ALLOWED_CHANNEL,
  OUTPUT_CHANNELS: OUTPUT_CHANNELS,
  DEFAULT_INPUTS: DEFAULT_INPUTS,
  DEFAULT_ROUND_A: DEFAULT_ROUND_A,
  MAX_ROUND_A: MAX_ROUND_A,
  DEFAULT_HOLD_S: DEFAULT_HOLD_S,
  MIN_STEPS: MIN_STEPS,
  MAX_STEPS: MAX_STEPS,
  MAX_CURRENT_A: MAX_CURRENT_A,
  MIN_CELL_V: MIN_CELL_V,
  MAX_CELL_V: MAX_CELL_V,
  currentFromSoc: currentFromSoc,
  latch: latch,
  evaluate: evaluate,
  normalize: normalize,
  normalizeSteps: normalizeSteps,
};
