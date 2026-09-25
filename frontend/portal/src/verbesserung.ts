/** AP-18 NW-1: Ziele, Maßnahmen, Abweichungen — reine Regeln (docs/contracts/v2/verbesserung.md). Keine Fläche ruft sie bisher auf.
 * Zwillinge: VerbesserungRegeln.java und voltpilot_optimization/verbesserung.py; alle drei fahren verbesserung-vectors.json.
 * Δ, Band und Urteil je Monat und die Summe durch Summe sind die Operationen `vergleich` und `zeitraum` der Bezugsbasis
 * (./bezugsbasis) — hier steht nur, welche Monate zählen, der Vorschlag am Energieziel und die Frist. Die Uhr kommt von außen.
 * Die Kundensätze sind eigene Schablonen (§5.9), nicht die Kundenwort-Konstanten des Glossars.
 */
import { vergleich, zeitraum, type Ergebnis, type VergleichEingang } from './bezugsbasis';
import { dez } from './dez';
import { UEMS_NORMGRENZE } from './glossar';

export const STARTWERTE = { nachher_monate: 12, nachher_monate_hoechstens: 36, abweichung_frist_tage: 30 };
export const VOKABULARE: Record<string, string[]> = {
  energieziel_zustand: ['offen', 'bewertet', 'beendet'],
  energieziel_ergebnis: ['erreicht', 'verfehlt', 'nicht_bewertbar'],
  zielstand_vorschlag: ['erreicht', 'nicht_erreicht'],
  massnahme_zustand: ['geplant', 'umgesetzt', 'bewertet', 'verworfen'],
  massnahme_herkunft: ['abweichung', 'energieziel', 'einsatz', 'von_hand', 'nichtkonformitaet', 'audit', 'managementbewertung'],
  abweichung_zustand: ['offen', 'abgeschlossen'],
  abweichung_ergebnis: ['massnahme', 'erklaert', 'keine_abweichung', 'nicht_bewertbar'],
  abweichung_eintrag_art: ['kommentar', 'ursache_aussage'],
  auffaelligkeit_zustand: ['offen', 'beantwortet'],
  auffaelligkeit_antwort: ['abweichung', 'zur_kenntnis'],
  ursache_beleg: ['keine_messung', 'mit_beleg'],
  wirkung_ergebnis: ['belegt', 'nicht_belegt', 'nicht_messbar'],
  wirkung_grund: ['umsetzungsmonat', 'basis_nach_umsetzung', 'unvollstaendig', 'basis_fehlt', 'basis_beendet', 'zu_wenig_perioden', 'variable_fehlt', 'variable_ausserhalb', 'periode_nicht_zu_ende', 'keine_werte'],
  anstoss_art: ['ausgangslage_korrigiert', 'bewertung_korrigiert', 'messgrundlage_beendet', 'messgrundlage_neu_gefasst'],
  anstoss_zustand: ['offen', 'beantwortet'],
  anstoss_antwort: ['bleibt', 'neu_kopiert', 'neu_bewertet'],
  frist_art: ['massnahme', 'abweichung', 'energieziel'],
  frist_faellig: ['ueberfaellig', 'bewertung_faellig'],
};
/** Die Kundensätze (Report §5.9) als Schablonen; {name} füllt die Operation `satz`. */
export const SAETZE: Record<string, string> = {
  auffaelligkeit: "Auffälligkeit: {monat} — {gemessen} gemessen, {erwartet} erwartet bei {bedingung}: {prozent} als die Bezugsbasis erwarten lässt ({urteil}, Band ± {band} %). Vermerkt am {am}. Abweichung eröffnen oder zur Kenntnis nehmen.",
  auffaelligkeit_zur_kenntnis: "Auffälligkeit {monat}: {prozent} als die Bezugsbasis erwarten lässt ({urteil}, Band ± {band} %) — zur Kenntnis genommen von {person} am {am}: ‚{begruendung}‘",
  abweichung_kopf: "Abweichung {kennzeichen} · {kennzahl}, {monate}: {prozent} als die Bezugsbasis erwarten lässt · Verantwortlich {person} · Frist {frist} · {zustand}.",
  ursache_aussage: "Ursache — Aussage von {person}, {am} (keine Messung): ‚{wortlaut}‘",
  ursache_aussage_mit_beleg: "Ursache — Aussage von {person}, {am} (mit Beleg: {beleg}): ‚{wortlaut}‘",
  abschluss_massnahme: "Abgeschlossen am {am} von {person}: Maßnahme {massnahme} — ‚{begruendung}‘",
  abschluss_erklaert: "Abgeschlossen am {am} von {person}: erklärt — ‚{begruendung}‘",
  massnahme_kopf: "{kennzeichen} · {titel} · Verantwortlich {person} · Termin {termin} · umgesetzt am {umgesetzt_am}.",
  messgrundlage: "Messgrundlage: {kennzahl}, Bezugsbasis {bezugsbasis}, Fassung {fassung} — bereinigt um {bereinigt_um} ({methode}). Ausgangslage {ausgangslage_monat}: {ausgangslage_prozent} als erwartet (Version {version}, Kopie vom {kopiert_am}). Erwartete Wirkung: {erwartete_wirkung} — ‚{wortlaut}‘",
  ohne_messgrundlage: "{kennzeichen} · {titel} · ohne Messgrundlage — Wirkung nicht messbar. Um die Wirkung zu messen, braucht {einsatz} eine Energieleistungskennzahl ({hinweis}).",
  wirkung_vorlaeufig: "Wirkung von {massnahme}, beobachtet: {prozent} {energie} als die Bezugsbasis erwarten lässt ({zeitraum}, {monate} Monaten; {ausschluesse}) — erwartet waren {erwartete_wirkung}. Ob die Maßnahme das bewirkt hat, sagt eine Person.",
  wirkung_umsetzungsmonat: "{monat}: Umsetzungsmonat — nicht gezählt.",
  wirkung_nicht_bewertbar: "{monat}: nicht bewertbar — {grund}.",
  wirkung_basis_nach_umsetzung: "{monat}: nicht bewertbar — die Bezugsbasis {bezugsbasis}, Fassung {fassung} hat eine Referenzperiode ({referenzperiode}), die nach der Umsetzung endet; sie enthielte die Maßnahme.",
  bewertung_belegt: "Belegt von {person} am {am}: ‚{begruendung}‘ Beobachtet: {prozent} ({monate} Monaten). Stand Nr. {stand}, Prüfsumme {pruefsumme}",
  bewertung_offen: "Beobachtet — nicht belegt. Eine Bewertung mit Begründung setzt eine Person.",
  bewertung_nicht_messbar: "Bewertet am {am} von {person}: nicht messbar — ‚{begruendung}‘",
  energieziel_stand: "Energieziel {kennzeichen} · {wortlaut} · {zielperiode} · Verantwortlich {person}. Stand nach {monate} Monaten: {prozent} ({ausschluesse}). Bezugsbasis {bezugsbasis}, Fassung {fassung}.",
  energieziel_ende: "Energieziel {kennzeichen}, Zielperiode {zielperiode}: {prozent} {energie} als die Bezugsbasis erwarten lässt ({monate} Monaten; {ausschluesse}) — Zielwert {zielwert}. Über die ganze Zielperiode nicht bewertbar; die Bewertung trifft eine Person. Bewertet am {am} von {person}: {ergebnis}.",
  energieziel_vorschlag: "Zielwert {vorschlag}: {prozent} gegenüber {zielwert} ({monate} Monaten) — Vorschlag; bestätigen oder mit Begründung abweichen.",
  ueberfaellig: "{kennzeichen} · {zustand} · Termin {termin} · überfällig seit {tage} Tagen · {person}.",
  baustein: "Ziele und Maßnahmen — {ueberfaellig} · {umgesetzt} · {ziele}.",
  anstoss_ausgangslage_korrigiert: "Ausgangslage korrigiert: {korrektur} ({am}) — die Ausgangslage zitiert {monat} in Version {version_alt} ({prozent_alt} als erwartet), gültig ist Version {version_neu} ({prozent_neu}). Beibehalten mit Begründung oder neu kopieren.",
  leer: "Noch keine Energieziele, Maßnahmen oder Abweichungen. Sie entstehen aus Ihren Energieleistungskennzahlen: aus einer Auffälligkeit, aus einem Energieziel oder von Hand.",
  grenz_satz: UEMS_NORMGRENZE, // der Grenz-Satz hat eine Quelle (SP3); der Vektor prüft den Wortlaut
};

