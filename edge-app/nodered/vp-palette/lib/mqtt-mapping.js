/**
 * mqtt-mapping.js - die reine RECHNUNG der Feld-Zuordnung eines selbst
 * angebundenen Batterie-Anschlusses (P5 Ebene 1, Konzept
 * vp-deye-diybms-luecke-l5 §3.2b).
 *
 * Sie liegt aus demselben Grund in einer eigenen Datei wie
 * `lib/reactive-eval.js`: was aus einer MQTT-Nachricht ein Messwert wird, ist
 * eine Aussage ueber EHRLICHKEIT (fehlend ist nie 0, ein Sentinel ist nie ein
 * Wert, ein alter Wert ist nie ein frischer) - und die muss ohne Broker, ohne
 * Node-RED und ohne Uhr vollstaendig pruefbar sein.
 *
 * DIE VIER SCHRITTE einer Zuordnung, in dieser Reihenfolge:
 *   1. topicMatches()  - passt die eingetroffene Nachricht auf den Filter?
 *   2. extract()       - hol den Rohwert am Wertepfad aus dem JSON (oder die
 *                        nackte Zahl, wenn die Nachricht selbst der Wert ist)
 *   3. convert()       - Wahrheitswert -> 0/1 bzw. Zahl; Sentinel = FEHLEND;
 *                        dann scale/offset. Skaliert wird JE PROBE, nicht erst
 *                        am Ende: `min ueber alle Zellen in mV` heisst genau
 *                        das - jede Zelle wird nach mV gebracht, dann verglichen.
 *   4. aggregate()     - min/max/sum/avg/count/last ueber die FRISCHEN Proben
 *                        aller passenden Topics.
 *
 * Der Kundenfall, an dem die Form haengt (Ground Truth 09.09.2026): das DIYBMS
 * eines 176s-Packs veroeffentlicht `emon/diybms/<bank>/<cell>` mit `.voltage`
 * je Zelle. EIN Filter `emon/diybms/+/+`, Pfad `voltage`, Skalierung 1000, und
 * zwei Zuordnungen (`min` -> cell_min_mv, `max` -> cell_max_mv) machen daraus
 * genau die zwei Kanaele, aus denen P5b spaeter den Ladestand ableitet.
 */
'use strict';

/** Die Aggregate, die eine Zuordnung kennt. */
var AGGREGATES = ['last', 'min', 'max', 'sum', 'avg', 'count'];

/** Was eine Zuordnung liefern kann - `bool` reist als 0/1 (Telemetrie-Vertrag). */
var VALUE_TYPES = ['number', 'bool'];

/** Wortlisten fuer `bool`, wenn die Quelle Text statt 0/1 schickt. */
var TRUE_WORDS = ['1', 'true', 'on', 'yes', 'ja', 'ok', 'allowed', 'enabled'];
var FALSE_WORDS = ['0', 'false', 'off', 'no', 'nein', 'blocked', 'disabled'];

/**
 * Hoechstens so viele QUELLEN (konkrete Topics) je Zuordnung. Ein `#`-Filter
 * auf einem belebten Broker waere sonst ein unbegrenzt wachsender Speicher -
 * 176 Zellen sind der reale Fall, 512 ist reichlich Luft und trotzdem eine
 * Schranke.
 */
var MAX_SOURCES = 512;

/** Segmente, die in einem Wertepfad NIE vorkommen duerfen (Prototyp-Vergiftung). */
var FORBIDDEN_SEGMENTS = ['__proto__', 'constructor', 'prototype'];

/**
 * Passt ein konkretes Topic auf einen MQTT-Filter (`+` = ein Segment, `#` =
 * der Rest)? Bewusst hier und nicht aus einem Paket: es sind zwoelf Zeilen,
 * und der Filter entscheidet, WELCHE Nachricht ein Messwert wird.
 */
