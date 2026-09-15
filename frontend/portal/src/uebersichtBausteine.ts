/**
 * Die Übersichts-Bausteine je Ebene (UEMS AP-13 IP-7; E3 = A, E13 = A, Ü1–Ü5) — reine Hälfte.
 *
 * Unter der Anlagen-Tabelle der Unternehmens- und der Standort-Übersicht, vor der Karte „Funktionen“ (Ü1), stehen
 * aus der Messstellen-Welt drei Bausteine — und keiner rechnet selbst:
 * - **Messstellen**: die Datenlage je Standort, wie das Register sie zählt (`GET /api/v1/messstellen`, `aggregat`) —
 *   dieselbe Zahl, die das Register nach dem Sprung nennt und die Karte „Funktionen“ seit IP-7 spricht (E13);
 * - **Energiebilanz**: die Summe der Hauptzähler Bezug der Systeme der Ebene über den Zwilling `uemsBilanz.ebene` aus
 *   den Bilanzen je Anlage (`GET …/sites/{id}/bilanz`), „x von y Systemen“, „mindestens … (… fehlt)“; am Standort
 *   zusätzlich die Gebäude-Zeilen über `uemsBilanz.gebaeude` (Ü4) — der Rest eines Systems steht NUR an der Anlage;
 * - **Kennzahlen**: die Listen-Karten der lebenden Kennzahlen mit Geltung in der Ebene (AP-11 IP-13).
 * Ein Baustein ohne Inhalt wird nicht gebaut (`null`), nie leer gezeigt. Kein Geld, kein Steuern (Ü5).
 *
 * Reines Modul: keine React-Importe, kein Netzwerk.
 */
