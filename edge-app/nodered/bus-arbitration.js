'use strict';
/*
 * bus-arbitration.js - die WARTESCHLANGE des EINEN Wechselrichter-Sockets.
 *
 * Der Solarman/LSW3-Logger bedient GENAU EINEN TCP-Client, deshalb teilen sich
 * die drei Knoten des Tabs „Wechselrichter (automatisch)" eine Sperre im
 * Flow-Kontext: der Lese-Poll (5 s), der Steuer-Executor (~10 s) und der
 * EINMAL-Auftrag (auf Zuruf, lokal an :8484 oder als Portal-Downlink).
 *
 * ⚠ WARUM ES DIESES MODUL GIBT (Produktionsvorfall Pilsting/Herzogau,
 * 20.08.2026, Box edge-45gz7da): die Sperre war eine reine SPIN-Sperre OHNE
 * Warteschlange, und der Einmal-Auftrag verhungerte darin.
 *
 *   1. EINE ABSICHTS-FAHNE FÜR ZWEI SCHREIBER. Steuerung UND Einmal-Auftrag
 *      benutzten beide `sv5_write_want:`; der Steuer-Executor setzt sie am Ende
 *      JEDER Runde (und beim Verschieben) auf 0 - und löschte damit die
 *      Absichts-Meldung eines noch WARTENDEN Einmal-Auftrags. Der Lese-Poll,
 *      der genau auf diese Fahne zurücktritt, nahm sich den Socket danach
 *      wieder. Symmetrisch löschte der Einmal-Auftrag die Absicht der Steuerung.
 *   2. KEINE ÜBERGABE. Wer den Socket freigab, entließ ihn ins Rennen: der
 *      nächste Inject-Takt (Lesen alle 5 s, Steuern alle ~10 s) prüfte EINMAL
 *      synchron und griff zu, während der Einmal-Auftrag nur alle 300 ms
 *      nachsah. Es gab keine Reihenfolge und damit keine endliche Zusage.
 *   3. DIE ZEITFENSTER-KETTE WAR GERISSEN. Der Einmal-Knoten durfte 12 s auf
 *      den Socket warten UND danach 25 s am Socket verbringen - zusammen 37 s,
 *      während der Kern ihn nach 30 s aufgibt (`installerWriteTimeout`). Auf
 *      einer belegten Anlage meldete die Cloud deshalb `timeout`, obwohl der
 *      Knoten Sekunden später korrekt geantwortet hätte - in einen längst
 *      vergessenen Wartenden hinein.
 *
 * DIE REGEL, in einem Satz: ein Einmal-Auftrag RESERVIERT den Bus; wer den
 * Socket hält, ÜBERGIBT ihn beim Beenden an diese Reservierung; Lese-Poll und
 * Steuer-Executor behandeln die Übergabe wie „belegt" und warten sie ab.
 *
 * ⚠ STEUER-VORRANG BLEIBT DAS PRINZIP. Eine Reservierung bricht NIE eine
 * laufende Steuerrunde ab und weist NIE einen Steuer-Schreibvorgang zurück -
 * sie kann eine Steuerrunde höchstens um die Dauer EINES Einmal-Auftrags
 * verzögern, und genau dieses Verschieben ist der seit je getestete Normalfall
 * des Steuer-Executors (es passiert heute schon, wenn der Lese-Poll den Socket
 * hält). Umgekehrt gilt die Zusage: zwischen einem Einmal-Auftrag und seinem
 * Slot steht HÖCHSTENS EINE laufende Socket-Runde.
 *
 * ⚠ DIE ZAHLEN SIND EINE KETTE, KEINE EINSTELLUNGEN. Sie müssen zusammen
 * wandern, und `chainOK()` ist ihr Wächter:
 *
 *     ONESHOT_ACQUIRE_MS + ONESHOT_SOCKET_MS  <=  BOX_ROUND_TRIP_MS
 *              (Knoten: warten + arbeiten)          (Kern gibt auf)
 *     BOX_ROUND_TRIP_MS < voltpilot.register-write.read-timeout (api, PT40S)
 *
 * Die Cloud-Hälfte derselben Kette hängt an `RegisterWriteService.BOX_ROUND_TRIP`
 * und ist von `RegisterWriteBudgetTest` festgenagelt; die Geräte-Hälfte von
 * `flows-sync.test.js` („die Zeitfenster-Kette").
 *
 * Rein: kein Socket, keine Uhr - jede zeitabhängige Funktion nimmt ihr `now`
 * (das Muster von internal/probe, internal/otaapply, internal/registerwrite).
 */

