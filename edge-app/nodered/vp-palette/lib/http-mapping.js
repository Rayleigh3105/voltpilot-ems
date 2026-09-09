/**
 * http-mapping.js - die reine RECHNUNG des HTTP/JSON-Lesetyps des
 * BMS-unabhaengigen Batterie-Anschlusses (P5 Ebene 1 „HTTP/JSON", Konzept
 * vp-deye-diybms-luecke-l5 §3.2b, Report data/vp-deye-diybms-luecke-l5 3.2b).
 *
 * Sie ist der ZWILLING von `lib/mqtt-mapping.js` und teilt sich mit ihr
 * ausdruecklich die zweite Haelfte der Rechnung: `convert()` (Sentinel =
 * FEHLEND, Wahrheitswert-Vokabular, scale/offset) und `aggregate()` (min/max/
 * sum/avg/count/last ueber die frischen Proben) leben dort und werden hier
 * BENUTZT, nicht kopiert. Zwei Kopien derselben Ehrlichkeitsregel waeren genau
 * die Doppeldeutigkeit, die dieser Bausatz beseitigt - und `soc_pct` haette
 * dann je Transport eine andere Bedeutung.
 *
 * DER EINE UNTERSCHIED zu MQTT, und alles Weitere folgt daraus: MQTT wird
 * NICHT abgefragt, es kommt an - viele Nachrichten, je eine Quelle. HTTP
 * dagegen ist EINE Antwort mit EINEM Dokument, und das Aggregat lebt deshalb
 * INNERHALB dieses Dokuments. Was dort dem Topic-Filter `emon/diybms/+/+`
 * entspricht, ist ein Wertepfad mit PLATZHALTER: `cells.*.v` liest jede Zelle
 * der Liste, `banks.*.cells.*.v` jede Zelle jeder Bank. Ohne ihn waere
 * `aggregate` an einem HTTP-Anschluss ein Feld ohne Bedeutung.
 *
 * DER GROUND-TRUTH-FALL (Bauplan P5-HTTP): das DIYBMS v4 beantwortet
 * `GET http://<box>/ha` mit dem Header `ApiKey: <secret>` und einem FLACHEN
 * Dokument - `soc`, `v`, `c`, `pwr`, `lowcellv`, `highcellv`, `celltemp` … Die
 * Vorlage „DIYBMS v4 - /ha" bildet genau das ab; der Platzhalter ist fuer die
 * Geraete da, die ihre Zellen als Liste ausliefern.
 *
 * DIE VIER SCHRITTE einer Zuordnung, in dieser Reihenfolge:
 *   1. collect()   - hol ALLE Rohwerte am (platzhalter-faehigen) Wertepfad
 *   2. convert()   - je Rohwert (aus mqtt-mapping): Sentinel = FEHLEND,
 *                    Wahrheitswert -> 0/1, dann scale/offset. Skaliert wird JE
 *                    PROBE, nicht erst am Ende - `min ueber alle Zellen in mV`
 *                    heisst genau das.
 *   3. aggregate() - min/max/sum/avg/count/last (aus mqtt-mapping)
 *   4. Der Kanal FEHLT, wenn nichts uebrig bleibt - nie eine erfundene 0.
 */
'use strict';

var map = require('./mqtt-mapping.js');

/** Der Platzhalter eines Wertepfads: „jedes Element / jeder Schluessel hier". */
var WILDCARD = '*';

/** Segmente, die in einem Wertepfad NIE vorkommen duerfen (Prototyp-Vergiftung). */
var FORBIDDEN_SEGMENTS = ['__proto__', 'constructor', 'prototype'];

/**
 * Die Anmelde-Arten, die dieser Lesetyp kennt.
 *
 * `header` ist der DIYBMS-/Home-Assistant-Fall (ein frei benannter Kopfzeilen-
 * Schluessel, typisch `ApiKey`), `bearer` das OAuth-uebliche
 * `Authorization: Bearer …`, `basic` das klassische HTTP-Basic. `none` ist die
 * Vorgabe, weil die meisten BMS im Heimnetz gar nichts verlangen.
 *
 * ⚠ Der ZWILLING dieser Liste lebt in `flowc/catalog.js` (HTTP_AUTH_MODES) und
 * in der Cloud (`UserDefinedBatteryDefinition.AUTH_MODES`). Wer eines aendert,
 * aendert alle drei - sonst nimmt der Compiler an, was die Box verwirft.
 */