import type { Bilanz, BilanzEingang, Kennzahl, MessstelleRegisterAbdeckung, MessstellenRegister } from './api';
import { dez, dezText } from './bezugsdaten';
import { UEMS_MESSSTELLE, UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { amStandort } from './kennzahlKarte';
import { anlageRoute, pageRoute, standortBereichRoute, standortMessstellenRoute, type Route } from './nav';
import type { Ton, UebersichtEbene } from './uebersicht';
import { ebene as ebenenSumme, gebaeude as gebaeudeSicht, type GebaeudeZeile, type SystemZeile } from './uemsBilanz';
import { zahl } from './uemsErgebnis';

/** Die drei Bausteine in der Reihenfolge von Ü1 — zugleich ihre Schlüssel im Katalog (`anwendungen/catalog.json`). */
export type UebersichtBausteinId = 'messstellen' | 'energiebilanz' | 'kennzahlen';

// ---------------------------------------------------------------------------------------------- Messstellen

export const MESSSTELLEN_TITEL = `${UEMS_MESSSTELLE}n`;

/** Eine Zeile des Bausteins „Messstellen“: der Satz des Registers und der Sprung ins gefilterte Register. */
export interface DatenlageZeile {
  key: string;
  /** Der Standort der Zeile; `null` = die Ebene selbst. */
  name: string | null;
  text: string;
  ton: Ton;
  ziel: Route;
}

/** Alle liefern → ruhig; keine liefert → grau; sonst bernstein. Schweigen ist nie rot. */
export const tonDerDatenlage = (a: Pick<MessstelleRegisterAbdeckung, 'erfuellt' | 'gesamt'>): Ton =>
  a.erfuellt === a.gesamt ? 'ok' : a.erfuellt === 0 ? 'off' : 'warn';

/**
 * Ü1/Ü2 — die Datenlage der Ebene, wörtlich aus dem Aggregat des Registers (keine dritte Zählung): am Standort seine
 * Zeile, im Unternehmen die Zeile des Unternehmens (auch Messstellen ohne Standort) und je lebendem Standort seine.
 * `null` = kein Register oder keine Messstelle in der Ebene — dann gibt es den Baustein nicht.
 */
export function messstellenBaustein(ebene: UebersichtEbene, register: MessstellenRegister | null): DatenlageZeile[] | null {
  if (!register) return null;
  const jeStandort = (id: string) => register.aggregat.standorte.find((s) => s.id === id && s.gesamt > 0) ?? null;
  if (ebene.art === 'standort') {
    const a = jeStandort(ebene.standort.id);
    if (!a) return null;
    return [{ key: ebene.standort.id, name: null, text: a.text, ton: tonDerDatenlage(a), ziel: standortMessstellenRoute(ebene.standort.id) }];
  }
  const u = register.aggregat.unternehmen;
  if (u.gesamt === 0) return null;
  const standorte = ebene.standorte
    .filter((st) => st.zustand !== 'archiviert')
    .flatMap((st): DatenlageZeile[] => {
      const a = jeStandort(st.id);
      return a ? [{ key: st.id, name: st.name, text: a.text, ton: tonDerDatenlage(a), ziel: standortMessstellenRoute(st.id) }] : [];
    });
  return [{ key: 'unternehmen', name: null, text: u.text, ton: tonDerDatenlage(u), ziel: pageRoute('portfolio-messstellen') }, ...standorte];
}

// ------------------------------------------------------------------------------------------------ Zeitraum

/** Die Zeiträume der Leiste: die Bilanz-Route kennt Tag · Monat · Jahr (keine Woche). */
export type BilanzPeriode = Bilanz['periode'];

export const BILANZ_PERIODEN: readonly { id: BilanzPeriode; label: string }[] = [
  { id: 'tag', label: 'Tag' },
  { id: 'monat', label: 'Monat' },
  { id: 'jahr', label: 'Jahr' },
];

const zwei = (n: number) => String(n).padStart(2, '0');
const isoTag = (d: Date) => `${d.getUTCFullYear()}-${zwei(d.getUTCMonth() + 1)}-${zwei(d.getUTCDate())}`;
const teile = (tag: string) => tag.split('-').map(Number) as [number, number, number];

/** Der erste Tag des Zeitraums, der `tag` enthält — so heißt `am` in der Adresse der Route. */
export function beginn(periode: BilanzPeriode, tag: string): string {
  if (periode === 'tag') return tag;
  return periode === 'monat' ? `${tag.slice(0, 7)}-01` : `${tag.slice(0, 4)}-01-01`;
}

/** Der letzte Tag des Zeitraums (einschließlich). */
export function ende(periode: BilanzPeriode, am: string): string {
  const [j, m] = teile(am);
  if (periode === 'tag') return am;
  return periode === 'monat' ? isoTag(new Date(Date.UTC(j, m, 0))) : `${j}-12-31`;
}

/** Ein Zeitraum weiter (`+1`) oder zurück (`-1`). */
export function blaettere(periode: BilanzPeriode, am: string, schritt: number): string {
  const [j, m, t] = teile(am);
  if (periode === 'jahr') return `${j + schritt}-01-01`;
  if (periode === 'monat') return isoTag(new Date(Date.UTC(j, m - 1 + schritt, 1)));
  return isoTag(new Date(Date.UTC(j, m - 1, t + schritt)));
}

/** Ü3 — die Leiste steht auf dem letzten GEBILDETEN Zeitraum: dem, der vor dem laufenden endet. */
export const letzterGebildeter = (periode: BilanzPeriode, heute: string): string =>
  blaettere(periode, beginn(periode, heute), -1);

/** Läuft der Zeitraum noch (oder liegt er vorn)? Dann gibt es keine Zahl, nie eine Hochrechnung (E11). */
export const laeuftNoch = (periode: BilanzPeriode, am: string, heute: string): boolean => am >= beginn(periode, heute);

/** „18.10.2026“ · „Oktober 2026“ · „2026“. */
export function zeitraumText(periode: BilanzPeriode, am: string): string {
  const [j, m, t] = teile(am);
  if (periode === 'jahr') return String(j);
  if (periode === 'monat') {
    return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(j, m - 1, 1)));
  }
  return `${zwei(t)}.${zwei(m)}.${j}`;
}

// ----------------------------------------------------------------------------------------------- Energiebilanz

/** Die Bilanz EINER Anlage der Ebene für den Zeitraum der Leiste. */
export interface AnlageBilanz {
  anlage: { id: string; name: string };
  /** `null` = die Bilanz dieser Anlage ist gerade nicht abrufbar. */
  bilanz: Bilanz | null;
}

export const NETZBEZUG = 'Netzbezug';
export const KEINE_WERTE = 'keine Werte';
export const NICHT_ABRUFBAR = 'Die Energiebilanz dieser Anlage ist gerade nicht abrufbar.';
export const STELLUNG_GEWECHSELT = 'Der Hauptzähler hat im Zeitraum gewechselt — die Abschnitte stehen an der Anlage.';
export const OHNE_STANDORT = 'Ohne Standort';

/** Ein System der Summe: die Zeile für den Zwilling, die Eingänge seiner Bilanz und — ohne Zahl — der Grund. */
interface SystemLesung {
  zeile: SystemZeile;
  eingaenge: BilanzEingang[] | null;
  grund: string | null;
}

