/**
 * Konzept Verbessern (vp-verbessern-konzept-v1 §6.3, §6.4, §6.12, PR 1): das Bild der Energieziele - Name, Antwort
 * zuerst, Skala, Kacheln, „Was noch nötig ist“, die Monate als Grafik und als Liste, der festgehaltene Stand.
 *
 * REIN: Lage, Lücke und der nötige Schnitt kommen von der Route (Operation `kurs`, Vertrag verbesserung.md §4a), Σ, Δ
 * und Urteil je Monat vom Leser der Bezugsbasis. Hier stehen nur Wörter, deutsche Zahlen und die Geometrie der Bilder;
 * „heute“ ist immer der Abruf-Tag der Route, nie die Uhr des Browsers. „Energieziel“, nie „Ziel“ allein (W6).
 */
import type {
  Energieziel,
  EnergiezielFestgehaltenerStand,
  EnergiezielKurs,
  EnergiezielStand,
  Massnahme,
} from './api';
import { runden } from './bezugsbasis';
import { dez, dezText } from './dez';
import { MONAT_LAEUFT, MONAT_OHNE_WERT, offenGrund } from './energieziele';

export type Ton = 'ok' | 'warn' | 'rahmen' | 'ohne';
export type Lage = EnergiezielKurs['lage'];

const NBSP = ' ';
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const ZAHLWORT = ['null', 'einen', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];
/** Zahlen bis zwölf als Wort („neun Monaten“), darüber als Ziffer. */
export const zahlwort = (n: number) => (n >= 2 && n <= 12 ? ZAHLWORT[n] : String(n));

// ------------------------------------------------------------------ Wörter

export const TITEL = 'Energieziele';
export const UNTERTITEL = 'Was Sie erreichen wollen - und wie weit Sie sind.';
export const KNOPF_SETZEN = 'Energieziel setzen';
export const KNOPF_PLANEN = 'Maßnahme planen';
export const ZUR_LISTE = 'Alle Energieziele';
export const ABGESCHLOSSEN = 'Abgeschlossen';
export const LEER =
  'Noch kein Energieziel. Ein Energieziel sagt, wie viel weniger Energie eine Kennzahl brauchen soll - zum Beispiel 4 % weniger Strom je kg im Spritzguss.';
export const LADEFEHLER = 'Die Energieziele ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const LADEFEHLER_SEITE = 'Das Energieziel ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const STAND_LADEFEHLER = 'Der Stand lädt gerade nicht. Ihre Daten sind nicht betroffen.';
export const NICHT_GEFUNDEN = 'Dieses Energieziel gibt es nicht oder Sie dürfen es nicht sehen.';
export const ERNEUT = 'Erneut versuchen';
export const SO_ENTSTEHT = 'So entsteht ein Energieziel';
export const SO_ENTSTEHT_SATZ =
  'An einer Kennzahl mit Bezugsbasis, für ganze Monate, frühestens ab dem nächsten Monat. Meist beschließt es die Managementbewertung; setzen kann es, wer Energiemanagement verantwortet.';

export const LAGE_WORT: Record<Lage, string> = {
  auf_kurs: 'auf Kurs',
  knapp_dahinter: 'knapp dahinter',
  nicht_auf_kurs: 'nicht auf Kurs',
  noch_keine_aussage: 'noch keine Aussage',
};
export const LAGE_TON: Record<Lage, Ton> = {
  auf_kurs: 'ok',
  knapp_dahinter: 'rahmen',
  nicht_auf_kurs: 'warn',
  noch_keine_aussage: 'ohne',
};
export const ERGEBNIS_WORT: Record<NonNullable<Energieziel['ergebnis']>, string> = {
  erreicht: 'erreicht',
  verfehlt: 'verfehlt',
  nicht_bewertbar: 'nicht bewertbar',
};
const URTEIL_WORT: Record<string, string> = {
  besser: 'unter der Bezugsbasis',
  schlechter: 'über der Bezugsbasis',
  im_rahmen: 'im Rahmen',
};
const URTEIL_TON: Record<string, Ton> = { besser: 'ok', schlechter: 'warn', im_rahmen: 'rahmen' };

// ------------------------------------------------------------------ Zahlen und Tage (nur Anzeige)

/** Ein Dezimaltext deutsch: Tausender mit Punkt, Komma, kaufmännisch gerundet („88740“ → „88.740“). */
export function zahl(text: string, stellen = 0): string {
  const t = runden(text, stellen);
  const minus = t.startsWith('-');
  const [vorn, hinten] = (minus ? t.slice(1) : t).split('.');
  const ganz = vorn.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const null_ = /^0+$/.test(vorn + (hinten ?? ''));
  return `${minus && !null_ ? '−' : ''}${ganz}${hinten ? `,${hinten}` : ''}`;
}

/** Eine Menge in ganzen Einheiten ohne Vorzeichen: „5.400 kWh“. */
export const menge = (text: string, einheit: string | null) => `${zahl(text.replace(/^-/, ''))}${einheit ? `${NBSP}${einheit}` : ''}`;