// --- die Schlüssel im Flow-Kontext, je (Host, Port) --------------------------
//
// Der Flow-Kontext ist PRO TAB, und alle drei Knoten liegen im selben Tab -
// genau deshalb ist die Sperre überhaupt geteilt. Ein Knoten in einem anderen
// Tab bekäme seine EIGENE Sperre und damit einen ZWEITEN TCP-Client auf einem
// Logger, der einen bedient.
const KEY_BUSY = (target) => 'sv5_busy:' + target;
const KEY_WANT = (target) => 'sv5_write_want:' + target;
const KEY_CAL = (target) => 'sv5_write_cal:' + target;
// NEU: die Reservierung des Einmal-Auftrags. EIGENER Schlüssel - das ist der
// Fix für Befund 1: kein anderer Schreiber fasst ihn an, also kann ihn auch
// keiner mehr löschen.
const KEY_ONESHOT = (target) => 'sv5_oneshot:' + target;
// NEU: die ÜBERGABE. Wer freigibt, legt sie hin; nur der genannte Auftrag darf
// sie einlösen (Befund 2).
const KEY_GRANT = (target) => 'sv5_grant:' + target;

// --- die Zeitfenster-Kette (ms) ---------------------------------------------

// Wie lange eine Reservierung ohne Auffrischung gilt. Der Einmal-Knoten frischt
// sie bei JEDEM Wartetakt auf, solange er wirklich wartet - stirbt der Knoten,
// verfällt sie und der Bus gehört wieder allen (eine Reservierung darf den Bus
// nie festhalten können).
const ONESHOT_RESERVE_TTL_MS = 20000;

// Wie lange eine ÜBERGABE gilt. Kurz, denn der Empfänger sieht alle 50 ms nach;
// verfällt sie, ist der Socket wieder frei für alle - eine verlorene Übergabe
// kostet einen Wartetakt, nie den Bus.
const ONESHOT_GRANT_TTL_MS = 5000;

// Das Warte-Budget des Einmal-Auftrags. Es MUSS die längste Socket-Runde eines
// anderen Halters überdauern (der Steuer-Executor deckelt sich bei
// CONTROL_SOCKET_MS), sonst gibt der Auftrag genau dann auf, wenn die Übergabe
// gleich käme.
const ONESHOT_ACQUIRE_MS = 15000;

// Das Socket-Budget des Einmal-Auftrags. Vorher 25 s - das war der zweite Teil
// des gerissenen Zeitfensters. Eine Lesung dauert ~1 s, ein Schreibvorgang
// Lesen + Schreiben + SETTLE_MS + Lesen; 12 s ist grosszügig und hält die Kette.
const ONESHOT_SOCKET_MS = 12000;

// Der Selbst-Deckel des Steuer-Executors auf EINE Socket-Runde. Hier notiert,
// weil ONESHOT_ACQUIRE_MS daran hängt; `flows-sync.test.js` prüft, dass der
// Knoten wirklich diese Zahl trägt.
const CONTROL_SOCKET_MS = 12000;

// Wie viele Lese-Takte nacheinander für eine Reservierung zurücktreten dürfen.
// 6 × 5 s = 30 s deckt den ganzen Worst Case eines Einmal-Auftrags ab, also
// erzwingt der Lese-Poll nie mitten in einem legitimen Auftrag - und die
// Schranke bleibt trotzdem da, damit eine hängende Reservierung die Telemetrie
// nicht aushungern kann.
const ONESHOT_READ_YIELD_TICKS = 6;