/**
 * Das System einer Anlage im Zeitraum. `null`, wenn die Anlage keinen Hauptzähler Bezug hat — dann ist sie kein
 * System der Summe (sie fehlt nicht, sie hat keinen). Die Zahl ist der Periodenwert des Hauptzählers aus der Route,
 * nie nachgerechnet; wechselt der Hauptzähler im Zeitraum (mehrere Abschnitte), gibt es EINE Zahl nicht — die Anlage
 * zählt dann ohne Zahl, und die Summe sagt „mindestens“.
 */
function system(a: AnlageBilanz): SystemLesung | null {
  const ohneZahl = (messstelle: string, grund: string): SystemLesung => ({
    zeile: { anlage: a.anlage.id, kurzname: a.anlage.name, messstelle, menge: null, zustand: KEINE_WERTE, abdeckung_prozent: null, version: 1, kennzeichen: [] },
    eingaenge: null,
    grund,
  });
  if (!a.bilanz) return ohneZahl(`anlage:${a.anlage.id}`, NICHT_ABRUFBAR);
  const hz = a.bilanz.hauptzaehler;
  if (hz.length === 0) return null;
  const werte = hz.flatMap((h) => h.abschnitte.flatMap((ab) => ab.werte));
  const kennzeichen = hz[0].messstelle.kennzeichen;
  const e = werte.length === 1 ? werte[0].eingaenge.find((x) => x.messstelle === kennzeichen && x.rolle === 'zufluss') : undefined;
  if (hz.length > 1 || !e) return ohneZahl(kennzeichen, STELLUNG_GEWECHSELT);
  return {
    zeile: {
      anlage: a.anlage.id,
      kurzname: a.anlage.name,
      messstelle: kennzeichen,
      menge: e.menge === null ? null : dez(String(e.menge)),
      zustand: e.zustand,
      abdeckung_prozent: e.abdeckung_prozent,
      version: e.version,
      kennzeichen: e.kennzeichen,
    },
    eingaenge: werte[0].eingaenge,
    grund: null,
  };
}

/** Eine Summe in Worten: „174.400 kWh · 3 von 3 Systemen · Werk Lindach ab 15.10.2026“ — gerechnet vom Zwilling. */
export interface SummenSatz {
  text: string;
  ton: Ton;
}

function summenSatz(periode: BilanzPeriode, systeme: SystemZeile[], mitKennzeichen = true): SummenSatz {
  const u = ebenenSumme('kWh', systeme.length === 1 ? 'System' : 'Systemen', systeme);
  const xVonY = u.kennzeichen[u.kennzeichen.length - 1];
  if (u.mit_werten === 0) return { text: `${KEINE_WERTE} · ${xVonY}`, ton: 'off' };
  const menge = zahl(dezText(u.menge), 'kWh', periode);
  // Das geerbte Kennzeichen („Werk Lindach ab 15.10.2026“) steht an der Summe der Ebene und an der Zeile der Anlage —
  // die Zwischensumme eines Standorts wiederholt es nicht.
  const zusatz = mitKennzeichen ? u.anzeige_kennzeichen.map((k) => ` · ${k}`).join('') : '';
  if (u.fehlend.length === 0) return { text: `${menge} · ${xVonY}${zusatz}`, ton: 'ok' };
  const namen = u.fehlend.map((m) => systeme.find((s) => s.messstelle === m)?.kurzname ?? m);
  return {
    text: `mindestens ${menge} · ${xVonY} (${namen.join(', ')} ${namen.length === 1 ? 'fehlt' : 'fehlen'})${zusatz}`,
    ton: 'warn',
  };
}

/** Eine Anlage in der Energiebilanz — mit dem Sprung zu ihrem Verlauf (dort kommt mit IP-8 der Reiter „Energiebilanz“). */
export interface SystemBild {
  key: string;
  name: string;
  zahl: string;
  zusatz: string | null;
  ton: Ton;
  ziel: Route;
}

function systemBild(s: SystemLesung, periode: BilanzPeriode): SystemBild {
  const z = s.zeile;
  const woerter = [z.zustand === 'vollständig' ? null : z.zustand, ...z.kennzeichen].filter((w): w is string => !!w);
  return {
    key: z.anlage,
    name: z.kurzname,
    zahl: z.menge === null ? '—' : zahl(dezText(z.menge), 'kWh', periode),
    zusatz: s.grund ?? (woerter.length > 0 ? woerter.join(' · ') : null),
    ton: s.grund !== null || z.menge === null ? 'off' : z.zustand === 'vollständig' ? 'ok' : 'warn',
    ziel: anlageRoute(z.anlage, 'messwerte'),
  };
}

