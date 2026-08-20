'use strict';

/**
 * bus-arbitration.test.js - die reinen Regeln der Warteschlange am einen
 * Wechselrichter-Socket. Ohne Uhr, ohne Socket, ohne Node-RED: jede Regel, die
 * einen Einmal-Auftrag warten lassen oder durchlassen kann, ist hier prüfbar
 * (das Muster von internal/probe, internal/otaapply, internal/registerwrite).
 */

const test = require('node:test');
const assert = require('node:assert');
const bus = require('./bus-arbitration');

const NOW = 1_700_000_000_000;

test('die Zeitfenster sind eine KETTE, keine Einstellungen', () => {
  // Der Befund, der den Produktionsvorfall erzeugt hat: Warten + Arbeiten des
  // Knotens lagen ÜBER der Schranke des Kerns (12 s + 25 s = 37 s > 30 s), also
  // meldete die Cloud `timeout`, während das Gerät noch arbeitete.
  assert.ok(bus.ONESHOT_ACQUIRE_MS + bus.ONESHOT_SOCKET_MS <= bus.BOX_ROUND_TRIP_MS,
    'Warten + Arbeiten bleiben unter der Schranke des Kerns');
  // Und das Warte-Budget muss EINE volle Socket-Runde eines anderen Halters
  // überdauern - sonst gibt der Auftrag genau dann auf, wenn die Übergabe
  // gleich käme.
  assert.ok(bus.ONESHOT_ACQUIRE_MS > bus.CONTROL_SOCKET_MS);
  assert.strictEqual(bus.chainOK(), true);
});

test('eine Reservierung gilt, solange sie aufgefrischt wird - und keine Sekunde laenger', () => {
  const res = { id: 'abc', at: NOW };
  assert.strictEqual(bus.reserveLive(res, NOW), true);
  assert.strictEqual(bus.reserveLive(res, NOW + bus.ONESHOT_RESERVE_TTL_MS - 1), true);
  // ⚠ Der tote Auftrag darf den Bus NIE festhalten: nach der Frist ist er weg.
  assert.strictEqual(bus.reserveLive(res, NOW + bus.ONESHOT_RESERVE_TTL_MS), false);
  assert.strictEqual(bus.reserveLive(null, NOW), false);
  assert.strictEqual(bus.reserveLive({ id: 'abc' }, NOW), false, 'ohne Stempel keine Reservierung');
  assert.strictEqual(bus.reserveLive({ id: 'abc', at: 0 }, NOW), false);
});

test('eine Uebergabe ist ein NAME, kein Freibrief', () => {
  const g = { id: 'abc', at: NOW };
  assert.strictEqual(bus.grantFor(g, 'abc', NOW), true);
  assert.strictEqual(bus.grantFor(g, 'xyz', NOW), false, 'nur der Genannte loest sie ein');
  assert.strictEqual(bus.grantFor(g, '', NOW), false, 'ohne eigene Kennung nie');
  assert.strictEqual(bus.grantFor(g, 'abc', NOW + bus.ONESHOT_GRANT_TTL_MS), false, 'verfallen');
  // Aber sie ist für JEDEN anderen eine Sperre, solange sie gilt.
  assert.strictEqual(bus.grantLive(g, NOW + bus.ONESHOT_GRANT_TTL_MS - 1), true);
  assert.strictEqual(bus.grantLive(g, NOW + bus.ONESHOT_GRANT_TTL_MS), false);
});

test('wer freigibt, uebergibt an eine gueltige Reservierung - und nie an sich selbst', () => {
  const res = { id: 'abc', at: NOW };
  assert.deepStrictEqual(bus.handoverFor(res, null, NOW + 10), { id: 'abc', at: NOW + 10 },
    'der Lese-Poll / die Steuerung haben keinen eigenen Auftrag und uebergeben');
  assert.strictEqual(bus.handoverFor(res, 'abc', NOW + 10), null,
    'der Auftrag selbst uebergibt nicht an sich');
  assert.strictEqual(bus.handoverFor(res, 'xyz', NOW + 10).id, 'abc',
    'ein FREMDER Auftrag uebergibt an den wartenden');
  assert.strictEqual(bus.handoverFor(null, null, NOW), null, 'ohne Reservierung keine Uebergabe');
  assert.strictEqual(bus.handoverFor(res, null, NOW + bus.ONESHOT_RESERVE_TTL_MS), null,
    'an eine verfallene Reservierung wird nicht uebergeben');
});

test('mayClaim: eine an mich gerichtete Uebergabe schlaegt alles, eine fremde ist eine Sperre', () => {
  const busySince = NOW - 1000;
  const mine = { id: 'abc', at: NOW };
  const theirs = { id: 'xyz', at: NOW };

  // Der Empfänger nimmt den Socket, auch wenn `busy` noch steht: die Übergabe
  // IST die Freigabe (der Halter setzt sie, bevor er busy räumt).
  assert.strictEqual(bus.mayClaim({ busySince, grant: mine, now: NOW, myID: 'abc' }), true);
  // Jeder andere wartet sie ab - er bricht sie NICHT.
  assert.strictEqual(bus.mayClaim({ busySince: 0, grant: theirs, now: NOW, myID: 'abc' }), false);
  assert.strictEqual(bus.mayClaim({ busySince: 0, grant: theirs, now: NOW }), false,
    'auch die Steuerung ueberholt eine laufende Uebergabe nicht');
  // Ohne Übergabe gilt die alte Regel unverändert.
  assert.strictEqual(bus.mayClaim({ busySince: 0, grant: null, now: NOW }), true);
  assert.strictEqual(bus.mayClaim({ busySince, grant: null, now: NOW }), false);
  // Und eine ABGELAUFENE Sperre ist keine: ein abgestürzter Halter darf den Bus
  // nicht für immer halten.
  assert.strictEqual(bus.mayClaim({ busySince: NOW - 30000, grant: null, now: NOW }), true);
  assert.strictEqual(bus.mayClaim({ busySince: 0, grant: { id: 'xyz', at: NOW - bus.ONESHOT_GRANT_TTL_MS }, now: NOW }), true,
    'eine verfallene Uebergabe blockiert nichts');
});

test('die Schluessel sind je (Host, Port) - und je Anlage verschieden', () => {
  assert.strictEqual(bus.KEY_ONESHOT('192.168.0.28:8899'), 'sv5_oneshot:192.168.0.28:8899');
  assert.strictEqual(bus.KEY_GRANT('192.168.0.28:8899'), 'sv5_grant:192.168.0.28:8899');
  assert.notStrictEqual(bus.KEY_ONESHOT('a:1'), bus.KEY_ONESHOT('b:1'));
  // ⚠ Der Einmal-Auftrag hat einen EIGENEN Schluessel - nicht die gemeinsame
  // Absichts-Fahne der Steuerung. Genau ihre Doppelnutzung war Befund 1.
  assert.notStrictEqual(bus.KEY_ONESHOT('a:1'), bus.KEY_WANT('a:1'));
});
