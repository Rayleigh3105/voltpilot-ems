/**
 * vp-soc-derive - der GENERIERTE SoC-ABLEITUNGS-Knoten (P5b Ebene 2,
 * Katalogtyp vp.soc.derive, Palette 0.11.0; Konzept vp-deye-diybms-luecke-l5
 * §3.2b „Zwei-Ebenen-Architektur", Bauplan-Paket P5b).
 *
 * WAS ER TUT: Er nimmt die Standard-Batteriekanaele, die eine Ebene-1-Quelle
 * gerade geliefert hat (heute vp-mqtt-read, spaeter genauso ein HTTP-Lesetyp),
 * und LEITET DARAUS den Ladestand ab - direkt uebernommen, aus der
 * Spannungskennlinie gerechnet oder aus der Ladung gezaehlt. Das Ergebnis
 * veroeffentlicht er als GANZ NORMALE Telemetrie auf
 * edge/entities/<id>/telemetry: zwei Kanaele, `soc_pct` und `soc_source_code`.
 * Von dort laeuft die bewiesene v2-Kette weiter (gepufferter Uplink ->
 * telemetry_v2 -> Rollups -> Historie); es entsteht keine zweite Mechanik und
 * kein zweiter SoC-Begriff.
 *
 * WARUM EIN EIGENER KNOTEN und nicht ein Schalter in vp-mqtt-read: die
 * Rechnung haengt an den KANAELEN, nicht am Transport. Als eigener Baustein ist
 * sie fuer jede Ebene-1-Quelle wiederverwendbar (MQTT heute, HTTP spaeter), und
 * die Ebene 1 bleibt, was sie ist: Rohwerte holen und abbilden.
 *
 * DIE REIHENFOLGE IM FLOW ist deshalb: Takt -> vp-mqtt-read -> DIESER Knoten.
 * Der Auslöser trifft NUR die Quelle; dieser Knoten rechnet auf dem, was sie
 * gerade gesendet hat. Haenge er selbst am Takt, rechnete er auf dem Stand des
 * VORIGEN Taktes - und die Reihenfolge zweier gleichzeitig gefeuerter Knoten
 * ist nichts, worauf man einen Ladestand baut.
 *
 * DIE EHRLICHKEITSREGELN (§3.2b), Zeile fuer Zeile umgesetzt:
 *   - KEIN Ladestand ohne EINGANG: fehlt die Zellspannung (b) oder der Anker
 *     (c), wird NICHTS veroeffentlicht - nie eine Vorgabe, nie eine 50.
 *   - Ein EINGEFRORENER Wert bekommt NIE einen frischen Zeitstempel. Der
 *     Knoten veroeffentlicht ihn deshalb gar nicht erneut; er ZEIGT ihn samt
 *     Alter im Status, und die Telemetrie laesst ihn von selbst altern (jedes
 *     Frischefenster stromabwaerts sieht das richtige Alter).
 *   - Nach `hold_s` ist der eingefrorene Wert ABWESEND: der Knoten vergisst
 *     ihn, und die Ladungszaehlung braucht einen neuen Anker - was ein
 *     Speicher in einer unbeobachteten Stunde getan hat, weiss niemand.
 *   - Die HERKUNFT reist mit: `soc_source_code` steht in DERSELBEN Nachricht
 *     wie der Wert, also behaelt die Historie die damalige Quelle. Eine spaeter
 *     geaenderte Definition faelscht keine alte Zeile.
 *
 * ZUSTAND: die Ladungszaehlung ist die einzige Methode mit Gedaechtnis. Ihr
 * Stand liegt in der DAUERHAFTEN Kontextablage ('file', siehe
 * edge-app/nodered/settings.js) - ein Neustart der Box darf eine Zaehlung nicht
 * heimlich bei einem alten Wert fortsetzen und auch nicht stillschweigend
 * verlieren: beim Laden entscheidet dieselbe `hold_s`-Regel wie im Betrieb.
 *
 * NUR-LESEND: dieser Knoten schreibt auf kein Kundengeraet. Er veroeffentlicht
 * ausschliesslich auf dem lokalen VoltPilot-Bus.
 *
 * BEWUSST NICHT hier: der Schutz-/Strombegrenzungs-Baustein (SoC->Strom-Treppe,
 * Zellspannungs-Hysterese) - das ist P5c; und die Zuordnungs-/Kurven-Flaeche
 * im Portal - das ist P5d.
 */
'use strict';

const soc = require('../lib/soc-derivation.js');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WARN_INTERVAL_MS = 60000;

/**
 * envelope() ist fuer die Tests exportiert: die edge-entity-§3-Nutzlast, mit
 * der ein abgeleiteter Ladestand reist - dieselbe Form wie jede andere
 * Telemetrie, damit Cloud, Optimierer und Portal ihn wie einen gemessenen SoC
 * lesen (gekennzeichnet durch soc_source_code).
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
 * channelsFor() ist fuer die Tests exportiert: aus einem Ableitungs-Ergebnis
 * werden die ZWEI Kanaele einer Nachricht. Der Wert wird auf 6 Nachkommastellen
 * gerundet (Gleitkomma-Rauschen waere ein Wert, den niemand gerechnet hat), die
 * Herkunft reist als ganzzahliger Code.
 */
function channelsFor(result) {
  const out = {};
  out[soc.SOC_CHANNEL] = Math.round(result.soc_pct * 1e6) / 1e6;
  out[soc.SOURCE_CHANNEL] = result.code;
  return out;
}