export interface MonatEingang { monat: string; referenzperiode: string | null; vergleich: VergleichEingang }
export interface WirkungEingang { umgesetzt_am: string; nachher_monate: number; monate: MonatEingang[] }
export interface ZielstandEingang { zielwert_prozent: string; zielperiode: string; monate: MonatEingang[] }
export interface FristEingang { art: string; zustand: string; termin?: string; zielperiode?: string; letzter_monat_endgueltig?: boolean; abruf: string }
type NichtGezaehlt = { monat: string; grund: string };

const NA = 'nicht_anwendbar', OHNE = 'ohne_urteil';
const PERIODE = /^(\d{4})-(0[1-9]|1[0-2])\/(\d{4})-(0[1-9]|1[0-2])$/;
const PLATZ = /\{([a-z_]+)\}/g;

const monatsZahl = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const alsMonat = (z: number) => `${String(Math.floor(z / 12)).padStart(4, '0')}-${String((z % 12) + 1).padStart(2, '0')}`;
const plus = (monat: string, n: number) => alsMonat(monatsZahl(monat) + n);

/** Ein Monat zählt, wenn der Vergleich der Bezugsbasis ein Urteil trägt; sonst ihr Grund (`unvollstaendig` für ohne_urteil). */
function einordnen(m: MonatEingang): string | null {
  const r = vergleich(m.vergleich);
  if (r.urteil === NA) return r.grund;
  return r.urteil === OHNE ? 'unvollstaendig' : null;
}

