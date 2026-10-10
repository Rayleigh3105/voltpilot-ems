'use strict';
/**
 * Der Einliefer-Weg fuer GERAETE-Ereignisse (UEMS AP-07 IP-19).
 *
 * Ein Treiber sagt hier nur, WAS er gesehen hat. Kennung der Box, Umschlag,
 * Sequenz und Zeitstempel des Umschlags gehoeren dem Kern - genau wie bei
 * `edge/data-sources/poll`. Der Weg ist:
 *
 *     Treiber -> edge/events -> Kern (internal/boxevents) -> Outbox -> .../v2/events
 *
 * Das Vokabular ist GESCHLOSSEN und es ist das der Cloud
 * (`docs/contracts/v2/mqtt-events-2.1.schema.json`, `events-vocabulary.md` Paragraf 4).
 * Ein unbekanntes Wort oder ein fremdes Feld verwirft in der Datenannahme den GANZEN
 * Umschlag - deshalb faellt es schon hier durch, wo nur diese eine Meldung verloren geht.
 *
 * NICHT hier: die Ausloeser. Wann ein Statuswort-Bit `range_limit` bedeutet und wann
 * ein stehender Herzschlag `frozen_source` wird, entscheidet der jeweilige Treiber
 * (fuer WAGO: AP-05 IP-8). Dieses Modul ist der Briefkasten, nicht der Absender.
 */

/** Der lokale Bus-Zweig. Ein Kern-Abonnent, viele Treiber. */
const TOPIC = 'edge/events';

/** Genau die vier Arten, die ein TREIBER melden darf. */
const ARTEN = Object.freeze(['device_restart', 'frozen_source', 'range_limit', 'layout_changed']);

/** Pflicht- und erlaubte Felder je Art - Spiegel von `$defs/box_*` des Vertrags. */
const REGELN = Object.freeze({
  device_restart: {
    pflicht: ['art', 'zeitpunkt', 'datenquelle'],
    felder: { art:'wort', zeitpunkt:'zeit', datenquelle:'kennung',
      herzschlag_vorher:'ganz0', herzschlag_nachher:'ganz0' },
  },
  frozen_source: {
    pflicht: ['art', 'zeitpunkt', 'datenquelle'],
    felder: { art:'wort', zeitpunkt:'zeit', datenquelle:'kennung', komponente:'kennung',
      messkanal:'messkanal', lesungen:'ganz1', herzschlag:'ganz0' },
  },
  range_limit: {
    pflicht: ['art', 'zeitpunkt', 'datenquelle'],
    felder: { art:'wort', zeitpunkt:'zeit', datenquelle:'kennung', komponente:'kennung',
      statuswort:'statuswort' },
  },
  layout_changed: {
    pflicht: ['art', 'zeitpunkt', 'datenquelle'],
    felder: { art:'wort', zeitpunkt:'zeit', datenquelle:'kennung', fassung_erwartet:'ganz1',
      fassung_gelesen:'ganz1', karten_erwartet:'ganz0', karten_gelesen:'ganz0' },
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KENNUNG = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ZEIT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

/** UTC, auf die Sekunde, mit Z - die eine Schreibweise des Vertrags (E13). */
function zeit(wann) {
  const d = wann instanceof Date ? wann : new Date(wann);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

function ganz(wert) { return Number.isInteger(wert) ? wert : null; }

function feldOk(typ, wert, art) {
  switch (typ) {
    case 'wort': return wert === art;
    case 'zeit': return typeof wert === 'string' && ZEIT.test(wert) && !Number.isNaN(Date.parse(wert));
    case 'kennung': return typeof wert === 'string' && wert.length >= 1 && wert.length <= 128
      && KENNUNG.test(wert);
    case 'messkanal': return typeof wert === 'string' && wert.length >= 1 && wert.length <= 240;
    case 'ganz0': return ganz(wert) !== null && wert >= 0;
    case 'ganz1': return ganz(wert) !== null && wert >= 1;
    case 'statuswort': return ganz(wert) !== null && wert >= 0 && wert <= 65535;
    default: return false;
  }
}

/**
 * Prueft EIN Geraete-Ereignis und gibt die Form zurueck, die auf den Bus gehoert -
 * oder `null`. `null` heisst immer: nicht senden. Ein halb gueltiges Ereignis wird
 * nie zurechtgebogen, denn ein falsches Wort kostet in der Cloud den ganzen Umschlag.
 *
 * `zeitpunkt` darf fehlen; dann setzt ihn `now`. `ereignis_id` darf fehlen; dann
 * vergibt sie der Kern EINMAL beim Ablegen in die Outbox - genau deshalb wiederholt
 * ein Replay dieselbe Kennung und die Cloud speichert ein Ereignis, nicht zwei.
 */
function ereignis(eingang, now = new Date()) {
  if (!eingang || typeof eingang !== 'object') return null;
  const art = eingang.art;
  if (!ARTEN.includes(art)) return null;
  const regel = REGELN[art];
  const gebaut = { art };
  if (eingang.ereignis_id !== undefined) {
    if (typeof eingang.ereignis_id !== 'string' || !UUID.test(eingang.ereignis_id)) return null;
    gebaut.ereignis_id = eingang.ereignis_id;
  }
  const zeitpunkt = eingang.zeitpunkt === undefined ? zeit(now) : eingang.zeitpunkt;
  if (zeitpunkt !== undefined && zeitpunkt !== null) gebaut.zeitpunkt = zeitpunkt;
  for (const [feld, wert] of Object.entries(eingang)) {
    if (feld === 'art' || feld === 'ereignis_id' || feld === 'zeitpunkt') continue;
    if (wert === undefined || wert === null) continue;
    // Ein Feld, das diese Art nicht kennt, wird nicht still mitgeschleppt.
    if (!(feld in regel.felder)) return null;
    gebaut[feld] = wert;
  }
  for (const feld of regel.pflicht) if (!(feld in gebaut)) return null;
  for (const [feld, wert] of Object.entries(gebaut)) {
    if (feld === 'ereignis_id') continue;
    if (!feldOk(regel.felder[feld], wert, art)) return null;
  }
  return gebaut;
}

/**
 * Bequemlichkeit fuer einen Treiber-Knoten: baut die Bus-Nachricht oder `null`.
 * `node.send(nachricht(...))` ist alles, was ein Treiber braucht.
 */
function nachricht(eingang, now = new Date()) {
  const payload = ereignis(eingang, now);
  return payload === null ? null : { topic: TOPIC, payload };
}

module.exports = { TOPIC, ARTEN, REGELN, ereignis, nachricht, zeit };
