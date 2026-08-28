/**
 * Die Kachel „Laden" - der GROSSE Teil der Verbraucher-Sichtbarkeit (Konzept
 * `vp-verbraucher-cockpit-k1` §5, Captain-Entscheide E1/E2/E6).
 *
 * Sie beantwortet, was die Aufschlüsselung ohne Klick NICHT beantworten kann:
 * „steckt ein Auto?" (Konzept §7). Reine Anzeige - kein Start, kein Stopp,
 * keine Freigabe (Captain); jede Zeile ist ein Absprung auf ihre Geräteseite,
 * der Kopf auf die Seite „Ladevorgänge".
 *
 * ⚠ Die WORTE kommen aus {@link ladeZustand} - dieselbe eine Quelle wie die
 * Ladevorgänge-Seite und die Aufschlüsselung. Geschlüsselt wird auf das
 * MASCHINEN-Wort {@link LadeZustandKind}, nie auf den deutschen Satz.
 *
 * Rein + rahmenfrei (getestet in `ladenKachel.test.ts`).
 */
import { fmtNum } from './format';
import {
  budgetBand,
  chargerName,
  connectorName,
  ladeZustand,
  type BudgetBand,
  type ChargePoint,
  type LadeZustandKind,
  type LadeTone,
  type SiteCharging,
} from './ladepunkte';

/** E6: bis hierher trägt jede Säule ihre volle Zeile. */
export const VOLLE_ZEILEN = 6;

/** Die Zustände, in denen wirklich geladen wird. */
const LAEDT: ReadonlySet<LadeZustandKind> = new Set<LadeZustandKind>([
  'laedt',
  'laedt_ohne_messung',
]);

/** Die Zustände, in denen ein Auto steckt (aber nicht lädt). */
const STECKT: ReadonlySet<LadeZustandKind> = new Set<LadeZustandKind>([
  'startet',
  'nimmt_nichts',
  'wartet',
  'saeule_pausiert',
  'auto_pausiert',
  'beendet',
]);

/** Eine Zeile der Kachel - ein Stecker, oder eine Säule ohne Stecker. */
export interface LadenZeile {
  key: string;
  /** Der Name wie auf der Geräteseite. */
  label: string;
  /** Das Zustandswort aus der EINEN Quelle. */
  word: string;
  /** Der Grund/Zusatz der Box (unverändert) plus „seit HH:MM", wo es passt. */
  note: string | null;
  tone: LadeTone;
  kind: LadeZustandKind;
  /** Gemessene Leistung; `null` = nicht gemessen (nie eine 0). */
  kw: number | null;
  /** Der Sprung auf die Geräteseite; `null` = kein Ziel. */
  href: string | null;
}

export interface LadenKachel {
  /** „Lädt · 11,0 kW" / „2 von 6 laden · 22,0 kW" / „Kein Auto eingesteckt". */
  kopf: string;
  /** Die Unterzeile des Kopfes („Auto eingesteckt · seit 14:10", „2 warten · 2 frei"). */
  unterzeile: string | null;
  zeilen: LadenZeile[];
  /**
   * E6: die ruhenden Säulen sind eingeklappt - dieser Satz sagt, wie viele und
   * warum. `null`, solange jede Zeile voll dasteht.
   */
  ruhendText: string | null;
  /** Das Netzanschluss-Band als Fußzeile - der Block zieht in diese Kachel. */
  band: BudgetBand | null;
  /** Der Sprung des Kopfes (die Seite „Ladevorgänge"). */
  href: string | null;
  /** Σ kW der ladenden Stecker; `null`, wenn keiner misst. */
  ladenKw: number | null;
  ladend: number;
  stecker: number;
}

