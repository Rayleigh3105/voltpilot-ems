/**
 * „Quelle binden“ (UEMS AP-04 IP-14, Mockups D3 · V1 · R2): der Dialog, der eine Messstellen-Größe
 * an einen Messwert bindet — führend oder als Vergleich mit Zweck (E3) —, und die Quelle-Karte, die
 * BEIDE Werte nebeneinander zeigt. Rein: keine Netzzugriffe, keine Uhr, kein React;
 * `components/QuelleBindenDialog.tsx` und die Messstellen-Seite rendern nur, was hier steht.
 *
 * ⚠ KEINE ZWEITE REGEL-LOGIK. Die Passung (Regel 7 samt der Ausnahme „Anteil“, AP-08 IP-7 E15)
 * urteilt der Vertrags-Zwilling `uemsMessstelle.ts` ⟷ `MessstelleRegeln`; die Zeilen und ihre Sätze
 * baut `messstelleDialog.messwertZeilen` — dieselbe Stelle, die schon der Messstellen-Dialog (IP-6)
 * benutzt. Was der Server sonst noch prüft (Überlappung, Gerät zum Zeitpunkt, Rückwirkung), urteilt
 * er; der Dialog nimmt sein Urteil an und stellt es an das richtige Feld.
 *
 * ⚠ AUSGEGRAUT MIT GRUND ist der Kern. Ein Messwert, der nicht passt, VERSCHWINDET nicht: er steht
 * grau in der Liste und sagt warum. Sonst sucht der Kunde etwas, das er sieht, aber nicht findet —
 * oder hält eine leere Liste für einen Fehler.
 *
 * ⚠ E3: Eine Vergleichsquelle wird GEKENNZEIGT und ANGEZEIGT, mehr nicht. Kein Prozentwert, keine
 * Ampel, kein stiller Ersatz — die Bewertung gehört AP-08 und beginnt an genau dieser Kennzeichnung.
 */
import type {
  Messkanal,
  MessstelleQuelle,
  MessstelleQuelleBinden,
  MessstelleQuelleGroesse,
  MessstelleQuellenListe,
  MessstelleRegisterZeile,
  SiteEntity,
  UemsDatenquelle,
} from './api';
import { boxAmGeraet, boxSatz } from './boxAnQuelle';
import { kanalZeile } from './geraetEinstellungen';
import {
  UEMS_FUEHREND,
  UEMS_GERAET,
  UEMS_HAUPTGROESSE,
  UEMS_MESSSTELLE,
  UEMS_NEBENGROESSE,
  UEMS_QUELLE,
  UEMS_VERGLEICH,
} from './glossar';
import {
  HAUPT,
  komponenteAus,
  komponenteName,
  komponenteWert,
  messwertZeilen,
  passtNichtSatz,
  type BindungsRolle,
  type MesswertZeile,
} from './messstelleDialog';
import { wertText } from './messstellen';
import type { VpOption } from './picker/optionen';
import { zeitpunktText } from './uemsEinstellung';
import { ANTEIL_RICHTUNGEN, passung, VERGLEICH_ZWECKE, type Anteil, type Groesse } from './uemsMessstelle';

export type { BindungsRolle, MesswertZeile } from './messstelleDialog';
export { messwertZeilen } from './messstelleDialog';

// ------------------------------------------------------------------- Wörter

export const QUELLE_TITEL = UEMS_QUELLE;
export const QUELLE_BINDEN = `${UEMS_QUELLE} binden`;
export const VERGLEICHSQUELLE = `${UEMS_VERGLEICH}squelle`;
export const VERGLEICHSQUELLE_HINZUFUEGEN = `${VERGLEICHSQUELLE} hinzufügen`;
export const ALS_MESSSTELLE_VERWENDEN = `Als ${UEMS_MESSSTELLE} verwenden`;
export const HISTORIE = 'Historie';
export const WAS_GESCHIEHT = 'Was geschieht';
export const LUECKE = 'Lücke';
export const GILT_AB = 'Gilt ab *';
export const UHRZEIT = 'Uhrzeit *';

