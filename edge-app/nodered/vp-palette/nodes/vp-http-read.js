/**
 * vp-http-read - der GENERIERTE HTTP/JSON-Lese-Knoten des BMS-unabhaengigen
 * Batterie-Anschlusses (P5 Ebene 1 „HTTP/JSON", Katalogtyp vp.http.read,
 * Palette 0.12.0; Konzept vp-deye-diybms-luecke-l5 §3.2b).
 *
 * WAS ER TUT: Er fragt im Takt EINE JSON-Auskunft im Kundennetz ab
 * (`GET http://<host>:<port><pfad>`) und bildet ihre Felder ueber eine
 * NUTZER-DEFINIERTE Zuordnung auf DIESELBEN Standard-Batteriekanaele ab wie
 * sein MQTT-Zwilling (soc_pct, voltage_v, current_a, power_kw, cell_min_mv,
 * cell_max_mv, temp_max_c, charge_allowed, discharge_allowed, charge_limit_a,
 * discharge_limit_a). Er veroeffentlicht auf edge/entities/<id>/telemetry - von
 * dort laeuft die bewiesene v2-Kette weiter (gepufferter Uplink -> telemetry_v2
 * -> Rollups -> Historie). Es entsteht keine zweite Ingest-Mechanik, und der
 * SoC-Ableiter (P5b) haengt an SEINER Kante wie an der des MQTT-Knotens.
 *
 * DER VORLAGEN-FALL: DIYBMS v4 beantwortet `GET /ha` mit dem Kopfzeilen-
 * Schluessel `ApiKey: <secret>` und einem flachen Dokument (soc, v, c, pwr,
 * lowcellv, highcellv, …). Ein Geraet, das seine Zellen als LISTE ausliefert,
 * wird mit einem Platzhalter-Wertepfad (`cells.*.v`) und `min`/`max` genauso
 * auf zwei Kanaele gebracht wie die 176 Topics des MQTT-Falls.
 *
 * DISZIPLIN (dieselbe wie vp-mqtt-read / vp-modbus-read):
 *   - LAN-only, auf der BOX geprueft: ein ausgerollter Flow ist eine Anweisung
 *     von aussen, und wer eine Verbindung oeffnet, prueft ihr Ziel selbst.
 *   - EIN Flug je HOST: laeuft eine Abfrage noch, wird der naechste Takt
 *     UEBERSPRUNGEN statt eine zweite daneben zu stellen. Ein BMS mit einem
 *     einzigen Web-Server im Wohnzimmer haelt keine Warteschlange aus, und
 *     zwei ueberlappende Abfragen haetten aus einem langsamen Geraet ein
 *     unerreichbares gemacht. Die Regel gilt UEBER Knoten hinweg (Modul-Ebene),
 *     weil zwei Anschluesse auf demselben Host dasselbe Geraet sind.
 *   - NIE eine erfundene Zahl: ein Kanal, den die Antwort nicht hergibt, FEHLT.
 *     Ein Fehlschlag veroeffentlicht GAR NICHTS - eine vorige Antwort noch
 *     einmal zu senden waere ein Messwert von damals mit dem Zeitstempel von
 *     jetzt.
 *   - Nie still: jeder Fehlschlag setzt den Knoten-Status und warnt
 *     ratenbegrenzt (60 s) mit Ziel und benannter Fehlerklasse - dasselbe
 *     Vokabular wie „Verbindung testen" (unreachable / no_answer /
 *     invalid_response).
 *
 * NUR-LESEND: dieser Knoten schickt ausschliesslich GET. Auf das Geraet des
 * Kunden schreibt er nie.
 *
 * ⚠ DAS GEHEIMNIS STEHT NICHT IM FLOW. Das Flow-Dokument nennt nur die
 * Anmelde-ART (und bei `header` den Namen der Kopfzeile); der WERT kommt aus
 * der per-Geraet ausgerollten Entitaets-Konfiguration
 * (`edge/entities/<id>/config` -> `driver.connection.auth_secret`) - der Kanal,
 * ueber den jedes andere Geraete-Kennwort dieser Box auch kommt. Der Grund ist
 * konkret: ein Flow-Dokument ist ueber die Portal-API fuer jeden Benutzer des
 * Mandanten lesbar, ein Kennwort darin waere ein Kennwort im Browser. Solange
 * das Geheimnis noch nicht angekommen ist, wird NICHT abgefragt - eine Abfrage
 * ohne Anmeldung waere ein 401, den man fuer „Geraet antwortet nicht" halten
 * koennte.
 */
