/**
 * Der Messstellen-Dialog (UEMS AP-04 IP-6, Mockups D1–D3): anlegen und bearbeiten in drei
 * Schritten — Identität · Zuordnung · Quelle. Rein: keine Netzzugriffe, keine Uhr, kein React;
 * `components/MessstelleDialog.tsx` rendert nur, was hier entschieden wird.
 *
 * ⚠ KEINE ZWEITE REGEL-LOGIK. Kennzeichen-Form, Größen-Katalog und Passung (Regel 7) stehen im
 * Vertrag (`uemsMessstelle.ts` ⟷ `MessstelleRegeln`, gegen `messstelle-vectors.json`) und
 * werden hier AUFGERUFEN. Die Stellungs-Regel (Hauptzähler, Unterzähler, Zyklus) urteilt der
 * Server an jedem Tag — der Dialog zeigt nur, was er vorher sicher weiß, und nimmt das Urteil an.
 *
 * ⚠ DIE SÄTZE DER ABLEHNUNGEN sind der Wortlaut der FEHLER-Tabelle (AP-04 §5.12), gebaut aus den
 * Fakten des Urteils (`messstelle.md` §7: „Gepinnt werden sie mit dem Dialog (IP-6)“) — der Test
 * hält jeden gegen die Tabelle. Wo der Dialog die Fakten nicht ergänzen kann (Name einer fremden
 * Anlage), gilt der Satz der Schnittstelle, der denselben Wortlaut trägt.
 */
import type {
  Messkanal,
  Messstelle,
  MessstelleAnlegen,
  MessstelleGroesse,
  MessstelleOrtAendern,
  MessstelleQuelleBinden,
  MessstelleQuelleZeitraum,
  MessstelleRegisterZeile,
  MessstelleStellung,
  MessstelleStellungAendern,
  OrtsbaumAmStichtag,
  OrtsbaumBereich,
  SiteEntity,
  StandorteAmStichtag,
} from './api';
import { kanalZeile, WERTART_WORT, zeitpunktAus } from './geraetEinstellungen';
import { UEMS_HAUPTGROESSE, UEMS_HAUPTZAEHLER, UEMS_NEBENGROESSE, UEMS_UNTERZAEHLER_VON } from './glossar';
import type { VpOption } from './picker/optionen';
import { zeitpunktText } from './uemsEinstellung';
import {
  ANTEIL_RICHTUNGEN,
  ANTEILE,
  GROESSEN_KATALOG,
  MEDIEN_WAEHLBAR,
  STELLUNGEN,
  groessePruefen,
  kennzeichenFormatGueltig,
  passung,
  rueckwirkung,
  type Anteil,
  type Groesse,
  type Herleitung,
  type PassungGrund,
} from './uemsMessstelle';
import { datumText } from './uemsOrtsbaum';

// -------------------------------------------------------------------- Rahmen

export type Fassung = 'anlegen' | 'bearbeiten';

/** Die drei Schritte (D1 · D2 · D3). */
export const SCHRITTE = ['Identität', 'Zuordnung', 'Quelle'] as const;
export type Schritt = 1 | 2 | 3;

export const DIALOG_TITEL: Record<Fassung, string> = {
  anlegen: 'Messstelle anlegen',
  bearbeiten: 'Messstelle bearbeiten',
};

/** Im ersten Umfang bietet der Dialog nur „Strom“ an (AP-00 E11) und nur „gemessen“ (E9). */
export const MEDIUM: string = MEDIEN_WAEHLBAR[0];
export const ART = 'gemessen' as const;

export const KNOPF = {
  weiterZuordnung: 'Weiter: Zuordnung',
  weiterQuelle: 'Weiter: Quelle',
  zurueck: 'Zurück',
  abbrechen: 'Abbrechen',
  schliessen: 'Schließen',
  spaeter: 'Später binden',
  fertig: 'Fertigstellen',
  nebengroesse: `${UEMS_NEBENGROESSE} hinzufügen`,
  entfernen: 'Entfernen',
  speichert: 'Speichern …',
  verstanden: 'Verstanden',
} as const;

/** Die Sätze der Pflichtfelder — sie nennen, was fehlt, und den Weg. */
export const PFLICHT = {
  name: 'Bitte geben Sie der Messstelle einen Namen.',
  groesse: 'Bitte wählen Sie die Größe.',
  richtung: 'Bitte wählen Sie die Richtung.',
  wertart: 'Bitte wählen Sie die Wertart.',
  nebengroesse: 'Bitte wählen Sie Größe, Richtung und Wertart — oder entfernen Sie die Nebengröße.',
  doppelt: 'Diese Größe hat die Messstelle schon.',
  anlage: 'Bitte wählen Sie die Anlage, in der die Messstelle steht.',
  stellung: 'Bitte wählen Sie die Stellung.',
  unterzaehler: 'Ein Unterzähler braucht die Messstelle, von der er Unterzähler ist.',
  tag: 'Bitte wählen Sie den Tag, ab dem das gilt.',
  kanal: 'Bitte wählen Sie mindestens einen Messwert — oder binden Sie die Quelle später.',
} as const;

/** Wenn die Schnittstelle nichts Lesbares sagt. */
export const SATZ_ALLGEMEIN = 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';

/** D1, wörtlich. */
export const HAUPTGROESSE_GRUND =
  'Eine Messstelle hat genau eine Hauptgröße — sie trägt Bilanz und Bericht. Weitere Größen (z. B. Wirkleistung) fügen Sie als Nebengröße hinzu.';

/** Bearbeiten: die Hauptgröße ist identitätsstiftend (E1, `messstelle.md` §1). */
export const HAUPTGROESSE_FEST = 'Die Hauptgröße bleibt fest — eine andere Größe ist eine andere Messstelle.';

/** Neben dem vorbelegten Kennzeichen (D1). */
export const KENNZEICHEN_CHIP = 'automatisch · änderbar';

/** D3: der Schritt Quelle ist freiwillig (E8). */
export const QUELLE_VORSPANN =
  'Aus welchem Messwert liest die Messstelle? Nur passende Messwerte sind wählbar. Eine Quelle ist keine Voraussetzung — Sie können sie später binden.';

export const KEINE_KOMPONENTE = 'Die gewählte Anlage hat noch keine Komponente mit Messwerten.';
export const OHNE_ANLAGE = 'Wählen Sie im Schritt Zuordnung einen Ort oder eine Anlage — dann stehen hier ihre Komponenten.';

// ------------------------------------------------- Sätze der FEHLER-Tabelle (§5.12)

/** „Kennzeichen-Format“ — wörtlich. */
export const SATZ_KENNZEICHEN_FORMAT = 'Erlaubt sind 2–16 Zeichen: Großbuchstaben, Ziffern, „-“, „.“, „/“.';

/** „Unterzähler von“ zeigt auf sich selbst — wörtlich. */
export const SATZ_SELBST = 'Eine Messstelle kann nicht ihr eigener Unterzähler sein.';