/** U5 der Bezugsbasis: Operation `zeitraum` über die zählenden Monate gegen die Fassung des letzten (P4). */
function summe(zaehlen: MonatEingang[], soll: number) {
  if (!zaehlen.length) {
    return { urteil: NA, gemessen: null, erwartet: null, delta_prozent: null, band_prozent: null, richtung: null, kennzeichen: [] as string[] };
  }
  const letzter = zaehlen[zaehlen.length - 1].vergleich;
  const z: Ergebnis = zeitraum({ fassung: letzter.fassung, basis_beendet: false, soll_monate: zaehlen.length,
    monate: zaehlen.map(m => ({ abgeschlossen: m.vergleich.abgeschlossen, gemessen: m.vergleich.gemessen, variablen: m.vergleich.variablen })) });
  const kennzeichen = [...z.kennzeichen];
  if (zaehlen.length < soll) kennzeichen.push(`${zaehlen.length} von ${soll} Monaten`);
  return { urteil: z.urteil, gemessen: z.gemessen, erwartet: z.erwartet, delta_prozent: z.delta_prozent, band_prozent: z.band_prozent,
    richtung: z.richtung, kennzeichen };
}

/** WK1–WK4: Nachher-Monate ab dem Monat nach `umgesetzt_am`; Σ ÷ Σ über die bewertbaren; Ausschlüsse mit Grund. */
export function wirkung(e: WirkungEingang) {
  const n = e.nachher_monate;
  if (n < STARTWERTE.nachher_monate || n > STARTWERTE.nachher_monate_hoechstens) return { fehler: 'nachher_monate' };
  const umsetzung = e.umgesetzt_am.slice(0, 7), von = plus(umsetzung, 1), bis = plus(umsetzung, n);
  const nichtGezaehlt: NichtGezaehlt[] = [], zaehlen: MonatEingang[] = [], endgueltig: string[] = [];
  for (const m of e.monate) {
    if (m.monat === umsetzung) { nichtGezaehlt.push({ monat: m.monat, grund: 'umsetzungsmonat' }); continue; }
    if (m.monat < von || m.monat > bis) continue;
    endgueltig.push(m.monat);
    const rp = m.referenzperiode;
    const grund = rp && m.vergleich.fassung !== null && rp.slice(8) >= umsetzung ? 'basis_nach_umsetzung' : einordnen(m);
    if (grund) nichtGezaehlt.push({ monat: m.monat, grund }); else zaehlen.push(m);
  }
  return { nachher_von: von, nachher_bis: bis, umsetzungsmonat: umsetzung,
    zeitraum_von: endgueltig[0] ?? null, zeitraum_bis: endgueltig[endgueltig.length - 1] ?? null,
    monate_bewertbar: zaehlen.length, monate_endgueltig: endgueltig.length, monate_soll: n, monate: `${zaehlen.length} von ${n}`,
    vorlaeufig: endgueltig.length < n, nicht_gezaehlt: nichtGezaehlt, ...summe(zaehlen, n) };
}