'use strict';
const sourceStatus = require('../../measurements/data-source-status');

const http = require('http');
const https = require('https');
const map = require('../lib/http-mapping.js');
const mqttMap = require('../lib/mqtt-mapping.js');
const privateHost = require('../lib/private-host');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const WARN_INTERVAL_MS = 60000;
const BOOL_AGGREGATES = ['last', 'min', 'max'];

/** Die Fehlerklassen - woertlich das testconn-Vokabular (test-read.js). */
const ERR_UNREACHABLE = 'unreachable';
const ERR_NO_ANSWER = 'no_answer';
const ERR_INVALID_RESPONSE = 'invalid_response';

/** Der deutsche Satz je Klasse - EINE Kopie, damit keine Flaeche raet. */
const ERROR_TEXT = {
  unreachable: 'nicht erreichbar',
  no_answer: 'keine Antwort',
  invalid_response: 'unerwartete Antwort',
};

/**
 * Die EIN-FLUG-Sperre je Host, auf Modul-Ebene: zwei Knoten auf demselben
 * Geraet sind dasselbe Geraet. Der Schluessel ist host:port - nicht die
 * Entitaet, denn die Ruecksicht gilt dem Web-Server, nicht der Batterie.
 */
const inFlight = new Set();

/**
 * envelope() ist fuer die Tests exportiert: die edge-entity-§3-Nutzlast einer
 * Lesung - GENAU die Form, die vp-entity-read.parse und der Go-Kern
 * konsumieren (und dieselbe wie bei vp-mqtt-read).
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
 * Zuordnungs-Liste wird die Form, mit der der Knoten rechnet. Eine unbrauchbare
 * Zeile wird VERWORFEN statt mit Vorgaben aufgefuellt - die Cloud hat sie
 * bereits geprueft, und was hier trotzdem kaputt ankommt, ist kein Kanal, den
 * man raten sollte.
 */
function normalize(raw) {
  const out = [];
  const seen = {};
  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    const channel = String(m.channel || '');
    const path = typeof m.path === 'string' ? m.path : '';
    if (!CHANNEL_RE.test(channel) || !map.isValidPath(path)) continue;
    if (Object.prototype.hasOwnProperty.call(seen, channel)) continue;
    seen[channel] = true;
    out.push({
      channel: channel,
      path: path,
      aggregate: aggregateFor(m),
      value_type: m.value_type === 'bool' ? 'bool' : 'number',
      scale: isFinite(Number(m.scale)) ? Number(m.scale) : 1,
      offset: isFinite(Number(m.offset)) ? Number(m.offset) : 0,
      sentinel: m.sentinel === undefined || m.sentinel === null || !isFinite(Number(m.sentinel))
        ? null : Number(m.sentinel),
      true_values: Array.isArray(m.true_values) ? m.true_values : null,
      false_values: Array.isArray(m.false_values) ? m.false_values : null,
    });
  }
  return out;
}

/**
 * classify() ist fuer die Tests exportiert: aus einem Node-Fehler wird die
 * benannte Klasse. Ein Zeitablauf ist „keine Antwort" (das Geraet ist da, es
 * schweigt nur), alles andere auf der Verbindungsebene ist „nicht erreichbar".
 */
function classify(err) {
  const code = err && err.code ? String(err.code) : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return ERR_NO_ANSWER;
  return ERR_UNREACHABLE;
}

/**
 * fetchJson() ist fuer die Tests exportiert: EIN GET, hoechstens MAX_BODY_BYTES
 * gelesen, und jeder Ausgang benannt.
 *
 * @param {Object} deps { http, https } - injizierbar, damit der Test ohne
 *     Node-RED gegen einen echten Server im Prozess laufen kann.
 * @returns {Promise<{ok:boolean, doc?:*, error_code?:string, status?:number}>}
 */