/** Ein Prozentwert ohne Vorzeichen, eine Stelle: „2,2 %“. */
export const prozent = (text: string) => `${zahl(text.replace(/^-/, ''), 1)}${NBSP}%`;

/** Mit Vorzeichen für Skala, Achse und Monatszeile: „+2,2 %“ · „−2,7 %“ · „0,0 %“. */
export function prozentVz(text: string): string {
  const t = runden(text, 1);
  const vz = /^-/.test(t) && !/^-0\.0$/.test(t) ? '−' : /^0\.0$|^-0\.0$/.test(t) ? '' : '+';
  return `${vz}${prozent(t)}`;
}

/** Der Zielwert einer Person ohne „,0“ (SP4), die Richtung als Wort (V7): „-4.0“ → „4 % weniger“. */
export function zielText(zielwert: string): string {
  const betrag = zielwert.replace(/^-/, '').replace(/\.0+$/, '').replace('.', ',');
  return `${betrag}${NBSP}% ${zielwert.startsWith('-') ? 'weniger' : 'mehr'}`;
}

/** „−4 %“ für die Skala. */
export const zielKurz = (zielwert: string) =>
  `${zielwert.startsWith('-') ? '−' : '+'}${zielwert.replace(/^-/, '').replace(/\.0+$/, '').replace('.', ',')}${NBSP}%`;

const monatIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const alsMonat = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const monatName = (m: string) => MONATE[Number(m.slice(5, 7)) - 1];
export const monatKurz = (m: string) => MONATE_KURZ[Number(m.slice(5, 7)) - 1];
export const monatLang = (m: string) => `${monatName(m)} ${m.slice(0, 4)}`;

/** `2028-01-15` → `15.01.2028`. */
export function tag(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? '');
}

/** Endgültig ist ein Monat etwa sieben Tage nach seinem Ende (Vertrag verbesserung.md §5): `2029-03` → `2029-04-07`. */
export function endgueltigAb(monat: string): string {
  const d = new Date(Date.UTC(Number(monat.slice(0, 4)), Number(monat.slice(5, 7)), 7));
  return d.toISOString().slice(0, 10);
}

/** „März bis Dezember 2029“, über den Jahreswechsel „November 2027 bis Oktober 2028“, ein Kalenderjahr „2028“ nur mit `jahr`. */
export function periodeText(von: string, bis: string, jahr = false): string {
  if (von === bis) return monatLang(von);
  if (jahr && von.slice(0, 4) === bis.slice(0, 4) && von.endsWith('-01') && bis.endsWith('-12')) return von.slice(0, 4);
  if (von.slice(0, 4) === bis.slice(0, 4)) return `${monatName(von)} bis ${monatLang(bis)}`;
  return `${monatLang(von)} bis ${monatLang(bis)}`;
}
const zp = (zielperiode: string) => [zielperiode.slice(0, 7), zielperiode.slice(8)] as const;
export const zielperiodeText = (zielperiode: string) => periodeText(...zp(zielperiode));

/** Name vor Kennzeichen (V6): „Energieziel 2029“, über den Jahreswechsel „Energieziel 2028/29“. */
export function energiezielName(ez: Pick<Energieziel, 'zielperiode'>): string {
  const [von, bis] = zp(ez.zielperiode);
  return von.slice(0, 4) === bis.slice(0, 4) ? `Energieziel ${bis.slice(0, 4)}` : `Energieziel ${von.slice(0, 4)}/${bis.slice(2, 4)}`;
}

/** „Energie“ nur, wenn gemessen wird, was Energie ist (kWh, MWh) - Wasser oder Gas in m³ bleiben ohne Wort. */
const energie = (einheit: string | null) => (einheit && /wh$/i.test(einheit) ? 'Energie ' : '');

/** Die Einheit der Summe - die des gemessenen Werts der Monate (kWh). */
export function einheitVon(stand: Pick<EnergiezielStand, 'monate'>): string | null {
  return stand.monate.find((m) => m.vergleich.bereinigt.gemessen.einheit)?.vergleich.bereinigt.gemessen.einheit ?? null;
}

/** „wurde 2,2 % mehr Energie gebraucht als erwartet“ - die Richtung als Wort (V7), Prozent nur gegen „erwartet“ (V4). */
function verbrauch(delta: string, richtung: string | null, einheit: string | null): string {
  if (richtung === 'gleich' || richtung === null) return `wurde so viel ${energie(einheit)}gebraucht wie erwartet`;
  return `wurde ${prozent(delta)} ${richtung} ${energie(einheit)}gebraucht als erwartet`;
}

// ------------------------------------------------------------------ Monate

export type MonatArt = 'gezaehlt' | 'vorlaeufig' | 'fehlt' | 'ausgeschlossen' | 'kommt';
export interface MonatsPunkt {
  periode: string;
  art: MonatArt;
  /** Δ in Prozent als Zahl (nur `gezaehlt`), für die Säule. */
  delta: number | null;
  deltaText: string | null;
  urteil: 'besser' | 'schlechter' | 'im_rahmen' | null;
  urteilWort: string | null;
  ton: Ton;
  gemessen: string | null;
  erwartet: string | null;
  hoechstens: string | null;
  /** Ohne Zahl: warum - der Grund der Route („läuft noch - endgültig etwa ab 07.05.2029“, „kein gemessener Wert“, ihr Satz). */
  grund: string | null;
}