/** §5.11 — die beiden Leerzustände der Quelle-Karte; beide nennen ihren nächsten Schritt. */
export const KEINE_DATENQUELLE = 'Keine Datenquelle. Diese Messstelle bekommt noch keine Werte.';
export const KEINE_VERGLEICHSQUELLE = `Keine ${VERGLEICHSQUELLE}. Eine ${VERGLEICHSQUELLE} zeigt einen zweiten Messwert neben dem führenden.`;

/** E3: die Karte stellt nebeneinander — sie urteilt nicht. Der Satz sagt das ausdrücklich. */
export const OHNE_BEWERTUNG = 'Beide Werte stehen nebeneinander; bewertet wird nichts.';

export const PFLICHT = {
  messstelle: `Bitte wählen Sie eine ${UEMS_MESSSTELLE} und ihre Messgröße.`,
  komponente: 'Bitte wählen Sie eine Komponente.',
  kanal: 'Bitte wählen Sie einen Messwert.',
  zweck: `Bitte wählen Sie den Zweck der ${VERGLEICHSQUELLE}.`,
} as const;

export const TITEL: Readonly<Record<BindungsRolle, string>> = {
  fuehrend: QUELLE_BINDEN,
  vergleich: VERGLEICHSQUELLE_HINZUFUEGEN,
};

export const KNOPF: Readonly<Record<BindungsRolle, string>> = {
  fuehrend: 'Binden',
  vergleich: 'Hinzufügen',
};

/** Die drei Zwecke (E3) — eine Vergleichsquelle gibt es nie ohne einen davon. */
export const ZWECKE = VERGLEICH_ZWECKE;

export const ZWECK_SUB: Readonly<Record<string, string>> = {
  Plausibilität: 'ein zweiter Messwert zum Vergleich',
  'Ersatz bei Ausfall': 'gedacht für Zeiten ohne die führende Quelle',
  Abrechnungszähler: 'der Wert, über den abgerechnet wird',
};

export function zweckOptionen(): VpOption[] {
  return ZWECKE.map((z) => ({ value: z, label: z, sub: ZWECK_SUB[z] ?? null }));
}

/** „liest den Bezugs-Teil des Werts“ — nur bei einem Vorzeichen-Wert (AP-08 IP-7, E15). */
export function anteilSatz(anteil: Anteil | null, richtung: string): string | null {
  return anteil === null ? null : `liest den ${richtung}s-Teil des Werts`;
}

// ------------------------------------------------- Die Messwerte einer Komponente

export const komponenteOptionen = (liste: readonly KomponenteWahl[]): VpOption[] =>
  liste.map((w) => ({
    value: komponenteWert(w.anlageId, w.entity.id),
    label: komponenteName(w.entity),
    sub: w.entity.label ? w.entity.typeLabel : null,
    group: w.anlageName,
  }));

export interface KomponenteWahl {
  anlageId: string;
  anlageName: string;
  entity: SiteEntity;
}

/**
 * Die Messwerte als Auswahl: die passenden zuerst, die übrigen GRAU mit ihrem Grund. Der Zusatz
 * einer wählbaren Zeile sagt, wofür sie passt — und bei einem Vorzeichen-Wert, welchen Teil sie
 * liest (AP-08 IP-7): sonst stünde derselbe Messwert zweimal wählbar da, ohne sichtbaren Unterschied.
 */
export function messwertOptionen(zeilen: readonly MesswertZeile[], ziel: Groesse): VpOption[] {
  return zeilen.map((z) => ({
    value: z.kanal,
    label: z.name,
    sub: z.grund
      ? z.detail
      : [z.detail, anteilSatz(z.anteil, ziel.richtung) ?? `passt zu ${ziel.groesse} · ${ziel.richtung}`]
          .filter(Boolean)
          .join(' · '),
    disabled: z.grund !== null,
    disabledHint: z.grund,
  }));
}

// ------------------------------------- Die Ziele EINES Messwerts („Als Messstelle verwenden“)

/** Der Schlüssel eines Ziels: Messstelle + Größe + Richtung. */
export const zielWert = (messstelleId: string, g: { groesse: string; richtung: string }): string =>
  `${messstelleId}|${g.groesse}|${g.richtung}`;

