/** AP-17 NW-1: reine Regeln der Bezugsbasis (docs/contracts/v2/bezugsbasis.md). Keine Fläche ruft sie bisher auf.
 * Zwillinge: BezugsbasisRegeln.java und voltpilot_optimization/bezugsbasis.py; alle drei fahren bezugsbasis-vectors.json.
 * Gerechnet wird mit exakten Brüchen (BigInt); gerundet wird nur die Ausgabe, kaufmännisch (,5 vom Nullpunkt weg) —
 * nie `Math.round`. Band, Spannweite und Abhängigkeit werden per Kreuzprodukt geprüft.
 */
import { halbAuf } from './dez';

export const STARTWERTE = { mindest_monate: 12, toleranz_prozent: '2', spannweite_prozent: '10', abhaengig_r: '0.9', wiedervorlage_monate: 12 };
export const METHODEN = ['verhaeltnis', 'regression_eine_variable', 'regression_zwei_variablen', 'gradtage'];
export const URTEILE = ['besser', 'schlechter', 'im_rahmen', 'ohne_urteil', 'nicht_anwendbar'];
export const GRUENDE = ['basis_fehlt', 'basis_beendet', 'zu_wenig_perioden', 'variable_fehlt', 'variable_ausserhalb',
  'variablen_abhaengig', 'keine_werte', 'periode_nicht_zu_ende'];
export const DATENLAGE = ['vollstaendig', 'vorlaeufig'];
export const RICHTUNGEN = ['mehr', 'weniger', 'gleich'];
export const ANPASSUNGSGRUENDE = ['referenzperiode_vervollstaendigt', 'grundlage_korrigiert', 'struktur_geaendert', 'variable_geaendert',
  'methode_geaendert', 'nicht_mehr_anwendbar', 'sonstiger'];
export const FAKTOR_ARTEN = ['flaeche', 'standort', 'anlage', 'prozess', 'kostenstelle', 'wortlaut'];
export const BASIS_ZUSTAENDE = ['entwurf', 'freigegeben', 'anstoss_liegt_vor', 'ueberpruefung_faellig', 'beendet'];
export const FREIGABE_STATUS = ['beantragt', 'freigegeben', 'abgelehnt'];
const NA = 'nicht_anwendbar', OHNE = 'ohne_urteil';

export interface Variable { name: string; einheit: string; art: string }
export interface Spannweite { von: string; bis: string; toleriert_von: string; toleriert_bis: string }
export interface Fassung {
  kennzeichen: string; fassung: number; methode: string; monate: number; basiswert: string | null;
  koeffizienten: { a: string; b: string; c?: string } | null; streuung_prozent: string | null; toleranz_prozent: string;
  spannweite: Spannweite[] | null; variablen: Variable[];
}
export interface Wert { wert: string | null; zustand?: string; kennzeichen?: string[] }
export interface VergleichEingang { fassung: Fassung | null; basis_beendet?: boolean; abgeschlossen: boolean; gemessen: Wert; variablen: Wert[] }
export interface ZeitraumEingang { fassung: Fassung | null; basis_beendet?: boolean; soll_monate: number;
  monate: { abgeschlossen: boolean; gemessen: Wert; variablen: Wert[] }[] }
export interface Ergebnis {
  urteil: string; grund: string | null; gemessen: string | null; erwartet: string | null; delta_prozent: string | null;
  band_prozent: string | null; richtung: string | null; kennzeichen: string[]; monate?: string;
}