/** Der Satz der Route ohne den Monat davor: „März 2028: nicht bewertbar - …“ → „nicht bewertbar - …“. */
const ohneMonat = (satz: string) => satz.replace(/^[^:]*:\s*/, '').replace(/\.$/, '');

/** Höchstens laut Energieziel in einem Monat: erwartet · (100 + Zielwert) / 100, nur zur Anzeige gerundet. */
function hoechstensVon(erwartet: string, zielwert: string): string {
  const e = dez(erwartet);
  const z = dez(zielwert);
  const hundert = 100n * 10n ** BigInt(z.e);
  return dezText({ z: e.z * (hundert + z.z), e: e.e + z.e + 2 });
}

/**
 * Je Monat der Zielperiode, was er zeigt: gezählt (mit Δ und Urteil), vorläufig (läuft noch), fehlt (kein Wert, obwohl
 * er endgültig sein müsste), ausgeschlossen (endgültig, aber nicht bewertbar - mit dem Satz der Route) oder kommt.
 */
export function monatsPunkte(stand: Pick<EnergiezielStand, 'monate' | 'nicht_gezaehlt' | 'abruf' | 'zielwert_prozent'>): MonatsPunkt[] {
  const aus = new Set(stand.nicht_gezaehlt.map((n) => n.monat));
  const abrufMonat = stand.abruf.slice(0, 7);
  return stand.monate.map(({ periode, endgueltig, vergleich: v }) => {
    const b = v.bereinigt;
    const einheit = b.gemessen.einheit;
    const leer: MonatsPunkt = {
      periode, art: 'kommt', delta: null, deltaText: null, urteil: null, urteilWort: null, ton: 'ohne',
      gemessen: b.gemessen.wert === null ? null : menge(b.gemessen.wert, einheit),
      erwartet: b.erwartet === null ? null : menge(b.erwartet, einheit),
      hoechstens: b.erwartet === null ? null : menge(hoechstensVon(b.erwartet, stand.zielwert_prozent), einheit),
      grund: null,
    };
    if (periode > abrufMonat) return leer;
    if (endgueltig && !aus.has(periode) && b.delta_prozent !== null && (b.urteil === 'besser' || b.urteil === 'schlechter' || b.urteil === 'im_rahmen')) {
      return {
        ...leer, art: 'gezaehlt', delta: Number(b.delta_prozent), deltaText: prozentVz(b.delta_prozent), urteil: b.urteil,
        urteilWort: URTEIL_WORT[b.urteil], ton: URTEIL_TON[b.urteil],
      };
    }
    if (endgueltig) return { ...leer, art: 'ausgeschlossen', grund: ohneMonat(v.satz) };
    // Nicht endgültig: der Grund der Route (Befund 1), nie geraten. Nur ein laufender Monat bekommt den geschätzten
    // Tag dazu - die Route nennt ihn nicht, die Frist danach ist die übliche Woche.
    if (b.grund === 'periode_nicht_zu_ende') {
      return { ...leer, art: 'vorlaeufig', grund: `${MONAT_LAEUFT} - endgültig etwa ab ${tag(endgueltigAb(periode))}` };
    }
    if (b.gemessen.wert === null) return { ...leer, art: 'fehlt', grund: b.grund ? offenGrund(v) : MONAT_OHNE_WERT };
    return { ...leer, art: 'vorlaeufig', grund: offenGrund(v) };
  });
}

export interface MonatsZeile {
  /** `JJJJ-MM` des neuesten Monats der Zeile (Schlüssel). */
  periode: string;
  titel: string;
  text: string;
  zahl: string | null;
  marke: string | null;
  ton: Ton;
}

/**
 * „Werte je Monat“, neueste zuerst: je gezählter Monat eine Zeile; gleiche Gründe nebeneinander liegender Monate ohne
 * Zahl in einer Zeile („Januar bis Dezember 2028 · kein gemessener Wert“). Kommende Monate stehen in `spaeter`.
 */
export function monatsZeilen(punkte: MonatsPunkt[]): { zeilen: MonatsZeile[]; spaeter: string | null } {
  const bisher = punkte.filter((p) => p.art !== 'kommt');
  const kommend = punkte.filter((p) => p.art === 'kommt');
  const gruppen: MonatsPunkt[][] = [];
  for (const p of bisher) {
    const letzte = gruppen[gruppen.length - 1];
    if (letzte && p.art !== 'gezaehlt' && letzte[0].art === p.art && letzte[0].grund === p.grund) letzte.push(p);
    else gruppen.push([p]);
  }
  const zeilen = gruppen.reverse().map((g): MonatsZeile => {
    const p = g[0];
    const titel = g.length > 1 ? periodeText(g[0].periode, g[g.length - 1].periode) : monatLang(p.periode);
    if (p.art === 'gezaehlt') {
      return { periode: p.periode, titel, text: `${p.gemessen}, erwartet ${p.erwartet}`, zahl: p.deltaText, marke: p.urteilWort, ton: p.ton };
    }
    const marke = p.art === 'vorlaeufig' ? 'vorläufig' : p.art === 'fehlt' ? 'kein Wert' : 'nicht gezählt';
    return { periode: g[g.length - 1].periode, titel, text: p.grund ?? '', zahl: null, marke, ton: 'ohne' };
  });
  const spaeter = kommend.length
    ? `${periodeText(kommend[0].periode, kommend[kommend.length - 1].periode)} ${kommend.length > 1 ? 'haben' : 'hat'} noch nicht begonnen.`
    : null;
  return { zeilen, spaeter };
}