/** Wer ein Kennzeichen trägt oder trug (`kennzeichen_belegt`, Fakt `bestehend`). */
export interface BelegtVon {
  kennzeichen: string;
  /** Das heutige Kennzeichen der Messstelle, die es trägt oder trug. */
  messstelle: string;
  name: string | null;
  archiviert: boolean;
  frueher: boolean;
}

/** „MS-01 ist bereits vergeben (Netzbezug Halle 1). Kennzeichen sind je Unternehmen eindeutig — auch archivierte bleiben belegt.“ */
export function kennzeichenBelegtSatz(b: BelegtVon): string {
  const traeger = b.name == null ? b.messstelle : b.frueher ? `${b.name}, heute ${b.messstelle}` : b.name;
  return `${b.kennzeichen} ist bereits vergeben (${traeger}). Kennzeichen sind je Unternehmen eindeutig — auch archivierte bleiben belegt.`;
}

/** Die bestehende Messstelle im Urteil der Stellung (`bestehend`): Kennzeichen, Name, Anlage-ID. */
export interface StellungBestehend {
  kennzeichen: string;
  name: string | null;
  anlage: string;
}

const nennung = (kennzeichen: string, name: string | null | undefined): string =>
  name ? `${kennzeichen} ${name}` : kennzeichen;

/** „Werk Ahrenberg – Halle 1 hat bereits einen Hauptzähler: MS-01 Netzbezug Halle 1. Wählen Sie „Unterzähler von MS-01“ oder ändern Sie MS-01.“ */
export function hauptzaehlerSatz(anlageName: string, b: StellungBestehend): string {
  return (
    `${anlageName} hat bereits einen ${UEMS_HAUPTZAEHLER}: ${nennung(b.kennzeichen, b.name)}. ` +
    `Wählen Sie „${UEMS_UNTERZAEHLER_VON} ${b.kennzeichen}“ oder ändern Sie ${b.kennzeichen}.`
  );
}

/** „MS-11 gehört zu Halle 2. Ein Unterzähler kann nur auf eine Messstelle derselben Anlage zeigen.“ */
export function fremdeAnlageSatz(kennzeichen: string, anlageName: string): string {
  return `${kennzeichen} gehört zu ${anlageName}. Ein Unterzähler kann nur auf eine Messstelle derselben Anlage zeigen.`;
}

/** „Dieser Messwert speist bereits MS-06 (führend). …“ — wörtlich mit dem Kennzeichen aus dem Urteil. */
export function kanalBereitsFuehrendSatz(messstelle: string): string {
  return `Dieser Messwert speist bereits ${messstelle} (führend). Ein Messwert kann nur eine Messstelle führend speisen — als Vergleichsquelle ist er möglich.`;
}

const HERLEITUNG_ZUSATZ: Partial<Record<Herleitung, string>> = {
  integration: 'aus Leistung integriert',
  differenzen: 'aus Zählerstand',
};

const wertartWort = (k: Messkanal): string | null => (k.wertart ? (WERTART_WORT[k.wertart] ?? null) : null);

/**
 * „Der Messwert „Wirkleistung“ (kW, Momentanwert) kann die Größe „Wirkenergie · Zählerstand“
 * nicht liefern. Wählen Sie „Wirkenergie Bezug (Zählerstand)“ oder ändern Sie die Wertart auf
 * Intervallmenge (aus Leistung integriert).“ — der Grund einer ausgegrauten Zeile (Regel 7).
 *
 * `passend`: ein wählbarer Messwert derselben Komponente, sonst entfällt der erste Weg.
 * `wertartAenderbar`: nur solange die Hauptgröße noch nicht gespeichert ist — danach wäre „ändern
 * Sie die Wertart“ eine Sackgasse, und der Satz nennt nur, was geht.
 */
export function passtNichtSatz(
  k: Messkanal,
  ziel: Groesse,
  grund: PassungGrund,
  passend: Messkanal | null,
  wertartAenderbar: boolean,
): string {
  const merkmal = grund === 'richtung' ? ziel.richtung : grund === 'einheit' ? ziel.einheit : ziel.wertart;
  const fakten = [k.einheit, wertartWort(k), grund === 'richtung' ? k.richtung : null].filter(
    (x): x is string => Boolean(x),
  );
  const satz =
    `Der Messwert „${kanalZeile(k).name}“${fakten.length ? ` (${fakten.join(', ')})` : ''} ` +
    `kann die Größe „${ziel.groesse} · ${merkmal}“ nicht liefern.`;
  const wege: string[] = [];
  if (passend) wege.push(`Wählen Sie „${kanalZeile(passend).name} (${wertartWort(passend) ?? ''})“`);
  if (wertartAenderbar) {
    for (const w of eintragVon(ziel.groesse)?.wertarten ?? []) {
      if (w === ziel.wertart) continue;
      const p = passung(MEDIUM, { ...ziel, wertart: w }, k.groesse, k.richtung, k.einheit, k.wertart);
      if (p.fehler || !p.herleitung) continue;
      const zusatz = HERLEITUNG_ZUSATZ[p.herleitung];
      wege.push(`${wege.length ? 'ändern' : 'Ändern'} Sie die Wertart auf ${w}${zusatz ? ` (${zusatz})` : ''}`);
      break;
    }
  }
  return wege.length ? `${satz} ${wege.join(' oder ')}.` : satz;
}

// ---------------------------------------------------------- Schritt 1 · Identität

export interface GroesseEingabe {
  groesse: string;
  richtung: string;
  wertart: string;
}

export interface Identitaet {
  kennzeichen: string;
  name: string;
  notiz: string;
  hauptgroesse: GroesseEingabe;
  nebengroessen: GroesseEingabe[];
}

export const leereGroesse = (): GroesseEingabe => ({ groesse: '', richtung: '', wertart: '' });

/** Anlegen: das Kennzeichen ist mit dem Vorschlag des Servers VORBELEGT (E7), der Rest leer. */
export function leereIdentitaet(vorschlag: string | null): Identitaet {
  return { kennzeichen: vorschlag ?? '', name: '', notiz: '', hauptgroesse: leereGroesse(), nebengroessen: [] };
}

/** Bearbeiten: das, was gespeichert ist. */
export function identitaetAus(m: Messstelle): Identitaet {
  const g = m.hauptgroesse;
  return {
    kennzeichen: m.kennzeichen,
    name: m.name ?? '',
    notiz: m.notiz ?? '',
    hauptgroesse: g ? { groesse: g.groesse, richtung: g.richtung, wertart: g.wertart } : leereGroesse(),
    nebengroessen: (m.nebengroessen ?? [])
      .filter((n) => n.lebenszyklus !== 'archiviert')
      .map((n) => ({ groesse: n.groesse, richtung: n.richtung, wertart: n.wertart })),
  };
}

/** Der Katalog-Eintrag einer Größe für das Medium des Dialogs. */
export function eintragVon(groesse: string) {
  return GROESSEN_KATALOG.find((e) => e.groesse === groesse && e.medien.includes(MEDIUM));
}

/** Was der Kunde unter der Wertart liest. */
export const WERTART_SUB: Readonly<Record<string, string>> = {
  Zählerstand: 'der Stand des Zählwerks',
  Intervallmenge: 'die Menge je Zeitraum',
  Momentanwert: 'der Wert im Augenblick',
};

