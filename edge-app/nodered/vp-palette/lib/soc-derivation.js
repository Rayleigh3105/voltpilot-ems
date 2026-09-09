/**
 * soc-derivation.js - die reine RECHNUNG der SoC-ABLEITUNG (P5b Ebene 2,
 * Konzept vp-deye-diybms-luecke-l5 §3.2b).
 *
 * Sie liegt aus demselben Grund in einer eigenen Datei wie
 * `lib/mqtt-mapping.js`: WOHER ein Ladestand kommt und wann es KEINEN gibt, ist
 * eine Aussage ueber Ehrlichkeit - und die muss ohne Broker, ohne Node-RED und
 * ohne Uhr vollstaendig pruefbar sein. Die Uhr reist als Parameter herein.
 *
 * DREI METHODEN, mit klarer Praeferenz (§3.2b Ebene 2):
 *
 *   (a) direct   - die Quelle liefert einen ECHTEN Ladestand (kommerzielles BMS
 *                  mit Shunt). Uebernehmen, fertig. `soc_source = gemessen`.
 *   (b) ocv_curve- der DIYBMS-Fall, die HA-Methode des Kunden 1:1: zwei
 *                  OCV->SoC-Tabellen (Laden/Entladen) bei Referenztemperatur,
 *                  linear interpoliert, geklemmt 0..100, und aus der HOECHSTEN
 *                  und der NIEDRIGSTEN Zelle das KONSERVATIVE MINIMUM.
 *                  `soc_source = berechnet:kennlinie`.
 *   (c) coulomb  - Ladungszaehlung: SoC(t) = SoC(t-1) + P*dt/E_nutz*100. Braucht
 *                  einen ANKER und driftet; deshalb Alternative, nie Vorgabe.
 *                  `soc_source = berechnet:ladungszaehlung`.
 *
 * DIE AUSWAHL-LOGIK ist eine Praeferenz, keine Verzweigung im Nutzer-Formular:
 * liegt ein FRISCHER gemessener Ladestand vor, gewinnt er IMMER - eine Messung
 * schlaegt jede Rechnung. Erst wenn er fehlt, rechnet die konfigurierte
 * Methode. `preferDirect: false` schaltet das ab (dann rechnet die Methode auch
 * neben einer Messung - fuer den Vergleichs-/Einfahrbetrieb).
 *
 * DIE EHRLICHKEITSREGELN, an denen die ganze Stufe haengt (§3.2b):
 *   1. KEIN soc_pct ohne EINGANG. (b) braucht frische Zellspannungen, (c) einen
 *      Anker. Fehlt der Eingang, gibt es KEINEN Ladestand - nie eine Vorgabe,
 *      nie den letzten Wert mit neuem Zeitstempel.
 *   2. Ein abgeleiteter Wert traegt IMMER seine Herkunft (`source` + `code`).
 *      Der Code reist als Kanal `soc_source_code` in derselben Telemetrie-
 *      Nachricht, damit die HISTORIE die damalige Quelle behaelt - eine spaeter
 *      geaenderte Definition faelscht keine alte Zeile.
 *   3. Ein eingefrorener Wert bekommt NIE einen frischen Zeitstempel. Diese
 *      Datei gibt ihn deshalb gar nicht erst als Messung zurueck; sie meldet
 *      `frozen` samt Alter, und der Knoten VEROEFFENTLICHT nichts.
 *   4. Ein Wort/eine Zahl ausserhalb des Erlaubten wird VERWORFEN, nie geraten.
 *
 * WAS HIER BEWUSST NICHT WOHNT: der Schutz-/Strombegrenzungs-Baustein
 * (SoC->Strom-Treppe, Zellspannungs-Hysterese) - das ist P5c.
 */
'use strict';

/** Die Ableitungs-Methoden - der Zwilling von UserDefinedBatteryDefinition. */
var METHODS = ['direct', 'ocv_curve', 'coulomb'];