// ------------------------------------------------------------------ Antwort zuerst

const gezaehlte = (stand: Pick<EnergiezielStand, 'monate' | 'nicht_gezaehlt'>) => {
  const aus = new Set(stand.nicht_gezaehlt.map((n) => n.monat));
  return stand.monate.filter((m) => m.endgueltig && !aus.has(m.periode)).map((m) => m.periode);
};

/** „Im März“ (ein Monat, im Jahr der Zielperiode) · „Von März bis Mai“ - jede Zahl trägt ihren Zeitraum (V3). */
function wann(stand: Pick<EnergiezielStand, 'monate' | 'nicht_gezaehlt' | 'zielperiode'>): string {
  const g = gezaehlte(stand);
  const jahr = stand.zielperiode.slice(8, 12);
  const name = (m: string) => (m.slice(0, 4) === jahr ? monatName(m) : monatLang(m));
  if (g.length === 1) return `Im ${name(g[0])}`;
  const von = g[0], bis = g[g.length - 1];
  return von.slice(0, 4) === bis.slice(0, 4) ? `Von ${monatName(von)} bis ${name(bis)}` : `Von ${monatLang(von)} bis ${monatLang(bis)}`;
}

/** Warum es noch keine Aussage gibt - mit Tag oder Weg, nie nur „0 von 10“ (§6.12). */
export function keineAussageGrund(stand: Pick<EnergiezielStand, 'monate' | 'nicht_gezaehlt' | 'abruf' | 'zielperiode' | 'zielwert_prozent'>): string {
  const [von] = zp(stand.zielperiode);
  if (von > stand.abruf.slice(0, 7)) return `Die Zielperiode beginnt im ${monatLang(von)}.`;
  const punkte = monatsPunkte(stand);
  const fehlt = punkte.find((p) => p.art === 'fehlt');
  if (fehlt) return `Für ${monatLang(fehlt.periode)} fehlt ein gemessener Wert.`;
  const aus = punkte.find((p) => p.art === 'ausgeschlossen');
  const laeuft = punkte.find((p) => p.art === 'vorlaeufig');
  if (laeuft) {
    const satz = `Der ${monatName(laeuft.periode)} ist etwa ab ${tag(endgueltigAb(laeuft.periode))} endgültig.`;
    return aus ? `${monatLang(aus.periode)} ist nicht bewertbar. ${satz}` : satz;
  }
  if (aus) return `${monatLang(aus.periode)}: ${aus.grund}.`;
  return 'Noch ist kein Monat der Zielperiode bewertbar.';
}

export interface Antwort {
  satz: string;
  formal: string;
  lage: Lage;
}

/** Die Antwort der Seite eines laufenden Energieziels (§6.4): Lage, Monat, Zahl, was vorgenommen ist (V1, V3, V7). */
export function seitenAntwort(stand: EnergiezielStand, ez: Pick<Energieziel, 'bezugsbasis'>): Antwort {
  const k = stand.kurs;
  const lage: Lage = k?.lage ?? (stand.monate_bewertbar > 0 ? 'nicht_auf_kurs' : 'noch_keine_aussage');
  const periode = zielperiodeText(stand.zielperiode);
  const basis = `gegen die Bezugsbasis ${ez.bezugsbasis.kennzeichen}`;
  if (lage === 'noch_keine_aussage' || stand.summe.delta_prozent === null) {
    return { lage: 'noch_keine_aussage', satz: `Noch keine Aussage: ${keineAussageGrund(stand)}`, formal: `${periode} · ${basis}` };
  }
  const z = zielText(stand.zielwert_prozent);
  const v = verbrauch(stand.summe.delta_prozent, stand.summe.richtung, einheitVon(stand));
  const kopf = lage === 'auf_kurs' ? 'Auf Kurs' : lage === 'knapp_dahinter' ? 'Knapp dahinter' : 'Bisher nicht auf Kurs';
  return {
    lage,
    satz: `${kopf}: ${wann(stand)} ${v} - vorgenommen sind ${z}.`,
    formal: `Stand nach ${stand.monate_text} Monaten · ${periode} · ${basis}`,
  };
}

