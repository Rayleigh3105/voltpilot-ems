/**
 * Reine Zeitrechnung für Ruhezeit-Fenster (Alerting Scheibe 3, Konzept §6.4) - der Portal-Zwilling
 * von `RuhezeitFenster.java` (API), NUR für die Live-Vorschau im Blatt ("Ruhezeit ist jetzt aktiv
 * bis …"); die tatsächliche Zustellung entscheidet ausschließlich der Server. Dieselbe JSON-Form:
 *
 * ```json
 * {"werktags": {"von": "22:00", "bis": "07:00"}, "wochenende": "ganz"}
 * ```
 *
 * `wochenende` ist entweder das Wort `"ganz"` (Samstag UND Sonntag) oder ein `{von,bis}`-Objekt wie
 * `werktags`; beide Felder sind optional. `von > bis` überspannt Mitternacht.
 *
 * Der volle Eintrag im Fachmodell-Glossar (`docs/fachmodell`) ist für diese Scheibe bewusst
 * zurückgestellt (dasselbe Vorgehen wie `meldungen.ts`) - das Glossar verlangt belegte
 * Zeilenverweise gegen einen festgehaltenen Repo-Stand, den eine neue Scheibe noch nicht hat.
 */

export interface RuhezeitTeilfenster {
  von: string;
  bis: string;
}

export interface RuhezeitRegeln {
  werktags?: RuhezeitTeilfenster;
  wochenende?: 'ganz' | RuhezeitTeilfenster;
}

const WOCHENTAGE_WOCHENENDE = new Set(['Sat', 'Sun']);

function lokaleTeile(zeitpunkt: Date, zeitzone: string) {
  const formatiert = new Intl.DateTimeFormat('en-US', {
    timeZone: zeitzone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(zeitpunkt);
  const wert = (typ: string) => formatiert.find((t) => t.type === typ)?.value ?? '0';
  return {
    jahr: Number(wert('year')),
    monat: Number(wert('month')),
    tag: Number(wert('day')),
    stunde: Number(wert('hour')) % 24,
    minute: Number(wert('minute')),
    sekunde: Number(wert('second')),
    wochentag: wert('weekday'),
  };
}

/** Wandelt lokale Kalenderfelder EINER Zeitzone in den entsprechenden absoluten Zeitpunkt um. */
function alsZeitpunkt(jahr: number, monat: number, tag: number, stunde: number, minute: number, zeitzone: string): Date {
  const roh = Date.UTC(jahr, monat - 1, tag, stunde, minute, 0);
  const abgelesen = lokaleTeile(new Date(roh), zeitzone);
  const abgelesenAlsUtc = Date.UTC(abgelesen.jahr, abgelesen.monat - 1, abgelesen.tag, abgelesen.stunde,
    abgelesen.minute, abgelesen.sekunde);
  return new Date(roh - (abgelesenAlsUtc - roh));
}

function minuten(zeit: string): number {
  const [h, m] = zeit.split(':').map(Number);
  return h * 60 + m;
}

function fensterDesTages(regeln: RuhezeitRegeln, tagStart: Date, zeitzone: string): [Date, Date] | null {
  const teile = lokaleTeile(tagStart, zeitzone);
  const wochenendtag = WOCHENTAGE_WOCHENENDE.has(teile.wochentag);
  if (wochenendtag) {
    const wochenende = regeln.wochenende;
    if (wochenende == null) return null;
    if (wochenende === 'ganz') {
      if (teile.wochentag !== 'Sat') return null; // nur Samstag trägt das zweitägige Fenster
      const start = alsZeitpunkt(teile.jahr, teile.monat, teile.tag, 0, 0, zeitzone);
      const ende = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
      return [start, ende];
    }
    return vonBis(wochenende, teile, zeitzone);
  }
  if (!regeln.werktags) return null;
  return vonBis(regeln.werktags, teile, zeitzone);
}

function vonBis(spec: RuhezeitTeilfenster, teile: ReturnType<typeof lokaleTeile>, zeitzone: string): [Date, Date] {
  const vonMin = minuten(spec.von);
  const bisMin = minuten(spec.bis);
  const start = alsZeitpunkt(teile.jahr, teile.monat, teile.tag, Math.floor(vonMin / 60), vonMin % 60, zeitzone);
  let ende = alsZeitpunkt(teile.jahr, teile.monat, teile.tag, Math.floor(bisMin / 60), bisMin % 60, zeitzone);
  if (bisMin <= vonMin) {
    ende = new Date(ende.getTime() + 24 * 60 * 60 * 1000); // überspannt Mitternacht
  }
  return [start, ende];
}

/** `null`, wenn `jetzt` in KEINEM Fenster liegt; sonst der Zeitpunkt, an dem es endet. */
export function ruhezeitEndeFallsAktiv(regeln: RuhezeitRegeln, zeitzone: string, jetzt: Date): Date | null {
  for (const tagVersatz of [-1, 0]) {
    const heute = lokaleTeile(jetzt, zeitzone);
    const tagStart = alsZeitpunkt(heute.jahr, heute.monat, heute.tag + tagVersatz, 0, 0, zeitzone);
    const fenster = fensterDesTages(regeln, tagStart, zeitzone);
    if (!fenster) continue;
    const [start, ende] = fenster;
    if (jetzt.getTime() >= start.getTime() && jetzt.getTime() < ende.getTime()) {
      return ende;
    }
  }
  return null;
}