/**
 * Die HERKUNFT eines Ladestands, als geschlossenes Vokabular samt Zahlencode.
 *
 * ⚠ Warum ein CODE und kein Wort: die Telemetrie-Kanaele sind per Vertrag
 * ZAHLEN (edge-entity.schema.json $defs.channels, telemetry_v2.value ist
 * DOUBLE PRECISION). Ein Wort haette einen Vertrags-Umbau der ganzen
 * Ingest-Kette gebraucht; ein Code reist durch die BEWIESENE Kette unveraendert
 * und steht je Messzeitpunkt in der Historie - genau die Eigenschaft, die §3.2b
 * verlangt („die Historie behaelt die damalige Quelle").
 *
 * Es gibt bewusst KEINE 0 fuer „unbekannt": ein unbekannter Ladestand ist ein
 * ABWESENDER Kanal, nie eine gemeldete Null.
 */
var SOURCE_GEMESSEN = 'gemessen';
var SOURCE_KENNLINIE = 'berechnet:kennlinie';
var SOURCE_LADUNGSZAEHLUNG = 'berechnet:ladungszaehlung';
var SOURCE_CODES = {};
SOURCE_CODES[SOURCE_GEMESSEN] = 1;
SOURCE_CODES[SOURCE_KENNLINIE] = 2;
SOURCE_CODES[SOURCE_LADUNGSZAEHLUNG] = 3;

/** Der Kanal, der den Code traegt. */
var SOURCE_CHANNEL = 'soc_source_code';

/** Der Kanal, den jede Methode fuellt. */
var SOC_CHANNEL = 'soc_pct';

/** Die Vorgabe-Kanaele je Eingang - der Nutzer darf sie ueberschreiben. */
var DEFAULT_INPUTS = {
  soc: 'soc_pct',
  cell_min: 'cell_min_mv',
  cell_max: 'cell_max_mv',
  voltage: 'voltage_v',
  current: 'current_a',
  power: 'power_kw',
};

/** Auf so viel Prozent wird gerundet, wenn nichts anderes dasteht (HA: 0,1). */
var DEFAULT_ROUND_PCT = 0.1;

/** Wie lange ein eingefrorener Wert ueberhaupt noch gehalten wird. */
var DEFAULT_HOLD_S = 900;

/** Schranken einer Kennlinie - der Zwilling der Cloud-Pruefung. */
var MIN_CURVE_POINTS = 2;
var MAX_CURVE_POINTS = 64;
var MIN_CELL_V = 0.5;
var MAX_CELL_V = 5.0;

/**
 * Linear interpolierter Ladestand aus EINER OCV-Kennlinie.
 *
 * Die Kennlinie ist eine Liste [[Zellspannung_V, SoC_%], ...], aufsteigend nach
 * Spannung. Ausserhalb ihrer Enden wird GEKLEMMT statt extrapoliert: eine
 * Extrapolation ueber das Ende einer gemessenen Kurve hinaus waere eine
 * erfundene Chemie.
 *
 * @param {number} v Zellspannung in VOLT
 * @param {Array<Array<number>>} curve die Tabelle
 * @returns {number|null} 0..100, oder null wenn Eingang/Kurve unbrauchbar sind
 */
function socFromVoltage(v, curve) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  if (!Array.isArray(curve) || curve.length < MIN_CURVE_POINTS) return null;
  var pts = [];
  for (var i = 0; i < curve.length; i++) {
    var p = curve[i];
    if (!Array.isArray(p) || p.length < 2) return null;
    var pv = Number(p[0]);
    var pp = Number(p[1]);
    if (!isFinite(pv) || !isFinite(pp)) return null;
    pts.push([pv, pp]);
  }
  // Aufsteigend nach Spannung - die Kurve darf in beliebiger Reihenfolge
  // ankommen, die Rechnung nicht davon abhaengen.
  pts.sort(function (a, b) { return a[0] - b[0]; });
  if (v <= pts[0][0]) return clampPct(pts[0][1]);
  var last = pts[pts.length - 1];
  if (v >= last[0]) return clampPct(last[1]);
  for (var k = 1; k < pts.length; k++) {
    var hi = pts[k];
    var lo = pts[k - 1];
    if (v <= hi[0]) {
      var span = hi[0] - lo[0];
      // Zwei Punkte auf derselben Spannung: der obere gewinnt statt durch 0 zu
      // teilen.
      if (span <= 0) return clampPct(hi[1]);
      var t = (v - lo[0]) / span;
      return clampPct(lo[1] + t * (hi[1] - lo[1]));
    }
  }
  return clampPct(last[1]);
}