/** Der Satz eines laufenden Energieziels im Reiter (§6.3): mit seinem Namen. */
export function zielSatz(stand: EnergiezielStand, ez: Pick<Energieziel, 'zielperiode'>): string {
  const name = energiezielName(ez);
  const k = stand.kurs;
  const lage: Lage = k?.lage ?? (stand.monate_bewertbar > 0 ? 'nicht_auf_kurs' : 'noch_keine_aussage');
  if (lage === 'noch_keine_aussage' || stand.summe.delta_prozent === null) {
    return `Zum ${name} gibt es noch keine Aussage: ${keineAussageGrund(stand)}`;
  }
  const wie = lage === 'auf_kurs' ? 'ist auf Kurs' : lage === 'knapp_dahinter' ? 'ist knapp dahinter' : 'ist bisher nicht auf Kurs';
  const v = verbrauch(stand.summe.delta_prozent, stand.summe.richtung, einheitVon(stand));
  return `Das ${name} ${wie}: ${wann(stand)} ${v}, vorgenommen sind ${zielText(stand.zielwert_prozent)}.`;
}

/** Mehrere laufende Energieziele: die Zahl je Lage (§6.3) - „3 laufende Energieziele: 1 auf Kurs, 2 nicht auf Kurs.“ */
export function registerSatz(laufend: { ez: Energieziel; stand: EnergiezielStand | null }[], abgeschlossen: Energieziel[]): string | null {
  if (laufend.length === 1 && laufend[0].stand) return zielSatz(laufend[0].stand, laufend[0].ez);
  if (laufend.length > 1) {
    const zahl: Partial<Record<Lage, number>> = {};
    for (const l of laufend) {
      const lage: Lage = l.stand?.kurs?.lage ?? 'noch_keine_aussage';
      zahl[lage] = (zahl[lage] ?? 0) + 1;
    }
    const teile = (['auf_kurs', 'knapp_dahinter', 'nicht_auf_kurs', 'noch_keine_aussage'] as Lage[])
      .filter((l) => zahl[l])
      .map((l) => (l === 'noch_keine_aussage' ? `${zahl[l]} noch ohne Aussage` : `${zahl[l]} ${LAGE_WORT[l]}`));
    return `${laufend.length} laufende Energieziele: ${teile.join(', ')}.`;
  }
  if (laufend.length === 1) return `Das ${energiezielName(laufend[0].ez)} läuft; sein Stand lädt gerade nicht.`;
  const zuletzt = [...abgeschlossen].sort((a, b) => b.zielperiode.localeCompare(a.zielperiode))[0];
  if (!zuletzt) return null;
  const ergebnis = zuletzt.ergebnis ? `, ${ERGEBNIS_WORT[zuletzt.ergebnis]}` : zuletzt.zustand === 'beendet' ? ', vorzeitig beendet' : '';
  return `Gerade läuft kein Energieziel. Zuletzt abgeschlossen: ${energiezielName(zuletzt)}${ergebnis}.`;
}

// ------------------------------------------------------------------ Skala

export interface SkalaBild {
  /** Positionen in der viewBox 0…320 (Spur 10…310, Bezugsbasis bei 160). */
  basis: number;
  ziel: number;
  punkt: number | null;
  punktTon: Ton;
  punktText: string | null;
  zielText: string;
  /** Der grüne Bereich zwischen Bezugsbasis und Energieziel. */
  bereich: [number, number];
}

/**
 * Die Skala aus Auswerten (a1): Bezugsbasis in der Mitte, „weniger als erwartet“ rechts, das Energieziel als Strich,
 * „bisher“ als Punkt in der Urteilsfarbe. Der Bereich reicht mindestens ± 6 % und immer zwei Prozent über die Werte.
 */
export function skalaBild(e: { delta: string | null; urteil: string | null; zielwert: string; punktWort?: string }): SkalaBild {
  const z = Number(e.zielwert);
  const d = e.delta === null ? null : Number(e.delta);
  const r = Math.max(6, Math.ceil(Math.max(Math.abs(z), Math.abs(d ?? 0))) + 2);
  const x = (p: number) => 160 - (p * 150) / r;
  const ziel = x(z);
  return {
    basis: 160,
    ziel,
    punkt: d === null ? null : x(d),
    punktTon: e.urteil ? (URTEIL_TON[e.urteil] ?? 'rahmen') : 'rahmen',
    punktText: e.delta === null ? null : `${e.punktWort ? `${e.punktWort} ` : ''}${prozentVz(e.delta)}`,
    zielText: `Energieziel ${zielKurz(e.zielwert)}`,
    bereich: [Math.min(160, ziel), Math.max(160, ziel)],
  };
}

// ------------------------------------------------------------------ Stand: Kacheln und was noch nötig ist

export interface Kachel {
  name: string;
  wert: string;
  einheit: string | null;
  subFett?: string;
  sub: string;
}

