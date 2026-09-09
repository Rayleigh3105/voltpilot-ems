/**
 * vp-limit-guard - der GENERIERTE SCHUTZ-/GRENZBAUSTEIN (P5c, Katalogtyp
 * vp.bms.limit, Palette 0.13.0; Konzept vp-deye-diybms-luecke-l5 §3.2b
 * „OPTIONAL - Schutz-/Grenzbaustein" und §3.3, Bauplan-Paket P5c).
 *
 * WAS ER TUT: Er nimmt die Kanaele, die der Strang vor ihm gerade geliefert hat
 * - die Rohwerte der Ebene 1 (vp-mqtt-read / vp-http-read) und, wenn es sie
 * gibt, den abgeleiteten Ladestand der Ebene 2 (vp-soc-derive) -, und leitet
 * daraus ab, WAS DIE BATTERIE GERADE ZULAESST: eine Strom-Treppe je Richtung
 * und einen Zellspannungs-Riegel mit Hysterese. Das Ergebnis veroeffentlicht er
 * als GANZ NORMALE Telemetrie auf edge/entities/<id>/telemetry - bis zu vier
 * Kanaele: charge_limit_a, discharge_limit_a, charge_allowed,
 * discharge_allowed. Von dort laeuft die bewiesene v2-Kette weiter, und die
 * Speiser-Bindung (P6) traegt sie in den Speicher-Knoten.
 *
 * ⚠ ER SCHREIBT AUF KEIN GERAET. Der Kundenflow, dem dieser Baustein
 * nachgebaut ist, schreibt die Stromgrenzen in den Deye (0x006C/0x006D) - das
 * tut VoltPilot hier ausdruecklich NICHT. Die Grenzen werden BEREITGESTELLT:
 * als Anzeige und als KAPPE FUER DEN WAECHTER auf der Box (guards.Clamp
 * bekommt sie als BMS-Huelle, und jeder VoltPilot-Sollwert muss darunter
 * bleiben). Ein echter Schreibpfad entsteht erst hinter dem
 * Zertifizierungs-Gate (vp-deye-bench-cert / hybrid-control-p2); bis dahin
 * bleibt der Kundenflow der aktive Schreiber (§3.3), und die
 * Kommando-Transparenz kennt ihn als fremden Einfluss.
 *
 * WARUM EIN EIGENER KNOTEN und kein Schalter in vp-soc-derive: die Ableitung
 * beantwortet „wie voll?", dieser Baustein „was ist erlaubt?". Die zweite Frage
 * hat eine eigene Antwort auch dann, wenn die erste keine hat - ein Hartstopp
 * an der Zellspannung braucht keinen Ladestand. Als eigener Baustein haengt er
 * deshalb hinter BEIDEN Lesetypen und mit ODER ohne Ableitung davor.
 *
 * DIE REIHENFOLGE IM FLOW ist: Takt -> Lese-Knoten -> [vp-soc-derive] -> DIESER
 * Knoten. Er haengt an einer KANTE, nie am Takt - sonst rechnete er auf dem
 * Stand des VORIGEN Taktes, und die Reihenfolge zweier gleichzeitig gefeuerter
 * Knoten ist nichts, worauf man eine Schutzgrenze baut.
 *
 * DIE EHRLICHKEITSREGELN (§3.2b), Zeile fuer Zeile umgesetzt:
 *   - Was er nicht sagen KANN, sagt er nicht: ohne Ladestand keine Treppe, ohne
 *     Zellspannung keine Freigabe. Ein abwesender Kanal heisst „nicht gesagt",
 *     nie „0" und nie „erlaubt".
 *   - Eine gesperrte Richtung meldet BEIDES: allowed = 0 UND limit_a = 0.
 *   - Der Riegel ist ein GEDAECHTNIS und ueberlebt einen Neustart der Box (die
 *     dauerhafte Kontextablage) - aber nur, solange die Haltefrist gilt: was
 *     ein Pack in einer unbeobachteten Viertelstunde getan hat, weiss niemand.
 *   - Er veroeffentlicht NUR, wenn sich etwas geaendert hat ODER die stille
 *     Frist abgelaufen ist. Das ist der „rbe"-Teil des Kundenflows - und
 *     zugleich die Bedingung dafuer, dass die Waechter-Kappe stromabwaerts
 *     nicht wegen Alters verfaellt: eine unveraenderte Grenze wird regelmaessig
 *     WIEDERHOLT, damit ihr Alter ehrlich klein bleibt.
 */
'use strict';

const prot = require('../lib/limit-protection.js');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WARN_INTERVAL_MS = 60000;

/**
 * Wie lange eine UNVERAENDERTE Grenze hoechstens verschwiegen wird, bevor sie
 * wiederholt wird. Sie muss deutlich unter dem Frischefenster des Waechters
 * liegen (edge-app/core/internal/agent: bmsEnvelopeWindow, 5 min), sonst
 * verfiele die Kappe genau dann, wenn der Pack ruhig ist.
 */
const REPEAT_AFTER_MS = 120000;

