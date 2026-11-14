/**
 * **Anlagen-Check** (Bedienkonzept `vp-privatkunde-bedienkonzept` §6, Captain BK-4 = BK-5 = BK-7 = A): die Wörter
 * der Kachel „Solaranlage", der Karte „Erzeugung nach Einheiten" und der „Speicher-Bilanz". Rein - das Urteil
 * bildet der Server (`AnlagenCheckRegel`), hier wird es nur gesagt und gerundet.
 *
 * Farbe nur als Marke (Kacheln.css: `is-ok` / `is-warn` / `is-ohne`); „liefert wie erwartet" steht da, nie Schweigen.
 */
import type {
  AnlagenCheck,
  AnlagenCheckEinheit,
  AnlagenCheckGesamt,
  AnlagenCheckUrteil,
  AnlagenCheckZeitraum,
  SpeicherBilanz,
} from './api';
import { fmtNum } from './format';
import { ANLAGEN_CHECK_SPEICHER_BILANZ, ANLAGEN_CHECK_VOLLZYKLEN } from './glossar';

const NBSP = ' ';


/** Ein Prozentwert aus einem Anteil, ganzzahlig, mit geschütztem Leerzeichen. */
export function prozentAus(anteil: number | null): string | null {
  return anteil == null ? null : `${Math.round(anteil * 100)}${NBSP}%`;
}

const kwh1 = (v: number | null) => (v == null ? '—' : fmtNum(v, 'kWh', 1));
const kwh0 = (v: number | null) => (v == null ? '—' : fmtNum(v, 'kWh', 0));