function clampPct(v) {
  if (!isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/**
 * Rundet auf ein Raster (Vorgabe 0,1 %) und beseitigt das Gleitkomma-Rauschen.
 * 7.299999999999999 waere ein Wert, den niemand je gerechnet hat.
 */
function roundTo(value, step) {
  var s = typeof step === 'number' && isFinite(step) && step > 0 ? step : DEFAULT_ROUND_PCT;
  var out = Math.round(value / s) * s;
  return Math.round(out * 1e6) / 1e6;
}

/**
 * Die Zellspannung in VOLT aus dem, was die Ebene 1 liefert.
 *
 * Die Standard-Kanaele `cell_min_mv`/`cell_max_mv` reisen in MILLIVOLT (so
 * sagt es der Typkatalog), die Kennlinie steht in VOLT - der Faktor 1000 lebt
 * deshalb HIER und genau einmal.
 */
function cellVolt(mv) {
  if (typeof mv !== 'number' || !isFinite(mv)) return null;
  var v = mv / 1000;
  return v > 0 ? v : null;
}

/**
 * Methode (b): die Spannungskennlinie.
 *
 * Der Kundenflow (Ground Truth `evidence/ha-nodered-soc-flow-note.md`) rechnet
 * genau das hier:
 *
 *     soc_high = socFromVoltage(vmax, Ladekurve)
 *     soc_low  = socFromVoltage(vmin, Entladekurve)
 *     soc      = min(soc_high, soc_low)          // KONSERVATIV
 *
 * Warum das Minimum: die hoechste Zelle sagt, wie voll der Pack HOECHSTENS ist,
 * die niedrigste, wie leer er MINDESTENS ist. Der Pack kann nur so viel
 * hergeben wie seine schwaechste Zelle - deshalb ist das Minimum die einzige
 * Aussage, die den Pack nicht schoenrechnet. (An der Anlage des Kunden ist
 * genau das der Grund fuer den „Boden ~8 %": vmin 3,393 V ergibt 7,3 %,
 * waehrend vmax 3,606 V allein 31,5 % ergaebe.)
 *
 * VEREINFACHTE VARIANTE: liegen keine Zellspannungen vor, aber die PACK-Spannung
 * und die Zellzahl in Reihe, wird daraus die mittlere Zellspannung gebildet und
 * die Ladekurve benutzt. Sie ist gruendlich ungenauer (sie sieht die Spreizung
 * nicht) und deshalb nie die erste Wahl.
 *
 * @param {Object} channels die frischen Kanaele der Ebene 1
 * @param {Object} cfg normalisierte Konfiguration
 * @returns {{soc_pct:number}|{reason:string}}
 */
function deriveOcv(channels, cfg) {
  var inputs = cfg.inputs;
  var params = cfg.params;
  var candidates = [];

  var maxMv = numberOr(channels[inputs.cell_max]);
  var minMv = numberOr(channels[inputs.cell_min]);
  var curveCharge = params.curve_charge;
  // Ohne Entladekurve wird die Ladekurve fuer BEIDE Enden benutzt - eine
  // erfundene zweite Kurve waere schlimmer als eine ehrlich benannte einzige.
  var curveDischarge = params.curve_discharge || params.curve_charge;

  if (maxMv !== null) {
    var high = socFromVoltage(cellVolt(maxMv), curveCharge);
    if (high !== null) candidates.push(high);
  }
  if (minMv !== null) {
    var low = socFromVoltage(cellVolt(minMv), curveDischarge);
    if (low !== null) candidates.push(low);
  }

  if (candidates.length === 0) {
    // Vereinfachte Variante: Packspannung / Zellzahl.
    var packV = numberOr(channels[inputs.voltage]);
    var n = params.cells_in_series;
    if (packV !== null && typeof n === 'number' && n >= 1) {
      var mid = socFromVoltage(packV / n, curveCharge);
      if (mid !== null) candidates.push(mid);
    }
  }

  if (candidates.length === 0) {
    return { reason: 'keine frische Zellspannung' };
  }
  var soc;
  if (candidates.length === 1) {
    soc = candidates[0];
  } else if (cfg.params.conservative_min) {
    soc = Math.min.apply(null, candidates);
  } else {
    // Die optimistische Lesart - ausdruecklich gewaehlt, nie die Vorgabe. Ein
    // MITTEL waere hier keine dritte Lesart, sondern eine erfundene Zelle.
    soc = Math.max.apply(null, candidates);
  }
  return { soc_pct: roundTo(soc, params.round_pct) };
}

/**
 * Methode (c): die Ladungszaehlung.
 *
 *     SoC(t) = SoC(t-1) + P*dt / E_nutz * 100        (geklemmt 0..100)
 *
 * VORZEICHEN: `power_kw` ist POSITIV beim LADEN. Eine Quelle mit der
 * umgekehrten Zaehlrichtung braucht dafuer keinen zweiten Begriff - die
 * Feld-Zuordnung der Ebene 1 hat `scale`, und -1 ist die ganze Antwort.
 *
 * OHNE ANKER kein Ladestand (Ehrlichkeitsregel 1): eine Zaehlung, die bei einem
 * geratenen Startwert beginnt, ist eine Behauptung mit Nachkommastellen.
 *
 * DIE DRIFT ist der bekannte Preis dieser Methode. Zwei Gegenmittel, beide
 * ausdruecklich konfiguriert, nie geraten:
 *   - `efficiency_pct` daempft die LADE-Seite (Ladeverluste); ohne Angabe wird
 *     verlustfrei gerechnet, und das steht so in der Doku.
 *   - `recalibrate` setzt den Zaehler an einem Spannungs-ENDPUNKT wieder
 *     gerade (voll/leer), sobald die Zellspannung ihn belegt.
 *
 * EINE LUECKE zaehlt NICHT: ist zwischen zwei Takten mehr Zeit vergangen als
 * `hold_s`, ist unbekannt, was der Speicher in der Zwischenzeit getan hat - der
 * Zustand wird VERWORFEN und die Zaehlung braucht einen neuen Anker.
 *
 * @param {Object} channels die frischen Kanaele
 * @param {Object} cfg normalisierte Konfiguration
 * @param {Object|null} state der fortgeschriebene Zustand ({soc_pct, at})
 * @param {number} nowMs die Uhr (herein gereicht, nie gelesen)
 * @returns {{soc_pct:number, state:Object}|{reason:string, drop?:boolean}}
 */
function deriveCoulomb(channels, cfg, state, nowMs) {
  var inputs = cfg.inputs;
  var params = cfg.params;
  var capacity = params.capacity_kwh;
  if (!(typeof capacity === 'number' && isFinite(capacity) && capacity > 0)) {
    return { reason: 'keine nutzbare Kapazitaet' };
  }

  var powerKw = numberOr(channels[inputs.power]);
  if (powerKw === null) {
    // Ersatzweg: Strom x Spannung. Die Spannung kommt bevorzugt aus der
    // Messung; nur wenn die fehlt, aus der ausdruecklich hinterlegten
    // Nennspannung.
    var amps = numberOr(channels[inputs.current]);
    if (amps !== null) {
      var volts = numberOr(channels[inputs.voltage]);
      if (volts === null && typeof params.nominal_voltage_v === 'number') {
        volts = params.nominal_voltage_v;
      }
      if (volts !== null && volts > 0) powerKw = amps * volts / 1000;
    }
  }
  if (powerKw === null) {
    return { reason: 'keine frische Leistung/Strom-Messung' };
  }

  var prev = state && typeof state.soc_pct === 'number' && isFinite(state.soc_pct)
    && typeof state.at === 'number' && isFinite(state.at) ? state : null;
  if (prev === null) {
    var anchor = params.anchor;
    if (!anchor || typeof anchor.soc_pct !== 'number' || !isFinite(anchor.soc_pct)) {
      return { reason: 'kein Anker - die Ladungszaehlung braucht einen Startwert' };
    }
    // Der Anker ist der Startpunkt, nicht schon eine Messung dieses Taktes:
    // ab hier wird gezaehlt.
    return {
      soc_pct: roundTo(clampPct(anchor.soc_pct), params.round_pct),
      state: { soc_pct: clampPct(anchor.soc_pct), at: nowMs, anchored: true },
    };
  }

  var dtS = (nowMs - prev.at) / 1000;
  if (!(dtS > 0)) {
    // Kein Fortschritt (gleicher oder rueckwaerts gelaufener Takt): der
    // bisherige Stand gilt unveraendert weiter, es wird nichts dazu gerechnet.
    return {
      soc_pct: roundTo(prev.soc_pct, params.round_pct),
      state: { soc_pct: prev.soc_pct, at: prev.at, anchored: true },
    };
  }
  if (dtS > cfg.hold_s) {
    return {
      reason: 'Luecke von ' + Math.round(dtS) + ' s - die Zaehlung braucht einen neuen Anker',
      drop: true,
    };
  }

  var eff = typeof params.efficiency_pct === 'number' && params.efficiency_pct > 0
    ? params.efficiency_pct / 100 : 1;
  // Verluste treffen die LADE-Seite: von 1 kWh aus dem Netz kommt weniger im
  // Speicher an. Die Entladung wird NICHT zusaetzlich gedaempft - sonst
  // stuende der Wirkungsgrad zweimal in derselben Bilanz.
  var deliveredKwh = powerKw * (dtS / 3600) * (powerKw > 0 ? eff : 1);
  var next = clampPct(prev.soc_pct + deliveredKwh / capacity * 100);

  // Rekalibrierung am Endpunkt: eine Zellspannung, die „voll" bzw. „leer"
  // BELEGT, setzt den Zaehler gerade. Sie ueberschreibt die Zaehlung bewusst -
  // eine Messung schlaegt eine Integration.
  var recal = params.recalibrate;
  if (recal) {
    var maxMv = numberOr(channels[inputs.cell_max]);
    var minMv = numberOr(channels[inputs.cell_min]);
    if (maxMv !== null && typeof recal.full_cell_mv === 'number'
        && maxMv >= recal.full_cell_mv && typeof recal.full_soc_pct === 'number') {
      next = clampPct(recal.full_soc_pct);
    } else if (minMv !== null && typeof recal.empty_cell_mv === 'number'
        && minMv <= recal.empty_cell_mv && typeof recal.empty_soc_pct === 'number') {
      next = clampPct(recal.empty_soc_pct);
    }
  }

  return {
    soc_pct: roundTo(next, params.round_pct),
    state: { soc_pct: next, at: nowMs, anchored: true },
  };
}

/**
 * Die AUSWAHL-LOGIK plus die gewaehlte Methode - der eine Einstieg.
 *
 * @param {Object} channels die frischen Kanaele EINES Taktes (Ebene 1)
 * @param {Object} cfg rohe Konfiguration (wird hier normalisiert)
 * @param {Object|null} state der fortgeschriebene Zaehl-Zustand
 * @param {number} nowMs die Uhr
 * @returns {{soc_pct:number, source:string, code:number, state?:Object}
 *          |{reason:string, drop?:boolean}}
 */
function derive(channels, cfg, state, nowMs) {
  var c = normalize(cfg);
  var ch = channels && typeof channels === 'object' ? channels : {};
  if (c === null) return { reason: 'Konfiguration unbrauchbar' };

  // (a) hat IMMER Vorrang, sobald ein frischer gemessener Ladestand vorliegt -
  // eine Messung schlaegt jede Rechnung (§3.2b Auswahl-Logik).
  if (c.prefer_direct || c.method === 'direct') {
    var measured = numberOr(ch[c.inputs.soc]);
    if (measured !== null) {
      return {
        // ⚠ UEBERNEHMEN heisst UEBERNEHMEN: der gemessene Wert reist
        // VERBATIM weiter - weder gerundet noch geklemmt. Der Grund ist
        // handfest: derselbe Kanal traegt in derselben Sekunde schon die
        // ROHE Messung aus der Ebene 1. Wuerde die Ableitung sie auch nur um
        // 0,03 Prozentpunkte veraendern, stuenden zwei verschiedene Zahlen
        // fuer denselben Ladestand in derselben Sekunde in der Historie, und
        // welche gewinnt, haenge an der Zustellreihenfolge. Eine Messung zu
        // runden oder zu klemmen waere ausserdem eine stille Korrektur an
        // einem Wert, den ein Geraet so gemeldet hat.
        soc_pct: measured,
        source: SOURCE_GEMESSEN,
        code: SOURCE_CODES[SOURCE_GEMESSEN],
        // Der gemessene Wert ist zugleich der beste Anker, den die
        // Ladungszaehlung je bekommt: sie startet danach nicht bei einer
        // alten Zahl, sondern bei dieser Messung. HIER wird geklemmt - ein
        // Zaehler-Startpunkt ausserhalb von 0..100 waere kein Startpunkt.
        state: { soc_pct: clampPct(measured), at: nowMs, anchored: true },
      };
    }
    if (c.method === 'direct') {
      return { reason: 'kein gemessener Ladestand' };
    }
  }

  if (c.method === 'ocv_curve') {
    var ocv = deriveOcv(ch, c);
    if (ocv.reason) return ocv;
    return {
      soc_pct: ocv.soc_pct,
      source: SOURCE_KENNLINIE,
      code: SOURCE_CODES[SOURCE_KENNLINIE],
      // Auch die Kennlinie ankert die Zaehlung: ein Methodenwechsel faengt
      // damit nicht bei null an.
      state: { soc_pct: ocv.soc_pct, at: nowMs, anchored: true },
    };
  }

  if (c.method === 'coulomb') {
    var cou = deriveCoulomb(ch, c, state, nowMs);
    if (cou.reason) return cou;
    return {
      soc_pct: cou.soc_pct,
      source: SOURCE_LADUNGSZAEHLUNG,
      code: SOURCE_CODES[SOURCE_LADUNGSZAEHLUNG],
      state: cou.state,
    };
  }

  return { reason: 'unbekannte Methode' };
}

/**
 * Bringt eine ausgerollte Konfiguration in die Form, mit der gerechnet wird.
 *
 * Eine unbrauchbare Konfiguration ergibt `null` statt aufgefuellter Vorgaben:
 * die Cloud hat sie geprueft, und was hier trotzdem kaputt ankommt, ist keine
 * Ableitung, die man raten sollte.
 */
function normalize(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  var method = String(cfg.method || '');
  if (METHODS.indexOf(method) < 0) return null;

  var inputs = {};
  var raw = cfg.inputs && typeof cfg.inputs === 'object' ? cfg.inputs : {};
  Object.keys(DEFAULT_INPUTS).forEach(function (key) {
    var name = raw[key];
    inputs[key] = typeof name === 'string' && name !== '' ? name : DEFAULT_INPUTS[key];
  });

  var p = cfg.params && typeof cfg.params === 'object' ? cfg.params : {};
  var params = {
    curve_charge: curve(p.curve_charge),
    curve_discharge: curve(p.curve_discharge),
    cells_in_series: posInt(p.cells_in_series),
    conservative_min: p.conservative_min !== false,
    round_pct: typeof p.round_pct === 'number' && p.round_pct > 0
      ? p.round_pct : DEFAULT_ROUND_PCT,
    capacity_kwh: posNumber(p.capacity_kwh),
    efficiency_pct: posNumber(p.efficiency_pct),
    nominal_voltage_v: posNumber(p.nominal_voltage_v),
    anchor: p.anchor && typeof p.anchor === 'object'
      && typeof p.anchor.soc_pct === 'number' ? p.anchor : null,
    recalibrate: p.recalibrate && typeof p.recalibrate === 'object' ? p.recalibrate : null,
  };
  if (method === 'ocv_curve' && params.curve_charge === null) return null;
  if (method === 'coulomb' && params.capacity_kwh === null) return null;

  return {
    method: method,
    // Die Praeferenz ist die Vorgabe: nur eine ausdrueckliche `false` schaltet
    // sie ab.
    prefer_direct: cfg.prefer_direct !== false,
    inputs: inputs,
    params: params,
    hold_s: typeof cfg.hold_s === 'number' && cfg.hold_s > 0 ? cfg.hold_s : DEFAULT_HOLD_S,
  };
}

/** Eine Kennlinie, gepruft und aufsteigend - oder null. */
function curve(raw) {
  if (!Array.isArray(raw) || raw.length < MIN_CURVE_POINTS
      || raw.length > MAX_CURVE_POINTS) {
    return null;
  }
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var p = raw[i];
    if (!Array.isArray(p) || p.length < 2) return null;
    var v = Number(p[0]);
    var pct = Number(p[1]);
    if (!isFinite(v) || !isFinite(pct)) return null;
    if (v < MIN_CELL_V || v > MAX_CELL_V) return null;
    if (pct < 0 || pct > 100) return null;
    out.push([v, pct]);
  }
  out.sort(function (a, b) { return a[0] - b[0]; });
  // Eine Kennlinie, die bei steigender Spannung FAELLT, beschreibt keine
  // Lithium-Zelle - sie waere ein Tippfehler mit Ergebnis.
  for (var k = 1; k < out.length; k++) {
    if (out[k][1] < out[k - 1][1]) return null;
  }
  return out;
}

function numberOr(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function posNumber(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
}

function posInt(v) {
  return Number.isInteger(v) && v >= 1 ? v : null;
}

module.exports = {
  METHODS: METHODS,
  SOURCE_GEMESSEN: SOURCE_GEMESSEN,
  SOURCE_KENNLINIE: SOURCE_KENNLINIE,
  SOURCE_LADUNGSZAEHLUNG: SOURCE_LADUNGSZAEHLUNG,
  SOURCE_CODES: SOURCE_CODES,
  SOURCE_CHANNEL: SOURCE_CHANNEL,
  SOC_CHANNEL: SOC_CHANNEL,
  DEFAULT_INPUTS: DEFAULT_INPUTS,
  DEFAULT_ROUND_PCT: DEFAULT_ROUND_PCT,
  DEFAULT_HOLD_S: DEFAULT_HOLD_S,
  MIN_CURVE_POINTS: MIN_CURVE_POINTS,
  MAX_CURVE_POINTS: MAX_CURVE_POINTS,
  MIN_CELL_V: MIN_CELL_V,
  MAX_CELL_V: MAX_CELL_V,
  socFromVoltage: socFromVoltage,
  roundTo: roundTo,
  cellVolt: cellVolt,
  deriveOcv: deriveOcv,
  deriveCoulomb: deriveCoulomb,
  derive: derive,
  normalize: normalize,
  curve: curve,
};