/**
 * envelope() ist fuer die Tests exportiert: die edge-entity-§3-Nutzlast, mit
 * der eine Schutzgrenze reist - dieselbe Form wie jede andere Telemetrie.
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
 * payloadChannels() ist fuer die Tests exportiert: welche Kanaele eine
 * eingetroffene Nachricht traegt. Erlaubt sind die Nutzlast des Vorgaengers
 * (msg.payload = {kanal: zahl}) und die vollstaendige Telemetrie-Huelle
 * (msg.payload.channels). Alles andere ist KEINE Kanalliste und wird verworfen,
 * nie geraten. (Wortgleich mit vp-soc-derive - dieselbe Kante, dieselbe Form.)
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

/** Ob zwei Kanal-Saetze dieselbe Aussage machen (der „rbe"-Vergleich). */
function same(a, b) {
  if (a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

module.exports = function (RED) {
  function VpLimitGuardNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    const entity = String(config.entity || '');
    // ⚠ Die ROHE Form wird weitergereicht, nicht die normalisierte: `evaluate`
    // normalisiert selbst (wie `derive` nebenan), und eine schon normalisierte
    // Konfiguration ein zweites Mal durch `normalize` zu schicken haette den
    // Riegel stillschweigend verloren - seine Felder heissen danach anders.
    // Hier wird deshalb nur GEPRUEFT.
    const raw = {
      inputs: config.inputs,
      charge: config.charge,
      discharge: config.discharge,
      hysteresis: config.hysteresis,
      round_a: config.round_a,
      hold_s: config.hold_s,
    };
    const cfg = prot.normalize(raw);

    if (!ID_RE.test(entity) || cfg === null) {
      node.status({ fill: 'red', shape: 'ring', text: 'Konfiguration ungültig' });
      return;
    }
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }

    // Der Riegel-Zustand ueberlebt einen Neustart - ein Pack, das beim
    // Herunterfahren an seiner Stopp-Spannung stand, darf beim Hochfahren nicht
    // stillschweigend wieder laden duerfen.
    const stateKey = 'vp_limit_' + entity;
    const store = node.context();
    let state = null;
    try {
      const stored = store.get(stateKey, 'file');
      if (stored && typeof stored.charge_blocked === 'boolean'
          && typeof stored.discharge_blocked === 'boolean') {
        state = stored;
      }
    } catch (e) {
      // Eine unlesbare Ablage ist kein Grund, eine Sperre zu erfinden oder eine
      // zu verschweigen - der Riegel faengt dann bei der naechsten Messung an.
      node.warn('Riegel-Zustand konnte nicht gelesen werden: ' + e.message);
    }
    const remember = (next) => {
      state = next;
      try {
        store.set(stateKey, next, 'file');
      } catch (e) {
        node.warn('Riegel-Zustand konnte nicht gesichert werden: ' + e.message);
      }
    };

    let lastWarn = 0;
    const warnLimited = (text) => {
      const now = Date.now();
      if (now - lastWarn >= WARN_INTERVAL_MS) {
        lastWarn = now;
        node.warn('Schutzgrenzen: ' + text);
      }
    };

    let lastSent = null;
    let lastSentAt = 0;

    node.on('input', function (msg, send, done) {
      const now = Date.now();
      const channels = payloadChannels(msg && msg.payload);
      if (channels === null) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'keine Messwerte' });
        done();
        return;
      }

      const result = prot.evaluate(channels, raw, state, now);
      if (result.reason) {
        node.status({ fill: 'red', shape: 'ring', text: result.reason });
        warnLimited(result.reason);
        done();
        return;
      }
      remember(result.state);

      const out = result.channels;
      if (Object.keys(out).length === 0) {
        // Nichts zu sagen ist eine ehrliche Antwort - sie wird gezeigt, aber
        // nicht als Telemetrie erfunden.
        lastSent = null;
        node.status({ fill: 'yellow', shape: 'ring', text: 'keine Schutzgrenze ableitbar' });
        done();
        return;
      }

      // „Nur bei Aenderung" wie im Kundenflow - mit einer Wiederholung nach
      // REPEAT_AFTER_MS, damit die Waechter-Kappe stromabwaerts nicht wegen
      // Alters verfaellt, waehrend der Pack ruhig steht.
      const changed = !same(lastSent, out);
      if (changed || now - lastSentAt >= REPEAT_AFTER_MS) {
        if (core.client) {
          core.client.publish('edge/entities/' + entity + '/telemetry',
            envelope(entity, out, new Date(now).toISOString()), { qos: 1 });
        }
        lastSent = out;
        lastSentAt = now;
      }
      node.status({ fill: 'green', shape: 'dot', text: statusText(out) });
      send({ payload: Object.assign({}, channels, out), topic: entity });
      done();
    });
  }

  RED.nodes.registerType('vp-limit-guard', VpLimitGuardNode);
};

/** Der Status-Text: was gerade erlaubt ist, in einer Zeile. */
function statusText(out) {
  const parts = [];
  parts.push(side('Laden', out[prot.CHARGE_LIMIT_CHANNEL], out[prot.CHARGE_ALLOWED_CHANNEL]));
  parts.push(side('Entladen', out[prot.DISCHARGE_LIMIT_CHANNEL],
    out[prot.DISCHARGE_ALLOWED_CHANNEL]));
  return parts.filter(Boolean).join(' · ');
}

function side(label, limitA, allowed) {
  if (allowed === 0) return label + ' gesperrt';
  if (typeof limitA === 'number') {
    return label + ' max. ' + String(Math.round(limitA * 10) / 10).replace('.', ',') + ' A';
  }
  if (allowed === 1) return label + ' frei';
  return '';
}

module.exports.envelope = envelope;
module.exports.payloadChannels = payloadChannels;
module.exports.same = same;
module.exports.statusText = statusText;
module.exports.REPEAT_AFTER_MS = REPEAT_AFTER_MS;
