/**
 * Die Schaltspur im Portal (vp-schalten-3s, `docs/contracts/v2/schaltspur.md`): was nur der Browser messen kann -
 * Klick bis Antwort der API und Klick bis bestätigt SICHTBAR, in seiner monotonen Uhr (`performance.now`, keine
 * Uhrenabweichung zur API).
 *
 * Der Ablauf hängt an `consumersApi`, nicht an einer Fläche: jeder Start, Stopp und „Automatik fortsetzen“ merkt
 * sich seine Spur ({@link merkeSpur}), und jede Antwort von `consumer-status` prüft die offenen Spuren der Anlage
 * ({@link pruefeSpuren}). Sobald ein Eintrag den Wunsch bestätigt - nach derselben Regel wie die API
 * (`SchaltSpurAbgleich`, gemeinsame Vektoren `schaltspur-abgleich-vectors.json`) -, meldet das Portal seine Zeiten
 * EINMAL. Fehlt die Antwort der API oder bleibt die Seite nicht offen, fehlt eben die Portal-Zeit; erfunden wird
 * nichts.
 */
import type { ConsumerRuntimeStatus } from './status';

export type SpurUrteil = 'offen' | 'bestaetigt' | 'gehalten' | 'abweichung';

/** Der Wunsch einer Spur (wie `SchaltSpurAbgleich.Wunsch`). */
export interface SpurWunsch {
  art: 'start' | 'stop' | 'zurueck';
  kommando?: 'on_off' | 'setpoint_kw' | null;
  wert?: number | null;
  ausgaenge?: number[] | null;
}

/** Die Gründe, mit denen eine Schutzregel der Box einen Wunsch hält (wie `SchaltSpurAbgleich.HALTEGRUENDE`). */
export const HALTEGRUENDE: ReadonlySet<string> = new Set(['guard_min_on', 'guard_min_off', 'guard_max_starts',
  'guard_ramp', 'guard_phase_switch', 'guard_rated_power', 'guard_grid_limit']);

type SpurStatus = Pick<ConsumerRuntimeStatus, 'state' | 'reasonCode' | 'confirmed' | 'stufe'>;

function an(w: SpurWunsch): boolean {
  if (w.art === 'stop') return false;
  if (w.kommando === 'on_off') return true;
  return w.wert == null || w.wert > 0;
}

function erfuellt(w: SpurWunsch, s: SpurStatus): boolean {
  const manuell = s.state === 'running_manual';
  const stufe = s.stufe ?? null;
  if (w.art === 'zurueck') {
    return !manuell && s.confirmed !== false && !stufe?.mismatch_since;
  }
  if (stufe) {
    if (stufe.confirmed == null) return false; // ein Ausgang ist ungelesen - unbekannt ist nie "aus"
    const lauf = new Set(stufe.outputs_on ?? []);
    if (!an(w)) return lauf.size === 0;
    if (!manuell || lauf.size === 0) return false;
    if (w.ausgaenge && w.ausgaenge.length > 0) {
      return lauf.size === new Set(w.ausgaenge).size && w.ausgaenge.every((k) => lauf.has(k));
    }
    return stufe.confirmed === stufe.commanded && stufe.commanded > 0;
  }
  if (s.confirmed !== true) return false;
  const laeuft = s.state?.startsWith('running_') ?? false;
  return an(w) ? manuell : !laeuft;
}

/** Was ein Status-Eintrag über einen offenen Wunsch sagt - der Zwilling von `SchaltSpurAbgleich.urteil`. */
export function spurUrteil(w: SpurWunsch, s: SpurStatus | null | undefined): SpurUrteil {
  if (!s) return 'offen';
  if (erfuellt(w, s)) return 'bestaetigt';
  if (s.reasonCode && HALTEGRUENDE.has(s.reasonCode)) return 'gehalten';
  if (s.confirmed === false || s.reasonCode === 'readback_mismatch' || s.stufe?.mismatch_since) return 'abweichung';
  return 'offen';
}

// ---------------------------------------------------------------------------
// Messen im Browser

/** Wie lange eine Spur auf ihre sichtbare Bestätigung wartet (länger hält keine Schutzregel einen Wunsch). */
export const SPUR_WARTET_MS = 60 * 60_000;

interface OffeneSpur {
  spur: string;
  siteId: string;
  entityId: string;
  wunsch: SpurWunsch;
  klick: number;
  antwortMs: number;
}

const offen = new Map<string, OffeneSpur>();
let jetzt: () => number = () => performance.now();
let melden: (siteId: string, entityId: string, spur: string, zeiten: { antwortMs: number; sichtbarMs: number }) =>
  Promise<unknown> = async () => undefined;

/** Der Weg, auf dem die Zeiten zur API gehen (consumersApi setzt ihn; Tests setzen ihre eigene Uhr). */
export function spurMeldeweg(m: typeof melden, uhr?: () => number): void {
  melden = m;
  if (uhr) jetzt = uhr;
}

/** Die Uhr des Browsers für den Klick - VOR dem Aufruf gelesen. */
export function spurKlick(): number {
  return jetzt();
}

/**
 * Merkt sich die Spur eines Handeingriffs, sobald die API geantwortet hat. Ein neuer Tipp am selben Verbraucher
 * ersetzt die vorige Spur (dieselbe Regel wie in der API).
 */
export function merkeSpur(siteId: string, entityId: string, spur: string | null | undefined, wunsch: SpurWunsch,
  klick: number): void {
  if (!spur) return;
  offen.set(entityId, { spur, siteId, entityId, wunsch, klick, antwortMs: Math.round(jetzt() - klick) });
}

/**
 * Prüft die offenen Spuren einer Anlage gegen eine frische Antwort von `consumer-status` und meldet jede
 * bestätigte einmal. Gibt die gemeldeten Spuren zurück (für Tests).
 */
export function pruefeSpuren(siteId: string, status: readonly ConsumerRuntimeStatus[] | null | undefined): string[] {
  if (offen.size === 0 || !status) return [];
  const t = jetzt();
  const gemeldet: string[] = [];
  for (const o of [...offen.values()]) {
    if (o.siteId !== siteId) continue;
    if (t - o.klick > SPUR_WARTET_MS) {
      offen.delete(o.entityId);
      continue;
    }
    const s = status.find((x) => x.entityId === o.entityId);
    if (spurUrteil(o.wunsch, s) !== 'bestaetigt') continue;
    offen.delete(o.entityId);
    gemeldet.push(o.spur);
    void melden(siteId, o.entityId, o.spur, { antwortMs: o.antwortMs, sichtbarMs: Math.round(t - o.klick) })
      .catch(() => undefined);
  }
  return gemeldet;
}

/** Nur für Tests. */
export function vergissSpuren(): void {
  offen.clear();
}