// Was der KERN abwartet (`installerWriteTimeout` in
// edge-app/core/internal/agent/installerwrite.go). Die äussere Schranke der
// Geräte-Hälfte; hier notiert, damit chainOK() sie prüfen kann.
const BOX_ROUND_TRIP_MS = 30000;

// --- die reinen Regeln -------------------------------------------------------

const at = (rec) => (rec && typeof rec === 'object' && Number(rec.at) > 0 ? Number(rec.at) : 0);

/** Gilt diese Reservierung jetzt noch? */
function reserveLive(rec, now) {
  const t = at(rec);
  return t > 0 && now - t < ONESHOT_RESERVE_TTL_MS;
}

/** Gilt diese Übergabe jetzt noch - egal an wen? */
function grantLive(rec, now) {
  const t = at(rec);
  return t > 0 && now - t < ONESHOT_GRANT_TTL_MS;
}

/**
 * Ist die Übergabe an GENAU diesen Auftrag gerichtet? Nur dann darf er sie
 * einlösen - eine Übergabe ist ein Name, kein Freibrief.
 */
function grantFor(rec, id, now) {
  return grantLive(rec, now) && !!id && rec.id === id;
}

/**
 * Was ein FREIGEBENDER Halter hinterlassen muss: die Übergabe an eine noch
 * gültige Reservierung - oder nichts.
 *
 * ⚠ `holderID` ist der eigene Auftrag (nur der Einmal-Knoten hat einen): wer
 * seine EIGENE Reservierung freigibt, übergibt nicht an sich selbst.
 */
function handoverFor(reservation, holderID, now) {
  if (!reserveLive(reservation, now)) return null;
  if (holderID && reservation.id === holderID) return null;
  return { id: reservation.id, at: now };
}

/**
 * Darf ein Halter den Socket JETZT nehmen? Die eine Frage, die Lese-Poll,
 * Steuer-Executor und Einmal-Auftrag gleich beantworten müssen.
 *
 * `myID` gesetzt = der Einmal-Auftrag: eine an ihn gerichtete Übergabe schlägt
 * alles andere. Ohne eigene Kennung (Lesen/Steuern) ist eine laufende Übergabe
 * eine Sperre - sie WARTEN sie ab, sie brechen sie nicht.
 */
function mayClaim({ busySince, grant, now, myID, staleMs }) {
  if (grantFor(grant, myID, now)) return true;
  if (grantLive(grant, now)) return false;
  const bs = Number(busySince) > 0 ? Number(busySince) : 0;
  return !bs || now - bs >= (Number(staleMs) > 0 ? Number(staleMs) : 30000);
}

/**
 * Die Kette der Zeitfenster. Ein Fehlschlag hier ist kein Stil-Befund: er
 * bedeutet, dass der Knoten den Kern überleben kann und die Cloud einen
 * `timeout` meldet, während das Gerät noch arbeitet.
 */
function chainOK() {
  return ONESHOT_ACQUIRE_MS + ONESHOT_SOCKET_MS <= BOX_ROUND_TRIP_MS &&
    ONESHOT_ACQUIRE_MS > CONTROL_SOCKET_MS;
}

module.exports = {
  KEY_BUSY, KEY_WANT, KEY_CAL, KEY_ONESHOT, KEY_GRANT,
  ONESHOT_RESERVE_TTL_MS, ONESHOT_GRANT_TTL_MS, ONESHOT_ACQUIRE_MS,
  ONESHOT_SOCKET_MS, CONTROL_SOCKET_MS, ONESHOT_READ_YIELD_TICKS,
  BOX_ROUND_TRIP_MS,
  reserveLive, grantLive, grantFor, handoverFor, mayClaim, chainOK,
};