/** „Gemessen 88.740 kWh statt 86.812 erwartet“ · „Höchstens laut Energieziel 83.340 kWh · 5.400 kWh darüber“ (V4). */
export function standKacheln(stand: EnergiezielStand): Kachel[] | null {
  const k = stand.kurs;
  const { gemessen, erwartet } = stand.summe;
  if (!k || k.hoechstens === null || k.luecke === null || gemessen === null || erwartet === null) return null;
  const einheit = einheitVon(stand);
  const darueber = !k.luecke.startsWith('-') && runden(k.luecke, 0) !== '0';
  return [
    { name: 'Gemessen', wert: zahl(gemessen), einheit, sub: `statt ${zahl(erwartet)} erwartet` },
    {
      name: 'Höchstens laut Energieziel',
      wert: zahl(k.hoechstens),
      einheit,
      ...(runden(k.luecke, 0).replace('-', '') === '0'
        ? { sub: 'genau erreicht' }
        : { subFett: menge(k.luecke, einheit), sub: darueber ? ' darüber' : ' darunter' }),
    },
  ];
}

/** „In den übrigen neun Monaten im Schnitt rund 4,7 % weniger als erwartet.“ - ohne offenen Monat `null`. */
export function noetigSatz(k: EnergiezielKurs | undefined): string | null {
  if (!k || k.monate_offen === 0 || k.noetig_prozent === null) return null;
  const wo = k.monate_offen === 1 ? 'Im übrigen Monat' : `In den übrigen ${zahlwort(k.monate_offen)} Monaten`;
  if (Number(k.noetig_prozent) <= -100) return `${wo} lässt sich das Energieziel nicht mehr erreichen - selbst ohne jeden Verbrauch.`;
  if (k.noetig_richtung === 'mehr') return `${wo} im Schnitt bis zu ${prozent(k.noetig_prozent)} mehr als erwartet.`;
  if (k.noetig_richtung === 'gleich') return `${wo} im Schnitt so viel wie erwartet.`;
  return `${wo} im Schnitt rund ${prozent(k.noetig_prozent)} weniger als erwartet.`;
}
export const NAEHERUNG = 'Näherung bei gleich großen Monaten.';

/** Die Marke an der Karte: „März: 5.400 kWh über dem Energieziel“ · „Bisher 1.200 kWh unter dem Energieziel“. */
export function lueckeMarke(stand: EnergiezielStand): string | null {
  const k = stand.kurs;
  if (!k || k.luecke === null || k.lage === 'noch_keine_aussage') return null;
  const einheit = einheitVon(stand);
  if (runden(k.luecke, 0).replace('-', '') === '0') return 'genau auf dem Energieziel';
  const g = gezaehlte(stand);
  const vorn = g.length === 1 ? `${monatName(g[0])}:` : 'Bisher';
  return `${vorn} ${menge(k.luecke, einheit)} ${k.luecke.startsWith('-') ? 'unter' : 'über'} dem Energieziel`;
}

/** Ein Hinweis, solange erst wenige Monate zählen: der Stand ändert sich noch mit jedem Monat. */
export function wenigeMonateHinweis(stand: EnergiezielStand): string | null {
  const b = stand.monate_bewertbar;
  if (b === 0 || b >= 3 || stand.monate_endgueltig >= stand.monate_soll) return null;
  const naechster = monatsPunkte(stand).find((p) => p.art === 'vorlaeufig');
  const teil = b === 1 ? 'Erst ein Monat der Zielperiode ist abgeschlossen' : 'Erst zwei Monate der Zielperiode sind abgeschlossen';
  const ab = naechster ? ` Der ${monatName(naechster.periode)} ist etwa ab ${tag(endgueltigAb(naechster.periode))} endgültig.` : '';
  return `${teil}; der Stand ändert sich mit jedem Monat.${ab}`;
}

// ------------------------------------------------------------------ Bewertet: der festgehaltene Stand (Entscheid 11)

/** „Verfehlt: Im Jahr 2028 wurde 2,7 % weniger Energie gebraucht als erwartet - vorgenommen waren 5 % weniger.“ */
export function festAntwort(ez: Energieziel): Antwort | null {
  const b = ez.bewertung;
  const s = b?.stand;
  if (!b || !s || b.status !== 'bewertet') return null;
  const [von, bis] = zp(ez.zielperiode);
  const jahr = periodeText(von, bis, true);
  const wannText = /^\d{4}$/.test(jahr) ? `Im Jahr ${jahr}` : `Von ${jahr}`;
  const kopf = b.ergebnis === 'erreicht' ? 'Erreicht' : b.ergebnis === 'verfehlt' ? 'Verfehlt' : 'Nicht bewertbar';
  const zahlTeil = s.delta_prozent === null ? 'gab es keinen bewertbaren Monat' : verbrauch(s.delta_prozent, s.richtung, s.einheit);
  const aus = s.ausgeschlossen.map((a) => `${monatLang(a.monat)} nicht bewertbar`);
  return {
    lage: 'noch_keine_aussage',
    satz: `${kopf}: ${wannText} ${zahlTeil} - vorgenommen waren ${zielText(ez.zielwert_prozent)}.`,
    formal: [`Bewertet am ${tag(b.am)} von ${b.person.name}`, `${s.monate_bewertbar} von ${s.monate_gesamt} Monaten`, ...aus].join(' · '),
  };
}

