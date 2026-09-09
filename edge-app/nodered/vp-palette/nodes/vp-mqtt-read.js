/**
 * vp-mqtt-read - der GENERIERTE MQTT-Lese-Knoten des BMS-unabhaengigen
 * Batterie-Anschlusses (P5 Ebene 1, Katalogtyp vp.mqtt.read, Palette 0.10.0;
 * Konzept vp-deye-diybms-luecke-l5 §3.2b „Zwei-Ebenen-Architektur").
 *
 * WAS ER TUT: Er abonniert auf einem LOKALEN MQTT-Broker im Kundennetz die
 * Topics einer selbstgebauten Batterie (DIYBMS, Seplos, JK, ein ESP am Shunt)
 * und bildet ihre Felder ueber eine NUTZER-DEFINIERTE Zuordnung auf die
 * Standard-Batteriekanaele ab (soc_pct, voltage_v, current_a, power_kw,
 * cell_min_mv, cell_max_mv, temp_max_c, charge_allowed, discharge_allowed,
 * charge_limit_a, discharge_limit_a). Bei jedem Auslöser-Takt veroeffentlicht
 * er EINE Telemetrie-Nachricht auf edge/entities/<id>/telemetry - von dort
 * laeuft die bewiesene v2-Kette weiter (gepufferter Uplink -> telemetry_v2 ->
 * Rollups -> Historie). Es entsteht keine zweite Ingest-Mechanik.
 *
 * DER AGGREGAT-FALL ist der Grund fuer diesen Knoten: eine Zuordnung darf
 * VIELE Topics umfassen (`emon/diybms/+/+`, Feld `.voltage`) und daraus das
 * Minimum bzw. Maximum bilden - 176 Zellspannungen ergeben so genau zwei
 * Kanaele. Ein Knoten „ein Topic -> ein Kanal" haette diesen Kundenfall nicht
 * abgebildet.
 *
 * DISZIPLIN (dieselbe wie vp-modbus-read):
 *   - LAN-only, auf der BOX geprueft: ein ausgerollter Flow ist eine Anweisung
 *     von aussen, und wer eine Verbindung oeffnet, prueft ihr Ziel selbst.
 *   - Auslöser-getrieben veroeffentlichen: das Abo laeuft dauernd, gesendet
 *     wird im Takt des kompilierten Intervalls - sonst wuerden 176 Zellen den
 *     Uplink mit jeder Zellmeldung fluten.
 *   - NIE eine erfundene Zahl: ein Kanal ohne frische Probe fehlt in der
 *     Nachricht, statt als 0 zu erscheinen. Hat KEIN Kanal einen frischen
 *     Wert, wird gar nichts veroeffentlicht.
 *   - Nie still: jeder Fehlschlag setzt den Knoten-Status und warnt
 *     ratenbegrenzt (60 s) mit Broker und Grund.
 *
 * NUR-LESEND: dieser Knoten veroeffentlicht ausschliesslich auf dem lokalen
 * VoltPilot-Bus. Auf den KUNDEN-Broker schreibt er nie.
 *
 * BEWUSST NICHT in dieser Stufe: Broker-Anmeldedaten (ein Kennwort im
 * retained ausgerollten Flow-Dokument waere ein Klartext-Geheimnis - der
 * Geheimnis-Weg kommt mit dem HTTP-Lesetyp), die SoC-Ableitung aus einer
 * Spannungskennlinie (P5b) und der Schutz-/Strombegrenzungs-Baustein (P5c).
 */
'use strict';

const mqtt = require('mqtt');
const map = require('../lib/mqtt-mapping.js');
const privateHost = require('../lib/private-host');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const WARN_INTERVAL_MS = 60000;
const DEFAULT_STALE_S = 300;
const DEFAULT_PORT = 1883;
const BOOL_AGGREGATES = ['last', 'min', 'max'];

/**
 * envelope() ist fuer die Tests exportiert: die edge-entity-§3-Nutzlast, die
 * eine Lesung veroeffentlicht - GENAU die Form, die vp-entity-read.parse und
 * der Go-Kern konsumieren.
 */
function envelope(entity, channels, tsIso) {
  return JSON.stringify({
    schema_version: '1.0',
    entity_id: entity,
    ts: tsIso,
    channels: channels,
  });
}

