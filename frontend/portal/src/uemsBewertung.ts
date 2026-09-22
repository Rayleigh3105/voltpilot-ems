/** AP-16 NW-1: reine Vertragsregeln. Keine Fläche ruft diese Regeln bisher auf.
 * Zwillinge: BewertungRegeln.java und voltpilot_optimization/bewertung.py.
 * Mengen kommen aus Monatswerten/Bilanz; keine zweite Verbrauchsbildung.
 */
import { dez, dezText, dezVergleich, halbAuf, type Dez } from './dez';
import { dezPlus, dezMinus, dezMal, dezKuerze } from './uemsBilanz';

export const STARTWERTE = { K1: '10', K2: '80', K3: '100000', K5: '90', K6: '5', K7: 12, K8: '80', mindest_monate: 3 };
export const TRAEGER = ['Strom', 'Gas', 'Wärme', 'Kälte', 'Wasser', 'Druckluft'];
export const URTEILE = ["ueber_schwelle", "unter_schwelle", "nicht_anwendbar", "nicht_belastbar", "erfuellt", "vorbehalt_datenlage", "vorbehalt_ersatzwerte", "unter_zwoelf", "vorlaeufig"];
export const ABDECKUNG = ["gemessen", "geplant", "ersatz", "ungemessen"];
export const EINSTUFUNGEN = ["wesentlich", "nicht_wesentlich", "offen"];
const UEBER = 'ueber_schwelle', UNTER = 'unter_schwelle', NA = 'nicht_anwendbar', NB = 'nicht_belastbar';
const d = (v: string | null): Dez | null => v === null ? null : dez(v);
const text = (v: Dez | null): string | null => v === null ? null : dezText(dezKuerze(v));
const summe = (werte: Dez[]): Dez => werte.reduce(dezPlus, dez('0'));
const cmp = dezVergleich;
const mal100 = (v: Dez) => dezMal(v, dez('100'));