function fetchJson(deps, target, headers, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    const lib = target.indexOf('https:') === 0 ? deps.https : deps.http;
    const opts = { method: 'GET', timeout: timeoutMs, headers: headers || {} };
    let req;
    try {
      req = lib.request(target, opts, (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          // Ein 401/403 ist eine ANTWORT, kein Schweigen: die Anmeldung wurde
          // abgelehnt, und das ist eine Aussage ueber die Zugangsdaten.
          done({ ok: false, error_code: ERR_INVALID_RESPONSE, status: res.statusCode });
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > map.MAX_BODY_BYTES) {
            try {
              req.destroy();
            } catch (e) { /* ignore */ }
            done({ ok: false, error_code: ERR_INVALID_RESPONSE });
          }
        });
        res.on('end', () => {
          let doc;
          try {
            doc = JSON.parse(body);
          } catch (e) {
            return done({ ok: false, error_code: ERR_INVALID_RESPONSE });
          }
          if (doc === null || typeof doc !== 'object') {
            return done({ ok: false, error_code: ERR_INVALID_RESPONSE });
          }
          return done({ ok: true, doc: doc, status: res.statusCode });
        });
      });
    } catch (e) {
      return done({ ok: false, error_code: ERR_UNREACHABLE });
    }
    req.on('error', (err) => done({ ok: false, error_code: classify(err) }));
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch (e) { /* ignore */ }
      done({ ok: false, error_code: ERR_NO_ANSWER });
    });
    req.end();
    return undefined;
  });
}

/**
 * secretFrom() ist fuer die Tests exportiert: das Geheimnis aus einer
 * retained Entitaets-Konfiguration.
 *
 * Sie liest genau EINEN Ort - `driver.connection.auth_secret` der
 * edge-entity-§3-Konfiguration - und prueft die Identitaet: eine
 * Konfiguration, die eine ANDERE Entitaet nennt, wird verworfen statt ihr
 * Kennwort zu benutzen (dieselbe Identitaetsregel wie vp-entity-read.parse).
 */
function secretFrom(entity, buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  if (obj.entity_id !== entity) return null;
  const driver = obj.driver && typeof obj.driver === 'object' ? obj.driver : null;
  const conn = driver && driver.connection && typeof driver.connection === 'object'
    ? driver.connection : null;
  if (!conn) return null;
  const secret = conn.auth_secret;
  return typeof secret === 'string' && secret !== '' ? secret : null;
}

