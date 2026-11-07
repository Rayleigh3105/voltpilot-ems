/**
 * Die EINE Regel „an diesem Stecker läuft ein Ladevorgang“ und ihr
 * Gegenstück „Auto steckt, aber kein Ladevorgang“. Eigene kleine Datei ohne
 * Abhängigkeiten: das Cockpit fragt sie schon im ersten Bild (ob die Zeile
 * „Jetzt schnell laden“ nachlädt), ohne `ladepunkte.ts` mitzuladen.
 */
import type { ChargeConnector, SiteCharging } from './ladepunkte';

/**
 * DIE Regel „an diesem Stecker läuft ein Ladevorgang“ - genau das `charging`
 * der Box, dasselbe Feld, an dem der Server „Schnell“, „Aus“ und „bis
 * Abstecken“ annimmt oder mit „An diesem Stecker läuft gerade kein
 * Ladevorgang.“ ablehnt (`ChargingBoostService`), und dieselbe Sitzung, die
 * die Box dafür braucht (`ocppTransactionOf`).
 *
 * ⚠ Jede Fläche, die einen dieser Eingriffe anbietet (Reiter „Laden“, die
 * Cockpit-Zeile, *Ladevorgänge*, „Eingreifen“), fragt DIESE Funktion - nie das
 * Statuswort. `SuspendedEVSE` heisst nur „Auto verbunden, keine Energie“; ob
 * die Box dazu einen Ladevorgang kennt, sagt allein `charging`.
 */
export function ladungLaeuft(con: Pick<ChargeConnector, 'charging'> | null | undefined): boolean {
  return con?.charging === true;
}

/** Die Statuswörter, mit denen eine Säule „ein Auto ist verbunden, eine Ladung sollte laufen“ meldet. */
const STECKT_MIT_LADUNG: ReadonlySet<string> = new Set(['Charging', 'SuspendedEV', 'SuspendedEVSE']);

/**
 * Der Satz zu „Auto steckt, aber kein Ladevorgang“ - derselbe, den die Box
 * mit dem Grund `kein_ladevorgang` schickt (`lastmgmt.NoSessionText`,
 * geteilte Vektoren `ocpp-ladezustand-vectors.json`).
 */
export const KEIN_LADEVORGANG_SATZ =
  'Die Wallbox hat für dieses Auto keinen Ladevorgang begonnen. Stecker kurz ziehen und wieder einstecken.';

/**
 * Steckt ein Auto, ohne dass die Box einen Ladevorgang kennt? Dann nimmt sie
 * für diesen Stecker keine Eingriffe an, und auch „Smart“ kann nicht laden -
 * erst ein neues Einstecken beginnt einen Ladevorgang (Befund an einer
 * Pilotanlage: die Wallbox verband sich neu, als die Ladung begann, und gab
 * den abgelehnten Start danach nicht wieder auf).
 *
 * Eine neue Box meldet es ausdrücklich (`reason: kein_ladevorgang`). Für die
 * Boxen im Feld erkennt das Portal denselben Fall aus den Feldern, die es
 * schon gibt: ein Statuswort „Auto verbunden“, `charging` falsch, keine
 * Sitzung (`sessionSince`) - und keine Zuteilung und kein Grund, denn beides
 * vergibt die Box nur an einen Stecker MIT Sitzung.
 */
export function keinLadevorgang(
  con: Pick<ChargeConnector, 'status' | 'charging' | 'sessionSince' | 'allocatedKw' | 'reason'>,
): boolean {
  if (!STECKT_MIT_LADUNG.has((con.status ?? '').trim()) || ladungLaeuft(con)) return false;
  const reason = (con.reason ?? '').trim() || null;
  if (reason === 'kein_ladevorgang') return true;
  return reason == null && !(con.sessionSince ?? '').trim() && !Number.isFinite(con.allocatedKw ?? NaN);
}

/**
 * Hat die Cockpit-Zeile „Jetzt schnell laden“ an dieser Anlage etwas zu sagen?
 * Ja, sobald an einer verbundenen Säule ein Ladevorgang läuft (eine Sitzung im
 * Abgleich zählt mit) oder ein Auto ohne Ladevorgang steckt - dann nennt sie
 * den Ausweg. Was sie anbietet, entscheidet `schnellZeilen`.
 */
export function schnellZeileRelevant(charging: Pick<SiteCharging, 'chargers'> | null | undefined): boolean {
  return (charging?.chargers ?? []).some(
    (cp) => cp.connected && (cp.connectors ?? []).some((c) => ladungLaeuft(c) || c.sessionSince != null || keinLadevorgang(c)),
  );
}
