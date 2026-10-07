/**
 * Verbessern-Konzept v1, PR 2 (Captain-Freigabe 06.10.2026): das reine Bild des Reiters „Maßnahmen“ und der Seite einer
 * Maßnahme - Stufen, Gruppen, Antwort zuerst, Datumsblock, „Was es bringt“, der nächste Schritt mit seinem Verb.
 *
 * **Hier wird nichts gemessen.** Prozent, Summen, „x von 12“ und Urteil kommen von der Route (`wirkung_kurz` der Liste,
 * `…/wirkung` der Seite); das Portal setzt sie ins deutsche Format, wählt Wörter (V1–V7) und rechnet nur Kalender
 * (Tage bis zum Termin gegen `frist.abruf`, die Uhr der Route) und das Runden zur Anzeige („rund 24 200 kWh“). Eine
 * Schätzung (erwartet) steht nie an der Stelle einer Beobachtung und wird nie mit ihr summiert (Entscheid 13).
 */
import type { Massnahme, MassnahmeArt, MassnahmeBewertung, MassnahmeWirkung, MassnahmeWirkungKurz } from './api';
import { monatWort } from './bezugsbasisVergleich';
import { tag, zielperiodeText } from './energieziele';
import { NBSP } from './format';
import { UEMS_MASSNAHME, UEMS_MASSNAHME_ERGEBNISSE, UEMS_MASSNAHMEN, UEMS_WIRKUNG } from './glossar';

// ------------------------------------------------------------------ Wörter

export const TITEL = UEMS_MASSNAHMEN;
export const UNTERTITEL = 'Was Sie tun, um Energie zu sparen - und was es bringt.';
export const KNOPF_PLANEN = `${UEMS_MASSNAHME} planen`;
export const KNOPF_PLANEN_KURZ = 'Planen';
export const KNOPF_UMSETZUNG = 'Umsetzung melden';
export const KNOPF_WIRKUNG = 'Wirkung prüfen';
export const KNOPF_ABSCHLIESSEN = 'Abschließen';
export const KNOPF_ANSEHEN = 'Ansehen';
export const KNOPF_NEU_PRUEFEN = 'Neu prüfen';
export const WAS_IST = `Was ist eine ${UEMS_MASSNAHME}?`;
export const SO_LAEUFT = `So läuft eine ${UEMS_MASSNAHME}`;
export const SO_LAEUFT_SATZ =
  'Ab dem Monat nach der Umsetzung vergleicht VoltPilot zwölf Monate lang mit der Bezugsbasis. Maßnahmen ohne Kennzahl schließen Sie nach der Umsetzung mit einem Satz ab.';
export const LADEFEHLER = `Die ${UEMS_MASSNAHMEN} ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.`;
export const LADEFEHLER_SEITE = `Die ${UEMS_MASSNAHME} ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.`;
export const LADEFEHLER_TITEL = 'Nicht geladen';
export const ERNEUT_VERSUCHEN = 'Erneut versuchen';
export const LEER = `Noch keine ${UEMS_MASSNAHME}. Planen Sie, was Sie tun wollen - am Energieziel oder hier.`;
export const LEER_GEFILTERT = 'In dieser Stufe steht gerade nichts.';

/** Die Stufen der Liste (Richtungsfrage 9.2 A): was jetzt Arbeit macht, steht oben. */
export type Stufe = 'zu_tun' | 'umgesetzt' | 'abgeschlossen';
export const STUFEN: readonly Stufe[] = ['zu_tun', 'umgesetzt', 'abgeschlossen'];
export const STUFE_WORT: Record<Stufe, string> = { zu_tun: 'Zu tun', umgesetzt: 'Umgesetzt', abgeschlossen: 'Abgeschlossen' };
/** Der leise Satz rechts im Kopf einer Gruppe am Rechner. */
export const STUFE_ORDNUNG: Record<Stufe, string> = {
  zu_tun: 'nach Termin',
  umgesetzt: 'Wirkung prüfen oder abschließen',
  abgeschlossen: 'neueste zuerst',
};

/** Entscheid 6: die Art als leise Marke („Art statt Mangel“). */
export const ART_MARKE: Record<MassnahmeArt, string | null> = {
  gemessen: null,
  nicht_gemessen: 'nicht gemessen',
  organisatorisch: 'organisatorisch',
};

/** Die Spalten der Reihe am Rechner (§6.5). */
export const SPALTEN = {
  termin: 'Termin',
  massnahme: UEMS_MASSNAHME,
  bringt: 'Was es bringt',
  verantwortlich: 'Verantwortlich',
  schritt: 'Nächster Schritt',
} as const;

// ------------------------------------------------------------------ Zahlen (nur Anzeige, AP-08 E11)

/** Deutsches Zahlenformat mit Tausenderpunkt (Portal-Regel AP-08 E11). */
const de = (n: number, stellen = 0) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });

/** „2,7 %“ - ein Prozentwert der Route ohne Vorzeichen, eine Stelle. */
export function prozentBetrag(delta: string): string {
  return `${de(Math.abs(Number(delta)), 1)}${NBSP}%`;
}

/** Eine Zahl der Person ohne „,0“: `-3.0` → „3 %“, `-2.5` → „2,5 %“. */
export function personProzent(p: string): string {
  const n = Math.abs(Number(p));
  return `${de(n, Number.isInteger(n) ? 0 : 1)}${NBSP}%`;
}

/** „24.200“ - eine Menge der Route, zur Anzeige auf Hundert gerundet (unter 1.000 auf Zehn). */
export function rund(wert: string | number): string {
  const n = Math.abs(Number(wert));
  const stufe = n >= 1000 ? 100 : 10;
  return de(Math.round(n / stufe) * stufe);
}

/** Eine ganze Menge ohne Rundung: „88.740“. */
export const ganz = (wert: string | number) => de(Math.round(Math.abs(Number(wert))));

/** V7: die Richtung als Wort. */
export const richtungWort = (wert: string | number) => (Number(wert) < 0 ? 'weniger' : 'mehr');

// ------------------------------------------------------------------ Kalender (nur Anzeige, Uhr der Route)

/** Kalendertage von `von` bis `bis` (beide `JJJJ-MM-TT`). */
export function tageZwischen(von: string, bis: string): number {
  const a = Date.UTC(Number(von.slice(0, 4)), Number(von.slice(5, 7)) - 1, Number(von.slice(8, 10)));
  const b = Date.UTC(Number(bis.slice(0, 4)), Number(bis.slice(5, 7)) - 1, Number(bis.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** „seit 15 Tagen“, „seit 1 Tag“ (Dativ). */
export const tageWort = (n: number) => `${n} ${n === 1 ? 'Tag' : 'Tagen'}`;
/** „noch 61 Tage“, „noch 1 Tag“ (Akkusativ). */
export const tageNoch = (n: number) => `${n} ${n === 1 ? 'Tag' : 'Tage'}`;

/** `2028-02` und `2029-01` → „Februar 2028 bis Januar 2029“. */
export const zeitraumText = (von: string, bis: string) => zielperiodeText(`${von}/${bis}`);

// ------------------------------------------------------------------ Liste: Stufe, Ordnung, Antwort

export function stufeVon(m: Pick<Massnahme, 'zustand'>): Stufe {
  return m.zustand === 'geplant' ? 'zu_tun' : m.zustand === 'umgesetzt' ? 'umgesetzt' : 'abgeschlossen';
}

/** Der Tag, an dem eine abgeschlossene Maßnahme abgeschlossen wurde: Stand der Bewertung oder Verwerfen. */
export function abschlussTag(m: Pick<Massnahme, 'bewertung' | 'verworfen_am'>): string {
  return (m.bewertung?.am ?? m.verworfen_am ?? '').slice(0, 10);
}

/**
 * Je Stufe geordnet: zu tun überfällige zuerst (längste Frist oben), dann nach Termin; umgesetzt nach dem Tag der
 * Umsetzung (wer am längsten wartet, oben); abgeschlossen die neueste zuerst.
 */
export function gruppen(liste: readonly Massnahme[]): Record<Stufe, Massnahme[]> {
  const aus: Record<Stufe, Massnahme[]> = { zu_tun: [], umgesetzt: [], abgeschlossen: [] };
  for (const m of liste) aus[stufeVon(m)].push(m);
  const kz = (a: Massnahme, b: Massnahme) => a.kennzeichen.localeCompare(b.kennzeichen);
  aus.zu_tun.sort(
    (a, b) =>
      Number(b.frist.faellig === 'ueberfaellig') - Number(a.frist.faellig === 'ueberfaellig') ||
      (b.frist.seit_tagen ?? 0) - (a.frist.seit_tagen ?? 0) ||
      a.termin.localeCompare(b.termin) ||
      kz(a, b),
  );
  aus.umgesetzt.sort((a, b) => (a.umgesetzt_am ?? '').localeCompare(b.umgesetzt_am ?? '') || kz(a, b));
  aus.abgeschlossen.sort((a, b) => abschlussTag(b).localeCompare(abschlussTag(a)) || kz(b, a));
  return aus;
}

const anzahl = (n: number, einzahl = UEMS_MASSNAHME, mehrzahl = UEMS_MASSNAHMEN) => `${n} ${n === 1 ? einzahl : mehrzahl}`;
const istSind = (n: number) => (n === 1 ? 'ist' : 'sind');

/**
 * V1 · zuerst, wie weit: „2 Maßnahmen sind bis 30.06.2029 geplant; 1 ist umgesetzt und noch abzuschließen.“ -
 * Überfälliges zuerst, dann was geplant ist, dann was auf Abschluss wartet; nichts offen: alles abgeschlossen.
 */
export function antwortSatz(liste: readonly Massnahme[]): string {
  const g = gruppen(liste);
  if (liste.length === 0) return LEER;
  const teile: string[] = [];
  const ueber = g.zu_tun.filter((m) => m.frist.faellig === 'ueberfaellig');
  const plan = g.zu_tun.filter((m) => m.frist.faellig !== 'ueberfaellig');
  if (ueber.length) {
    const laengste = Math.max(...ueber.map((m) => m.frist.seit_tagen ?? 0));
    teile.push(
      ueber.length === 1
        ? `1 ${UEMS_MASSNAHME} ist seit ${tageWort(laengste)} überfällig`
        : `${ueber.length} ${UEMS_MASSNAHMEN} sind überfällig, die älteste seit ${tageWort(laengste)}`,
    );
  }
  if (plan.length) {
    const termine = plan.map((m) => m.termin).sort();
    const letzter = termine[termine.length - 1];
    teile.push(`${teile.length ? plan.length : anzahl(plan.length)} ${istSind(plan.length)} bis ${tag(letzter)} geplant`);
  }
  if (g.umgesetzt.length) {
    teile.push(`${teile.length ? g.umgesetzt.length : anzahl(g.umgesetzt.length)} ${istSind(g.umgesetzt.length)} umgesetzt und noch abzuschließen`);
  }
  if (!teile.length) return `${liste.length === 1 ? `Die ${UEMS_MASSNAHME} ist` : `Alle ${liste.length} ${UEMS_MASSNAHMEN} sind`} abgeschlossen.`;
  const satz = teile.join('; ');
  return `${satz.charAt(0).toUpperCase()}${satz.slice(1)}.`;
}

/** „5 Maßnahmen · 2 abgeschlossen · Stand 30.04.2029“ - der Tag ist der Abruf der Route. */
export function formalZeile(liste: readonly Massnahme[], abruf: string): string {
  const fertig = liste.filter((m) => stufeVon(m) === 'abgeschlossen').length;
  return [anzahl(liste.length), ...(fertig ? [`${fertig} abgeschlossen`] : []), `Stand ${tag(abruf)}`].join(' · ');
}

/** Die Filter-Chips: „Alle 5 · Zu tun 2 · Umgesetzt 1 · Abgeschlossen 2“ - leere Stufen ohne Chip. */
export function chips(liste: readonly Massnahme[]): { key: Stufe | 'alle'; label: string }[] {
  const g = gruppen(liste);
  return [
    { key: 'alle' as const, label: `Alle ${liste.length}` },
    ...STUFEN.filter((s) => g[s].length > 0).map((s) => ({ key: s, label: `${STUFE_WORT[s]} ${g[s].length}` })),
  ];
}

// ------------------------------------------------------------------ Datumsblock

export interface DatumBild {
  wort: string;
  tag: string;
  jahr: string;
  satz: string;
  ton: 'ueber' | 'bald' | 'erledigt' | 'plan';
}

function datum(iso: string, wort: string, satz: string, ton: DatumBild['ton']): DatumBild {
  const [j, m, t] = iso.slice(0, 10).split('-');
  return { wort, tag: `${t}.${m}.`, jahr: j, satz: `${satz} ${t}.${m}.${j}`, ton };
}

/** „bis 30.06.“ bei geplanten, „seit“ im Warnton bei überfälligen, „umgesetzt“/„geprüft“ grün bei erledigten. */
export function datumBild(m: Massnahme): DatumBild {
  if (m.zustand === 'geplant') {
    return m.frist.faellig === 'ueberfaellig'
      ? datum(m.termin, 'seit', 'überfällig seit', 'ueber')
      : datum(m.termin, 'bis', 'geplant bis', 'bald');
  }
  if (m.zustand === 'umgesetzt') return datum(m.umgesetzt_am ?? m.termin, 'umgesetzt', 'umgesetzt am', 'erledigt');
  if (m.zustand === 'verworfen') return datum(m.verworfen_am ?? m.termin, 'verworfen', 'verworfen am', 'bald');
  // Wie im Konzept (§6.5) auch ohne Messung „geprüft“: eine Person hat gesagt, was daraus geworden ist.
  return datum(abschlussTag(m) || m.termin, 'geprüft', m.art === 'gemessen' ? 'Wirkung geprüft am' : 'abgeschlossen am', 'erledigt');
}

// ------------------------------------------------------------------ Woher (Zeile unter dem Titel)

/**
 * Ohne Messung (§6.6): „Druckluft hat noch keine Kennzahl mit Bezugsbasis, zum Beispiel Strom je Betriebsstunde. Mit
 * ihr misst VoltPilot die Wirkung.“ Das Beispiel ist der Hinweis der Route („zum Beispiel … mit einer Bezugsbasis“);
 * ohne Energieeinsatz nennt sie keins.
 */
export function nichtGemessenSatz(m: Pick<Massnahme, 'einsatz' | 'ohne_messgrundlage'>): string {
  const beispiel = (m.ohne_messgrundlage?.hinweis ?? '').replace(/\s*mit einer (freigegebenen )?Bezugsbasis$/, '').trim();
  const wer = m.einsatz?.name ?? m.einsatz?.kennzeichen ?? null;
  const kopf = wer ? `${wer} hat noch keine Kennzahl mit Bezugsbasis` : 'Diese Maßnahme hat keine Kennzahl mit Bezugsbasis';
  return `${kopf}${beispiel.startsWith('zum Beispiel') ? `, ${beispiel}` : ''}. Mit ihr misst VoltPilot die Wirkung.`;
}

/**
 * „bereinigt um Produktionsmenge“ - die Methode der Fassung ohne ihre Klammer (die nennt Modell, Bezugsbasis und
 * Fassung, die in derselben Zeile schon stehen; §6.6 „Wofür und woran gemessen“).
 */
export const methodeKurz = (methode: string) => methode.replace(/\s*\(.*\)\s*$/, '');

const BR = /^(BR-\d{4}-\d{4,})\/B(\d{1,3})$/;

/** „aus der Abweichung AW-2028-0001“, „Hinweis aus dem internen Audit AU-2029-0001“, „aus der Managementbewertung …, Beschluss 2“. */
export function herkunftText(m: Pick<Massnahme, 'herkunft'>): string | null {
  const k = m.herkunft.kennung;
  switch (m.herkunft.art) {
    case 'abweichung':
      return `aus der Abweichung ${k}`;
    case 'nichtkonformitaet':
      return `aus der Feststellung ${k}`;
    case 'audit':
      return `Hinweis aus dem internen Audit ${k}`;
    case 'managementbewertung': {
      const b = k ? BR.exec(k) : null;
      return b ? `aus der Managementbewertung ${b[1]}, Beschluss ${b[2]}` : `aus der Managementbewertung ${k ?? ''}`.trim();
    }
    case 'einsatz':
      return 'am Energieeinsatz geplant';
    default:
      return null;
  }
}

/** Das Energieziel als Name (V6): „Energieziel 2028“ aus EZ-2028-0001. */
export const energiezielName = (kennzeichen: string) => {
  const j = /^EZ-(\d{4})-/.exec(kennzeichen);
  return j ? `Energieziel ${j[1]}` : kennzeichen;
};

/**
 * „Energieziel 2029 für den Spritzguss: 4 % weniger …“ - Name und Wortlaut ohne Doppelung, wenn der Wortlaut schon mit
 * dem Namen beginnt (so schreiben ihn viele Kunden).
 */
export function energiezielText(kennzeichen: string, wortlaut: string | null | undefined): string {
  const name = energiezielName(kennzeichen);
  const w = (wortlaut ?? '').trim();
  return !w ? name : w.startsWith(name) ? w : `${name} · ${w}`;
}

/** Der Wortlaut ohne den vorangestellten Namen (für die Zeile unter dem Namen). */
export function energiezielRest(kennzeichen: string, wortlaut: string | null | undefined): string | null {
  const name = energiezielName(kennzeichen);
  const w = (wortlaut ?? '').trim();
  const rest = w.startsWith(name) ? w.slice(name.length).replace(/^[\s:·-]+/, '') : w;
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null;
}

/** „Spritzguss · aus der Abweichung AW-2028-0001 · für das Energieziel 2028“. */
export function woherZeile(m: Pick<Massnahme, 'herkunft' | 'einsatz' | 'energieziel' | 'art'>): string {
  return [
    m.einsatz?.name ?? null,
    m.art === 'organisatorisch' ? 'organisatorisch' : null,
    herkunftText(m),
    m.energieziel ? `für das ${energiezielName(m.energieziel.kennzeichen)}` : null,
  ]
    .filter((x): x is string => !!x)
    .join(' · ');
}

// ------------------------------------------------------------------ Was es bringt (§6.5)

export type MarkeTon = 'ok' | 'warn' | 'ohne' | 'rahmen' | 'plan';
export interface Marke {
  wort: string;
  ton: MarkeTon;
}
export interface BringtBild {
  /** Die beobachtete Zahl, fett: „2,7 % weniger“. */
  zahl: string | null;
  text: string | null;
  marke: Marke | null;
}

/** Das Urteil einer Person als Marke: belegt grün, sonst leise (V2: „belegt“ ist das Wort einer Person). */
/**
 * Kein Monat nach der Umsetzung bewertbar - je nach Lage des Vergleichszeitraums zum Tag der Route: noch nicht
 * begonnen, läuft, oder vorbei ohne bewertbaren Wert (dann nie „vergleicht ab …“ in der Vergangenheit).
 */
export function ohneMonatSatz(w: Pick<MassnahmeWirkung, 'abruf' | 'nachher_von' | 'nachher_bis'>): string {
  const heute = w.abruf.slice(0, 7);
  if (!w.nachher_von) return 'Noch ist kein Monat nach der Umsetzung bewertbar.';
  const zeitraum = w.nachher_bis ? zielperiodeText(`${w.nachher_von}/${w.nachher_bis}`) : monatWort(w.nachher_von);
  if (w.nachher_bis && w.nachher_bis < heute) return `Für ${zeitraum} liegt kein bewertbarer Monatswert vor.`;
  if (w.nachher_von <= heute) return `Bisher ist kein Monat nach der Umsetzung bewertbar - verglichen wird ${zeitraum}.`;
  return `Noch ist kein Monat nach der Umsetzung bewertbar. VoltPilot vergleicht ab ${monatWort(w.nachher_von)} zwölf Monate lang mit der Bezugsbasis.`;
}

/** „nach 8 von 12 Monaten (damals 2,4 % weniger)“ - aus der Kopie des Stands, wie sie festgehalten wurde. */
export function standKopie(b: Pick<MassnahmeBewertung, 'kopie'>): { monate: string; prozent: string; anzahl: number } | null {
  if (!b.kopie) return null;
  try {
    const k = JSON.parse(b.kopie) as { wirkung?: { delta_prozent?: string | number; monate_bewertbar?: number }; nachher?: string };
    const d = k.wirkung?.delta_prozent;
    const n = k.wirkung?.monate_bewertbar;
    if (d === undefined || d === null || n === undefined) return null;
    const soll = k.nachher ? monateZwischen(k.nachher) : 12;
    return { monate: `${n} von ${soll}`, prozent: `${prozentBetrag(String(d))} ${richtungWort(d)}`, anzahl: n };
  } catch {
    return null;
  }
}

function monateZwischen(p: string): number {
  const [von, bis] = p.split('/');
  return (Number(bis.slice(0, 4)) - Number(von.slice(0, 4))) * 12 + Number(bis.slice(5, 7)) - Number(von.slice(5, 7)) + 1;
}

export function ergebnisMarke(b: Pick<MassnahmeBewertung, 'ergebnis'>): Marke {
  return { wort: UEMS_MASSNAHME_ERGEBNISSE[b.ergebnis], ton: b.ergebnis === 'belegt' ? 'ok' : 'ohne' };
}

/** „Soll bringen: 3 % weniger, rund 30 500 kWh im Jahr“ - die Schätzung beim Planen, als solche gekennzeichnet. */
export function sollBringen(m: Pick<Massnahme, 'erwartete_wirkung_prozent' | 'erwartete_wirkung_wortlaut' | 'erwartete_einsparung' | 'art'>): string {
  const kwh = m.erwartete_einsparung ? Number(m.erwartete_einsparung.kwh_jahr) : null;
  const kwhText = kwh === null ? null : `rund ${rund(kwh)}${NBSP}kWh ${kwh < 0 ? 'mehr ' : ''}im Jahr`;
  if (m.erwartete_wirkung_prozent !== null) {
    const p = `${personProzent(m.erwartete_wirkung_prozent)} ${richtungWort(m.erwartete_wirkung_prozent)}`;
    return `Soll bringen: ${kwhText ? `${p}, ${kwhText}` : p}`;
  }
  if (kwhText) return `Soll bringen: ${kwhText}, geschätzt`;
  return `Soll bringen: ${m.erwartete_wirkung_wortlaut}`;
}

/** Die Kurzform der Route in Wörtern: „2,7 % weniger“ · „als erwartet · rund 24 200 kWh in 11 Monaten“. */
export function beobachtetText(k: MassnahmeWirkungKurz): { zahl: string; text: string } {
  const einheit = k.einheit ?? 'kWh';
  return {
    zahl: `${prozentBetrag(k.delta_prozent)} ${richtungWort(k.delta_prozent)}`,
    text: `als erwartet · rund ${rund(k.differenz)}${NBSP}${einheit} in ${k.monate_bewertbar} ${k.monate_bewertbar === 1 ? 'Monat' : 'Monaten'}`,
  };
}

/**
 * Je Karte die Zeile „Was es bringt“: beobachtet (mit Kurzform der Route) mit dem Urteil einer Person oder
 * „vorläufig“; geplant, was es bringen soll; ohne Messung die Art als leise Marke; organisatorisch nur die Marke.
 */
export function bringtBild(m: Massnahme): BringtBild {
  if (m.zustand === 'verworfen') return { zahl: null, text: null, marke: { wort: 'verworfen', ton: 'ohne' } };
  const k = m.wirkung_kurz;
  if (m.art === 'gemessen' && k) {
    const b = beobachtetText(k);
    const marke = m.bewertung
      ? ergebnisMarke(m.bewertung)
      : k.vorlaeufig
        ? { wort: `vorläufig · ${k.monate_text}`, ton: 'ohne' as const }
        : { wort: 'beobachtet', ton: 'ohne' as const };
    return { zahl: b.zahl, text: b.text, marke };
  }
  if (m.art === 'gemessen' && m.bewertung) {
    // Ohne Live-Kurzform (z. B. keine Werte im Zeitraum) sagt der festgehaltene Stand, was damals beobachtet war.
    const kopie = standKopie(m.bewertung);
    return kopie
      ? { zahl: kopie.prozent, text: `als erwartet · Stand nach ${kopie.monate} Monaten`, marke: ergebnisMarke(m.bewertung) }
      : { zahl: null, text: sollBringen(m), marke: ergebnisMarke(m.bewertung) };
  }
  if (m.art === 'organisatorisch') {
    return { zahl: null, text: null, marke: m.bewertung ? { wort: 'abgeschlossen', ton: 'ohne' } : { wort: 'organisatorisch', ton: 'ohne' } };
  }
  if (m.art === 'nicht_gemessen') {
    const fertig = m.zustand === 'bewertet';
    return { zahl: null, text: fertig ? m.erwartete_wirkung_wortlaut : sollBringen(m), marke: { wort: fertig ? 'nicht messbar' : 'nicht gemessen', ton: 'ohne' } };
  }
  return { zahl: null, text: sollBringen(m), marke: m.zustand === 'umgesetzt' ? { wort: 'noch kein Monat bewertbar', ton: 'ohne' } : null };
}

// ------------------------------------------------------------------ Der nächste Schritt (V5)

/** Je Stufe genau ein Verb; ohne Recht „Ansehen“. */
export function naechsterSchritt(
  m: Pick<Massnahme, 'zustand' | 'art' | 'bewertung_antrag'>,
  darf: { melden: boolean; abschliessen: boolean },
): { wort: string; leise: boolean } {
  if (m.zustand === 'geplant' && darf.melden) return { wort: KNOPF_UMSETZUNG, leise: false };
  if (m.zustand === 'umgesetzt' && darf.abschliessen && !m.bewertung_antrag) {
    return { wort: m.art === 'gemessen' ? KNOPF_WIRKUNG : KNOPF_ABSCHLIESSEN, leise: false };
  }
  return { wort: KNOPF_ANSEHEN, leise: true };
}

// ------------------------------------------------------------------ Seite: Stufen und Antwort

export type StufePunkt = 'done' | 'an' | 'offen' | 'aus';
export interface StufeBild {
  wort: string;
  klein: string;
  stand: StufePunkt;
}

/**
 * Die Stufen eines Vorgangs (§6.11): grün erledigt, Navy der aktuelle Schritt, grau gestrichelt ein Schritt, der für
 * diese Maßnahme anders aussieht (ohne Messung: „Abschließen“ statt „Wirkung geprüft“).
 */
export function stufenBild(m: Massnahme): StufeBild[] {
  const ohneMessung = m.art !== 'gemessen';
  const geplant: StufeBild = { wort: 'Geplant', klein: tag(m.angelegt_am), stand: 'done' };
  if (m.zustand === 'verworfen') {
    return [geplant, { wort: 'Verworfen', klein: tag(m.verworfen_am), stand: 'done' }];
  }
  const umgesetzt: StufeBild =
    m.zustand === 'geplant'
      ? { wort: 'Umsetzen', klein: `bis ${tag(m.termin)}`, stand: 'an' }
      : { wort: 'Umgesetzt', klein: tag(m.umgesetzt_am), stand: 'done' };
  const dritte: StufeBild = ohneMessung
    ? m.zustand === 'bewertet'
      ? { wort: 'Abgeschlossen', klein: tag(m.bewertung?.am), stand: 'done' }
      : { wort: 'Abschließen', klein: 'ohne Messung', stand: m.zustand === 'umgesetzt' ? 'an' : 'aus' }
    : m.zustand === 'bewertet'
      ? { wort: 'Wirkung geprüft', klein: tag(m.bewertung?.am), stand: 'done' }
      : { wort: 'Wirkung prüfen', klein: m.zustand === 'umgesetzt' ? 'nach bis zu 12 Monaten' : 'nach bis zu 12 Monaten', stand: m.zustand === 'umgesetzt' ? 'an' : 'offen' };
  return [geplant, umgesetzt, dritte];
}

export interface AntwortBild {
  satz: string;
  formal: string | null;
  /** Die Wirkung ist noch unterwegs: die Seite zeigt ein Skelett statt eines Satzes, der gleich wieder umspringt. */
  laedt?: true;
  /** Die Wirkung ließ sich nicht lesen: der Satz sagt es, die Seite bietet „Erneut versuchen“ (ein Fehler ist keine Null). */
  fehler?: true;
}

/** Wo die Wirkung der Route für die Antwort steht. */
export type WirkungStand = 'da' | 'laedt' | 'fehler';

/**
 * V1/V3 · die Antwort der Seite mit Zeitraum: geplant mit Restzeit; überfällig seit n Tagen; umgesetzt mit der
 * beobachteten Wirkung gegen die Bezugsbasis (erwartet daneben, nie an ihrer Stelle); ohne Messung, was als Nächstes
 * kommt; abgeschlossen, mit welchem Ergebnis.
 */
/** Wer abschließt, wenn die angemeldete Person es selbst nicht darf (`verbesserung.abschliessen`). */
export const WER_ABSCHLIESST = 'abschließen kann, wer im Energiemanagement Maßnahmen bewertet';

export function antwortBild(m: Massnahme, w: MassnahmeWirkung | null, darfAbschliessen = true, wirkung: WirkungStand = 'da'): AntwortBild {
  const abruf = m.frist.abruf;
  if (m.zustand === 'verworfen') {
    return { satz: `Verworfen am ${tag(m.verworfen_am)}${m.verworfen_grund ? `: ‚${m.verworfen_grund}‘` : '.'}`, formal: 'Bleibt mit Verlauf lesbar.' };
  }
  if (m.zustand === 'geplant') {
    if (m.frist.faellig === 'ueberfaellig' && m.frist.seit_tagen !== null) {
      return {
        satz: `Seit ${tageWort(m.frist.seit_tagen)} überfällig - Termin war ${tag(m.termin)}.`,
        formal: 'Melden Sie die Umsetzung oder verschieben Sie den Termin.',
      };
    }
    const rest = tageZwischen(abruf, m.termin);
    return { satz: `Geplant bis ${tag(m.termin)} - ${rest === 0 ? 'Termin ist heute' : rest > 0 ? `noch ${tageNoch(rest)}` : `Termin ist vorbei`}.`, formal: null };
  }
  if (m.art !== 'gemessen') {
    if (m.zustand === 'bewertet' && m.bewertung) {
      return { satz: `Abgeschlossen am ${tag(m.bewertung.am)} von ${m.bewertung.person.name}: ${UEMS_MASSNAHME_ERGEBNISSE[m.bewertung.ergebnis]}.`, formal: null };
    }
    return {
      satz: darfAbschliessen
        ? `Umgesetzt am ${tag(m.umgesetzt_am)} - jetzt mit einem Satz abschließen.`
        : `Umgesetzt am ${tag(m.umgesetzt_am)} - ${WER_ABSCHLIESST}.`,
      formal: 'Ohne Kennzahl misst VoltPilot nichts; ob es geholfen hat, sagt eine Person.',
    };
  }
  // Solange die Wirkung lädt oder fehlt, sagt die Antwort nichts über bewertbare Monate - unbekannt ist keine Null.
  if (wirkung === 'laedt') return { satz: '', formal: null, laedt: true };
  if (wirkung === 'fehler') {
    return m.zustand === 'bewertet' && m.bewertung
      ? { satz: urteilSatz(m.bewertung), formal: `Die ${UEMS_WIRKUNG} von heute ließ sich nicht laden; Stand Nr. ${m.bewertung.stand_nr} bleibt, wie er festgehalten wurde.`, fehler: true }
      : { satz: `Umgesetzt am ${tag(m.umgesetzt_am)} - die ${UEMS_WIRKUNG} ließ sich nicht laden.`, formal: 'Ihre Daten sind nicht betroffen.', fehler: true };
  }
  if (!w || w.grund !== null || !w.summe || w.summe.delta_prozent === null || !w.monate_bewertbar) {
    // Bewertet, aber heute kein bewertbarer Monat (z. B. fehlen Werte): die Antwort ist das Urteil mit seinem Stand.
    if (m.zustand === 'bewertet' && m.bewertung) {
      return {
        satz: urteilSatz(m.bewertung),
        formal: `Heute ist kein Monat nach der Umsetzung bewertbar; Stand Nr. ${m.bewertung.stand_nr} bleibt, wie er festgehalten wurde.`,
      };
    }
    const ab = m.umgesetzt_am ? monatWort(naechsterMonat(m.umgesetzt_am.slice(0, 7))) : null;
    return {
      satz: `Umgesetzt am ${tag(m.umgesetzt_am)} - noch ist kein Monat danach bewertbar.`,
      formal: ab ? `Die Wirkung zählt ab ${ab}, zwölf Monate lang gegen die Bezugsbasis.` : null,
    };
  }
  const s = w.summe;
  const zahl = `${prozentBetrag(s.delta_prozent!)} ${richtungWort(s.delta_prozent!)} ${w.energie ?? 'Energie'}`;
  const erwartet = m.erwartete_wirkung_prozent
    ? ` - erwartet waren ${personProzent(m.erwartete_wirkung_prozent)} ${richtungWort(m.erwartete_wirkung_prozent)}`
    : '';
  const basis = m.messgrundlage ? ` · gegen die Bezugsbasis ${m.messgrundlage.bezugsbasis.kennzeichen}` : '';
  const von = w.monate.find((x) => x.gezaehlt)?.periode ?? w.nachher_von!;
  const bis = [...w.monate].reverse().find((x) => x.endgueltig)?.periode ?? von;
  return {
    satz: `Seit der Umsetzung ${zahl}, als die Bezugsbasis erwarten lässt${erwartet}.`,
    formal: `${zeitraumText(von, bis)} · ${w.monate_text} Monaten${w.vorlaeufig ? ', vorläufig' : ''}${basis}`,
  };
}

/** „Wirkung geprüft am 15.11.2028 von Ines Kaltenbach: belegt - damals 2,4 % weniger als erwartet nach 8 von 12 Monaten.“ */
function urteilSatz(b: NonNullable<Massnahme['bewertung']>): string {
  const kopie = standKopie(b);
  return `Wirkung geprüft am ${tag(b.am)} von ${b.person.name}: ${UEMS_MASSNAHME_ERGEBNISSE[b.ergebnis]}${kopie ? ` - damals ${kopie.prozent} als erwartet nach ${kopie.monate} Monaten` : ''}.`;
}

function naechsterMonat(jjjjmm: string): string {
  const j = Number(jjjjmm.slice(0, 4));
  const m = Number(jjjjmm.slice(5, 7));
  return m === 12 ? `${j + 1}-01` : `${j}-${String(m + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ Kacheln (beobachtet neben erwartet, nie summiert)

export interface KachelBild {
  titel: string;
  wert: string;
  einheit: string;
  unter: string;
  ton: 'ok' | 'warn' | 'neutral';
}

/**
 * V2/V4 · drei Kacheln: beobachtet in kWh (weniger/mehr als erwartet), erwartet in kWh (Schätzung beim Anlegen, über
 * dieselben Monate), Vorher (die Ausgangslage). Alle Mengen sind die der Route (`wirkung_kurz`); erwartet steht neben
 * beobachtet, nie an seiner Stelle und nie mit ihm summiert.
 */
export function kachelnBild(m: Pick<Massnahme, 'erwartete_wirkung_prozent' | 'messgrundlage'>, k: MassnahmeWirkungKurz): KachelBild[] {
  const einheit = k.einheit ?? 'kWh';
  const monate = k.monate_bewertbar;
  const aus: KachelBild[] = [
    {
      titel: Number(k.differenz) < 0 ? 'Weniger als erwartet' : 'Mehr als erwartet',
      wert: rund(k.differenz),
      einheit,
      unter: `in ${monate} ${monate === 1 ? 'Monat' : 'Monaten'} · ${prozentBetrag(k.delta_prozent)}`,
      ton: k.urteil === 'besser' ? 'ok' : k.urteil === 'schlechter' ? 'warn' : 'neutral',
    },
  ];
  if (m.erwartete_wirkung_prozent !== null && k.erwartete_wirkung !== null) {
    aus.push({
      titel: 'Erwartet waren',
      wert: rund(k.erwartete_wirkung),
      einheit,
      unter: `${personProzent(m.erwartete_wirkung_prozent)} ${richtungWort(m.erwartete_wirkung_prozent)} · Schätzung beim Anlegen`,
      ton: 'neutral',
    });
  }
  const vorher = vorherBild(m);
  if (vorher) aus.push({ titel: 'Vorher', wert: vorher.wert, einheit: '%', unter: `${vorher.monat}, Anlass`, ton: 'neutral' });
  return aus;
}

/** Die Ausgangslage als „+12,9 %“ mit Monat - nur bei EINEM Monat mit Urteil (sonst steht sie unter „Details“). */
export function vorherBild(m: Pick<Massnahme, 'messgrundlage'>): { wert: string; monat: string; satz: string } | null {
  const inhalt = m.messgrundlage?.ausgangslage_inhalt as
    | { vergleich?: { periode: string; bereinigt?: { delta_prozent?: string | number | null; richtung?: string | null } }[] }
    | undefined;
  const v = inhalt?.vergleich;
  if (!v || v.length !== 1) return null;
  const d = v[0].bereinigt?.delta_prozent;
  if (d === null || d === undefined) return null;
  const n = Number(d);
  const betrag = de(Math.abs(n), 1);
  return {
    wert: `${n < 0 ? '−' : '+'}${betrag}`,
    monat: monatWort(v[0].periode),
    satz: `${monatWort(v[0].periode)}: ${betrag}${NBSP}% ${n < 0 ? 'weniger' : 'mehr'} als erwartet`,
  };
}