/** Die Größen des Katalogs für „Strom“ — nie eine, die der Katalog nicht kennt. */
export function groesseOptionen(): VpOption[] {
  return GROESSEN_KATALOG.filter((e) => e.medien.includes(MEDIUM)).map((e) => ({
    value: e.groesse,
    label: e.groesse,
    sub: e.einheit,
  }));
}

/** Die Richtungen einer Größe — ohne die, die nur eine berechnete Messstelle trägt (`saldiert`). */
export function richtungOptionen(groesse: string): VpOption[] {
  return (eintragVon(groesse)?.richtungen ?? []).map((r) => ({ value: r, label: r }));
}

export function wertartOptionen(groesse: string): VpOption[] {
  return (eintragVon(groesse)?.wertarten ?? []).map((w) => ({ value: w, label: w, sub: WERTART_SUB[w] ?? null }));
}

export function einheitVon(groesse: string): string | null {
  return eintragVon(groesse)?.einheit ?? null;
}

/** Eine andere Größe gewählt: Richtung und Wertart bleiben, wenn sie weiter passen; gibt es nur eine, ist sie gewählt. */
export function groesseWaehlen(e: GroesseEingabe, groesse: string): GroesseEingabe {
  const k = eintragVon(groesse);
  const behalte = (wert: string, liste: string[]) =>
    liste.includes(wert) ? wert : liste.length === 1 ? liste[0] : '';
  return {
    groesse,
    richtung: behalte(e.richtung, k?.richtungen ?? []),
    wertart: behalte(e.wertart, k?.wertarten ?? []),
  };
}

/** Die vollständige Größe mit Einheit — nur, wenn der Katalog sie so kennt (`groessePruefen`). */
export function groesseAus(e: GroesseEingabe): MessstelleGroesse | null {
  const einheit = einheitVon(e.groesse);
  if (!einheit || !e.richtung || !e.wertart) return null;
  const g = { groesse: e.groesse, richtung: e.richtung, einheit, wertart: e.wertart };
  return groessePruefen(MEDIUM, g, ART).fehler ? null : g;
}

/** „Wirkenergie · Bezug · kWh · Zählerstand“ */
export function groesseText(g: MessstelleGroesse): string {
  return `${g.groesse} · ${g.richtung} · ${g.einheit} · ${g.wertart}`;
}

export type IdentitaetFeld = 'kennzeichen' | 'name' | 'groesse' | 'richtung' | 'wertart';

export interface IdentitaetFehler {
  felder: Partial<Record<IdentitaetFeld, string>>;
  /** Je Nebengröße ihr Satz, sonst `null`. */
  neben: (string | null)[];
}

const IDENTITAET_REIHENFOLGE: IdentitaetFeld[] = ['kennzeichen', 'name', 'groesse', 'richtung', 'wertart'];

/**
 * Was fehlen darf und was nicht. PFLICHT: der Name und — beim Anlegen — Größe, Richtung und
 * Wertart der Hauptgröße (Einheit folgt aus dem Katalog). DARF FEHLEN: das Kennzeichen beim
 * Anlegen (leer = der Vorschlag wird vergeben), Notiz und Nebengrößen. Beim Bearbeiten ist das
 * Kennzeichen Pflicht (die Schnittstelle ersetzt die Felder ganz).
 */
export function identitaetPruefen(f: Identitaet, fassung: Fassung): IdentitaetFehler {
  const felder: IdentitaetFehler['felder'] = {};
  const leerErlaubt = fassung === 'anlegen' && f.kennzeichen === '';
  if (!leerErlaubt && !kennzeichenFormatGueltig(f.kennzeichen)) felder.kennzeichen = SATZ_KENNZEICHEN_FORMAT;
  if (!f.name.trim()) felder.name = PFLICHT.name;
  if (fassung === 'bearbeiten') return { felder, neben: [] };
  if (!f.hauptgroesse.groesse) felder.groesse = PFLICHT.groesse;
  else {
    if (!f.hauptgroesse.richtung) felder.richtung = PFLICHT.richtung;
    if (!f.hauptgroesse.wertart) felder.wertart = PFLICHT.wertart;
  }
  const gesehen = new Set<string>();
  if (f.hauptgroesse.groesse && f.hauptgroesse.richtung) gesehen.add(groesseSchluessel(f.hauptgroesse));
  const neben = f.nebengroessen.map((n) => {
    if (!groesseAus(n)) return PFLICHT.nebengroesse;
    const s = groesseSchluessel(n);
    if (gesehen.has(s)) return PFLICHT.doppelt;
    gesehen.add(s);
    return null;
  });
  return { felder, neben };
}

/** Das erste Feld mit Fehler in Lesereihenfolge — `neben-<i>` für eine Nebengröße. */
export function ersterIdentitaetFehler(e: IdentitaetFehler): string | null {
  const feld = IDENTITAET_REIHENFOLGE.find((f) => e.felder[f]);
  if (feld) return feld;
  const i = e.neben.findIndex((s) => s !== null);
  return i >= 0 ? `neben-${i}` : null;
}

export const hatFehler = (e: IdentitaetFehler): boolean => ersterIdentitaetFehler(e) !== null;

/** Neben dem Kennzeichen-Feld beim Anlegen: der Chip, solange der Vorschlag steht. */
export function kennzeichenHinweis(eingabe: string, vorschlag: string | null, fassung: Fassung): string | null {
  if (fassung !== 'anlegen' || !vorschlag) return null;
  if (eingabe === vorschlag) return KENNZEICHEN_CHIP;
  if (eingabe === '') return `Leer vergibt ${vorschlag}.`;
  return null;
}

/**
 * FEHLER-Tabelle „Kennzeichen belegt“: „Feld markiert; Vorschlag „MS-0022“ bleibt stehen“ — ein
 * eigenes Kennzeichen verdrängt den Vorschlag nicht, er ist einen Klick entfernt. `null`, solange
 * er im Feld steht.
 */
export function vorschlagKnopf(eingabe: string, vorschlag: string | null, fassung: Fassung): string | null {
  return fassung === 'anlegen' && vorschlag && eingabe !== vorschlag && eingabe !== '' ? `Vorschlag ${vorschlag} übernehmen` : null;
}

/** Unverändert (oder leer) = automatisch: das Feld fehlt in der Anfrage, und der Zähler rückt vor. */
export function kennzeichenFuerAnlegen(eingabe: string, vorschlag: string | null): string | undefined {
  return eingabe === '' || eingabe === vorschlag ? undefined : eingabe;
}

export function anlegenAnfrage(f: Identitaet, vorschlag: string | null): MessstelleAnlegen {
  const kennzeichen = kennzeichenFuerAnlegen(f.kennzeichen, vorschlag);
  const hauptgroesse = groesseAus(f.hauptgroesse);
  if (!hauptgroesse) throw new Error('Hauptgröße unvollständig — erst prüfen, dann senden');
  return {
    ...(kennzeichen !== undefined ? { kennzeichen } : {}),
    name: f.name.trim(),
    art: ART,
    medium: MEDIUM,
    hauptgroesse,
    nebengroessen: f.nebengroessen.map(groesseAus).filter((g): g is MessstelleGroesse => g !== null),
    ...(f.notiz.trim() ? { notiz: f.notiz.trim() } : {}),
  };
}