/** Unter dem Zitat der Bewertung: wer, wann - und ohne Vorschlag, warum („weil März 2028 nicht bewertbar war“). */
export function bewertetFuss(
  b: { person: { name: string }; am: string; vorschlag: string | null },
  s: EnergiezielFestgehaltenerStand | undefined,
): string {
  const aus = s?.ausgeschlossen.map((a) => monatLang(a.monat)) ?? [];
  const ohne = b.vorschlag === null && aus.length > 0
    ? ` · ohne Vorschlag, weil ${aus.join(' und ')} nicht bewertbar ${aus.length === 1 ? 'war' : 'waren'}`
    : '';
  return `${b.person.name} · ${tag(b.am)}${ohne}`;
}

/** Die zwei Kacheln des festgehaltenen Stands und der Satz darunter. */
export function festKacheln(ez: Energieziel): { kacheln: Kachel[]; fuss: string | null } | null {
  const s = ez.bewertung?.stand;
  if (!s || s.gemessen === null || s.erwartet === null) return null;
  const [von, bis] = zp(ez.zielperiode);
  const diff = dez(s.gemessen);
  const erw = dez(s.erwartet);
  const e = Math.max(diff.e, erw.e);
  const unterschied = dezText({ z: diff.z * 10n ** BigInt(e - diff.e) - erw.z * 10n ** BigInt(e - erw.e), e });
  const weniger = unterschied.startsWith('-');
  const hoch = hoechstensVon(s.erwartet, ez.zielwert_prozent);
  const h = dez(hoch);
  const e2 = Math.max(diff.e, h.e);
  const ueber = dezText({ z: diff.z * 10n ** BigInt(e2 - diff.e) - h.z * 10n ** BigInt(e2 - h.e), e: e2 });
  return {
    kacheln: [
      { name: 'Gemessen', wert: zahl(s.gemessen), einheit: s.einheit, sub: periodeText(von, bis) },
      {
        name: 'Erwartet', wert: zahl(s.erwartet), einheit: s.einheit,
        ...(runden(unterschied, 0).replace('-', '') === '0'
          ? { sub: 'so viel gebraucht wie erwartet' }
          : { subFett: menge(unterschied, s.einheit), sub: weniger ? ' weniger gebraucht' : ' mehr gebraucht' }),
      },
    ],
    fuss: `Für ${zielText(ez.zielwert_prozent)} wären es höchstens ${menge(hoch, s.einheit)} gewesen - gebraucht wurden ${menge(ueber, s.einheit)} ${ueber.startsWith('-') ? 'weniger' : 'mehr'}.`,
  };
}

/** „Heute gelesen: …“ - nur, wenn der Live-Stand vom festgehaltenen abweicht (Entscheid 11). */
export function heuteGelesen(fest: EnergiezielFestgehaltenerStand | undefined, live: EnergiezielStand | null): string | null {
  if (!fest || !live) return null;
  const gleich = live.monate_bewertbar === fest.monate_bewertbar && live.summe.delta_prozent !== null
    && fest.delta_prozent !== null && runden(live.summe.delta_prozent, 1) === runden(fest.delta_prozent, 1);
  if (gleich) return null;
  const am = fest.abruf ? ` vom ${tag(fest.abruf)}` : '';
  if (live.monate_bewertbar === 0 || live.summe.delta_prozent === null) {
    return `Heute gelesen: kein Monat der Zielperiode ist bewertbar. Festgehalten bleibt der Stand${am}.`;
  }
  const wie = live.summe.richtung === 'gleich' ? 'so viel wie erwartet' : `${prozent(live.summe.delta_prozent)} ${live.summe.richtung ?? ''} als erwartet`;
  return `Heute gelesen: ${wie} nach ${live.monate_text} Monaten. Festgehalten bleibt der Stand${am}.`;
}

// ------------------------------------------------------------------ Maßnahmen am Energieziel (Entscheid 5)

export interface MassnahmenAmZiel {
  fuer: Massnahme[];
  imStand: Massnahme[];
}

export function massnahmenAmZiel(liste: { massnahmen: Massnahme[]; im_stand_enthalten?: string[] }): MassnahmenAmZiel {
  const enthalten = new Set(liste.im_stand_enthalten ?? []);
  return {
    fuer: liste.massnahmen.filter((m) => !enthalten.has(m.id) && m.zustand !== 'verworfen'),
    imStand: liste.massnahmen.filter((m) => enthalten.has(m.id)),
  };
}

const ERGEBNIS_MASSNAHME: Record<string, string> = { belegt: 'belegt', nicht_belegt: 'nicht belegt', nicht_messbar: 'nicht messbar' };

/**
 * Was eine umgesetzte Maßnahme beobachtet: die Kurzform der Liste (`wirkung_kurz`, dieselbe Operation `wirkung` wie
 * `…/{id}/wirkung`) - kein Abruf je Maßnahme (Review r1 S-1.6). Ohne Kurzform keine Zahl.
 */
export function beobachtetAus(m: Pick<Massnahme, 'wirkung_kurz'>): string | null {
  const k = m.wirkung_kurz;
  if (!k) return null;
  return k.richtung === 'gleich' ? 'wie erwartet' : `${prozent(k.delta_prozent)} ${k.richtung}`;
}