var AUTH_MODES = ['none', 'header', 'bearer', 'basic'];

/** Hoechstens so viele Quell-WERTE je Zuordnung - die Schranke von MQTT. */
var MAX_SOURCES = map.MAX_SOURCES;

/** Wie lange die Box auf eine Antwort wartet, bevor sie „no_answer" sagt. */
var DEFAULT_TIMEOUT_MS = 5000;
var MIN_TIMEOUT_MS = 500;
var MAX_TIMEOUT_MS = 30000;

/** Wie viele Bytes einer Antwort ueberhaupt gelesen werden. */
var MAX_BODY_BYTES = 262144;

/**
 * Prueft einen Wertepfad. Ein LEERER Pfad heisst hier - anders als bei MQTT -
 * gar nichts: eine HTTP-Antwort ist ein Dokument, kein nackter Wert, und ein
 * leerer Pfad waere die Aufforderung, das ganze Dokument als Zahl zu lesen.
 */
function isValidPath(path) {
  if (typeof path !== 'string' || path === '' || path.length > 200) return false;
  var segments = path.split('.');
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (seg === WILDCARD) continue;
    if (FORBIDDEN_SEGMENTS.indexOf(seg) >= 0) return false;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(seg)) return false;
  }
  return true;
}

/**
 * Holt ALLE Rohwerte, die ein Wertepfad in einem geparsten Dokument trifft.
 *
 * Ohne Platzhalter ist das hoechstens einer (dann ist die Liste leer oder
 * einelementig - `last` und `min` liefern dasselbe). Mit `*` sind es so viele,
 * wie die Liste bzw. das Objekt an dieser Stelle hat.
 *
 * ⚠ Ein Zwischenknoten, der kein Objekt ist, beendet diesen Zweig - er wird
 * NICHT als 0 gelesen. Und die Schranke MAX_SOURCES gilt wie bei MQTT: sie
 * schweigt nicht, sie wird dem Aufrufer als `overflow` gemeldet.
 *
 * @param {*} doc das geparste JSON-Dokument
 * @param {string} path punkt-getrennter Wertepfad, `*` = jede Ebene hier
 * @returns {{values: Array, overflow: boolean}}
 */
function collect(doc, path) {
  var out = [];
  var overflow = false;
  if (!isValidPath(path)) return { values: out, overflow: false };
  var segments = path.split('.');

  function walk(node, depth) {
    if (overflow) return;
    if (depth === segments.length) {
      if (out.length >= MAX_SOURCES) {
        overflow = true;
        return;
      }
      out.push(node);
      return;
    }
    if (node === null || node === undefined || typeof node !== 'object') return;
    var key = segments[depth];
    if (key === WILDCARD) {
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) walk(node[keys[k]], depth + 1);
      return;
    }
    if (Array.isArray(node)) {
      // Ein Zahl-Segment ist ein Listen-Index (`cells.0.v`) - dieselbe Regel
      // wie in mqtt-mapping.extract.
      if (!/^[0-9]+$/.test(key)) return;
      var idx = Number(key);
      if (idx < 0 || idx >= node.length) return;
      walk(node[idx], depth + 1);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(node, key)) return;
    walk(node[key], depth + 1);
  }

  walk(doc, 0);
  return { values: out, overflow: overflow };
}

/**
 * Die Kanal-Nutzlast EINER Antwort: aus dem Dokument werden die Kanaele, die
 * wirklich einen Wert haben.
 *
 * @param {*} doc das geparste JSON-Dokument
 * @param {Array} mappings normalisierte Zuordnungen (channel, path, aggregate, …)
 * @param {number} now Millisekunden - uebergeben, nie gelesen: die Rechnung hat
 *     keine Uhr. Alle Proben EINER Antwort sind gleich alt, deshalb gibt es
 *     hier kein `stale_s`: eine HTTP-Zuordnung traegt gar keines. Was die
 *     jetzige Antwort nicht liefert, FEHLT - eine vorige Antwort wird nie noch
 *     einmal veroeffentlicht, denn sie waere ein Messwert von damals mit dem
 *     Zeitstempel von jetzt.
 * @returns {{channels: Object, overflow: boolean}}
 */