export interface ZielZeile {
  wert: string;
  messstelleId: string;
  /** „MS-01 · Netzbezug Halle 1“ */
  messstelle: string;
  groesse: Groesse;
  /** „Hauptgröße · Wirkenergie · Bezug · kWh · Zählerstand“ */
  label: string;
  hauptgroesse: boolean;
  passend: boolean;
  anteil: Anteil | null;
  /** Warum diese Größe den Messwert nicht nehmen kann; `null`, wenn sie ihn nehmen kann. */
  grund: string | null;
}

const groesseLabel = (g: Groesse, haupt: boolean): string =>
  `${haupt ? UEMS_HAUPTGROESSE : UEMS_NEBENGROESSE} · ${g.groesse} · ${g.richtung} · ${g.einheit} · ${g.wertart}`;

/**
 * Derselbe Blick von der anderen Seite (§5.2: „Als Messstelle verwenden“ öffnet denselben Dialog
 * mit vorbelegtem Kanal): WELCHE Messstellen-Größe kann diesen einen Messwert lesen? Geurteilt wird
 * mit derselben Regel 7 und demselben Satz — nur die Liste ist eine andere.
 *
 * ⚠ Eine Größe, die ihn nicht nehmen kann, steht ebenfalls grau da. Sie verschwindet nicht.
 */
export function zielZeilen(
  zeilen: readonly MessstelleRegisterZeile[],
  kanal: Messkanal,
  rolle: BindungsRolle,
): ZielZeile[] {
  const out: ZielZeile[] = [];
  for (const z of zeilen) {
    if (z.art !== 'gemessen' || z.lebenszyklus === 'archiviert') continue;
    const groessen: { g: Groesse; haupt: boolean }[] = [
      ...(z.hauptgroesse ? [{ g: z.hauptgroesse, haupt: true }] : []),
      ...(z.nebengroessen ?? []).map((n) => ({ g: n.groesse, haupt: false })),
    ];
    for (const { g, haupt } of groessen) {
      const treffer = messwertZeilen([kanal], g, { rolle, eigenesKennzeichen: z.kennzeichen, anteil: true })[0];
      out.push({
        wert: zielWert(z.id, g),
        messstelleId: z.id,
        messstelle: [z.kennzeichen, z.name].filter(Boolean).join(' · '),
        groesse: g,
        label: groesseLabel(g, haupt),
        hauptgroesse: haupt,
        passend: treffer.passend,
        anteil: treffer.anteil,
        grund: treffer.grund,
      });
    }
  }
  return [...out].sort((a, b) => Number(b.passend) - Number(a.passend));
}

export function zielOptionen(zeilen: readonly ZielZeile[]): VpOption[] {
  return zeilen.map((z) => ({
    value: z.wert,
    label: z.messstelle,
    sub: z.label,
    group: z.passend ? 'Passende Messgrößen' : 'Passen nicht',
    disabled: z.grund !== null,
    disabledHint: z.grund,
  }));
}

/**
 * Der Leerzustand, wenn KEINE Messstellen-Größe diesen Messwert nehmen kann — mit dem Weg, der
 * bleibt. Nie „keine Treffer“: der Kunde erfährt, woran es liegt.
 */
export function keinZielSatz(zeilen: readonly ZielZeile[], messwert: string): string {
  return zeilen.length === 0
    ? `Es gibt noch keine ${UEMS_MESSSTELLE}, die „${messwert}“ lesen könnte. Legen Sie zuerst eine an.`
    : `Keine ${UEMS_MESSSTELLE} hat eine Messgröße, die „${messwert}“ liefern kann. Legen Sie eine mit der passenden Messgröße an.`;
}

// ---------------------------------------------------------------- Der Dialog

export type BindenFeld = 'ziel' | 'komponente' | 'kanal' | 'zweck' | 'zeitpunkt';

export interface BindenEingabe {
  /** Einstieg am Messwert: `<messstelleId>|<Größe>|<Richtung>`; leer = keines gewählt. */
  ziel: string;
  /** Einstieg an der Messstelle: `<anlageId>|<komponentenId>`; leer = keine gewählt. */
  komponente: string;
  kanal: string;
  zweck: string;
  datum: string;
  uhrzeit: string;
}

export interface BindenZiel {
  messstelleId: string;
  kennzeichen: string;
  groesse: Groesse;
  hauptgroesse: boolean;
}