const WOCHENTAG_KURZ = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
const WOCHENTAG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function tagVon(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function tageZwischen(a: string, b: string): number {
  return Math.round((tagVon(b).getTime() - tagVon(a).getTime()) / 86_400_000);
}

function datumKurz(iso: string): string {
  const d = tagVon(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`;
}

/** „seit Di." innerhalb einer Woche vor `bis`, sonst „seit 03.11.". */
export function seitKurz(iso: string, bis: string): string {
  const d = tageZwischen(iso, bis);
  return d >= 0 && d < 7 ? `seit ${WOCHENTAG_KURZ[tagVon(iso).getUTCDay()]}` : `seit ${datumKurz(iso)}`;
}

/** „seit Mittwoch" innerhalb einer Woche vor `bis`, sonst „seit dem 03.11.". */
export function seitLang(iso: string, bis: string): string {
  const d = tageZwischen(iso, bis);
  return d >= 0 && d < 7 ? `seit ${WOCHENTAG[tagVon(iso).getUTCDay()]}` : `seit dem ${datumKurz(iso)}`;
}

/** „A", „A und B", „A, B und C". */
export function aufzaehlung(namen: string[]): string {
  if (namen.length <= 1) return namen[0] ?? '';
  return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

export type MarkeArt = 'ok' | 'warn' | 'ohne';

/** Die Aussage oben in der Kachel: Wortlaut und Ton der Marke. */
export function marke(u: AnlagenCheckUrteil, modus: AnlagenCheck['modus']): { text: string; art: MarkeArt } {
  const ganze = modus === 'ganze_anlage';
  const namen = (z: AnlagenCheckEinheit['zustand']) => u.einheiten.filter((e) => e.zustand === z).map((e) => e.name);
  switch (u.gesamt) {
    case 'wie_erwartet':
      return {
        // `ANLAGEN_CHECK_WIE_ERWARTET` ist das Glossar-Wort; hier steht es am Satzanfang bzw. im Plural.
        text: ganze || u.einheiten.length === 1 ? 'Liefert wie erwartet' : `Alle ${u.einheiten.length} liefern wie erwartet`,
        art: 'ok',
      };
    case 'weniger': {
      if (ganze) return { text: 'Liefert weniger als erwartet', art: 'warn' };
      const w = namen('weniger');
      return { text: `${aufzaehlung(w)} ${w.length === 1 ? 'liefert' : 'liefern'} weniger`, art: 'warn' };
    }
    case 'messwerte_fehlen':
      return { text: `Von ${aufzaehlung(namen('fehlt'))} fehlen Messwerte`, art: 'ohne' };
    case 'zu_wenig_sonne':
      return { text: 'Zu wenig Sonne für einen Vergleich', art: 'ohne' };
    case 'noch_zu_frueh':
      return { text: 'Noch zu kurz für einen Vergleich', art: 'ohne' };
  }
}

export interface KachelZeile {
  id: string;
  name: string;
  /** Rechts: „98 %", „—" oder ein Wort („keine Werte seit Di."). */
  wert: string;
  /** true: der Wert ist ein Wort, keine Zahl (ruhiger gesetzt). */
  wort: boolean;
  /** Füllung der Spur in Prozent (0..100). */
  fuellung: number;
  warn: boolean;
}

export interface SolarKachelModell {
  marke: { text: string; art: MarkeArt };
  zeilen: KachelZeile[];
  fuss: string;
  /** Eine Zeile („Ganze Anlage"): die Kachel steht klein. */
  klein: boolean;
}

/** Das Modell der Kachel „Solaranlage"; `null` ohne PV (keine Kachel). */
export function solarKachel(c: AnlagenCheck | null): SolarKachelModell | null {
  if (!c || c.pv !== true || !c.kachel) return null;
  const u = c.kachel;
  const zeilen: KachelZeile[] = u.einheiten.map((e) => {
    const pct = e.verhaeltnis == null ? null : Math.round(e.verhaeltnis * 100);
    if (e.zustand === 'fehlt') {
      return {
        id: e.id,
        name: e.name,
        wert: e.keineWerteSeit ? `keine Werte ${seitKurz(e.keineWerteSeit, u.bis)}` : 'Messwerte lückenhaft',
        wort: true,
        fuellung: 0,
        warn: false,
      };
    }
    return {
      id: e.id,
      name: e.name,
      wert: pct == null ? '—' : `${pct}${NBSP}%`,
      wort: pct == null,
      fuellung: pct == null ? 0 : Math.max(0, Math.min(100, pct)),
      warn: e.zustand === 'weniger',
    };
  });
  return { marke: marke(u, c.modus), zeilen, fuss: kachelFuss(u), klein: zeilen.length <= 1 };
}

/** Die graue Zeile unten: Fenster und was nicht gewertet ist. */
export function kachelFuss(u: AnlagenCheckUrteil): string {
  if (u.abgeregelteTage > 0) {
    const t = u.abgeregelteTage === 1 ? '1 Tag' : `${u.abgeregelteTage} Tage`;
    return `${u.sonnenTage} von ${u.fensterTage} Tagen · ${t} abgeregelt, nicht gewertet`;
  }
  if (u.gesamt === 'zu_wenig_sonne') return `letzte ${u.fensterTage} Tage · ab 3 Tagen mit Sonne`;
  return `letzte ${u.fensterTage} Tage · gemessen gegen erwartet`;
}

// ---- Karte „Erzeugung nach Einheiten" --------------------------------------------------------------

export interface KarteZeile {
  id: string;
  name: string;
  /** „erwartet 155 kWh" oder null. */
  erwartet: string | null;
  wert: string;
  prozent: string | null;
  warn: boolean;
}

export interface SolarKarteModell {
  sub: string | null;
  zeilen: KarteZeile[];
  saeulen: { start: string; kopf: string; summe: number; teile: (number | null)[] }[];
  satz: string | null;
  /** Grau unter dem Satz: Einheiten ohne gemessenes Gerät. */
  hinweis: string | null;
}

const MONAT = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];

function saeulenKopf(iso: string, eimer: AnlagenCheckZeitraum['eimer']): string {
  const d = tagVon(iso);
  if (eimer === 'monat') return MONAT[d.getUTCMonth()];
  return `${WOCHENTAG_KURZ[d.getUTCDay()]}, ${datumKurz(iso)}`;
}

/** Der Satz unter der Karte - EINE Aussage, wie in der Kachel, aber über den Zeitraum. */
export function karteSatz(z: AnlagenCheckZeitraum, modus: AnlagenCheck['modus']): string | null {
  if (z.bisAbgeschlossen == null) return 'Der Vergleich beginnt mit dem ersten abgeschlossenen Tag.';
  const g: AnlagenCheckGesamt | null = z.gesamt;
  if (g == null) return null;
  const bis = z.bisAbgeschlossen;
  const ganze = modus === 'ganze_anlage';
  switch (g) {
    case 'wie_erwartet':
      return ganze || z.einheiten.length === 1
        ? 'Die Anlage liefert wie erwartet.'
        : `Alle ${z.einheiten.length} liefern wie erwartet.`;
    case 'weniger': {
      if (ganze) return 'Die Anlage liefert weniger als erwartet.';
      const w = z.einheiten.filter((e) => e.zustand === 'weniger');
      if (w.length === 1 && w[0].wenigerSeit) {
        return `${w[0].name} liefert ${seitLang(w[0].wenigerSeit, bis)} weniger als erwartet.`;
      }
      return `${aufzaehlung(w.map((e) => e.name))} ${w.length === 1 ? 'liefert' : 'liefern'} weniger als erwartet.`;
    }
    case 'messwerte_fehlen':
      return `Von ${aufzaehlung(z.einheiten.filter((e) => e.zustand === 'fehlt').map((e) => e.name))} fehlen Messwerte.`;
    case 'zu_wenig_sonne':
      return 'Zu wenig Sonne für einen Vergleich.';
    case 'noch_zu_frueh':
      return 'Noch zu kurz für einen Vergleich.';
  }
}

/** Das Modell der Karte; `null` ohne PV oder ohne Zeitraum. */
export function solarKarte(c: AnlagenCheck | null): SolarKarteModell | null {
  if (!c || c.pv !== true || !c.zeitraum) return null;
  const z = c.zeitraum;
  const sub =
    z.gemessenKwh == null
      ? null
      : z.erwartetKwh == null
        ? kwh1(z.gemessenKwh)
        : `${kwh1(z.gemessenKwh)} · erwartet ${kwh0(z.erwartetKwh)}`;
  const zeilen: KarteZeile[] = z.einheiten.map((e) => ({
    id: e.id,
    name: e.name,
    erwartet: e.erwartetKwh == null ? null : `erwartet ${kwh0(e.erwartetKwh)}`,
    wert: kwh1(e.gemessenKwh),
    prozent: e.zustand === 'fehlt' ? null : prozentAus(e.verhaeltnis),
    warn: e.zustand === 'weniger',
  }));
  const saeulen = z.saeulen.map((s) => ({
    start: s.start,
    kopf: saeulenKopf(s.start, z.eimer),
    summe: s.kwh.reduce<number>((a, v) => a + (v ?? 0), 0),
    teile: s.kwh,
  }));
  const hinweis =
    c.modus === 'einheiten' && c.ohneGeraet.length > 0
      ? `Ohne gemessenes Gerät, nicht verglichen: ${aufzaehlung(c.ohneGeraet)}.`
      : null;
  return { sub, zeilen, saeulen, satz: karteSatz(z, c.modus), hinweis };
}

// ---- Speicher-Bilanz -------------------------------------------------------------------------------

export interface BilanzZelle {
  titel: string;
  wert: string;
  sub: string;
}

export interface SpeicherBilanzModell {
  titel: string;
  zellen: BilanzZelle[];
  satz: { text: string; ton: 'ok' | 'warn' | 'ohne' } | null;
  /** Je Monat dieselben drei Zahlen wie die Karte (Verlust = hinein × (1 − Wirkungsgrad), mit Ausgleich). */
  monate: { monat: string; wirkungsgrad: string; vollzyklen: string | null; verlust: string }[];
}

function band(b: SpeicherBilanz): string {
  const lo = Math.round((b.vergleichMin ?? 0) * 100);
  const hi = Math.round((b.vergleichMax ?? 0) * 100);
  return lo === hi ? `${lo}${NBSP}%` : `${lo}–${hi}${NBSP}%`;
}

function monatWort(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONAT[m - 1]} ${y}`;
}

/** Das Modell der Karte „Speicher-Bilanz"; `null` ohne Daten (kein Speicher - keine Karte). */
export function speicherBilanz(b: SpeicherBilanz | null): SpeicherBilanzModell | null {
  if (!b || (b.zustand !== 'normal' && b.zustand !== 'wenig')) return null;
  const mitKap = b.kapazitaetKwh != null;
  const wenig = b.zustand === 'wenig';
  const zellen: BilanzZelle[] = [
    {
      titel: 'Wirkungsgrad',
      wert: wenig || b.wirkungsgrad == null ? '—' : `${Math.round(b.wirkungsgrad * 100)}${NBSP}%`,
      sub: wenig
        ? `erst ${kwh0(b.hineinKwh)} geladen`
        : `${kwh0(b.hineinKwh)} hinein, ${kwh0(b.herausKwh)} heraus`,
    },
  ];
  if (mitKap) {
    zellen.push({
      titel: ANLAGEN_CHECK_VOLLZYKLEN,
      wert: b.vollzyklen == null ? '—' : String(Math.round(b.vollzyklen)),
      sub: b.vollzyklenSeitBeginn == null ? '' : `seit Beginn ${Math.round(b.vollzyklenSeitBeginn).toLocaleString('de-DE')}`,
    });
  }
  zellen.push({
    titel: 'Verlust',
    wert: wenig || b.verlustKwh == null ? '—' : kwh0(Math.max(0, b.verlustKwh)),
    sub: wenig ? '' : 'Wärme und Eigenbedarf',
  });
  let satz: SpeicherBilanzModell['satz'] = null;
  if (wenig) {
    satz = {
      text: mitKap
        ? 'Noch zu wenig geladen für eine Bilanz – ab etwa 5 Vollzyklen.'
        : 'Noch zu wenig geladen für eine Bilanz.',
      ton: 'ohne',
    };
  } else if (b.satz === 'unauffaellig') {
    satz = { text: `Unauffällig – wie in den letzten 12 Monaten (${band(b)}).`, ton: 'ok' };
  } else if (b.satz === 'niedriger') {
    satz = { text: `Niedriger als in den letzten 12 Monaten (${band(b)}).`, ton: 'warn' };
  }
  return {
    titel: `${ANLAGEN_CHECK_SPEICHER_BILANZ} · ${b.fensterTage} Tage`,
    zellen,
    satz,
    monate: b.monate.map((m) => ({
      monat: monatWort(m.monat),
      wirkungsgrad: m.wirkungsgrad == null ? '—' : `${Math.round(m.wirkungsgrad * 100)}${NBSP}%`,
      vollzyklen: m.vollzyklen == null ? null : String(Math.round(m.vollzyklen)),
      verlust: m.wirkungsgrad == null ? '—' : kwh0(Math.max(0, m.hineinKwh * (1 - m.wirkungsgrad))),
    })),
  };
}