/** Die Zeile einer Maßnahme am Energieziel: was sie ist, bis wann oder seit wann, wer - und was beobachtet ist. */
export function massnahmeUnterzeile(m: Massnahme): string {
  if (m.zustand === 'geplant') {
    const frist = m.frist.faellig === 'ueberfaellig' && m.frist.seit_tagen !== null
      ? `seit ${m.frist.seit_tagen} ${m.frist.seit_tagen === 1 ? 'Tag' : 'Tagen'} überfällig`
      : `geplant bis ${tag(m.termin)}`;
    return `${frist} · ${m.verantwortlich.name}`;
  }
  const teile = [m.umgesetzt_am ? `seit ${tag(m.umgesetzt_am)}` : 'umgesetzt'];
  const beobachtet = beobachtetAus(m);
  if (beobachtet) teile.push(`${beobachtet} beobachtet`);
  else if (m.erwartete_wirkung_prozent) teile.push(`erwartet ${zielText(m.erwartete_wirkung_prozent)}`);
  if (m.bewertung?.status === 'bewertet') teile.push(ERGEBNIS_MASSNAHME[m.bewertung.ergebnis] ?? m.bewertung.ergebnis);
  return teile.join(' · ');
}

/** Der Fuß der Karte im Reiter: „Noch keine Maßnahme geplant“ · „1 Maßnahme geplant“ · „2 Maßnahmen: 1 geplant, 1 umgesetzt“. */
export function massnahmenFuss(fuer: Massnahme[]): string {
  if (fuer.length === 0) return 'Noch keine Maßnahme geplant';
  const geplant = fuer.filter((m) => m.zustand === 'geplant').length;
  const umgesetzt = fuer.length - geplant;
  if (fuer.length === 1) return `1 Maßnahme ${geplant ? 'geplant' : 'umgesetzt'}`;
  const teile = [geplant ? `${geplant} geplant` : null, umgesetzt ? `${umgesetzt} umgesetzt` : null].filter(Boolean);
  return `${fuer.length} Maßnahmen: ${teile.join(', ')}`;
}

// ------------------------------------------------------------------ Bewertung (Ankündigung, fällig)

/** „Nach Dezember 2029, sobald der letzte Monat endgültig ist (etwa ab 07.01.2030), schlägt VoltPilot vor …“ */
export function bewertungAnkuendigung(zielperiode: string): string {
  const [, bis] = zp(zielperiode);
  return `Nach ${monatLang(bis)}, sobald der letzte Monat endgültig ist (etwa ab ${tag(endgueltigAb(bis))}), schlägt VoltPilot vor, ob das Energieziel erreicht ist. Entscheiden tut eine Person, mit Begründung.`;
}

/** Bewertung fällig (§6.12): der Vorschlag mit Zahl - oder warum es keinen gibt. */
export function bewertungFaelligSatz(stand: EnergiezielStand | null, ez: Energieziel): string {
  const name = energiezielName(ez);
  if (!stand || stand.summe.delta_prozent === null) return `Das ${name} ist zu Ende. Bewerten Sie es mit Begründung.`;
  const zahlTeil = `${prozent(stand.summe.delta_prozent)} ${stand.summe.richtung ?? ''} als erwartet, vorgenommen waren ${zielText(ez.zielwert_prozent)}`;
  if (stand.vorschlag === null) {
    return `Das ${name} ist zu Ende: ${zahlTeil}. Einen Vorschlag gibt es nicht, weil nur ${stand.monate_text} Monaten bewertbar sind - bewerten Sie es mit Begründung.`;
  }
  const v = stand.vorschlag === 'erreicht' ? 'erreicht' : 'verfehlt';
  return `Das ${name} ist zu Ende. VoltPilot schlägt vor: ${v} - ${zahlTeil}. Bewerten Sie es; mit Begründung auch anders.`;
}

// ------------------------------------------------------------------ Auffälligkeit (Hinweis)

/** Δ eines Vermerks aus seiner Kopie (`anlass_inhalt`), wo sie eine trägt: „2,2 % über der Erwartung“. */
export function auffaelligkeitDelta(inhalt: Record<string, unknown> | null | undefined): string | null {
  const suche = (x: unknown): { delta_prozent?: unknown; richtung?: unknown } | null => {
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    if (o.bereinigt && typeof o.bereinigt === 'object') return o.bereinigt as { delta_prozent?: unknown };
    if (Array.isArray(o.vergleich)) return suche(o.vergleich[0]);
    return null;
  };
  const b = suche(inhalt);
  if (!b || typeof b.delta_prozent !== 'string') return null;
  return `${prozent(b.delta_prozent)} ${b.delta_prozent.startsWith('-') ? 'unter' : 'über'} der Erwartung`;
}

/** Monate der Zielperiode, nur `JJJJ-MM` zwischen `von` und `bis` (für die Grafik ohne Stand). */
export function monateZwischen(von: string, bis: string): string[] {
  const aus: string[] = [];
  for (let i = monatIndex(von); i <= monatIndex(bis); i++) aus.push(alsMonat(i));
  return aus;
}