export interface BindenKontext {
  rolle: BindungsRolle;
  /** Die gewählte Zielgröße; `null`, solange keine gewählt ist. */
  ziel: BindenZiel | null;
  /** Der gewählte Messwert mit seinem Urteil; `null`, solange keiner gewählt ist. */
  messwert: (MesswertZeile & { komponente: string }) | null;
}

export interface BindenUrteil {
  fehler: Partial<Record<BindenFeld, string>>;
  /** Die Messstelle, an die geschickt wird; `null`, solange etwas fehlt. */
  messstelleId: string | null;
  anfrage: MessstelleQuelleBinden | null;
  zeitpunkt: string | null;
}

/**
 * Was der Dialog SICHER weiß, bevor er schickt: eine Zielgröße, ein wählbarer Messwert, bei einer
 * Vergleichsquelle ein Zweck (E3) und ein Zeitpunkt auf die Minute — nie geraten an der
 * Zeitumstellung. Alles Weitere urteilt der Server.
 */
export function bindenPruefen(
  e: BindenEingabe,
  k: BindenKontext,
  zeitpunktAus: (datum: string, uhrzeit: string) => { iso: string } | { fehler: string },
): BindenUrteil {
  const fehler: BindenUrteil['fehler'] = {};
  if (!k.ziel) fehler.ziel = PFLICHT.messstelle;
  if (!k.messwert) fehler.kanal = e.komponente ? PFLICHT.kanal : PFLICHT.komponente;
  else if (!k.messwert.passend) fehler.kanal = k.messwert.grund ?? PFLICHT.kanal;
  if (k.rolle === 'vergleich' && !(ZWECKE as readonly string[]).includes(e.zweck)) fehler.zweck = PFLICHT.zweck;
  const t = zeitpunktAus(e.datum, e.uhrzeit);
  if ('fehler' in t) fehler.zeitpunkt = t.fehler;
  if (Object.keys(fehler).length > 0 || !k.ziel || !k.messwert || 'fehler' in t) {
    return { fehler, messstelleId: k.ziel?.messstelleId ?? null, anfrage: null, zeitpunkt: null };
  }
  return {
    fehler,
    messstelleId: k.ziel.messstelleId,
    zeitpunkt: t.iso,
    anfrage: {
      ...(k.ziel.hauptgroesse
        ? {}
        : { groesse: { groesse: k.ziel.groesse.groesse, richtung: k.ziel.groesse.richtung } }),
      komponente: k.messwert.komponente,
      kanal: k.messwert.kanal,
      rolle: k.rolle,
      ...(k.rolle === 'vergleich' ? { zweck: e.zweck } : {}),
      ...(k.messwert.anteil ? { anteil: k.messwert.anteil } : {}),
      gueltig_ab: t.iso,
    },
  };
}

/**
 * „Was geschieht“ aus FAKTEN, nie aus Absichten (§5.2 · §5.3):
 * führend — „MS-0017 liest ab 15.10.2026, 09:00 Uhr Zähler Energiekarte EK-5 · Wirkenergie Bezug.“
 * Vergleich — „… vergleicht ab … (Plausibilität). Beide Werte stehen nebeneinander; bewertet wird nichts.“
 */
export function folgenSatz(e: {
  rolle: BindungsRolle;
  kennzeichen: string;
  zeitpunkt: string;
  jetzt: string;
  komponente: string;
  messwert: string;
  zweck: string | null;
  anteil: Anteil | null;
  richtung: string;
  rueckwirkendAbzeichen: string | null;
}): string {
  const teil = anteilSatz(e.anteil, e.richtung);
  const quelle = `${e.komponente} · ${e.messwert}${teil ? ` (${teil})` : ''}`;
  if (e.rolle === 'vergleich') {
    return `${e.kennzeichen} vergleicht ab ${zeitpunktText(e.zeitpunkt)} ${quelle}${
      e.zweck ? ` (${e.zweck})` : ''
    }. ${OHNE_BEWERTUNG}`;
  }
  const liest = `${e.kennzeichen} liest ab ${zeitpunktText(e.zeitpunkt)} ${quelle}.`;
  return e.rueckwirkendAbzeichen
    ? `${liest} Der Eintrag gilt ${e.rueckwirkendAbzeichen}.`
    : `${liest} Bis zu den ersten Werten steht „wartet auf erste Daten“.`;
}