export interface LadenKachelInput {
  charging: SiteCharging | null | undefined;
  links?: {
    /** Die Seite „Ladevorgänge" - der Sprung des Kopfes. */
    uebersicht?: () => string | null;
    /** Die Geräteseite einer Säule. */
    charger?: (chargePointId: string) => string | null;
  } | null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** „seit 14:10" - null, wenn der Zeitpunkt nicht lesbar ist. */
function seit(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return `seit ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(t)}`;
}

/**
 * Die Kachel, oder `null`, wenn es keinen einzigen Ladepunkt gibt - dann ist
 * der Baustein gar nicht erst verfügbar und lässt sich auch nicht anordnen.
 */
export function ladenKachel(input: LadenKachelInput): LadenKachel | null {
  const chargers = input.charging?.chargers ?? [];
  if (chargers.length === 0) return null;
  const links = input.links ?? {};

  const zeilen: LadenZeile[] = [];
  let ladend = 0;
  let steckt = 0;
  let frei = 0;
  let getrennt = 0;
  let ladenKw: number | null = null;
  let ersteLadung: { label: string; note: string | null } | null = null;

  for (const c of chargers) {
    const cons = c.connectors ?? [];
    const href = links.charger?.(c.chargePointId) ?? null;
    if (cons.length === 0) {
      // Eine Säule ohne gemeldeten Stecker ist trotzdem ein Ladepunkt.
      const verbunden = c.connected === true;
      if (!verbunden) getrennt += 1;
      zeilen.push({
        key: `cp:${c.chargePointId}`,
        label: chargerName(c),
        word: verbunden ? 'Noch kein Stecker gemeldet' : 'Säule getrennt',
        note: verbunden ? null : letztKontakt(c),
        tone: verbunden ? 'ruhig' : 'stoerung',
        kind: verbunden ? 'frei' : 'getrennt',
        kw: null,
        href,
      });
      continue;
    }
    for (const con of cons) {
      const z = ladeZustand(con, c);
      const laedt = LAEDT.has(z.kind);
      // ⚠ Der Messwert gehört NUR einem wirklich ladenden Stecker.
      const kw = z.kind === 'laedt' ? num(con.powerKw) : null;
      if (laedt) {
        ladend += 1;
        if (kw != null) ladenKw = round3((ladenKw ?? 0) + kw);
      } else if (z.kind === 'getrennt') {
        getrennt += 1;
      } else if (STECKT.has(z.kind)) {
        steckt += 1;
      } else {
        frei += 1;
      }
      const note = [z.reason, z.detail, seit(con.sessionSince)]
        .filter((s): s is string => s != null && s !== '')
        .join(' · ');
      const label = cons.length > 1
        ? `${chargerName(c)} · ${connectorName(con.connectorId)}`
        : chargerName(c);
      if (laedt && ersteLadung == null) {
        ersteLadung = { label, note: note === '' ? null : note };
      }
      zeilen.push({
        key: `cp:${c.chargePointId}#${con.connectorId}`,
        label,
        word: z.word,
        note: note === '' ? null : note,
        tone: z.tone,
        kind: z.kind,
        kw,
        href,
      });
    }
  }

  const stecker = zeilen.length;
  const sortiert = sortiere(zeilen);
  // E6: ab der siebten Zeile stehen die Aktiven voll da, die Ruhenden
  // kollabieren auf einen Satz - eine Kachel ist keine Liste.
  const kollabiert = sortiert.length > VOLLE_ZEILEN;
  const sichtbar = kollabiert ? sortiert.filter((z) => LAEDT.has(z.kind)) : sortiert;
  const ruhend = sortiert.length - sichtbar.length;

  return {
    kopf: kopfSatz(ladend, stecker, ladenKw, getrennt, steckt),
    unterzeile: unterSatz(ladend, steckt, frei, getrennt, ersteLadung),
    zeilen: sichtbar,
    ruhendText: ruhend > 0 ? ruhendSatz(ruhend) : null,
    band: budgetBand(input.charging?.budget ?? null),
    href: links.uebersicht?.() ?? null,
    ladenKw,
    ladend,
    stecker,
  };
}

/**
 * Aktive zuerst nach Leistung, danach die eingesteckten, dann die freien und
 * zuletzt die getrennten - die Reihenfolge der Aufmerksamkeit.
 */
function sortiere(zeilen: LadenZeile[]): LadenZeile[] {
  const rang = (z: LadenZeile) =>
    LAEDT.has(z.kind) ? 0 : z.kind === 'getrennt' ? 3 : STECKT.has(z.kind) ? 1 : 2;
  return [...zeilen].sort((a, b) => {
    const ra = rang(a);
    const rb = rang(b);
    if (ra !== rb) return ra - rb;
    if (a.kw != null && b.kw != null && a.kw !== b.kw) return b.kw - a.kw;
    if (a.kw != null && b.kw == null) return -1;
    if (a.kw == null && b.kw != null) return 1;
    return a.label.localeCompare(b.label, 'de');
  });
}

function kopfSatz(
  ladend: number,
  stecker: number,
  kw: number | null,
  getrennt: number,
  steckt: number,
): string {
  // Alles getrennt: dann gibt es GAR KEINE aktuelle Aussage über Autos.
  if (getrennt > 0 && getrennt === stecker) {
    return stecker === 1 ? 'Säule getrennt' : 'Säulen getrennt';
  }
  if (ladend === 0) {
    return steckt > 0 ? 'Eingesteckt · lädt gerade nicht' : 'Kein Auto eingesteckt';
  }
  const zahl = kw == null ? 'Leistung nicht messbar' : fmtNum(kw, 'kW');
  if (stecker === 1) return `Lädt · ${zahl}`;
  return `${ladend} von ${stecker} ${ladend === 1 ? 'lädt' : 'laden'} · ${zahl}`;
}

function unterSatz(
  ladend: number,
  steckt: number,
  frei: number,
  getrennt: number,
  ersteLadung: { label: string; note: string | null } | null,
): string | null {
  // Eine EINZELNE Ladung sagt ihre Geschichte, statt zu zählen. „Auto
  // eingesteckt" ist dabei keine Vermutung: wer lädt, steckt.
  if (ladend === 1 && steckt === 0 && getrennt === 0 && frei === 0) {
    const note = ersteLadung?.note;
    return note ? `Auto eingesteckt · ${note}` : 'Auto eingesteckt';
  }
  const teile: string[] = [];
  if (steckt > 0) teile.push(`${steckt} ${steckt === 1 ? 'wartet' : 'warten'}`);
  if (frei > 0) teile.push(`${frei} frei`);
  if (getrennt > 0) teile.push(`${getrennt} getrennt`);
  return teile.length > 0 ? teile.join(' · ') : null;
}

function ruhendSatz(n: number): string {
  return n === 1 ? '1 weiterer Ladepunkt lädt gerade nicht' : `${n} weitere laden gerade nicht`;
}

/** „zuletzt 08:50" - null ohne gemeldeten Zeitpunkt. */
function letztKontakt(c: ChargePoint): string | null {
  if (!c.lastSeen) return null;
  const t = new Date(c.lastSeen);
  if (Number.isNaN(t.getTime())) return null;
  return `zuletzt ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(t)}`;
}