/** PUT ersetzt die Felder GANZ: das Kennzeichen immer, die Anschlussleistung aus dem Bestand. */
export function bearbeitenAnfrage(f: Identitaet, bestand: Messstelle) {
  return {
    kennzeichen: f.kennzeichen,
    name: f.name.trim(),
    ...(f.notiz.trim() ? { notiz: f.notiz.trim() } : {}),
    anschlussleistung_kw: bestand.anschlussleistung_kw ?? null,
  };
}

export function identitaetUnveraendert(f: Identitaet, bestand: Messstelle): boolean {
  return (
    f.kennzeichen === bestand.kennzeichen &&
    f.name.trim() === (bestand.name ?? '') &&
    f.notiz.trim() === (bestand.notiz ?? '')
  );
}

export const groesseSchluessel = (g: { groesse: string; richtung: string }): string => `${g.groesse}|${g.richtung}`;

// ---------------------------------------------------------- Schritt 2 · Zuordnung

export type OrtArt = 'standort' | 'gebaeude' | 'bereich';

export interface OrtWahl {
  /** Die ID des Standorts, Gebäudes oder Bereichs. */
  id: string;
  kurzzeichen: string;
  name: string;
  /** „Werk Ahrenberg › Halle 1 › Halle 1 Nord“ */
  pfad: string;
  standortId: string;
  standortName: string;
  art: OrtArt;
}

export const ORT_ART_WORT: Record<OrtArt, string> = { standort: 'Standort', gebaeude: 'Gebäude', bereich: 'Bereich' };

const nichtArchiviert = (x: { zustand: string }) => x.zustand !== 'archiviert';
const nachKurzzeichen = (a: { kurzzeichen: string }, b: { kurzzeichen: string }) =>
  a.kurzzeichen.localeCompare(b.kurzzeichen, 'de-DE', { numeric: true });

/**
 * Die wählbaren Orte: jeder Standort, seine Gebäude und Bereiche — nur, was heute nicht
 * archiviert ist (FEHLER-Tabelle „Ort archiviert“: der Picker zeigt nur aktive Orte). Ein
 * Standort, dessen Baum noch nicht geladen ist, steht ohne Gebäude da.
 */
export function ortWahlen(
  standorte: StandorteAmStichtag,
  baeume: Readonly<Record<string, OrtsbaumAmStichtag | undefined>>,
): OrtWahl[] {
  const out: OrtWahl[] = [];
  for (const s of standorte.standorte.filter(nichtArchiviert)) {
    const am = { standortId: s.id, standortName: s.name };
    out.push({ id: s.id, kurzzeichen: s.kurzzeichen, name: s.name, pfad: s.name, art: 'standort', ...am });
    const baum = baeume[s.id];
    if (!baum) continue;
    const bereich = (b: OrtsbaumBereich, ueber: string) =>
      out.push({ id: b.id, kurzzeichen: b.kurzzeichen, name: b.name, pfad: `${ueber} › ${b.name}`, art: 'bereich', ...am });
    for (const g of baum.gebaeude.filter(nichtArchiviert).sort(nachKurzzeichen)) {
      const pfad = `${s.name} › ${g.name}`;
      out.push({ id: g.id, kurzzeichen: g.kurzzeichen, name: g.name, pfad, art: 'gebaeude', ...am });
      for (const b of g.bereiche.filter(nichtArchiviert).sort(nachKurzzeichen)) bereich(b, pfad);
    }
    for (const b of (baum.direktAmStandort?.bereiche ?? []).filter(nichtArchiviert).sort(nachKurzzeichen)) {
      bereich(b, s.name);
    }
  }
  return out;
}

/**
 * Der Name vorn, gruppiert nach Standort, darunter Art und was darüber hängt — am Telefon ist der
 * Auslöser zu schmal für „Werk Ahrenberg › Halle 1 › Halle 1 Nord“ und schnitte genau den Ort ab.
 */
export function ortOptionen(orte: OrtWahl[]): VpOption[] {
  return orte.map((o) => {
    const ueber = o.pfad.split(' › ').slice(1, -1).join(' › ');
    return {
      value: o.kurzzeichen,
      label: o.name,
      sub: ueber ? `${ORT_ART_WORT[o.art]} in ${ueber}` : ORT_ART_WORT[o.art],
      group: o.standortName,
    };
  });
}

/** Unter dem Ort-Feld: der ganze Pfad des gewählten Orts (D2) — sonst, was ohne Ort fehlt. */
export function ortHinweis(o: OrtWahl | null, kennzeichen: string): string {
  return o ? `${o.pfad} · ${ORT_ART_WORT[o.art]}` : ohneOrtSatz(kennzeichen);
}

export interface AnlageWahl {
  id: string;
  name: string;
  standortId: string | null;
  standortName: string | null;
}

export const OHNE_STANDORT = 'Noch keinem Standort zugeordnet';

/** Die Anlagen — mit gewähltem Ort die seines Standorts (und die noch keinem zugeordneten). */
export function anlageWahlen(standorte: StandorteAmStichtag, standortId: string | null): AnlageWahl[] {
  const zugeordnet = standorte.standorte
    .filter(nichtArchiviert)
    .flatMap((s) => s.anlagen.map((a) => ({ id: a.id, name: a.name, standortId: s.id, standortName: s.name })));
  const ohne = (standorte.nochNichtZugeordnet?.anlagen ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    standortId: null,
    standortName: null,
  }));
  const alle = [...zugeordnet, ...ohne];
  return standortId ? alle.filter((a) => a.standortId === standortId || a.standortId === null) : alle;
}

export function anlageOptionen(anlagen: AnlageWahl[]): VpOption[] {
  return anlagen.map((a) => ({ value: a.id, label: a.name, group: a.standortName ?? OHNE_STANDORT }));
}

/** D2: die Unterzeile je Stellung. */
export const STELLUNG_SUB: Record<MessstelleStellung, string> = {
  Hauptzähler: 'Die maßgebliche Messung am Netzanschluss',
  Unterzähler: 'Misst einen Teil dessen, was eine andere Messstelle misst.',
  Erzeuger: 'für PV oder eine andere Erzeugung',
  Speicher: 'für einen Batteriespeicher',
  Abzweig: 'für einen Abgang',
  keine: 'für eine Messstelle ohne elektrische Stellung',
};

const lebt = (r: MessstelleRegisterZeile) => r.lebenszyklus !== 'archiviert';

/** Die Hauptzähler einer Anlage heute, ohne die Messstelle selbst. */
export function hauptzaehlerDerAnlage(
  register: MessstelleRegisterZeile[],
  anlageId: string,
  eigeneId: string | null,
): MessstelleRegisterZeile[] {
  return register.filter(
    (r) =>
      lebt(r) &&
      r.id !== eigeneId &&
      r.elektrische_stellung?.anlage === anlageId &&
      r.elektrische_stellung.stellung === UEMS_HAUPTZAEHLER,
  );
}