/** Exakter Bruch z/n mit n > 0 — das Gegenstück zu `fractions.Fraction`. */
type Q = { z: bigint; n: bigint };
const abs = (x: bigint) => (x < 0n ? -x : x);
const ggt = (a: bigint, b: bigint): bigint => { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; };
const bruch = (z: bigint, n: bigint): Q => {
  if (n < 0n) { z = -z; n = -n; }
  const g = ggt(z, n);
  return g > 1n ? { z: z / g, n: n / g } : { z, n };
};
const q = (text: string): Q => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`kein Dezimaltext: ${text}`);
  const nach = m[3] ?? '';
  return bruch(BigInt(`${m[1]}${m[2]}${nach}`), 10n ** BigInt(nach.length));
};
const ganz = (v: number | bigint): Q => ({ z: BigInt(v), n: 1n });
const NULL = ganz(0);
const plus = (a: Q, b: Q) => bruch(a.z * b.n + b.z * a.n, a.n * b.n);
const minus = (a: Q, b: Q) => bruch(a.z * b.n - b.z * a.n, a.n * b.n);
const mal = (a: Q, b: Q) => bruch(a.z * b.z, a.n * b.n);
const durch = (a: Q, b: Q) => bruch(a.z * b.n, a.n * b.z);
const betrag = (a: Q): Q => ({ z: abs(a.z), n: a.n });
const cmp = (a: Q, b: Q) => { const x = a.z * b.n, y = b.z * a.n; return x < y ? -1 : x > y ? 1 : 0; };
const summe = (w: Q[]) => w.reduce(plus, NULL);
const mittel = (w: Q[]) => durch(summe(w), ganz(w.length));

function text(z: bigint, stellen: number): string {
  const ziffern = abs(z).toString().padStart(stellen + 1, '0');
  const vorn = ziffern.slice(0, ziffern.length - stellen), hinten = ziffern.slice(ziffern.length - stellen);
  return `${z < 0n ? '-' : ''}${vorn}${stellen > 0 ? `.${hinten}` : ''}`;
}
const fest = (x: Q, stellen: number) => text(halbAuf(x.z * 10n ** BigInt(stellen), x.n), stellen);
function kurz(x: Q, stellen: number): string {
  const t = fest(x, stellen);
  return t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
}
function exakt(x: Q): string {
  let n = x.n, stellen = 0;
  while (n !== 1n) {
    if (n % 2n === 0n) n /= 2n;
    else if (n % 5n === 0n) n /= 5n;
    else throw new Error(`kein endlicher Dezimalbruch: ${x.z}/${x.n}`);
    stellen++;
  }
  return stellen === 0 ? x.z.toString() : kurz(x, stellen);
}
function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = BigInt(Math.floor(Math.sqrt(Number(v)))) + 1n;
  for (;;) {
    const y = (x + v / x) / 2n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > v) x--;
  while ((x + 1n) * (x + 1n) <= v) x++;
  return x;
}
/** √x kaufmännisch auf `stellen`: ⌊(⌊√⌊4·x·10^2k⌋⌋ + 1) / 2⌋ — exakt, ohne Gleitkomma. */
function wurzelFest(x: Q, stellen: number): string {
  const v = mal(x, ganz(4n * 10n ** BigInt(2 * stellen)));
  return text((isqrt(v.z / v.n) + 1n) / 2n, stellen);
}
/** Zahl im Kennzeichen: Dezimalkomma, Tausender mit Leerzeichen (§5.8). */
function de(t: string): string {
  const minus = t.startsWith('-');
  const [vorn, hinten = ''] = (minus ? t.slice(1) : t).split('.');
  return `${minus ? '−' : ''}${vorn.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${hinten ? `,${hinten}` : ''}`;
}
const datenlage = (monate: number) => (monate < STARTWERTE.mindest_monate ? 'vorlaeufig' : 'vollstaendig');
const vorlaeufig = (monate: number) => `Bezugsbasis vorläufig (${monate} von ${STARTWERTE.mindest_monate} Monaten)`;