export interface EnergiebilanzGruppe {
  key: string;
  /** Der Standort (nur im Unternehmen); `null` = die Systeme der Ebene selbst. */
  name: string | null;
  summe: SummenSatz | null;
  systeme: SystemBild[];
}

export interface EnergiebilanzBild {
  zeitraum: string;
  /** Der Zeitraum läuft noch: statt einer Zahl der Grund-Satz. */
  hinweis: string | null;
  /** „Netzbezug 174.400 kWh · 3 von 3 Systemen …“; `null` im laufenden Zeitraum. */
  summe: SummenSatz | null;
  gruppen: EnergiebilanzGruppe[];
}

/**
 * Ü1/B3 — die Energiebilanz der Ebene: die Summe der Hauptzähler Bezug über ihre Systeme, im Unternehmen zusätzlich je
 * Standort (dieselbe Regel, kein eigener Rest). `null` = die Bilanzen fehlen noch oder die Ebene hat kein System.
 */
export function energiebilanzBaustein(i: {
  ebene: UebersichtEbene;
  periode: BilanzPeriode;
  am: string;
  heute: string;
  anlagen: AnlageBilanz[] | null;
}): EnergiebilanzBild | null {
  if (!i.anlagen) return null;
  const lesungen = i.anlagen.flatMap((a) => {
    const s = system(a);
    return s ? [s] : [];
  });
  if (lesungen.length === 0) return null;
  const zeitraum = zeitraumText(i.periode, i.am);
  if (laeuftNoch(i.periode, i.am, i.heute)) return { zeitraum, hinweis: UEMS_NOCH_NICHT_GERECHNET_SATZ, summe: null, gruppen: [] };
  const summe = summenSatz(i.periode, lesungen.map((s) => s.zeile));
  const bilder = (xs: SystemLesung[]) => xs.map((s) => systemBild(s, i.periode));
  if (i.ebene.art === 'standort') {
    return { zeitraum, hinweis: null, summe, gruppen: [{ key: i.ebene.standort.id, name: null, summe: null, systeme: bilder(lesungen) }] };
  }
  const standorte = i.ebene.standorte.filter((st) => st.zustand !== 'archiviert');
  const zugeordnet = new Set(standorte.flatMap((st) => st.anlagen.map((an) => an.id)));
  const gruppen: EnergiebilanzGruppe[] = standorte.flatMap((st) => {
    const xs = lesungen.filter((s) => st.anlagen.some((an) => an.id === s.zeile.anlage));
    return xs.length > 0 ? [{ key: st.id, name: st.name, summe: summenSatz(i.periode, xs.map((s) => s.zeile), false), systeme: bilder(xs) }] : [];
  });
  const ohne = lesungen.filter((s) => !zugeordnet.has(s.zeile.anlage));
  if (ohne.length > 0) {
    gruppen.push({ key: 'ohne-standort', name: OHNE_STANDORT, summe: summenSatz(i.periode, ohne.map((s) => s.zeile), false), systeme: bilder(ohne) });
  }
  return { zeitraum, hinweis: null, summe, gruppen };
}

// ------------------------------------------------------------------------------------------------- Gebäude

/** Was eine Gebäude-Zeile braucht — aus dem Ortsbaum und zwei gefilterten Abrufen des Registers. */
export interface GebaeudeEingang {
  id: string;
  kurzzeichen: string;
  name: string;
  /** Das Register mit Filter Ort = dieses Gebäude, heute — seine Datenlage; `null` = nicht abrufbar. */
  heute: MessstellenRegister | null;
  /** Die Kennzeichen der Messstellen im Gebäude am letzten Tag des Zeitraums; `null` = nicht abrufbar. */
  imZeitraum: readonly string[] | null;
}

export interface GebaeudeZeileBild {
  key: string;
  name: string;
  /** „gemessen im Gebäude 60 kWh (1 Messstelle)“; `null` = keine Zahl (laufend, nicht abrufbar, keine Messstelle). */
  gemessen: string | null;
  /** Die Datenlage der Messstellen im Gebäude; `null` = noch keine Messstelle. */
  datenlage: string | null;
  ton: Ton;
  ziel: Route;
}