/**
 * D2: „Die maßgebliche Messung am Netzanschluss — in Werk Lindach schon MS-16.“ Der Hinweis
 * sperrt nichts: zwei Hauptzähler desselben Zählers (Bezug und Abgabe) sind erlaubt, und
 * urteilen kann nur der Server an jedem Tag.
 */
export function stellungOptionen(
  register: MessstelleRegisterZeile[],
  anlage: AnlageWahl | null,
  eigeneId: string | null,
): VpOption[] {
  return STELLUNGEN.map((s) => {
    let sub = STELLUNG_SUB[s];
    if (s === UEMS_HAUPTZAEHLER) {
      const schon = anlage ? hauptzaehlerDerAnlage(register, anlage.id, eigeneId) : [];
      sub = schon.length ? `${sub} — in ${anlage!.name} schon ${schon.map((r) => r.kennzeichen).join(', ')}.` : `${sub}.`;
    }
    return { value: s, label: s, sub };
  });
}

/**
 * „Unterzähler von …“: nur Messstellen DERSELBEN Anlage (E12), nie sie selbst und nie eine, die
 * über ihre Kette schon unter ihr hängt (FEHLER-Tabelle: „Picker zeigt nur zulässige Messstellen“).
 */
export function unterzaehlerOptionen(
  register: MessstelleRegisterZeile[],
  anlageId: string,
  eigenesKennzeichen: string | null,
): VpOption[] {
  const bezug = new Map(register.map((r) => [r.kennzeichen, r.elektrische_stellung?.unterzaehler_von ?? null]));
  const unterMir = (kennzeichen: string): boolean => {
    const gesehen = new Set<string>();
    for (let k: string | null = kennzeichen; k && !gesehen.has(k); k = bezug.get(k) ?? null) {
      if (k === eigenesKennzeichen) return true;
      gesehen.add(k);
    }
    return false;
  };
  return register
    .filter((r) => lebt(r) && r.elektrische_stellung?.anlage === anlageId && r.kennzeichen !== eigenesKennzeichen)
    .filter((r) => !eigenesKennzeichen || !unterMir(r.kennzeichen))
    .map((r) => ({
      value: r.kennzeichen,
      label: nennung(r.kennzeichen, r.name),
      sub: `${r.hauptgroesse.groesse} · ${r.hauptgroesse.richtung}`,
    }));
}

export interface Zuordnung {
  /** Kurzzeichen des Orts; leer = noch keiner. */
  ort: string;
  /** ID der Anlage; leer = keine elektrische Stellung. */
  anlage: string;
  stellung: MessstelleStellung | '';
  /** Kennzeichen der übergeordneten Messstelle. */
  unterzaehlerVon: string;
  /** Ab welchem Tag (JJJJ-MM-TT) — für Ort und Stellung. */
  gueltigAb: string;
}

/** Was heute gilt — damit ein unverändertes Feld nichts schreibt und derselbe Tag korrigiert. */
export interface ZuordnungBestand {
  ort: string;
  ortAb: string | null;
  anlage: string;
  stellung: MessstelleStellung | '';
  unterzaehlerVon: string;
  stellungAb: string | null;
}

export type ZuordnungFeld = 'ort' | 'anlage' | 'stellung' | 'unterzaehlerVon' | 'gueltigAb';

export const ZUORDNUNG_REIHENFOLGE: ZuordnungFeld[] = ['ort', 'anlage', 'stellung', 'unterzaehlerVon', 'gueltigAb'];

export const LEERER_BESTAND: ZuordnungBestand = {
  ort: '',
  ortAb: null,
  anlage: '',
  stellung: '',
  unterzaehlerVon: '',
  stellungAb: null,
};

const giltAm = (heute: string) => (i: { gueltig_ab: string; gueltig_bis: string | null }) =>
  i.gueltig_ab <= heute && (i.gueltig_bis === null || i.gueltig_bis >= heute);

/** Der Bestand einer gespeicherten Messstelle: das Intervall von heute, sonst das jüngste. */
export function zuordnungBestandAus(m: Messstelle | null, heute: string): ZuordnungBestand {
  if (!m) return LEERER_BESTAND;
  const heuteOderJuengstes = <T extends { gueltig_ab: string; gueltig_bis: string | null }>(xs: T[] = []) =>
    xs.find(giltAm(heute)) ?? [...xs].sort((a, b) => b.gueltig_ab.localeCompare(a.gueltig_ab))[0] ?? null;
  const ort = heuteOderJuengstes(m.orte);
  const st = heuteOderJuengstes(m.elektrische_stellung);
  return {
    ort: ort?.kennzeichen ?? '',
    ortAb: ort?.gueltig_ab ?? null,
    anlage: st?.anlage ?? '',
    stellung: st?.stellung ?? '',
    unterzaehlerVon: st?.unterzaehler_von ?? '',
    stellungAb: st?.gueltig_ab ?? null,
  };
}

/** Das Formular aus dem Bestand; ohne Ort ist der Vorgabe-Ort vorbelegt (5.1: „Vorgabe: Standort“). */
export function zuordnungAus(b: ZuordnungBestand, heute: string, vorgabeOrt: string | null): Zuordnung {
  return {
    ort: b.ort || vorgabeOrt || '',
    anlage: b.anlage,
    stellung: b.stellung,
    unterzaehlerVon: b.unterzaehlerVon,
    gueltigAb: heute,
  };
}

/** Was fehlen darf: Ort und Stellung (dann bleibt es ein Entwurf bzw. ohne Stellung). Was nicht: s. Sätze. */
export function zuordnungPruefen(z: Zuordnung): Partial<Record<ZuordnungFeld, string>> {
  const f: Partial<Record<ZuordnungFeld, string>> = {};
  if (z.stellung && !z.anlage) f.anlage = PFLICHT.anlage;
  if (z.anlage && !z.stellung) f.stellung = PFLICHT.stellung;
  if (z.stellung === 'Unterzähler' && !z.unterzaehlerVon) f.unterzaehlerVon = PFLICHT.unterzaehler;
  if ((z.ort || z.anlage) && !/^\d{4}-\d{2}-\d{2}$/.test(z.gueltigAb)) f.gueltigAb = PFLICHT.tag;
  return f;
}

/** PUT …/ort — `null`, wenn nichts zu schreiben ist; derselbe Tag wie das laufende Intervall korrigiert es. */
export function ortAnfrage(z: Zuordnung, b: ZuordnungBestand): MessstelleOrtAendern | null {
  if (!z.ort || z.ort === b.ort) return null;
  return { kennzeichen: z.ort, gueltig_ab: z.gueltigAb, ...(b.ortAb === z.gueltigAb ? { korrektur: true } : {}) };
}

