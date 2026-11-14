/**
 * **Abrechnung prüfen** (Bedienkonzept `vp-privatkunde-bedienkonzept` §7, Variante A, Entscheide BK-8/9/10 = A):
 * der fünfte Abschnitt „Zeitraum“ im Verlauf › Energie und die Karte „Abrechnung prüfen“ darunter.
 *
 * Reines Modul (das `energieSeite.ts`-Muster): Adresse, Vorgabe-Zeitraum, Kartenzeilen und Sätze. Kein React,
 * kein Netz.
 *
 * **Kein Urteil über den Zähler** — nur der Unterschied: kein Grün, kein „stimmt“. Ab 5 % Abweichung steht der
 * Wert im Warn-Ton und die Karte fragt nach Zeitraum und Zählernummer (Startwert des Bauplans, nicht vom
 * Captain entschieden).
 */
import type { Abrechnung, AbrechnungZeile, HistoryRange } from './api';
import { NBSP, fmtNum } from './format';
import { ABRECHNUNG_PRUEFEN } from './glossar';
import { isoDate } from './periodNav';
import { zahl } from './zahl';

/** Ab dieser Abweichung (bezogen auf die Rechnung) der zweite Satz und der Warn-Ton. */
export const GROSSER_UNTERSCHIED_PCT = 5;

/** Bis zu so vielen Tagen zeigt die Seite Tage, darüber Monate (wie die API, `Zeitraum.TAGE_JE_TAG`). */
export const TAGE_JE_TAG = 92;

/** Längster Zeitraum (wie die API, `Zeitraum.MAX_TAGE`). */
export const MAX_TAGE = 3 * 366;

/** Die Wörter der Fläche — sie wohnen im Glossar (`glossar.ts`, Fachmodell „Abrechnung prüfen“). */
export const WORT = ABRECHNUNG_PRUEFEN;

/** Ein Zeitraum in ganzen Tagen, beide eingeschlossen (ISO `JJJJ-MM-TT`). */
export interface Zeitraum {
  von: string;
  bis: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Ein ISO-Tag als lokales Datum (12 Uhr: unempfindlich gegen die Zeitumstellung). */
export function tagDatum(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function gueltigerTag(iso: string | null): iso is string {
  if (!iso || !ISO.test(iso)) return false;
  return isoDate(tagDatum(iso)) === iso;
}

/** Tage von bis bis, beide eingeschlossen. */
export function zeitraumTage(z: Zeitraum): number {
  return Math.round((tagDatum(z.bis).getTime() - tagDatum(z.von).getTime()) / 86_400_000) + 1;
}

/** Über {@link TAGE_JE_TAG} Tage: Monate statt Tage. */
export function zeitraumJeMonat(z: Zeitraum): boolean {
  return zeitraumTage(z) > TAGE_JE_TAG;
}

/** Der letzte wählbare Tag: gestern. */
export function letzterTag(heute: Date): string {
  return isoDate(new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() - 1, 12));
}

/**
 * Liest `z=zeitraum&von=…&bis=…` aus einer Adresse. `null`, wenn die Adresse keinen gültigen Zeitraum trägt —
 * dann gilt der gewohnte Tag/Woche/Monat/Jahr-Weg (`parseVerlaufParams`).
 */
export function parseZeitraum(hashOrQuery: string): Zeitraum | null {
  const q = hashOrQuery.indexOf('?');
  const params = new URLSearchParams(q >= 0 ? hashOrQuery.slice(q + 1) : '');
  if (params.get('z') !== 'zeitraum') return null;
  const von = params.get('von');
  const bis = params.get('bis');
  if (!gueltigerTag(von) || !gueltigerTag(bis) || bis < von) return null;
  return { von, bis };
}

/** Die Adresse eines Zeitraums auf Verlauf › Energie. */
export function zeitraumHash(siteId: string, z: Zeitraum): string {
  return `#/anlage/${siteId}/messwerte?z=zeitraum&von=${z.von}&bis=${z.bis}`;
}

/**
 * Der Zeitraum, mit dem „Zeitraum“ beim ersten Tippen beginnt: die gezeigte Periode — Monat und Jahr wie sie sind,
 * Tag und Woche als ihr Monat —, höchstens bis gestern. Liegt sie ganz in der Zukunft (der erste Tag des Monats
 * ist heute), gilt der Vormonat. So schließt der Zeitraum an das an, was der Kunde gerade sah.
 */
export function zeitraumVorgabe(anchor: Date, range: HistoryRange, heute: Date): Zeitraum {
  const gestern = letzterTag(heute);
  let von: Date;
  let bis: Date;
  if (range === 'year') {
    von = new Date(anchor.getFullYear(), 0, 1, 12);
    bis = new Date(anchor.getFullYear(), 11, 31, 12);
  } else {
    von = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
    bis = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 12);
  }
  if (isoDate(von) > gestern) {
    von = new Date(von.getFullYear(), von.getMonth() - 1, 1, 12);
    bis = new Date(von.getFullYear(), von.getMonth() + 1, 0, 12);
  }
  const b = isoDate(bis) > gestern ? gestern : isoDate(bis);
  return { von: isoDate(von), bis: b };
}