/** P1/P2: ganze, abgeschlossene Kalendermonate `JJJJ-MM/JJJJ-MM`; unter der Mindestlänge vorläufig. */
export function referenzperiode(t: string, laufenderMonat: string) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])\/(\d{4})-(0[1-9]|1[0-2])$/.exec(t ?? '');
  const fehler = (f: string) => ({ gueltig: false, monate: null, datenlage: null, fehler: f });
  if (!m) return fehler('referenzperiode_format');
  const von = Number(m[1]) * 12 + Number(m[2]) - 1, bis = Number(m[3]) * 12 + Number(m[4]) - 1;
  if (bis < von) return fehler('referenzperiode_reihenfolge');
  const [jahr, monat] = laufenderMonat.split('-').map(Number);
  if (bis >= jahr * 12 + monat - 1) return fehler('periode_nicht_zu_ende');
  const monate = bis - von + 1;
  return { gueltig: true, monate, datenlage: datenlage(monate), fehler: null };
}

/** M1: Σ Zähler ÷ Σ Nenner der Referenzperiode — Summe durch Summe, nie ein Mittel. */
export function basiswert(grundlage: { zaehler: string | null; nenner: string | null }[]) {
  const n = grundlage.length;
  const keine = { basiswert: null, monate: n, datenlage: null, grund: 'keine_werte', kennzeichen: [] as string[] };
  if (n === 0 || grundlage.some(g => g.zaehler === null || g.nenner === null)) return keine;
  const zaehler = summe(grundlage.map(g => q(g.zaehler!))), nenner = summe(grundlage.map(g => q(g.nenner!)));
  if (nenner.z <= 0n) return keine;
  const lage = datenlage(n);
  return { basiswert: kurz(durch(zaehler, nenner), 4), monate: n, datenlage: lage, grund: null,
    kennzeichen: lage === 'vorlaeufig' ? [vorlaeufig(n)] : [] };
}

function summen(xs: Q[], ys: Q[]) {
  const mx = mittel(xs), my = mittel(ys);
  let sxx = NULL, sxy = NULL, syy = NULL;
  xs.forEach((x, i) => {
    const dx = minus(x, mx), dy = minus(ys[i], my);
    sxx = plus(sxx, mal(dx, dx)); sxy = plus(sxy, mal(dx, dy)); syy = plus(syy, mal(dy, dy));
  });
  return { sxx, sxy, syy, mx, my };
}

function abhaengigkeitQ(x1: Q[], x2: Q[]): { r: string | null; abhaengig: boolean } {
  const s = summen(x1, x2);
  if (s.sxx.z === 0n || s.syy.z === 0n) return { r: null, abhaengig: false };
  const r2 = durch(mal(s.sxy, s.sxy), mal(s.sxx, s.syy));
  const r = wurzelFest(r2, 3);
  const grenze = q(STARTWERTE.abhaengig_r);
  return { r: kurz(q(s.sxy.z < 0n && r !== '0.000' ? `-${r}` : r), 3), abhaengig: cmp(r2, mal(grenze, grenze)) >= 0 };
}
/** G4: Pearson r; abhängig ab |r| ≥ 0,9 — geprüft als sxy² ≥ 0,81·sxx·syy. */
export const abhaengigkeit = (x1: string[], x2: string[]) => abhaengigkeitQ(x1.map(q), x2.map(q));

function spannweite(xs: Q[]) {
  const von = xs.reduce((a, b) => (cmp(a, b) <= 0 ? a : b)), bis = xs.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  const p = durch(q(STARTWERTE.spannweite_prozent), ganz(100));
  return { von: exakt(von), bis: exakt(bis), toleriert_von: exakt(mal(von, minus(ganz(1), p))), toleriert_bis: exakt(mal(bis, plus(ganz(1), p))) };
}