/** KR4: Anzeige auf eine Stelle; niemals Grundlage eines Schwellenvergleichs. */
export function prozent(teil: Dez | null, ganzes: Dez | null): string | null {
  if (teil === null || ganzes === null || ganzes.z <= 0n) return null;
  return dezText({ z: halbAuf(teil.z * 1000n * 10n ** BigInt(ganzes.e), ganzes.z * 10n ** BigInt(teil.e)), e: 1 });
}
function schwelle(teil: Dez | null, ganzes: Dez | null, grenze: string): string {
  if (teil === null || ganzes === null || ganzes.z <= 0n) return NA;
  return cmp(mal100(teil), dezMal(ganzes, dez(grenze))) >= 0 ? UEBER : UNTER;
}
export interface Anlage { kennung: string; hauptzaehler: boolean; zufluss: string | null; abgabe: string | null; laden: string | null }
export interface Nenner { wert: string | null; vorhanden: number; gesamt: number; zustand: string }
export function nenner(anlagen: Anlage[]) {
  const werte = anlagen.map(a => !a.hauptzaehler || a.zufluss === null || a.abgabe === null || a.laden === null
    ? null : dezMinus(dezMinus(dez(a.zufluss), dez(a.abgabe)), dez(a.laden)));
  const vorhanden = werte.filter(w => w !== null).length;
  return { wert: vorhanden === werte.length ? text(summe(werte as Dez[])) : null, vorhanden, gesamt: werte.length,
    zustand: vorhanden === werte.length ? 'vollständig' : 'unvollständig',
    anlagen: anlagen.map((a, i) => ({ kennung: a.kennung, wert: text(werte[i]) })) };
}
export interface Messstelle { kennung: string; traeger: string; art: 'gemessen' | 'berechnet' | 'verteilung'; direkt: boolean; archiviert: boolean; wert: string | null; ersatz: string }
function relevante(messstellen: Messstelle[], traeger: string) {
  if (!TRAEGER.includes(traeger)) throw new Error('traeger_unbekannt');
  const ms = messstellen.filter(m => m.traeger === traeger && m.direkt && !m.archiviert && m.art === 'gemessen');
  if (new Set(ms.map(m => m.kennung)).size !== ms.length) throw new Error('messstelle_doppelt');
  return ms;
}
export function menge(messstellen: Messstelle[], traeger: string) {
  const ms = relevante(messstellen, traeger), mitWert = ms.filter(m => m.wert !== null);
  const ersatz = summe(mitWert.map(m => dez(m.ersatz)));
  return { menge: mitWert.length ? text(summe(mitWert.map(m => dez(m.wert!)))) : null,
    ersatz: mitWert.length ? text(ersatz) : null,
    zustand: !mitWert.length ? 'keine Werte' : mitWert.length !== ms.length ? 'unvollständig' : ersatz.z > 0n ? 'mit Ersatzwert' : 'vollständig' };
}
export interface Einsatz { kennung: string; menge: string | null; datenlage_prozent: string | null; ersatz_prozent: string | null; begruendung: string | null }
export interface RanglisteEingang { nenner: Nenner; traeger: string; monate: number; einsaetze: Einsatz[]; kriterien: typeof STARTWERTE }
/** KR2–KR4: Urteil und Vorschlag; ausdrücklich keine menschliche Einstufung. */
export function urteil(e: RanglisteEingang) {
  if (!TRAEGER.includes(e.traeger)) throw new Error('traeger_unbekannt');
  const k = e.kriterien;
  const n = e.traeger === 'Strom' && e.nenner.zustand === 'vollständig' ? d(e.nenner.wert) : null;
  const zeilen = [...e.einsaetze].sort((a, b) => {
    if ((a.menge === null) !== (b.menge === null)) return a.menge === null ? 1 : -1;
    const mengen = a.menge !== null && b.menge !== null ? cmp(dez(b.menge), dez(a.menge)) : 0;
    return mengen || (a.kennung < b.kennung ? -1 : a.kennung > b.kennung ? 1 : 0);
  });
  const zugeordnet = summe(zeilen.filter(x => x.menge !== null).map(x => dez(x.menge!)));
  const k8 = schwelle(zugeordnet, n, k.K8);
  const k7 = e.monate >= k.K7 ? 'erfuellt' : e.monate < k.mindest_monate ? 'vorlaeufig' : 'unter_zwoelf';
  let kum = dez('0');
  const aus = zeilen.map((x, i) => {
    const m = d(x.menge), k1 = schwelle(m, n, k.K1);
    const k2 = e.traeger !== 'Strom' || m === null || zugeordnet.z === 0n ? NA : k8 !== UEBER ? NB
      : cmp(mal100(kum), dezMal(zugeordnet, dez(k.K2))) < 0 ? UEBER : UNTER;
    const k3 = e.traeger !== 'Strom' || m === null || e.monate !== 12 ? NA : cmp(m, dez(k.K3)) >= 0 ? UEBER : UNTER;
    kum = dezPlus(kum, m ?? dez('0'));
    return { kennung: x.kennung, menge: text(m), rang: m !== null && e.traeger === 'Strom' ? i + 1 : null,
      anteil_prozent: prozent(m, n), kumuliert_zugeordnet_prozent: m !== null && e.traeger === 'Strom' ? prozent(kum, zugeordnet) : null,
      K1: k1, K2: k2, K3: k3, K4: x.begruendung,
      K5: x.datenlage_prozent !== null && cmp(dez(x.datenlage_prozent), dez(k.K5)) >= 0 ? 'erfuellt' : 'vorbehalt_datenlage',
      K6: x.ersatz_prozent !== null && cmp(dez(x.ersatz_prozent), dez(k.K6)) <= 0 ? 'erfuellt' : 'vorbehalt_ersatzwerte',
      vorschlag: [k1, k2, k3].includes(UEBER) ? UEBER : UNTER,
      zustand: m === null ? 'keine Werte' : e.nenner.zustand !== 'vollständig' && e.traeger === 'Strom' ? 'unvollständig' : 'vollständig' };
  });
  return { nenner: text(n), anlagen: `${e.nenner.vorhanden} von ${e.nenner.gesamt}`, zugeordnet: text(zugeordnet),
    rest: n === null ? null : text(dezMinus(n, zugeordnet)), abdeckung_prozent: prozent(zugeordnet, n), K8: k8, K7: k7, einsaetze: aus };
}
/** Kompatibler Name aus IP-2. */
export const rangliste = urteil;
export interface AbdeckungEingang { messstellen: Messstelle[]; traeger: string; reste: { kennung: string; wert: string | null }[]; nenner: string | null; offene_bedarfe: string[]; schwelle: string }
/** Gleiche Ableitung je Einsatz, Ort und Umfang; Ersatz ist Teil der Menge. */
export function abdeckung(e: AbdeckungEingang) {
  const ms = relevante(e.messstellen, e.traeger), m = menge(ms, e.traeger);
  const rest = e.reste.every(r => r.wert !== null) ? summe(e.reste.map(r => dez(r.wert!))) : null;
  const n = e.traeger === 'Strom' ? d(e.nenner) : null;
  return { ...m, gemessen: ms.filter(s => s.wert !== null).map(s => s.kennung),
    geplant: [...new Set([...e.offene_bedarfe, ...ms.filter(s => s.wert === null).map(s => s.kennung)])].sort(),
    ersatz_messstellen: ms.filter(s => s.wert !== null && dez(s.ersatz).z > 0n).map(s => s.kennung),
    ungemessen: e.reste.length ? text(rest) : null, abdeckung_prozent: prozent(d(m.menge), n), K8: schwelle(d(m.menge), n, e.schwelle) };
}
export interface Term { messstelle: string; verteilung: string | null }
export interface ProzessSumme { kennung: string; terme: Term[] }
export function prozessSummePasst(gemessen: string[], summen: ProzessSumme[]) {
  return summen.flatMap(s => s.terme.filter(t => !gemessen.includes(t.messstelle)).map(t => ({ summe: s.kennung, ...t })));
}
export function toleranz(fuehrend: string | null, vergleich: string | null, grenze: string) {
  const a = d(fuehrend), b = d(vergleich);
  let diff = a === null || b === null ? null : dezMinus(a, b);
  if (diff !== null && diff.z < 0n) diff = { ...diff, z: -diff.z };
  const p = prozent(diff, a);
  return { abweichung_prozent: p, toleranz_prozent: grenze, befund: p === null ? null : cmp(mal100(diff!), dezMal(a!, dez(grenze))) > 0 };
}
export interface MonatsSeite { menge: string | null; zustand: string | null }
export type MonatsvergleichZustand = 'passt' | 'abweichung' | 'nicht_vergleichbar';
function luecke(seite: string, s: MonatsSeite | null): string | null {
  if (s === null || s.menge === null || s.zustand !== 'vollständig')
    return seite + (s !== null && s.menge !== null && s.zustand === 'mit Ersatzwert' ? '_ersatzwert' : '_luecke');
  return null;
}
/** G5 im Lesemodell (IP-17): ein Monat führend ↔ Vergleich; Lücke/Ersatzwert = nicht vergleichbar, keine Ursache. */
export function monatsvergleich(fuehrend: MonatsSeite, vergleich: MonatsSeite, ganzerMonat: boolean, grenze: string) {
  let grund = !ganzerMonat ? 'vergleich_nicht_ganzer_monat' : luecke('fuehrend', fuehrend);
  if (grund === null) grund = luecke('vergleich', vergleich);
  const t = grund === null ? toleranz(fuehrend.menge, vergleich.menge, grenze) : null;
  if (t !== null && t.befund === null) grund = 'fuehrend_nicht_positiv';
  if (grund !== null || t === null)
    return { zustand: 'nicht_vergleichbar' as MonatsvergleichZustand, grund, abweichung_prozent: null, toleranz_prozent: grenze, befund: null };
  return { zustand: (t.befund ? 'abweichung' : 'passt') as MonatsvergleichZustand, grund: null,
    abweichung_prozent: t.abweichung_prozent, toleranz_prozent: grenze, befund: t.befund };
}