/**
 * normalize() ist fuer die Tests exportiert: aus der ausgerollten
 * Zuordnungs-Liste wird die Form, mit der der Knoten arbeitet. Eine
 * unbrauchbare Zeile wird VERWORFEN statt mit Vorgaben aufgefuellt - die Cloud
 * hat sie bereits geprueft, und was hier trotzdem kaputt ankommt, ist kein
 * Kanal, den man raten sollte.
 */
function normalize(raw) {
  const out = [];
  const seen = {};
  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    const channel = String(m.channel || '');
    const topic = String(m.topic || '');
    if (!CHANNEL_RE.test(channel) || topic === '' || topic.length > 200) continue;
    if (Object.prototype.hasOwnProperty.call(seen, channel)) continue;
    seen[channel] = true;
    const staleS = Number(m.stale_s);
    out.push({
      channel: channel,
      topic: topic,
      path: typeof m.path === 'string' ? m.path : '',
      // Ein Wahrheitswert kennt nur last/min/max (min = konservatives UND,
      // max = ODER). Die Cloud lehnt alles andere ab; kommt es trotzdem an,
      // faellt es auf `last` statt eine Freigabe zu MITTELN.
      aggregate: aggregateFor(m),
      value_type: m.value_type === 'bool' ? 'bool' : 'number',
      scale: isFinite(Number(m.scale)) ? Number(m.scale) : 1,
      offset: isFinite(Number(m.offset)) ? Number(m.offset) : 0,
      sentinel: m.sentinel === undefined || m.sentinel === null || !isFinite(Number(m.sentinel))
        ? null : Number(m.sentinel),
      true_values: Array.isArray(m.true_values) ? m.true_values : null,
      false_values: Array.isArray(m.false_values) ? m.false_values : null,
      staleMs: (isFinite(staleS) && staleS > 0 ? staleS : DEFAULT_STALE_S) * 1000,
      sources: new Map(),
      overflow: false,
    });
  }
  return out;
}

/**
 * ingest() ist fuer die Tests exportiert: eine eingetroffene Nachricht in die
 * Proben-Puffer aller passenden Zuordnungen legen.
 *
 * @returns {number} wie viele Zuordnungen die Nachricht angenommen haben
 */
function ingest(mappings, topic, payload, now) {
  let hits = 0;
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    if (!map.topicMatches(m.topic, topic)) continue;
    const value = map.convert(map.extract(payload, m.path), m);
    if (value === null) continue;
    if (!m.sources.has(topic) && m.sources.size >= map.MAX_SOURCES) {
      // Die Schranke schweigt nicht: der Knoten meldet sie, statt still die
      // 513. Zelle zu verlieren.
      m.overflow = true;
      continue;
    }
    m.sources.set(topic, { value: value, at: now });
    hits++;
  }
  return hits;
}

/**
 * collect() ist fuer die Tests exportiert: die Kanal-Nutzlast EINES Taktes.
 * Ein Kanal ohne frische Probe FEHLT - er wird nie als 0 erfunden.
 */
function collect(mappings, now) {
  const channels = {};
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const value = map.aggregate(Array.from(m.sources.values()), m.aggregate, now, m.staleMs);
    if (value === null) continue;
    // Ein Wahrheitswert bleibt 0/1, eine Zahl wird auf 6 Nachkommastellen
    // gerundet: Gleitkomma-Rauschen (3.5930000000000004) waere ein Wert, den
    // das Geraet nie gemeldet hat.
    channels[m.channel] = m.value_type === 'bool' ? (value ? 1 : 0)
      : Math.round(value * 1e6) / 1e6;
  }
  return channels;
}