/** M2/M3: kleinste Quadrate aus den Monatspaaren; R², Streuung in % des Mittels, Spannweite je Variable; G1, G4. */
export function modell(methode: string, reihe: { zaehler: string | null; variablen: (string | null)[] }[]) {
  const n = reihe.length;
  const abgelehnt: { variable: number; grund: string; r: string | null }[] = [];
  const leer = (grund: string) => ({ methode, monate: n, basiswert: null, koeffizienten: null, r2: null, streuung_prozent: null,
    spannweite: [] as ReturnType<typeof spannweite>[], abgelehnt, grund });
  if (n === 0 || reihe.some(r => r.zaehler === null || r.variablen.includes(null))) return leer('keine_werte');
  if (n < STARTWERTE.mindest_monate) return leer('zu_wenig_perioden');
  const ys = reihe.map(r => q(r.zaehler!));
  let spalten = reihe[0].variablen.map((_, i) => reihe.map(r => q(r.variablen[i]!)));
  if (spalten.length === 2) {
    const pruefung = abhaengigkeitQ(spalten[0], spalten[1]);
    if (pruefung.abhaengig) {
      abgelehnt.push({ variable: 2, grund: 'variablen_abhaengig', r: pruefung.r });
      spalten = spalten.slice(0, 1);
    }
  }
  const ergebnis = methode === 'regression_zwei_variablen' && spalten.length === 1 ? 'regression_eine_variable' : methode;
  const my = mittel(ys);
  let koeff: Record<string, Q>;
  let erwartet: Q[];
  if (spalten.length === 1) {
    const s = summen(spalten[0], ys);
    if (s.sxx.z === 0n) return leer('zu_wenig_perioden');
    const b = durch(s.sxy, s.sxx), a = minus(my, mal(b, s.mx));
    koeff = { a, b };
    erwartet = spalten[0].map(x => plus(a, mal(b, x)));
  } else {
    const [x1, x2] = spalten;
    const s1 = summen(x1, ys), s2 = summen(x2, ys);
    const s12 = summe(x1.map((u, i) => mal(minus(u, s1.mx), minus(x2[i], s2.mx))));
    const det = minus(mal(s1.sxx, s2.sxx), mal(s12, s12));
    if (det.z === 0n) return leer('zu_wenig_perioden');
    const b = durch(minus(mal(s1.sxy, s2.sxx), mal(s2.sxy, s12)), det);
    const c = durch(minus(mal(s2.sxy, s1.sxx), mal(s1.sxy, s12)), det);
    const a = minus(minus(my, mal(b, s1.mx)), mal(c, s2.mx));
    koeff = { a, b, c };
    erwartet = x1.map((u, i) => plus(plus(a, mal(b, u)), mal(c, x2[i])));
  }
  const ssRes = summe(ys.map((y, i) => { const r = minus(y, erwartet[i]); return mal(r, r); }));
  const ssTot = summe(ys.map(y => { const t = minus(y, my); return mal(t, t); }));
  const frei = n - spalten.length - 1;
  const summeX = summe(spalten[0]);
  return {
    methode: ergebnis, monate: n, basiswert: summeX.z > 0n ? kurz(durch(summe(ys), summeX), 4) : null,
    koeffizienten: Object.fromEntries(Object.entries(koeff).map(([k, v]) => [k, kurz(v, 4)])),
    r2: ssTot.z > 0n ? kurz(minus(ganz(1), durch(ssRes, ssTot)), 3) : null,
    streuung_prozent: my.z > 0n && frei > 0 ? wurzelFest(mal(durch(durch(ssRes, ganz(frei)), mal(my, my)), ganz(10000)), 1) : null,
    spannweite: spalten.map(spannweite), abgelehnt, grund: null,
  };
}