/**
 * Hält einen Zeitraum in seinen Grenzen, nachdem der Kunde EIN Datum geändert hat: bis höchstens gestern, von nie
 * nach bis (dann rückt das andere Datum nach), nie länger als {@link MAX_TAGE}.
 */
export function zeitraumSetzen(alt: Zeitraum, feld: 'von' | 'bis', wert: string, heute: Date): Zeitraum {
  const gestern = letzterTag(heute);
  let von = feld === 'von' ? wert : alt.von;
  let bis = feld === 'bis' ? wert : alt.bis;
  if (bis > gestern) bis = gestern;
  if (von > bis) {
    if (feld === 'von') bis = von > gestern ? gestern : von;
    else von = bis;
    if (von > bis) von = bis;
  }
  const z = { von, bis };
  if (zeitraumTage(z) > MAX_TAGE) {
    const d = tagDatum(feld === 'von' ? von : bis);
    if (feld === 'von') z.bis = isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + MAX_TAGE - 1, 12));
    else z.von = isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - MAX_TAGE + 1, 12));
  }
  return z;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** `01.11.2025` */
export function tagText(iso: string): string {
  const d = tagDatum(iso);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** `01.11.2025 – 31.10.2026` (ein Tag: nur der Tag). */
export function zeitraumText(z: Zeitraum): string {
  return z.von === z.bis ? tagText(z.von) : `${tagText(z.von)} – ${tagText(z.bis)}`;
}

/** Eine Tagesspanne knapp: `12.–14.02.2026`, `30.01.–02.02.2026`, `30.12.2025–02.01.2026`. */
export function spanneText(von: string, bis: string): string {
  if (von === bis) return tagText(von);
  const a = tagDatum(von);
  const b = tagDatum(bis);
  if (a.getFullYear() !== b.getFullYear()) return `${tagText(von)}–${tagText(bis)}`;
  if (a.getMonth() !== b.getMonth()) return `${p2(a.getDate())}.${p2(a.getMonth() + 1)}.–${tagText(bis)}`;
  return `${p2(a.getDate())}.–${tagText(bis)}`;
}

/** Eine Zeitraum-Menge: ganze kWh (UEMS-Zahlenformat: Tag/Monat/Jahr ohne Nachkommastelle). */
export function kwhGanz(v: number | null | undefined): string {
  return v == null ? '–' : fmtNum(v, 'kWh', 0);
}

/** Ein Zählerstand ohne Einheit: `12.455`. */
export function standText(v: number): string {
  return fmtNum(v, '', 0);
}

/** Der Wert eines Eingabefelds aus der gespeicherten Zahl: `5.131`, `5.131,4`. */
export function eingabeText(v: number | null | undefined): string {
  if (v == null) return '';
  return v.toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

/**
 * Liest ein Eingabefeld: leer = `null` (löscht die Zahl), ungültig = `'ungueltig'`. Deutsche Zahlen über `zahl.ts`
 * (Tausenderpunkt und Komma), nie negativ.
 */
export function eingabeWert(text: string): number | null | 'ungueltig' {
  if (text.trim() === '') return null;
  const n = zahl(text);
  if (n == null || n < 0) return 'ungueltig';
  return n;
}

/** Der Unterschied gemessen − Rechnung in kWh und Prozent der Rechnung. */
export interface Unterschied {
  text: string;
  gross: boolean;
}

export function unterschied(gemessen: number | null | undefined, rechnung: number | null | undefined): Unterschied | null {
  if (gemessen == null || rechnung == null) return null;
  const d = Math.round(gemessen) - Math.round(rechnung);
  const kwh = d === 0 ? `0${NBSP}kWh` : `${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d), 'kWh', 0)}`;
  if (rechnung <= 0) return { text: kwh, gross: false };
  const pct = (Math.abs(gemessen - rechnung) / rechnung) * 100;
  const pctText = `${pct.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}%`;
  return { text: `${kwh} · ${pctText}`, gross: pct >= GROSSER_UNTERSCHIED_PCT };
}

export type Richtung = 'bezug' | 'einspeisung';

/** Eine Zeile der Karte. */
export interface KartenZeile {
  richtung: Richtung;
  label: string;
  /** Die gemessene Menge: `5.154 kWh` oder `–`. */
  gemessen: string;
  /** Die graue Zeile darunter: `Zählerstand 12.455 → 17.609` oder `aus Messwerten summiert` (BK-9 = A). */
  herkunft: string | null;
  unterschied: Unterschied | null;
}

export interface KartenSatz {
  text: string;
  ton: 'normal' | 'warn';
}

export interface AbrechnungKarteView {
  titel: string;
  zeitraum: string;
  zeilen: KartenZeile[];
  saetze: KartenSatz[];
}

function herkunftText(z: AbrechnungZeile): string | null {
  if (z.mengeKwh == null) return null;
  if (z.herkunft === 'zaehler' && z.standVonKwh != null && z.standBisKwh != null) {
    return `Zählerstand ${standText(z.standVonKwh)} → ${standText(z.standBisKwh)}`;
  }
  return WORT.summiert;
}

function lueckenText(luecken: { von: string; bis: string }[]): string {
  const teile = luecken.slice(0, 3).map((l) => spanneText(l.von, l.bis));
  return luecken.length > 3 ? `${teile.join(', ')} …` : teile.join(', ');
}

/**
 * Die Karte aus der Antwort der API und den Zahlen in den Feldern. Die Sätze in dieser Reihenfolge: Messbeginn,
 * Zählertausch, Lücken, großer Unterschied — gibt es keinen, steht der Standardsatz.
 */
export function abrechnungKarte(
  a: Abrechnung,
  rechnung: { bezug: number | null; einspeisung: number | null },
): AbrechnungKarteView {
  const zeilen: KartenZeile[] = [];
  const paare: [Richtung, string, AbrechnungZeile | null][] = [
    ['bezug', WORT.netzbezug, a.bezug],
    ['einspeisung', WORT.einspeisung, a.einspeisung],
  ];
  for (const [richtung, label, z] of paare) {
    if (!z) continue;
    zeilen.push({
      richtung,
      label,
      gemessen: kwhGanz(z.mengeKwh),
      herkunft: herkunftText(z),
      unterschied: unterschied(z.mengeKwh, rechnung[richtung]),
    });
  }

  const saetze: KartenSatz[] = [];
  if (a.bezug.mengeKwh == null && (a.einspeisung?.mengeKwh ?? null) == null) {
    saetze.push({ text: 'Für diesen Zeitraum liegen keine Messwerte vor.', ton: 'normal' });
    return { titel: WORT.titel, zeitraum: zeitraumText(a), zeilen, saetze };
  }
  if (a.messbeginn && a.tageVorMessbeginn > 0) {
    const tage = a.tageVorMessbeginn === 1 ? '1 Tag' : `${a.tageVorMessbeginn} Tage`;
    saetze.push({
      text: `Gemessen wird erst seit dem ${tagText(a.messbeginn)} – davor fehlen ${tage} dieses Zeitraums.`,
      ton: 'warn',
    });
  }
  const zeilenMitDaten = [a.bezug, a.einspeisung].filter((z): z is AbrechnungZeile => z != null);
  if (zeilenMitDaten.some((z) => z.zaehlerFaellt)) {
    saetze.push({
      text: 'Der Zählerstand am Netzanschluss springt in diesem Zeitraum zurück (Zählertausch?) – die Mengen sind aus Messwerten summiert.',
      ton: 'warn',
    });
  }
  // Lücken: dieselben Tage fehlen meist in beiden Richtungen — einmal nennen, die längere Liste gewinnt.
  const mitLuecke = zeilenMitDaten.filter((z) => z.fehlendeTage > 0).sort((x, y) => y.fehlendeTage - x.fehlendeTage)[0];
  if (mitLuecke) {
    const n = mitLuecke.fehlendeTage;
    const wo = mitLuecke.herkunft === 'zaehler' ? 'in der Menge' : 'in der Summe';
    saetze.push({
      text: `An ${n === 1 ? '1 Tag' : `${n} Tagen`} fehlen Messwerte (${lueckenText(mitLuecke.luecken)}) – sie sind ${wo} nicht enthalten.`,
      ton: 'warn',
    });
  }
  const gross = zeilen.filter((z) => z.unterschied?.gross);
  if (gross.length > 0) {
    const bei = gross.map((z) => (z.richtung === 'bezug' ? 'beim Netzbezug' : 'bei der Einspeisung')).join(' und ');
    saetze.push({ text: `Größerer Unterschied ${bei}. Stimmen Zeitraum und Zählernummer auf der Rechnung?`, ton: 'normal' });
  }
  if (saetze.length === 0) saetze.push({ text: WORT.standard, ton: 'normal' });
  return { titel: WORT.titel, zeitraum: zeitraumText(a), zeilen, saetze };
}

/** Eine Zeile unter „Frühere Prüfungen“: `01.11.2025 – 31.10.2026`. */
export function fruehereZeile(p: { von: string; bis: string }): string {
  return zeitraumText(p);
}