module.exports = function (RED) {
  function VpMqttReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    const host = String(config.host || '');
    const port = boundedInt(config.port, 1, 65535, DEFAULT_PORT);
    const entity = String(config.entity || '');
    const mappings = normalize(config.mappings);
    const label = host + ':' + port;

    if (!ID_RE.test(entity) || mappings.length === 0 || !host) {
      node.status({ fill: 'red', shape: 'ring', text: 'Konfiguration ungültig' });
      return;
    }
    // ⚠ LAN-only, auf der BOX geprueft - der Zwilling der Cloud-Regel
    // (UserDefinedBatteryDefinition.isPrivateHost / probe.IsPrivateHost). Der
    // Knoten abonniert dann GAR NICHTS und sagt laut warum.
    if (!privateHost.isPrivateHost(host)) {
      node.status({ fill: 'red', shape: 'ring', text: privateHost.REFUSAL });
      node.warn('vp-mqtt-read: ' + host + ' liegt nicht nachweisbar im Heimnetz - '
        + 'es wird nichts gelesen.');
      return;
    }
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }

    let lastWarn = 0;
    let received = 0;
    const warnLimited = (text) => {
      const now = Date.now();
      if (now - lastWarn >= WARN_INTERVAL_MS) {
        lastWarn = now;
        node.warn('MQTT-Lesen ' + label + ': ' + text);
      }
    };

    // Ein Abo je DISTINKTEM Filter: zwei Zuordnungen auf `emon/diybms/+/+`
    // (min und max) sind EIN Abo, nicht zwei - der Broker bekommt keine
    // doppelte Last, und die Nachricht wird lokal an beide verteilt.
    const filters = [];
    for (const m of mappings) {
      if (filters.indexOf(m.topic) < 0) filters.push(m.topic);
    }

    const client = mqtt.connect('mqtt://' + host + ':' + port, {
      clientId: 'vp-mqtt-read-' + Math.random().toString(16).slice(2, 10),
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      // Der Kunden-Broker ist nicht unserer: eine saubere Sitzung hinterlaesst
      // dort keinen wachsenden Zustand.
      clean: true,
    });
    client.setMaxListeners(0);

    const subscribe = () => {
      client.subscribe(filters, { qos: 0 }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
          warnLimited('Abo fehlgeschlagen: ' + err.message);
        } else {
          node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Daten' });
        }
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('error', (err) => {
      node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 64) });
      warnLimited(String(err.message));
    });
    client.on('message', (topic, buf) => {
      if (ingest(mappings, topic, buf, Date.now()) > 0) received++;
    });

    // Der Auslöser-Takt ist der EINZIGE Sendezeitpunkt (die vp-modbus-read-
    // Disziplin): das Abo fuellt den Puffer, der Takt veroeffentlicht.
    node.on('input', function (msg, send, done) {
      const now = Date.now();
      const channels = collect(mappings, now);
      const names = Object.keys(channels);
      const overflow = mappings.some((m) => m.overflow);
      if (names.length === 0) {
        // Ehrlich statt still: der Status sagt, ob ueberhaupt etwas ankam.
        node.status({ fill: 'yellow', shape: 'ring',
          text: received === 0 ? 'keine Nachricht empfangen' : 'keine frischen Werte' });
        if (received === 0) warnLimited('kein Topic hat bisher geantwortet');
        done();
        return;
      }
      if (core.client) {
        core.client.publish('edge/entities/' + entity + '/telemetry',
          envelope(entity, channels, new Date(now).toISOString()), { qos: 1 });
      }
      node.status({ fill: overflow ? 'yellow' : 'green', shape: 'dot',
        text: overflow ? names.length + ' Kanäle · zu viele Quellen'
          : names.length + ' Kanäle' });
      if (overflow) {
        warnLimited('mehr als ' + map.MAX_SOURCES + ' Quell-Topics je Zuordnung - '
          + 'die weiteren werden nicht gelesen. Bitte den Topic-Filter enger fassen.');
      }
      send({ payload: channels, topic: entity });
      done();
    });

    node.on('close', function (done) {
      client.end(true, {}, done);
    });
  }

  RED.nodes.registerType('vp-mqtt-read', VpMqttReadNode);
};

// aggregateFor() is exported for unit tests: the aggregate a mapping really
// gets, with the boolean restriction applied.
function aggregateFor(m) {
  const wanted = m && m.aggregate;
  if (map.AGGREGATES.indexOf(wanted) < 0) return 'last';
  if (m.value_type === 'bool' && BOOL_AGGREGATES.indexOf(wanted) < 0) return 'last';
  return wanted;
}

function boundedInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n < min || n > max) return fallback;
  return n;
}

module.exports.envelope = envelope;
module.exports.normalize = normalize;
module.exports.ingest = ingest;
module.exports.collect = collect;
module.exports.DEFAULT_STALE_S = DEFAULT_STALE_S;
module.exports.aggregateFor = aggregateFor;