/** PUT …/stellung — `null`, wenn keine Stellung gewählt oder nichts geändert ist. */
export function stellungAnfrage(z: Zuordnung, b: ZuordnungBestand): MessstelleStellungAendern | null {
  if (!z.anlage || !z.stellung) return null;
  const bezug = z.stellung === 'Unterzähler' ? z.unterzaehlerVon : '';
  if (z.anlage === b.anlage && z.stellung === b.stellung && bezug === b.unterzaehlerVon) return null;
  return {
    anlage: z.anlage,
    stellung: z.stellung,
    unterzaehler_von: bezug || null,
    gueltig_ab: z.gueltigAb,
    ...(b.stellungAb === z.gueltigAb ? { korrektur: true } : {}),
  };
}

/** Unter „Gilt ab“: „ab heute“, „rückwirkend ab 01.10.2026“, „geplant ab 01.03.2027“. */
export function tagHinweis(tag: string, heute: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tag)) return null;
  if (tag === heute) return 'ab heute';
  return `${tag < heute ? 'rückwirkend' : 'geplant'} ab ${datumText(tag)}`;
}

/** Der Dialog sagt, was fehlt (`messstelle.md` §4) — ohne Ort bleibt es ein Entwurf. */
export function ohneOrtSatz(kennzeichen: string): string {
  return `Ohne Ort bleibt ${kennzeichen} ein Entwurf. Eingerichtet ist eine Messstelle mit Kennzeichen, Name, Hauptgröße und Ort.`;
}

// ------------------------------------------------------------ Schritt 3 · Quelle

/** Der Schlüssel der Hauptgröße in `QuelleEingabe.kanaele`; Nebengrößen tragen `Größe|Richtung`. */
export const HAUPT = 'haupt';

export interface QuelleEingabe {
  /** `<Anlage-ID>|<Komponenten-ID>`; leer = keine gewählt. */
  komponente: string;
  /** Je Größe der gewählte Messwert (Kanalname); leer = keiner. */
  kanaele: Record<string, string>;
  datum: string;
  uhrzeit: string;
}

export interface KomponenteWahl {
  anlageId: string;
  anlageName: string;
  entity: SiteEntity;
}

export const komponenteWert = (anlageId: string, entityId: string): string => `${anlageId}|${entityId}`;

export function komponenteAus(wert: string): { anlageId: string; entityId: string } | null {
  const i = wert.indexOf('|');
  return i > 0 ? { anlageId: wert.slice(0, i), entityId: wert.slice(i + 1) } : null;
}

export const komponenteName = (e: SiteEntity): string => e.label ?? e.typeLabel;

export function komponenteOptionen(liste: KomponenteWahl[]): VpOption[] {
  return liste.map((w) => ({
    value: komponenteWert(w.anlageId, w.entity.id),
    label: komponenteName(w.entity),
    sub: w.entity.label ? w.entity.typeLabel : null,
    group: w.anlageName,
  }));
}

/** Die Rolle, in der ein Messwert gebunden werden soll (AP-04 §4.3): führend oder Vergleich. */
export type BindungsRolle = 'fuehrend' | 'vergleich';

/**
 * EIN Messwert, an der Zielgröße gemessen (Regel 7) — die Zeile, aus der jede Fläche ihre Liste
 * baut. `passend` ist das Urteil, `grund` der Satz der FEHLER-Tabelle, wenn es „nein“ lautet:
 * eine Zeile VERSCHWINDET nie, sie steht grau da und sagt warum.
 */
export interface MesswertZeile {
  kanal: string;
  name: string;
  /** Wertart · Einheit · Kadenz. */
  detail: string | null;
  passend: boolean;
  /** Mit welchem Teil eines Vorzeichen-Werts er passt (AP-08 IP-7, E15); `null` = der ganze Wert. */
  anteil: Anteil | null;
  herleitung: Herleitung | null;
  /** Warum er nicht wählbar ist; `null`, wenn er passt. */
  grund: string | null;
}

export interface MesswertWahl {
  /** In welcher Rolle gebunden wird — „schon führend gebunden“ sperrt nur die führende (E3). */
  rolle: BindungsRolle;
  /** Das eigene Kennzeichen: was diese Messstelle selbst liest, ist kein fremder Griff. */
  eigenesKennzeichen: string | null;
  /**
   * Darf ein Vorzeichen-Wert über einen ANTEIL passen (AP-08 IP-7, E15)? Der Anteil wird nie
   * geraten: er folgt aus der Richtung der Zielgröße. Der Messstellen-Dialog (IP-6) kennt ihn
   * nicht und lässt ihn aus — „Quelle binden“ (IP-14) bietet ihn an.
   */
  anteil?: boolean;
}

/**
 * Der Anteil, mit dem ein Vorzeichen-Wert die Zielgröße liefert (AP-08 IP-7, E15) — oder `null`,
 * wenn keiner passt. Nicht gewählt, sondern ABGELEITET: die Richtung der Größe bestimmt ihn.
 */
function anteilFuer(k: Messkanal, ziel: Groesse): Anteil | null {
  const richtungen = ANTEIL_RICHTUNGEN[k.direction ?? ''];
  if (!richtungen) return null;
  return (ANTEILE.find((a) => richtungen[a] === ziel.richtung) as Anteil | undefined) ?? null;
}

/**
 * Die Messwerte einer Komponente an EINER Zielgröße (D3 · V1): wählbar nur, was nach Regel 7 passt
 * und — in der führenden Rolle — keine andere Messstelle schon mit demselben Teil des Werts liest.
 * Beides AUSGEGRAUT MIT GRUND (FEHLER-Tabelle: „Kanal nicht wählbar (ausgegraut mit Grund) statt
 * Fehler nach dem Klick“). Wählbare zuerst, sonst in der Reihenfolge der Liste.
 *
 * ⚠ EINE Regel-Stelle: geurteilt wird ausschließlich von {@link passung} (Vertrags-Zwilling), die
 * Sätze kommen aus {@link passtNichtSatz} und {@link kanalBereitsFuehrendSatz}.
 */
export function messwertZeilen(kanaele: Messkanal[], ziel: Groesse, w: MesswertWahl): MesswertZeile[] {
  const anteilVon = (k: Messkanal) => (w.anteil ? anteilFuer(k, ziel) : null);
  const passt = (k: Messkanal) => {
    const ganz = passung(MEDIUM, ziel, k.groesse, k.richtung, k.einheit, k.wertart);
    if (!ganz.fehler || !w.anteil) return ganz;
    const a = anteilVon(k);
    if (a === null) return ganz;
    const teil = passung(
      MEDIUM,
      ziel,
      k.groesse,
      k.richtung,
      k.einheit,
      k.wertart,
      k.direction ?? null,
      a,
    );
    return teil.fehler ? ganz : teil;
  };
  // Regel 7 · Ausnahme Anteil: ein Vorzeichen-Wert speist Bezug UND Abgabe — nur nie denselben
  // Teil zweimal führend. Ohne Anteil bleibt es der ganze Wert, und der schließt jeden anderen aus.
  const fremd = (k: Messkanal) => {
    if (w.rolle !== 'fuehrend') return null;
    const a = anteilVon(k);
    return (
      (k.speist ?? []).find(
        (s) =>
          s.rolle === 'fuehrend' &&
          s.messstelle !== w.eigenesKennzeichen &&
          !(a !== null && (s.anteil ?? null) !== null && s.anteil !== a),
      ) ?? null
    );
  };
  const waehlbar = (k: Messkanal) => !passt(k).fehler && !fremd(k);
  const passend = kanaele.find(waehlbar) ?? null;
  return [...kanaele]
    .sort((a, b) => Number(waehlbar(b)) - Number(waehlbar(a)))
    .map((k) => {
      const z = kanalZeile(k);
      const p = passt(k);
      const f = fremd(k);
      const grund =
        p.fehler && p.grund
          ? passtNichtSatz(k, ziel, p.grund, passend, false)
          : f
            ? kanalBereitsFuehrendSatz(f.messstelle)
            : null;
      return {
        kanal: k.kanal,
        name: z.name,
        detail: z.detail || null,
        passend: grund === null,
        anteil: grund === null ? anteilVon(k) : null,
        herleitung: p.herleitung,
        grund,
      };
    });
}