// ---------------------------------------------------------- Die Quelle-Karte

export interface QuelleWort {
  id: string;
  /** „führend“ · „Vergleich · Plausibilität“ */
  rolle: string;
  fuehrend: boolean;
  /** „Netzzähler Halle 1 · GR-2 · Wirkleistung“ */
  quelle: string;
  /** „312,4 kW“ — `null`, solange kein Wert bekannt ist (nie eine 0). */
  wert: string | null;
  /** „20.10.2026, 10:15 Uhr“ — `null` ohne Wert. */
  stand: string | null;
  /** Ohne Wert: warum keiner dasteht. */
  ohneWert: string | null;
  /** „seit 12.03.2024“ · „ab 01.03.2027“ */
  zeitraum: string;
  /** „liest den Bezugs-Teil des Werts“ — `null` beim ganzen Wert. */
  anteil: string | null;
  /**
   * AP-13 IP-12 (L6): „gelesen von Box Halle 2 (neu) seit 04.11.2026, 09:38 Uhr“ aus der
   * Zuständigkeit der Datenquelle dieses Geräts — `null`, solange keine bekannt ist.
   */
  box: string | null;
  geplant: boolean;
}

export type HistorieZustand = 'gueltig' | 'geplant' | 'beendet' | 'luecke';

export interface QuelleHistorieZeile {
  schluessel: string;
  /** Die Quelle des Abschnitts — an einer Lücke {@link LUECKE}. */
  wert: string;
  /** „12.03.2024 bis 18.11.2026, 10:40 Uhr“ · „seit 18.11.2026, 10:47 Uhr“ */
  zeitraum: string;
  zustand: HistorieZustand;
  marke: string | null;
}

export interface QuelleGroesseKarte {
  schluessel: string;
  /** „Hauptgröße · Wirkenergie · Bezug“ */
  titel: string;
  groesse: Groesse;
  hauptgroesse: boolean;
  /** Die führende Quelle und jede Vergleichsquelle — NEBENEINANDER (E3), führend zuerst. */
  werte: QuelleWort[];
  /** Statt einer führenden Quelle: der Leerzustand. */
  leerFuehrend: string | null;
  /** Statt einer Vergleichsquelle: der Leerzustand. */
  leerVergleich: string | null;
  historie: QuelleHistorieZeile[];
  /** Eine führende Quelle läuft schon — eine zweite wäre ein Zählerwechsel (IP-18), kein Binden. */
  fuehrendMoeglich: boolean;
}

const OHNE_BOXEN: ReadonlyMap<string, UemsDatenquelle> = new Map();

const MARKE_GILT = 'gilt heute';
const MARKE_GEPLANT = 'geplant';

/** „Netzzähler Halle 1 · GR-2 · Wirkleistung“ — Komponente · Gerät (mit Einbau) · Messwert. */
export function quelleText(q: MessstelleQuelle): string {
  const name = q.komponente_name ?? UEMS_GERAET;
  const einbau = q.geraet.einbau && q.geraet.einbau !== q.geraet.geraet ? ` ${q.geraet.einbau}` : '';
  const geraet = q.geraet.geraet ? `${q.geraet.geraet}${einbau}` : null;
  return [name, geraet, q.kanal_name ?? q.kanal].filter(Boolean).join(' · ');
}

const zeitraumText = (von: string, bis: string | null, jetzt: string): string =>
  Date.parse(von) > Date.parse(jetzt)
    ? `ab ${zeitpunktText(von)}`
    : bis === null
      ? `seit ${zeitpunktText(von)}`
      : `${zeitpunktText(von)} bis ${zeitpunktText(bis)}`;