const streuungText = (f: Fassung) => `Streuung ± ${de(fest(q(f.streuung_prozent!), 1))} %`;
function basisKennzeichen(f: Fassung): string[] {
  const v = f.variablen, wo = `Bezugsbasis ${f.kennzeichen}, Fassung ${f.fassung}`;
  let liste: string[];
  switch (f.methode) {
    case 'verhaeltnis': liste = [`bereinigt um ${v[0].name} (${wo})`]; break;
    case 'regression_eine_variable': liste = [`bereinigt um ${v[0].name} (Modell mit einer Einflussgröße, ${wo}; ${streuungText(f)})`]; break;
    case 'regression_zwei_variablen': liste = [`bereinigt um ${v[0].name} und ${v[1].name} (Modell mit zwei Einflussgrößen, ${wo}; ${streuungText(f)})`]; break;
    case 'gradtage': liste = [`bereinigt um Gradtage (G20/15, ${wo})`, streuungText(f)]; break;
    default: throw new Error(`Ungeprüfte Methode: ${f.methode}`);
  }
  if (f.methode === 'verhaeltnis' && v[0].art === 'gradtagzahl') liste.push('ohne Grundlast');
  if (f.monate < STARTWERTE.mindest_monate) liste.push(vorlaeufig(f.monate));
  return liste;
}
const ergebnis = (urteil: string, grund: string | null = null, gemessen: string | null = null, erwartet: string | null = null,
  delta: string | null = null, band: string | null = null, richtung: string | null = null, kennzeichen: string[] = []): Ergebnis =>
  ({ urteil, grund, gemessen, erwartet, delta_prozent: delta, band_prozent: band, richtung, kennzeichen });
function band(f: Fassung): Q {
  const toleranz = q(f.toleranz_prozent), streuung = f.streuung_prozent === null ? NULL : q(f.streuung_prozent);
  return cmp(toleranz, streuung) >= 0 ? toleranz : streuung;
}
const richtung = (g: Q, e: Q) => (cmp(g, e) > 0 ? 'mehr' : cmp(g, e) < 0 ? 'weniger' : 'gleich');
/** U2/U3: im Rahmen, wenn |g − e|·100 ≤ Band·e — nie auf das Band gerundet. */
function urteil(g: Q, e: Q, b: Q, unvollstaendig: boolean): string {
  if (unvollstaendig) return OHNE;
  if (cmp(mal(betrag(minus(g, e)), ganz(100)), mal(b, e)) <= 0) return 'im_rahmen';
  return cmp(g, e) < 0 ? 'besser' : 'schlechter';
}
function dazu(liste: string[], weitere: string[] = []) {
  for (const k of weitere) if (!liste.includes(k)) liste.push(k);
}
const delta = (g: Q, e: Q) => durch(mal(minus(g, e), ganz(100)), e);

/** U1–U4, G2, G3, G5: gemessen gegen erwartet einer freigegebenen Fassung, mit Grund statt Zahl, wo die Daten es nicht tragen. */
export function vergleich(e: VergleichEingang): Ergebnis {
  const f = e.fassung;
  if (f === null) return ergebnis(NA, e.basis_beendet ? 'basis_beendet' : 'basis_fehlt');
  if (!e.abgeschlossen) return ergebnis(NA, 'periode_nicht_zu_ende');
  const gemessen = e.gemessen;
  if (gemessen.wert === null) return ergebnis(NA, 'keine_werte');
  const k = f.variablen.length;
  const eigene = e.variablen.slice(0, k);
  if (eigene.length < k || eigene.some(v => v.wert === null)) return ergebnis(NA, 'variable_fehlt', gemessen.wert);
  const xs = eigene.map(v => q(v.wert!));
  const sw = f.spannweite ?? [];
  const ausserhalb = sw.flatMap((s, i) => (cmp(xs[i], q(s.toleriert_von)) < 0 || cmp(xs[i], q(s.toleriert_bis)) > 0 ? [i] : []));
  const kennzeichen = basisKennzeichen(f);
  let erwartet: Q;
  if (f.methode === 'verhaeltnis') {
    erwartet = mal(q(f.basiswert!), xs[0]);
    for (const i of ausserhalb) {
      const s = sw[i], v = f.variablen[i];
      kennzeichen.push(`${v.name} außerhalb der Basis-Spannweite (${de(s.von)}–${de(s.bis)} ${v.einheit})`);
    }
  } else {
    if (ausserhalb.length) return ergebnis(NA, 'variable_ausserhalb', gemessen.wert);
    const ko = f.koeffizienten!;
    erwartet = plus(q(ko.a), mal(q(ko.b), xs[0]));
    if (xs.length > 1) erwartet = plus(erwartet, mal(q(ko.c!), xs[1]));
  }
  if (erwartet.z <= 0n) return ergebnis(NA, 'keine_werte', gemessen.wert);
  const g = q(gemessen.wert);
  const unvollstaendig = gemessen.zustand === 'unvollstaendig' || e.variablen.some(v => v.zustand === 'unvollstaendig');
  dazu(kennzeichen, gemessen.kennzeichen);
  for (const v of e.variablen) dazu(kennzeichen, v.kennzeichen);
  if (unvollstaendig) dazu(kennzeichen, ['unvollständig']);
  return ergebnis(urteil(g, erwartet, band(f), unvollstaendig), null, exakt(g), exakt(erwartet), fest(delta(g, erwartet), 1),
    fest(band(f), 1), richtung(g, erwartet), kennzeichen);
}