function topicMatches(filter, topic) {
  if (typeof filter !== 'string' || typeof topic !== 'string') return false;
  var f = filter.split('/');
  var t = topic.split('/');
  for (var i = 0; i < f.length; i++) {
    if (f[i] === '#') {
      // `#` deckt den Rest ab - aber nur, wenn es das letzte Segment ist, und
      // es deckt auch das leere Ende ab (mqtt-3.1.1 §4.7.1.2).
      return i === f.length - 1;
    }
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/**
 * Holt den Rohwert am Wertepfad aus einer Nachricht.
 *
 * Ein LEERER Pfad heisst „die Nachricht IST der Wert" - der haeufigste
 * MQTT-Fall (ein Topic, eine nackte Zahl). Sonst wird der punkt-getrennte Pfad
 * gegangen; ein Listen-Index ist einfach ein Zahl-Segment (`cells.0.v`).
 *
 * @param {string|Buffer} raw die Nutzlast
 * @param {string} path punkt-getrennter Wertepfad, oder '' fuer die Nutzlast selbst
 * @returns {*} der Rohwert, oder undefined wenn der Pfad ins Leere geht
 */
function extract(raw, path) {
  var text = raw === null || raw === undefined ? '' : String(raw);
  var p = typeof path === 'string' ? path.trim() : '';
  if (p === '') {
    // Eine nackte Nutzlast darf trotzdem JSON sein (`{"v":1}` ohne Pfad ist
    // ein Konfigurationsfehler, kein Wert) - hier zaehlt nur der Skalar.
    var n = Number(text);
    if (text !== '' && isFinite(n)) return n;
    return text === '' ? undefined : text;
  }
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return undefined;
  }
  var cur = obj;
  var segments = p.split('.');
  for (var i = 0; i < segments.length; i++) {
    var key = segments[i];
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (FORBIDDEN_SEGMENTS.indexOf(key) >= 0) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Macht aus einem Rohwert die Zahl, die der Kanal traegt - oder null.
 *
 * null heisst FEHLEND und nie 0: ein unlesbarer Wert, ein Sentinel („keine
 * Messung"), ein Wort ausserhalb der Wahrheitswert-Liste. Nichts davon wird
 * geraten, alles davon verschwindet einfach aus der Telemetrie.
 */
function convert(rawValue, mapping) {
  if (rawValue === undefined || rawValue === null) return null;
  var m = mapping || {};
  var value;
  if (m.value_type === 'bool') {
    value = toBool(rawValue, m);
    if (value === null) return null;
    // Ein Wahrheitswert kennt keine Skalierung: 0/1 IST die Aussage.
    return value ? 1 : 0;
  }
  if (typeof rawValue === 'boolean') {
    // Eine Quelle, die `true` statt 1 schickt, obwohl eine Zahl erwartet wird:
    // das ist eine Zahl, keine Ablehnung.
    value = rawValue ? 1 : 0;
  } else {
    value = Number(rawValue);
  }
  if (!isFinite(value)) return null;
  if (m.sentinel !== undefined && m.sentinel !== null && value === Number(m.sentinel)) {
    return null; // „nicht gemessen" - ausdruecklich benannt, nie geraten
  }
  var scale = isFinite(Number(m.scale)) && m.scale !== undefined && m.scale !== null
    ? Number(m.scale) : 1;
  var offset = isFinite(Number(m.offset)) && m.offset !== undefined && m.offset !== null
    ? Number(m.offset) : 0;
  var out = value * scale + offset;
  return isFinite(out) ? out : null;
}

function toBool(rawValue, m) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (typeof rawValue === 'number') {
    if (!isFinite(rawValue)) return null;
    return rawValue !== 0;
  }
  var word = String(rawValue).trim().toLowerCase();
  if (word === '') return null;
  var yes = Array.isArray(m.true_values) && m.true_values.length
    ? m.true_values.map(lower) : TRUE_WORDS;
  var no = Array.isArray(m.false_values) && m.false_values.length
    ? m.false_values.map(lower) : FALSE_WORDS;
  if (yes.indexOf(word) >= 0) return true;
  if (no.indexOf(word) >= 0) return false;
  return null; // ein Wort ausserhalb des Vokabulars wird VERWORFEN
}

function lower(v) {
  return String(v).trim().toLowerCase();
}

/**
 * Rechnet die frischen Proben einer Zuordnung zu EINEM Kanalwert zusammen.
 *
 * @param {Array<{value:number, at:number}>} samples je Quell-Topic die letzte Probe
 * @param {string} aggregate eines aus AGGREGATES
 * @param {number} now Millisekunden (uebergeben, nie gelesen - die Rechnung hat keine Uhr)
 * @param {number} staleMs wie lange eine Probe zaehlt
 * @returns {number|null} der Kanalwert, oder null wenn keine frische Probe da ist
 */
function aggregate(samples, aggregateKind, now, staleMs) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  var fresh = [];
  var newest = null;
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (!s || typeof s.value !== 'number' || !isFinite(s.value)) continue;
    if (staleMs > 0 && now - s.at > staleMs) continue;
    fresh.push(s);
    if (newest === null || s.at > newest.at) newest = s;
  }
  if (fresh.length === 0) return null;
  switch (aggregateKind) {
    case 'min': return fresh.reduce(function (a, s) { return Math.min(a, s.value); }, Infinity);
    case 'max': return fresh.reduce(function (a, s) { return Math.max(a, s.value); }, -Infinity);
    case 'sum': return fresh.reduce(function (a, s) { return a + s.value; }, 0);
    case 'avg': return fresh.reduce(function (a, s) { return a + s.value; }, 0) / fresh.length;
    case 'count': return fresh.length;
    default: return newest.value; // 'last'
  }
}

module.exports = {
  AGGREGATES: AGGREGATES,
  VALUE_TYPES: VALUE_TYPES,
  MAX_SOURCES: MAX_SOURCES,
  TRUE_WORDS: TRUE_WORDS,
  FALSE_WORDS: FALSE_WORDS,
  topicMatches: topicMatches,
  extract: extract,
  convert: convert,
  aggregate: aggregate,
};