/** Exakter Vergleich a ≤ b für a = (g − e)·100 und b = Zielwert·e — Dezimaltexte als BigInt, nie gerundet. */
function hoechstens(g: string, e: string, ziel: string): boolean {
  const [dg, de, dz] = [dez(g), dez(e), dez(ziel)];
  const s = Math.max(dg.e, de.e);
  const hoch = (x: { z: bigint; e: number }, auf: number) => x.z * 10n ** BigInt(auf - x.e);
  const links = (hoch(dg, s) - hoch(de, s)) * 100n * 10n ** BigInt(dz.e);
  const rechts = dz.z * hoch(de, s);
  return links <= rechts;
}

/** Z3/Z4: Σ ÷ Σ über die endgültigen Monate der Zielperiode; Vorschlag nur, wenn alle Monate bewertbar sind. */
export function zielstand(e: ZielstandEingang) {
  if (!PERIODE.test(e.zielperiode)) return { fehler: 'zielperiode_format' };
  const von = e.zielperiode.slice(0, 7), bis = e.zielperiode.slice(8);
  if (bis < von) return { fehler: 'zielperiode_reihenfolge' };
  const soll = monatsZahl(bis) - monatsZahl(von) + 1;
  const nichtGezaehlt: NichtGezaehlt[] = [], zaehlen: MonatEingang[] = [];
  let endgueltig = 0;
  for (const m of e.monate) {
    if (m.monat < von || m.monat > bis) continue;
    endgueltig++;
    const grund = einordnen(m);
    if (grund) nichtGezaehlt.push({ monat: m.monat, grund }); else zaehlen.push(m);
  }
  const s = summe(zaehlen, soll);
  const vorschlag = zaehlen.length === soll ? (hoechstens(s.gemessen!, s.erwartet!, e.zielwert_prozent) ? 'erreicht' : 'nicht_erreicht') : null;
  return { zielperiode: e.zielperiode, zielwert_prozent: e.zielwert_prozent, monate_bewertbar: zaehlen.length, monate_endgueltig: endgueltig,
    monate_soll: soll, monate: `${zaehlen.length} von ${soll}`, vollstaendig: zaehlen.length === soll, nicht_gezaehlt: nichtGezaehlt,
    vorschlag, ...s };
}

const tagZahl = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
function letzterTag(monat: string): string {
  const d = new Date(Date.UTC(Number(monat.slice(0, 4)), Number(monat.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

/** F1: „überfällig seit n Tagen“ / „Bewertung fällig seit n Tagen“ beim Abruf; die Uhr kommt von außen (`abruf`). */
export function frist(e: FristEingang) {
  const offen = ({ massnahme: 'geplant', abweichung: 'offen', energieziel: 'offen' } as Record<string, string>)[e.art];
  if (!offen) throw new Error(`frist_art: ${e.art}`);
  const ziel = e.art === 'energieziel';
  const termin = ziel ? letzterTag(e.zielperiode!.slice(8)) : e.termin!;
  const ohne = { termin, faellig: null, seit_tagen: null };
  if (e.zustand !== offen || (ziel && !e.letzter_monat_endgueltig)) return ohne;
  const tage = tagZahl(e.abruf) - tagZahl(termin);
  if (tage < 0) return ohne;
  return { termin, faellig: ziel ? 'bewertung_faellig' : 'ueberfaellig', seit_tagen: tage };
}

/** SP4: die Schablone aus §5.9, jeder Platzhalter genau aus `werte` — kein Wert fehlt, keiner bleibt übrig. */
export function satz(schluessel: string, werte: Record<string, string>) {
  const vorlage = SAETZE[schluessel];
  if (vorlage === undefined) return { fehler: 'satz_unbekannt' };
  const namen = [...vorlage.matchAll(PLATZ)].map(t => t[1]);
  const fehlt = namen.find(n => !(n in werte));
  if (fehlt !== undefined) return { fehler: `wert_fehlt:${fehlt}` };
  const uebrig = Object.keys(werte).filter(k => !namen.includes(k)).sort();
  if (uebrig.length) return { fehler: `wert_uebrig:${uebrig[0]}` };
  return { satz: vorlage.replace(PLATZ, (_, n: string) => werte[n]) };
}