/**
 * Ü4 — die Gebäude-Zeilen der Standort-Übersicht: je Gebäude die Sicht Ort × Stellung über den Zwilling
 * `uemsBilanz.gebaeude` (gemessen im Gebäude, ohne Gebäude-Rest — der Rest steht nur an der Anlage) und die Datenlage
 * seiner Messstellen aus dem gefilterten Register; jede Zeile springt in Standort › Gebäude.
 */
export function gebaeudeZeilen(i: {
  standortId: string;
  periode: BilanzPeriode;
  am: string;
  heute: string;
  anlagen: AnlageBilanz[] | null;
  gebaeude: GebaeudeEingang[];
}): GebaeudeZeileBild[] {
  const lesungen = (i.anlagen ?? []).flatMap((a) => {
    const s = system(a);
    return s ? [s] : [];
  });
  // Eine Zahl nur, wenn JEDES System seine Eingänge hat — sonst verschwiege das Gebäude einen Summanden.
  const lesbar = i.anlagen !== null && !laeuftNoch(i.periode, i.am, i.heute) && lesungen.every((s) => s.eingaenge !== null);
  const eingaenge = lesbar ? lesungen.flatMap((s) => s.eingaenge ?? []) : [];
  return i.gebaeude.map((g) => {
    const a = g.heute?.aggregat.unternehmen ?? null;
    const drin = g.imZeitraum;
    const imGebaeude = drin ? eingaenge.filter((e) => e.rolle === 'zugeordnet' && drin.includes(e.messstelle)) : [];
    let gemessen: string | null = null;
    if (drin && imGebaeude.length > 0) {
      const zeilen: GebaeudeZeile[] = eingaenge
        .filter((e) => e.rolle === 'zugeordnet' && e.menge !== null)
        .map((e) => ({ messstelle: e.messstelle, rolle: e.rolle, menge: dez(String(e.menge)), im_gebaeude: drin.includes(e.messstelle) }));
      const sicht = gebaeudeSicht(g.name, i.standortId, 'kWh', zeilen, null);
      const n = imGebaeude.length;
      const fehlen = imGebaeude.filter((e) => e.menge === null).map((e) => e.messstelle);
      const menge = zahl(dezText(sicht.gemessen_im_gebaeude), 'kWh', i.periode);
      const anzahl = `${n} ${n === 1 ? UEMS_MESSSTELLE : MESSSTELLEN_TITEL}`;
      gemessen =
        fehlen.length === 0
          ? `gemessen im Gebäude ${menge} (${anzahl})`
          : fehlen.length === n
            ? `gemessen im Gebäude: ${KEINE_WERTE} (${anzahl})`
            : `gemessen im Gebäude mindestens ${menge} (${anzahl}, ${fehlen.join(', ')} ${fehlen.length === 1 ? 'fehlt' : 'fehlen'})`;
    }
    return {
      key: g.id,
      name: g.name,
      gemessen,
      datenlage: a && a.gesamt > 0 ? a.text : null,
      ton: a && a.gesamt > 0 ? tonDerDatenlage(a) : 'off',
      ziel: standortBereichRoute(i.standortId, 'gebaeude'),
    };
  });
}

// ------------------------------------------------------------------------------------------------ Kennzahlen

/**
 * Ü1 — die Kennzahlen der Ebene: lebende (nicht archivierte) mit Geltung in der Ebene — am Standort die, die dort
 * gelten (`amStandort`), im Unternehmen alle. `null` = keine: dann gibt es den Baustein nicht (O3: am 18.10.2026 hat
 * Werk Lindach noch keine Kennzahl).
 */
export function kennzahlenDerEbene(ebene: UebersichtEbene, liste: readonly Kennzahl[] | null): Kennzahl[] | null {
  if (!liste) return null;
  const lebend = liste.filter((k) => k.archiviert_am === null);
  const hier = ebene.art === 'standort' ? amStandort(lebend, ebene.standort.id) : lebend;
  return hier.length > 0 ? hier : null;
}

/** Welche Bausteine gerade Inhalt haben — nur diese bietet die Fläche an (Katalog, „Anpassen“). */
export function bausteineMitInhalt(i: {
  messstellen: DatenlageZeile[] | null;
  energiebilanz: EnergiebilanzBild | null;
  gebaeude: readonly GebaeudeZeileBild[];
  kennzahlen: readonly Kennzahl[] | null;
}): UebersichtBausteinId[] {
  const out: UebersichtBausteinId[] = [];
  if (i.messstellen) out.push('messstellen');
  if (i.energiebilanz || i.gebaeude.length > 0) out.push('energiebilanz');
  if (i.kennzahlen) out.push('kennzahlen');
  return out;
}