/**
 * payloadChannels() ist fuer die Tests exportiert: welche Kanaele eine
 * eingetroffene Nachricht traegt. Erlaubt sind die Nutzlast der Ebene 1
 * (msg.payload = {kanal: zahl}) und die vollstaendige Telemetrie-Huelle
 * (msg.payload.channels) - beides kommt vor, je nachdem, wer vorne haengt.
 * Alles andere ist KEINE Kanalliste und wird verworfen, nie geraten.
 */
function payloadChannels(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const inner = payload.channels;
  const src = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : payload;
  const out = {};
  let count = 0;
  for (const key of Object.keys(src)) {
    const v = src[key];
    if (typeof v === 'number' && isFinite(v)) {
      out[key] = v;
      count++;
    }
  }
  return count > 0 ? out : null;
}

module.exports = function (RED) {
  function VpSocDeriveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    const entity = String(config.entity || '');
    const cfg = soc.normalize({
      method: config.method,
      prefer_direct: config.prefer_direct,
      inputs: config.inputs,
      params: config.params,
      hold_s: config.hold_s,
    });

    if (!ID_RE.test(entity) || cfg === null) {
      node.status({ fill: 'red', shape: 'ring', text: 'Konfiguration ungültig' });
      return;
    }
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }

    // Der Zustand der Ladungszaehlung ueberlebt einen Neustart - aber nur,
    // solange er nach derselben Regel gilt wie im Betrieb (siehe unten).
    const stateKey = 'vp_soc_' + entity;
    const store = node.context();
    let state = null;
    try {
      const stored = store.get(stateKey, 'file');
      if (stored && typeof stored.soc_pct === 'number' && typeof stored.at === 'number') {
        state = stored;
      }
    } catch (e) {
      // Eine unlesbare Ablage ist kein Grund, still einen Ladestand zu erfinden
      // - die Zaehlung faengt dann eben mit ihrem Anker neu an.
      node.warn('SoC-Zustand konnte nicht gelesen werden: ' + e.message);
    }
    const remember = (next) => {
      state = next;
      try {
        store.set(stateKey, next, 'file');
      } catch (e) {
        node.warn('SoC-Zustand konnte nicht gesichert werden: ' + e.message);
      }
    };

    let lastWarn = 0;
    const warnLimited = (text) => {
      const now = Date.now();
      if (now - lastWarn >= WARN_INTERVAL_MS) {
        lastWarn = now;
        node.warn('Ladestand ableiten: ' + text);
      }
    };

    // Der zuletzt WIRKLICH abgeleitete Wert - er wird eingefroren gezeigt,
    // aber nie erneut als frische Messung veroeffentlicht.
    let frozen = null;

    const showFrozen = (now, reason) => {
      if (frozen === null) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'kein Ladestand · ' + reason });
        return;
      }
      const ageS = Math.max(0, Math.round((now - frozen.at) / 1000));
      if (ageS > cfg.hold_s) {
        // Nach der Frist ist der Wert ABWESEND, nicht alt: er wird vergessen,
        // und mit ihm der Zaehl-Zustand.
        frozen = null;
        if (state !== null) remember(null);
        node.status({ fill: 'yellow', shape: 'ring', text: 'kein Ladestand · ' + reason });
        return;
      }
      node.status({
        fill: 'yellow',
        shape: 'ring',
        text: fmt(frozen.soc_pct) + ' % · eingefroren seit ' + fmtAge(ageS) + ' · ' + reason,
      });
    };

    node.on('input', function (msg, send, done) {
      const now = Date.now();
      const channels = payloadChannels(msg && msg.payload);
      if (channels === null) {
        showFrozen(now, 'keine Messwerte');
        done();
        return;
      }

      // Der Zustand gilt nur, solange die Luecke die Frist nicht reisst - beim
      // Laden nach einem Neustart genauso wie im Betrieb.
      let usable = state;
      if (usable !== null && (now - usable.at) / 1000 > cfg.hold_s) {
        usable = null;
        remember(null);
      }

      const result = soc.derive(channels, cfg, usable, now);
      if (result.reason) {
        if (result.drop && state !== null) remember(null);
        showFrozen(now, result.reason);
        warnLimited(result.reason);
        done();
        return;
      }

      if (result.state) remember(result.state);
      frozen = { soc_pct: result.soc_pct, at: now, source: result.source };

      const out = channelsFor(result);
      if (core.client) {
        core.client.publish('edge/entities/' + entity + '/telemetry',
          envelope(entity, out, new Date(now).toISOString()), { qos: 1 });
      }
      node.status({
        fill: 'green',
        shape: 'dot',
        text: fmt(result.soc_pct) + ' % · ' + label(result.source),
      });
      send({ payload: out, topic: entity, soc_source: result.source });
      done();
    });
  }

  RED.nodes.registerType('vp-soc-derive', VpSocDeriveNode);
};

/** Der Herkunfts-Text im Knoten-Status - kurz, aber nie mehrdeutig. */
function label(source) {
  if (source === soc.SOURCE_GEMESSEN) return 'gemessen';
  if (source === soc.SOURCE_KENNLINIE) return 'Kennlinie';
  if (source === soc.SOURCE_LADUNGSZAEHLUNG) return 'Ladungszählung';
  return source;
}

function fmt(pct) {
  return String(Math.round(pct * 10) / 10).replace('.', ',');
}

function fmtAge(seconds) {
  if (seconds < 90) return seconds + ' s';
  return Math.round(seconds / 60) + ' min';
}

module.exports.envelope = envelope;
module.exports.channelsFor = channelsFor;
module.exports.payloadChannels = payloadChannels;
module.exports.label = label;