function decode(doc, mappings, now) {
  var channels = {};
  var overflow = false;
  var list = Array.isArray(mappings) ? mappings : [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (!m || typeof m.channel !== 'string') continue;
    var found = collect(doc, m.path);
    if (found.overflow) overflow = true;
    var samples = [];
    for (var j = 0; j < found.values.length; j++) {
      var value = map.convert(found.values[j], m);
      // null heisst FEHLEND: ein Sentinel, ein Wort ausserhalb des
      // Vokabulars, ein unlesbarer Wert. Es verschwindet, es wird nie 0.
      if (value === null) continue;
      samples.push({ value: value, at: now });
    }
    // staleMs = 0: innerhalb EINER Antwort gibt es keine alten Proben.
    var result = map.aggregate(samples, m.aggregate, now, 0);
    if (result === null) continue;
    channels[m.channel] = m.value_type === 'bool' ? (result ? 1 : 0)
      : Math.round(result * 1e6) / 1e6;
  }
  return { channels: channels, overflow: overflow };
}

/**
 * Die VOLLE Adresse, die abgefragt wird.
 *
 * Der Pfad reist ausgeschrieben aus der Cloud (inklusive einer etwaigen
 * Abfrage-Zeichenkette) - die Box haengt nichts an und raet nichts dazu.
 */
function url(endpoint) {
  var e = endpoint || {};
  var scheme = e.tls ? 'https' : 'http';
  var host = String(e.host || '');
  var port = Number(e.port);
  var defaultPort = e.tls ? 443 : 80;
  var portPart = !isFinite(port) || port === defaultPort ? '' : ':' + port;
  var path = String(e.path || '/');
  if (path.charAt(0) !== '/') path = '/' + path;
  return scheme + '://' + host + portPart + path;
}

/**
 * Die Kopfzeilen EINER Abfrage - der einzige Ort, an dem das Geheimnis
 * ueberhaupt vorkommt.
 *
 * ⚠ Das Geheimnis steht NICHT im Flow-Dokument: der Flow nennt nur die
 * Anmelde-ART und - bei `header` - den Namen der Kopfzeile. Der WERT kommt aus
 * der per-Geraet ausgerollten Entitaets-Konfiguration
 * (`edge/entities/<id>/config`, `driver.connection.auth_secret`), also aus dem
 * Kanal, ueber den jedes andere Geraete-Kennwort dieser Box auch kommt. Der
 * Grund ist konkret: das Flow-Dokument ist ueber
 * `GET /sites/{siteId}/flows/{flowId}/versions/{v}` fuer JEDEN Portal-Benutzer
 * des Mandanten lesbar - ein Kennwort darin waere ein Kennwort im Browser.
 *
 * Fehlt das Geheimnis, entstehen KEINE Kopfzeilen und der Aufrufer fragt gar
 * nicht erst ab: eine Abfrage ohne Anmeldung waere ein 401, den man als
 * „Geraet antwortet nicht" missverstehen koennte.
 *
 * @returns {Object|null} die Kopfzeilen, oder null wenn das Geheimnis fehlt
 */
function authHeaders(auth, secret) {
  var a = auth || {};
  var mode = AUTH_MODES.indexOf(a.mode) >= 0 ? a.mode : 'none';
  if (mode === 'none') return {};
  var value = secret === null || secret === undefined ? '' : String(secret);
  if (value === '') return null;
  if (mode === 'header') {
    var name = String(a.header || '').trim();
    if (name === '') return null;
    var headers = {};
    headers[name] = value;
    return headers;
  }
  if (mode === 'bearer') {
    return { Authorization: 'Bearer ' + value };
  }
  // basic: der Benutzername reist im Flow (er ist kein Geheimnis), das
  // Kennwort kommt aus der Entitaets-Konfiguration.
  var user = String(a.username || '');
  return {
    Authorization: 'Basic ' + Buffer.from(user + ':' + value, 'utf8').toString('base64'),
  };
}

/** Braucht diese Anmelde-Art ueberhaupt ein Geheimnis? */
function needsSecret(auth) {
  var mode = auth && AUTH_MODES.indexOf(auth.mode) >= 0 ? auth.mode : 'none';
  return mode !== 'none';
}

module.exports = {
  AUTH_MODES: AUTH_MODES,
  WILDCARD: WILDCARD,
  MAX_SOURCES: MAX_SOURCES,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS: MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS: MAX_TIMEOUT_MS,
  isValidPath: isValidPath,
  collect: collect,
  decode: decode,
  url: url,
  authHeaders: authHeaders,
  needsSecret: needsSecret,
};