module.exports = function (RED) {
  function VpHttpReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    const entity = String(config.entity || '');
    const report = (failed, errorClass) => {
      if (!core || !core.client) return;
      const evidence=sourceStatus.event({entity_id:entity,requests:1,failed,error_class:errorClass});
      if(evidence) core.client.publish(sourceStatus.TOPIC,JSON.stringify(evidence),{qos:1,retain:false});
    };
    const endpoint = {
      host: String(config.host || ''),
      port: boundedInt(config.port, 1, 65535, config.tls ? 443 : 80),
      path: String(config.path || '/'),
      tls: !!config.tls,
    };
    const auth = config.auth && typeof config.auth === 'object' ? config.auth : { mode: 'none' };
    const mappings = normalize(config.mappings);
    const timeoutMs = boundedInt(config.timeout_ms, map.MIN_TIMEOUT_MS, map.MAX_TIMEOUT_MS,
      map.DEFAULT_TIMEOUT_MS);
    const target = map.url(endpoint);
    const hostKey = endpoint.host + ':' + endpoint.port;

    if (!ID_RE.test(entity) || mappings.length === 0 || !endpoint.host) {
      node.status({ fill: 'red', shape: 'ring', text: 'Konfiguration ungültig' });
      return;
    }
    // ⚠ LAN-only, auf der BOX geprueft - der Zwilling der Cloud-Regel
    // (UserDefinedBatteryDefinition/SelfBuildDefinition.isPrivateHost und
    // probe.IsPrivateHost). Der Knoten fragt dann GAR NICHTS ab und sagt warum.
    if (!privateHost.isPrivateHost(endpoint.host)) {
      node.status({ fill: 'red', shape: 'ring', text: privateHost.REFUSAL });
      node.warn('vp-http-read: ' + endpoint.host + ' liegt nicht nachweisbar im Heimnetz - '
        + 'es wird nichts gelesen.');
      return;
    }
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }

    let lastWarn = 0;
    const warnLimited = (text) => {
      const now = Date.now();
      if (now - lastWarn >= WARN_INTERVAL_MS) {
        lastWarn = now;
        node.warn('HTTP-Lesen ' + target + ': ' + text);
      }
    };

    // Das Geheimnis kommt aus der retained Entitaets-Konfiguration - nie aus
    // dem Flow. Ohne Anmeldung wird gar nicht abonniert.
    let secret = null;
    const needsSecret = map.needsSecret(auth);
    if (needsSecret) {
      const configTopic = 'edge/entities/' + entity + '/config';
      const onConfig = (topic, buf) => {
        if (topic !== configTopic) return;
        const found = secretFrom(entity, buf);
        if (found !== null) secret = found;
      };
      const subscribe = () => {
        core.client.subscribe(configTopic, { qos: 1 }, (err) => {
          if (err) warnLimited('Zugangsdaten-Abo fehlgeschlagen: ' + err.message);
        });
      };
      core.client.on('message', onConfig);
      if (core.client.connected) subscribe();
      core.client.on('connect', subscribe);
      // Beide Zuhoerer wieder abmelden: der Kern-Client ueberlebt einen
      // Flow-Rollout, und ein zurueckgelassener Zuhoerer waere bei jedem
      // weiteren Ausrollen einer mehr auf demselben Client.
      node.on('close', () => {
        try {
          core.client.removeListener('message', onConfig);
          core.client.removeListener('connect', subscribe);
        } catch (e) { /* ignore */ }
      });
      node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Zugangsdaten' });
    } else {
      node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf den Takt' });
    }

    node.on('input', function (msg, send, done) {
      const headers = map.authHeaders(auth, secret);
      if (headers === null) {
        // Ehrlich statt still: die Anmeldung fehlt, das Geraet ist nicht
        // schuld, und eine Abfrage ohne Kopfzeile waere ein 401.
        node.status({ fill: 'yellow', shape: 'ring', text: 'Zugangsdaten fehlen' });
        warnLimited('die Zugangsdaten sind auf dieser Box noch nicht angekommen');
        done();
        return;
      }
      // EIN Flug je Host: der Takt wird UEBERSPRUNGEN, nicht gestapelt.
      if (inFlight.has(hostKey)) {
        node.status({ fill: 'blue', shape: 'ring', text: 'Abfrage läuft noch' });
        done();
        return;
      }
      inFlight.add(hostKey);
      fetchJson({ http: http, https: https }, target, headers, timeoutMs)
        .then((res) => {
          inFlight.delete(hostKey);
          if (!res.ok) {
            report(true,res.error_code);
            const text = ERROR_TEXT[res.error_code] || res.error_code;
            node.status({ fill: 'red', shape: 'ring',
              text: res.status ? text + ' (HTTP ' + res.status + ')' : text });
            warnLimited(res.status ? text + ' - HTTP ' + res.status : text);
            done();
            return;
          }
          const now = Date.now();
          const decoded = map.decode(res.doc, mappings, now);
          const names = Object.keys(decoded.channels);
          if (names.length === 0) {
            report(true,'invalid_response');
            node.status({ fill: 'yellow', shape: 'ring', text: 'keine Werte in der Antwort' });
            warnLimited('die Antwort enthielt keinen der zugeordneten Wertepfade');
            done();
            return;
          }
          report(false);
          if (core.client) {
            core.client.publish('edge/entities/' + entity + '/telemetry',
              envelope(entity, decoded.channels, new Date(now).toISOString()), { qos: 1 });
          }
          node.status({ fill: decoded.overflow ? 'yellow' : 'green', shape: 'dot',
            text: decoded.overflow ? names.length + ' Kanäle · zu viele Werte'
              : names.length + ' Kanäle' });
          if (decoded.overflow) {
            warnLimited('mehr als ' + map.MAX_SOURCES + ' Werte je Zuordnung - die weiteren '
              + 'werden nicht gelesen. Bitte den Wertepfad enger fassen.');
          }
          send({ payload: decoded.channels, topic: entity });
          done();
        })
        .catch((err) => {
          report(true,sourceStatus.errorClass(err));
          inFlight.delete(hostKey);
          node.status({ fill: 'red', shape: 'ring', text: String(err && err.message).slice(0, 64) });
          warnLimited(String(err && err.message));
          done();
        });
    });
  }

  RED.nodes.registerType('vp-http-read', VpHttpReadNode);
};

// aggregateFor() is exported for unit tests: the aggregate a mapping really
// gets, with the boolean restriction applied (the mqtt-read twin).
function aggregateFor(m) {
  const wanted = m && m.aggregate;
  if (mqttMap.AGGREGATES.indexOf(wanted) < 0) return 'last';
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
module.exports.classify = classify;
module.exports.fetchJson = fetchJson;
module.exports.secretFrom = secretFrom;
module.exports.aggregateFor = aggregateFor;
module.exports.ERROR_TEXT = ERROR_TEXT;