/** U5: Σ gemessen ÷ Σ erwartet über die Monate — nie ein Mittel der Monats-Δ; fehlt ein Monat: „x von y Monaten“. */
export function zeitraum(e: ZeitraumEingang): Ergebnis {
  const f = e.fassung;
  const einzeln = e.monate.map(m => vergleich({ fassung: f, basis_beendet: e.basis_beendet, ...m }));
  const nutzbar = einzeln.filter(x => x.urteil !== NA);
  const y = e.soll_monate;
  if (!nutzbar.length) return { ...ergebnis(NA, einzeln.length && f === null ? einzeln[0].grund : 'keine_werte'), monate: `0 von ${y}` };
  const g = summe(nutzbar.map(x => q(x.gemessen!))), erw = summe(nutzbar.map(x => q(x.erwartet!)));
  const unvollstaendig = nutzbar.length < y || nutzbar.some(x => x.urteil === OHNE);
  const kennzeichen = basisKennzeichen(f!);
  for (const x of nutzbar) dazu(kennzeichen, x.kennzeichen);
  if (nutzbar.length < y) dazu(kennzeichen, [`${nutzbar.length} von ${y} Monaten`]);
  return { ...ergebnis(urteil(g, erw, band(f!), unvollstaendig), null, exakt(g), exakt(erw), fest(delta(g, erw), 1),
    fest(band(f!), 1), richtung(g, erw), kennzeichen), monate: `${nutzbar.length} von ${y}` };
}

/** U1: die rohe Veränderung zur Vorperiode trägt nie ein Urteil. */
export function roh(aktuell: string | null, vorher: string | null) {
  if (aktuell === null || vorher === null || q(vorher).z <= 0n) return { delta_prozent: null, richtung: null, urteil: OHNE };
  const a = q(aktuell), v = q(vorher);
  return { delta_prozent: fest(delta(a, v), 1), richtung: richtung(a, v), urteil: OHNE };
}

/** Plan-Abnahme (E8): dieselbe Periode roh gegen den Vormonat — ohne Urteil — und bereinigt gegen die Basis. */
export function rohUndBereinigt(e: { roh: { gemessen: string; vorher: string; variable: string; variable_vorher: string }; bereinigt: VergleichEingang }) {
  return { roh: { ...roh(e.roh.gemessen, e.roh.vorher), variable_delta_prozent: roh(e.roh.variable, e.roh.variable_vorher).delta_prozent },
    bereinigt: vergleich(e.bereinigt) };
}

/** M3: dieselbe Periode gegen das Modell mit Konstante und gegen das Verhältnis ohne Grundlast. */
export const methodenPaar = (e: { modell: VergleichEingang; verhaeltnis: VergleichEingang }) =>
  ({ modell: vergleich(e.modell), verhaeltnis: vergleich(e.verhaeltnis) });

/** M5: Anzeige-Rundung kaufmännisch; ,5 vom Nullpunkt weg — anders als `Math.round`. */
export const runden = (wert: string, stellen: number) => fest(q(wert), stellen);