/**
 * Dieselben Messwerte als Auswahl des Messstellen-Dialogs (D3) — er bindet je Größe eine FÜHRENDE
 * Quelle und kennt den Anteil (noch) nicht.
 */
export function kanalOptionen(
  kanaele: Messkanal[],
  ziel: Groesse,
  eigenesKennzeichen: string | null,
  rolle: 'haupt' | 'neben',
): VpOption[] {
  const wort = rolle === 'haupt' ? UEMS_HAUPTGROESSE : UEMS_NEBENGROESSE;
  return messwertZeilen(kanaele, ziel, { rolle: 'fuehrend', eigenesKennzeichen }).map((z) => ({
    value: z.kanal,
    label: z.name,
    sub: z.grund ? z.detail : [z.detail, `passt zur ${wort}`].filter(Boolean).join(' · '),
    disabled: z.grund !== null,
    disabledHint: z.grund,
  }));
}

export interface QuelleUrteil {
  fehler: Partial<Record<'kanal' | 'zeitpunkt', string>>;
  /** Hauptgröße zuerst. */
  anfragen: MessstelleQuelleBinden[];
  zeitpunkt: string | null;
}

/**
 * Ohne Komponente gibt es nichts zu binden (dasselbe wie „Später binden“). Mit Komponente: je
 * gewählter Größe ein Messwert, der Zeitpunkt auf die Minute in Ortszeit — nie geraten an der
 * Zeitumstellung (`zeitpunktAus`).
 */
export function quellePruefen(q: QuelleEingabe, nebengroessen: GroesseEingabe[]): QuelleUrteil {
  const ziel = komponenteAus(q.komponente);
  if (!ziel) return { fehler: {}, anfragen: [], zeitpunkt: null };
  const fehler: QuelleUrteil['fehler'] = {};
  const schluessel = [HAUPT, ...nebengroessen.map(groesseSchluessel)];
  const gewaehlt = schluessel.filter((s) => q.kanaele[s]);
  if (gewaehlt.length === 0) fehler.kanal = PFLICHT.kanal;
  const t = zeitpunktAus(q.datum, q.uhrzeit);
  if ('fehler' in t) fehler.zeitpunkt = t.fehler;
  if (fehler.kanal || fehler.zeitpunkt || 'fehler' in t) return { fehler, anfragen: [], zeitpunkt: null };
  const anfragen = gewaehlt.map((s): MessstelleQuelleBinden => {
    const [groesse, richtung] = s.split('|');
    return {
      ...(s === HAUPT ? {} : { groesse: { groesse, richtung } }),
      komponente: ziel.entityId,
      kanal: q.kanaele[s],
      rolle: 'fuehrend',
      gueltig_ab: t.iso,
    };
  });
  return { fehler, anfragen, zeitpunkt: t.iso };
}

/** D3 „Was geschieht“: „MS-0017 liest ab 15.10.2026, 09:00 Uhr Zähler EK-5 · Wirkenergie Bezug. …“ */
export function quelleFolgenSatz(e: {
  kennzeichen: string;
  zeitpunkt: string;
  jetzt: string;
  komponente: string;
  messwerte: string[];
}): string {
  const r = rueckwirkung(e.jetzt, e.zeitpunkt);
  const liest = `${e.kennzeichen} liest ab ${zeitpunktText(e.zeitpunkt)} ${e.komponente} · ${e.messwerte.join(', ')}.`;
  if (r.art === 'rueckwirkend') return `${liest} Der Eintrag gilt ${r.abzeichen}.`;
  return `${liest} Bis zu den ersten Werten steht „wartet auf erste Daten“.`;
}

/**
 * Die führende Quelle einer Größe, die heute gilt oder angekündigt ist. Gibt es sie, bietet der
 * Dialog für diese Größe KEINEN Messwert an: eine neue Quelle beendete die laufende genau zu ihrem
 * Beginn (Regel 2) — das ist ein Zählerwechsel, kein Bearbeiten.
 */
export function laufendeQuelle(
  quellen: MessstelleQuelleZeitraum[] | undefined,
  jetzt: string,
): MessstelleQuelleZeitraum | null {
  const t = Date.parse(jetzt);
  return (quellen ?? []).find((q) => q.gueltig_bis === null || Date.parse(q.gueltig_bis) > t) ?? null;
}

/** „Hat seit 20.10.2026, 09:00 Uhr eine führende Quelle.“ — „ab …“, wenn sie erst angekündigt ist. */
export function laufendSatz(q: MessstelleQuelleZeitraum, jetzt: string): string {
  const wort = Date.parse(q.gueltig_ab) > Date.parse(jetzt) ? 'ab' : 'seit';
  return `Hat ${wort} ${zeitpunktText(q.gueltig_ab)} eine führende Quelle.`;
}

export interface QuellZiel {
  /** {@link HAUPT} oder `Größe|Richtung` einer Nebengröße. */
  schluessel: string;
  groesse: Groesse;
  rolle: 'haupt' | 'neben';
  label: string;
  laufend: MessstelleQuelleZeitraum | null;
}

/** Je Größe der Messstelle ein Ziel für den Schritt Quelle — Hauptgröße zuerst. */
export function quellZiele(f: Identitaet, gespeichert: Messstelle | null, jetzt: string): QuellZiel[] {
  const out: QuellZiel[] = [];
  const haupt = groesseAus(f.hauptgroesse);
  if (haupt) {
    out.push({
      schluessel: HAUPT,
      groesse: haupt,
      rolle: 'haupt',
      label: `Messwert für die ${UEMS_HAUPTGROESSE} · ${haupt.groesse} · ${haupt.richtung}`,
      laufend: laufendeQuelle(gespeichert?.fuehrende_quelle, jetzt),
    });
  }
  for (const n of f.nebengroessen) {
    const g = groesseAus(n);
    if (!g) continue;
    const schluessel = groesseSchluessel(n);
    const bestand = gespeichert?.nebengroessen?.find((x) => groesseSchluessel(x) === schluessel);
    out.push({
      schluessel,
      groesse: g,
      rolle: 'neben',
      label: `Messwert für die ${UEMS_NEBENGROESSE} · ${g.groesse} · ${g.richtung}`,
      laufend: laufendeQuelle(bestand?.fuehrende_quelle, jetzt),
    });
  }
  return out;
}