function wortVon(q: MessstelleQuelle, jetzt: string, boxen: ReadonlyMap<string, UemsDatenquelle>): QuelleWort {
  const w = q.letzter_wert ?? null;
  const text = w ? wertText(w) : null;
  const geplant = q.status === 'geplant';
  // Eine laufende Bindung fragt nach der Box von JETZT, eine geplante nach der ihres ersten Tages.
  const wann = Date.parse(q.gueltig_ab) > Date.parse(jetzt) ? q.gueltig_ab : jetzt;
  return {
    id: q.id,
    rolle: q.rolle === 'fuehrend' ? UEMS_FUEHREND : [UEMS_VERGLEICH, q.zweck].filter(Boolean).join(' · '),
    fuehrend: q.rolle === 'fuehrend',
    quelle: quelleText(q),
    wert: text,
    stand: w && text !== null ? zeitpunktText(w.zeitpunkt) : null,
    ohneWert: text !== null ? null : geplant ? 'Beginnt erst.' : 'Wartet auf erste Daten.',
    zeitraum: zeitraumText(q.gueltig_ab, q.gueltig_bis, jetzt),
    anteil: anteilSatz(q.anteil, q.richtung),
    box: boxSatz(boxAmGeraet(boxen, q.geraet.id, wann), zeitpunktText),
    geplant,
  };
}

/**
 * Der Zeitstrahl der FÜHRENDEN Quellen einer Größe, jüngster Beginn oben. Eine Lücke ist ein
 * eigener Abschnitt und bleibt sichtbar — sie wird nie aufgefüllt (E2).
 */
function historieVon(g: MessstelleQuelleGroesse, alle: readonly MessstelleQuelle[], jetzt: string): QuelleHistorieZeile[] {
  const t = Date.parse(jetzt);
  return [...g.zeitstrahl]
    .sort((a, b) => Date.parse(b.von) - Date.parse(a.von))
    .map((a) => {
      const q = a.quelle === null ? null : (alle.find((x) => x.id === a.quelle) ?? null);
      const laeuft = Date.parse(a.von) <= t && (a.bis === null || Date.parse(a.bis) > t);
      const zustand: HistorieZustand =
        q === null ? 'luecke' : Date.parse(a.von) > t ? 'geplant' : laeuft ? 'gueltig' : 'beendet';
      return {
        schluessel: `${a.von}|${a.quelle ?? LUECKE}`,
        wert: q === null ? LUECKE : quelleText(q),
        zeitraum: zeitraumText(a.von, a.bis, jetzt),
        zustand,
        marke: zustand === 'gueltig' ? MARKE_GILT : zustand === 'geplant' ? MARKE_GEPLANT : null,
      };
    });
}

/**
 * Die Quelle-Karten der Messstelle — je Größe eine (Hauptgröße zuerst). Sie zeigt, was die führende
 * und was jede Vergleichsquelle sagt, NEBENEINANDER und ohne jede Bewertung (E3), dazu die Historie
 * der führenden Quellen mit jeder Lücke.
 */
export function quelleKarte(
  liste: MessstelleQuellenListe,
  jetzt: string,
  boxen: ReadonlyMap<string, UemsDatenquelle> = OHNE_BOXEN,
): QuelleGroesseKarte[] {
  return liste.groessen.map((g) => {
    const groesse: Groesse = { groesse: g.groesse, richtung: g.richtung, einheit: g.einheit, wertart: g.wertart };
    const werte = [...(g.fuehrend ? [g.fuehrend] : []), ...g.vergleich].map((q) => wortVon(q, jetzt, boxen));
    return {
      schluessel: `${g.groesse}|${g.richtung}`,
      titel: `${g.hauptgroesse ? UEMS_HAUPTGROESSE : UEMS_NEBENGROESSE} · ${g.groesse} · ${g.richtung}`,
      groesse,
      hauptgroesse: g.hauptgroesse,
      werte,
      leerFuehrend: g.fuehrend ? null : KEINE_DATENQUELLE,
      leerVergleich: g.vergleich.length > 0 ? null : KEINE_VERGLEICHSQUELLE,
      historie: historieVon(g, liste.quellen, jetzt),
      fuehrendMoeglich: g.fuehrend === null && g.lebenszyklus !== 'archiviert',
    };
  });
}

/** Der Schlüssel, unter dem der Dialog seine Zielgröße findet (Hauptgröße ohne eigene Angabe). */
export const groessenSchluessel = (g: { groesse: string; richtung: string }): string =>
  `${g.groesse}|${g.richtung}`;

export { HAUPT, komponenteAus, komponenteName, komponenteWert, passtNichtSatz, passung, ANTEIL_RICHTUNGEN, kanalZeile };