// ------------------------------------------------------------------ Abschluss

export const FEHLT_WORT: Readonly<Record<string, string>> = {
  kennzeichen: 'Kennzeichen',
  name: 'Name',
  hauptgroesse: UEMS_HAUPTGROESSE,
  ort: 'Ort',
  formel: 'Formel',
  eingaenge: 'Eingänge',
};

/**
 * 5.1 „Fertig“: „MS-0017 Lagerhalle Lindach gesamt ist eingerichtet und aktiv · wartet auf erste
 * Daten“ — ohne Quelle „· keine Datenquelle“ (E8), mit Lücken „als Entwurf gespeichert — es fehlt: …“.
 * Die Stufe kommt vom Server (`lebenszyklus`, `fehlt`), nie aus dem Dialog.
 */
export function abschlussSatz(
  m: Pick<Messstelle, 'kennzeichen' | 'name' | 'lebenszyklus' | 'fehlt'>,
  e: { fassung: Fassung; quelleGebunden: boolean; quelleVorhanden: boolean },
): string {
  const wer = nennung(m.kennzeichen, m.name);
  if (m.lebenszyklus === 'entwurf') {
    return `${wer} ist als Entwurf gespeichert — es fehlt: ${m.fehlt.map((f) => FEHLT_WORT[f] ?? f).join(', ')}.`;
  }
  if (m.lebenszyklus === 'angehalten') return `${wer} ist gespeichert · angehalten`;
  if (e.fassung === 'bearbeiten') return `${wer} ist gespeichert`;
  const beobachtung = e.quelleGebunden ? 'wartet auf erste Daten' : e.quelleVorhanden ? null : 'keine Datenquelle';
  return `${wer} ist eingerichtet und aktiv${beobachtung ? ` · ${beobachtung}` : ''}`;
}

// ---------------------------------------------------------------- Ablehnungen

export type DialogFeld =
  | 'kennzeichen'
  | 'name'
  | 'ort'
  | 'anlage'
  | 'stellung'
  | 'unterzaehlerVon'
  | 'gueltigAb'
  | 'kanal'
  | 'zeitpunkt';

export interface Ablehnung {
  code: string | null;
  /** Das Feld, an dem der Satz steht; `null` = über dem Fuß. */
  feld: DialogFeld | null;
  satz: string;
}

export interface AblehnungKontext {
  schritt: Schritt;
  /** Der Name einer Anlage aus den geladenen Standorten; `null`, wenn der Dialog sie nicht kennt. */
  anlageName: (id: string) => string | null;
}

const ZUORDNUNG_CODES = new Set(['zuordnung_ueberlappt', 'zuordnung_ungueltig', 'zuordnung_unveraendert']);
const ZEITPUNKT_CODES = new Set([
  'bindung_ueberlappt',
  'zeitpunkt_vor_vorgaenger',
  'kein_geraet_zum_zeitpunkt',
  'zeitraum_ungueltig',
  'zeitpunkt_in_zukunft',
]);
const SERVER_FELD: Record<string, DialogFeld> = {
  kennzeichen: 'kennzeichen',
  name: 'name',
  anlage: 'anlage',
  stellung: 'stellung',
  unterzaehler_von: 'unterzaehlerVon',
  komponente: 'kanal',
  kanal: 'kanal',
  zeitpunkt: 'zeitpunkt',
};

const text = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

/**
 * Die Ablehnung der Schnittstelle als Satz am richtigen Feld. Wo die FEHLER-Tabelle einen
 * Wortlaut hat, baut der Dialog ihn aus den Fakten; sonst gilt der Satz der Schnittstelle (die
 * denselben Wortlaut sendet), sonst {@link SATZ_ALLGEMEIN}. Der Dialog bleibt immer offen.
 */
export function ablehnung(
  err: { status?: number; message?: string; body?: unknown } | null,
  k: AblehnungKontext,
): Ablehnung {
  const body = (err?.body && typeof err.body === 'object' ? err.body : {}) as Record<string, unknown>;
  const code = text(body.code);
  const message = text(body.message) ?? text(err?.message) ?? SATZ_ALLGEMEIN;
  const bestehend = (body.bestehend && typeof body.bestehend === 'object' ? body.bestehend : null) as Record<
    string,
    unknown
  > | null;
  const an = (feld: DialogFeld | null, satz = message): Ablehnung => ({ code, feld, satz });

  switch (code) {
    case 'kennzeichen_format':
      return an('kennzeichen', SATZ_KENNZEICHEN_FORMAT);
    case 'kennzeichen_belegt': {
      const kz = text(bestehend?.kennzeichen);
      const ms = text(bestehend?.messstelle);
      if (!kz || !ms) return an('kennzeichen');
      return an(
        'kennzeichen',
        kennzeichenBelegtSatz({
          kennzeichen: kz,
          messstelle: ms,
          name: text(bestehend?.name),
          archiviert: bestehend?.archiviert === true,
          frueher: bestehend?.frueher === true,
        }),
      );
    }
    case 'hauptzaehler_vorhanden': {
      const kz = text(bestehend?.kennzeichen);
      const anlage = text(bestehend?.anlage);
      const name = anlage ? k.anlageName(anlage) : null;
      if (!kz || !anlage || !name) return an('stellung');
      const satz = hauptzaehlerSatz(name, { kennzeichen: kz, name: text(bestehend?.name), anlage });
      // Die Schnittstelle ergänzt bei anderer Richtung einen zweiten Satz — der bleibt.
      return an('stellung', message.startsWith(satz) ? message : satz);
    }
    case 'stellung_ungueltig': {
      const grund = text(body.grund);
      if (grund === 'selbst') return an('unterzaehlerVon', SATZ_SELBST);
      if (grund === 'fremde_anlage') {
        const kz = text(bestehend?.kennzeichen);
        const anlage = text(bestehend?.anlage);
        const name = anlage ? k.anlageName(anlage) : null;
        return an('unterzaehlerVon', kz && name ? fremdeAnlageSatz(kz, name) : message);
      }
      return an(grund === 'nicht_elektrisch' ? 'stellung' : 'unterzaehlerVon');
    }
    case 'kanal_bereits_fuehrend': {
      const ms = text(body.bestehende_messstelle);
      return an('kanal', ms ? kanalBereitsFuehrendSatz(ms) : message);
    }
    case 'ort_ungueltig':
      return an('ort');
    case 'quelle_passt_nicht':
    case 'medium_ohne_quelle':
    case 'vergleich_ohne_zweck':
      return an('kanal');
    case 'anfrage_ungueltig': {
      const feld = text(body.feld);
      if (feld === 'gueltig_ab') return an(k.schritt === 3 ? 'zeitpunkt' : 'gueltigAb');
      return an(feld ? (SERVER_FELD[feld] ?? null) : null);
    }
    default:
      if (code && ZUORDNUNG_CODES.has(code)) return an('gueltigAb');
      if (code && ZEITPUNKT_CODES.has(code)) return an('zeitpunkt');
      return an(null);
  }
}
