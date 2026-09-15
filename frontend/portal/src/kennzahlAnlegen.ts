/**
 * Der Assistent „Kennzahl anlegen“ und das Kopieren (UEMS AP-11 IP-14; §5.1, §5.2, §5.6, E2, E9, E12) als REINE
 * Ableitung — `components/KennzahlAnlegenDialog.tsx` zeichnet nur, was hier steht.
 *
 * Hier wird nichts geprüft, was der Zwilling nicht prüft:
 *  - Einheit (U1–U3), Periode (P1–P3), Geltung (G1) und Standort-Fremdheit (G3) sind AUFRUFE von `uemsKennzahl.ts` —
 *    jeder rote Satz ist dessen Kundensatz (§5.8), nie eine Kopie; ein Befund der Vorschau mit Kette (K16) spricht
 *    ebenfalls der Zwilling;
 *  - Name und Zweck belegt `kennzahlVorlagen.vorbelegung` (Vorlage) bzw. `uemsKennzahl.kopie` (Kopie) vor;
 *  - die letzten drei abgeschlossenen Perioden rechnet der Server in `POST /api/v1/kennzahlen/vorschau`
 *    (Nur-Lese-Transaktion) — diese Datei ordnet sie nur an. Vor „Anlegen“ wird nichts gespeichert (K1, K20).
 *
 * ⚠ Eine Messstelle liefert der Kennzahl Tageswerte (Vektor K1 „MS-12 (Tag)“); eine Fläche der Standortstruktur ist
 * keine Bezugsgröße mit Kennzeichen und darum kein Eingang (`KennzahlEingangLeser`) — sie steht gesperrt mit Grund.
 *
 * REIN: kein Netz, keine Uhr, kein Zustand.
 */
import type {
  Bezugsflaeche,
  Bezugsgroesse,
  Kennzahl,
  KennzahlAnfrage,
  KennzahlEingang,
  KennzahlFassung,
  KennzahlGeltungArt,
  KennzahlPeriodeArt,
  KennzahlRechenform,
  KennzahlVorlageBezugsgroesse,
  KennzahlVorlageMessstelle,
  KennzahlVorschau,
  Kostenstelle,
  MessstelleRegisterZeile,
  OrtsbaumAmStichtag,
  Prozess,
  StandortAmStichtag,
  Unternehmen,
} from './api';
import {
  GESAMTWERT,
  UEMS_BERECHNUNG,
  UEMS_BEZUGSGROESSE,
  UEMS_FASSUNG,
  UEMS_GANZES,
  UEMS_GELTUNGSBEREICH,
  UEMS_KENNZAHL,
  UEMS_KENNZAHLEN,
  UEMS_KOSTENSTELLE,
  UEMS_MENGE,
  UEMS_MESSSTELLE,
  UEMS_PROZESS,
  UEMS_RECHENFORM,
  UEMS_STANDORT,
  UEMS_TEIL,
  UEMS_UNTERNEHMEN,
  UEMS_VERANTWORTLICH,
  UEMS_VORLAGE,
  UEMS_ZWECK,
} from './glossar';
import { GELTUNG_WORT, PERIODEN_NAME, tonVon } from './kennzahlKarte';
import { KENNZAHL_VORLAGEN, kennzahlVorlage, vorbelegung, vorlagenTitel } from './kennzahlVorlagen';
import type { VpGruppe, VpOption } from './picker/optionen';
import { PROZENT } from './uemsErgebnis';
import * as KZ from './uemsKennzahl';
import type { Ton } from './uemsWerteKarte';

const NB = String.fromCharCode(160);

// ------------------------------------------------------------------ Wörter der Fläche

export const KNOPF_ANLEGEN = `${UEMS_KENNZAHL} anlegen`;
export const KNOPF_KOPIEREN = 'Kopieren';
export const TITEL = `${UEMS_KENNZAHL} anlegen`;
export const TITEL_KOPIE = `${UEMS_KENNZAHL} kopieren`;
export const TITEL_FERTIG = 'Fertig';
/** §5.1 Neukunde: die leere Liste. Den Hebel „Bezugsgröße anlegen“ gibt es erst mit einer Bezugsgrößen-Fläche. */
export const LEER_SATZ = `${UEMS_KENNZAHLEN} setzen Messwerte ins Verhältnis — zu Stück, kg, m², Stunden oder Personen. Dafür braucht es Bezugsgrößen.`;
export const VORSCHAU = 'Vorschau';
export const SCHRITT_ZAHL = 5;
/** Schritt 3 einer Zusammenfassung (§5.6). */
export const ENTFAELLT = 'entfällt';

export const S1_TITEL = 'Eine Vorlage wählen — oder ohne Vorlage';
export const S1_SUB = 'Eine Vorlage belegt Rechenform, Name und Zweck vor. Die Eingänge wählen Sie selbst.';
export const OHNE_VORLAGE_TITEL = 'Ohne Vorlage';
export const OHNE_VORLAGE_SATZ = 'Rechenform und Eingänge selbst wählen';
export const RECHENFORM_FRAGE = 'Rechenform';
export const RECHENFORM_SATZ: Record<KennzahlRechenform, string> = {
  quotient: 'etwa kWh je Stück, je kg oder je m²',
  anteil: `in Prozent, etwa ein Verbrauch am Netzbezug`,
  zusammenfassung: `${KZ.GEWICHTET} über ${UEMS_KENNZAHLEN} derselben Rechenform und Einheit`,
};
export const KOMPLEMENT_SATZ = `Als Rest bis 100${NB}% zeigen (100${NB}% weniger den Anteil)`;
export const KOPIE_SUB = `Übernommen werden Rechenform, Name und ${UEMS_ZWECK}. Eingänge, ${UEMS_GELTUNGSBEREICH} und ${UEMS_VERANTWORTLICH} wählen Sie neu.`;

export const S2_TITEL: Record<KennzahlRechenform, string> = {
  quotient: 'Welche Menge?',
  anteil: 'Welcher Teil?',
  zusammenfassung: `Welche ${UEMS_KENNZAHLEN} fassen Sie zusammen?`,
};
export const OHNE_ERWARTUNG = `Eine ${UEMS_MESSSTELLE} oder ein ${GESAMTWERT} — eine ${UEMS_KENNZAHL} rechnet nur mit Mengen.`;
export const HEBEL_SATZ = `Mehrere Messstellen? Legen Sie zuerst einen ${GESAMTWERT} an`;
export const HEBEL_KNOPF = `${GESAMTWERT} anlegen`;
export const HEBEL_OHNE_ANLAGE = `Ein ${GESAMTWERT} entsteht an einer Anlage — keine der gewählten Messstellen hängt an einer.`;
export const EINE_MENGE = `Eine ${UEMS_KENNZAHL} liest genau einen Wert — ein ${GESAMTWERT} fasst mehrere Messstellen zusammen.`;
export const OHNE_BERECHNUNG = `Diese ${UEMS_KENNZAHL} hat heute keine ${UEMS_BERECHNUNG}.`;
export const LADEN = 'Wird geladen …';
export const LADEFEHLER = 'Die Auswahl konnte nicht geladen werden.';

export const S3_TITEL = { quotient: `${UEMS_BEZUGSGROESSE} wählen`, anteil: 'Das Ganze wählen' } as const;
export const PERIODE_WUNSCH = 'Gebildet je';
export const FLAECHEN_GRUPPE = 'Flächen der Standortstruktur';
export const FLAECHE_KEIN_EINGANG = `Eine Fläche der Standortstruktur hat kein Kennzeichen einer ${UEMS_BEZUGSGROESSE} — eine ${UEMS_KENNZAHL} kann sie nicht lesen.`;
export const SCHON_GEWAEHLT = `Schon als ${UEMS_TEIL} gewählt.`;

export const S4_TITEL = `${UEMS_GELTUNGSBEREICH}, Name, ${UEMS_VERANTWORTLICH}, ${UEMS_ZWECK}`;
export const NAME = 'Name';
export const NAME_AUS_VORLAGE = 'Vorbelegt — änderbar.';
export const VERANTWORTLICH_HINT = 'Vorbelegt mit Ihnen.';
export const RECHTE_TITEL = 'Rechte-Geltungsbereich';
export const RECHTE_SATZ = `Anlegen und ändern darf, wer dort ${UEMS_KENNZAHLEN} definieren darf.`;
export const PFLICHT = 'Bitte ausfüllen.';

export const S5_SUB = 'Nichts wird vor „Anlegen“ gespeichert';
export const PERIODEN_TITEL = 'Die letzten drei abgeschlossenen Perioden — gerechnet, nicht gespeichert';
export const VORSCHAU_LAEDT = 'Die Vorschau wird gerechnet …';
export const VORSCHAU_FEHLER = 'Die Vorschau konnte nicht gerechnet werden.';
export const OHNE_PERIODEN = 'Für Wochen gibt es noch keine Vorschau.';
export const VOR_BESTEHEN_WORT = 'vor dem Bestehen';
export const EINHEIT_WORT = 'Einheit';
export const ZU_SCHRITT = 'Zu Schritt';
export const ANLEGEN = 'Anlegen';
export const ANLEGEN_LAEUFT = 'Wird angelegt …';
export const ANLEGEN_FEHLER = 'Das Anlegen ist gerade nicht gelungen. Bitte versuchen Sie es noch einmal.';
export const FERTIG_SUB = `Ihre Werte bildet VoltPilot im nächsten Rechenlauf — nach den Messwerten, die sie liest.`;
export const ZUR_KENNZAHL = `Zur ${UEMS_KENNZAHL}`;
export const STRICH = '—';

/** Die Wörter der fünf Schritte — Schritt 2 und 3 heißen je Rechenform (E12: „Teil an Ganzem“). */
export const schrittWoerter = (form: KennzahlRechenform | null): string[] => [
  UEMS_VORLAGE,
  form === KZ.ANTEIL ? UEMS_TEIL : form === KZ.ZUSAMMENFASSUNG ? UEMS_KENNZAHLEN : UEMS_MENGE,
  form === KZ.ANTEIL ? UEMS_GANZES : form === KZ.ZUSAMMENFASSUNG ? ENTFAELLT : UEMS_BEZUGSGROESSE,
  UEMS_GELTUNGSBEREICH,
  VORSCHAU,
];

export const eyebrow = (n: number, wort: string): string => `Schritt ${n} von ${SCHRITT_ZAHL} · ${wort}`;

export type Schritt = 1 | 2 | 3 | 4 | 5 | 6;

/** Eine Zusammenfassung überspringt Schritt 3 (§5.6) — vorwärts wie rückwärts. */
export const naechster = (s: Schritt, form: KennzahlRechenform | null): Schritt =>
  (s === 2 && form === KZ.ZUSAMMENFASSUNG ? 4 : Math.min(s + 1, 6)) as Schritt;
export const voriger = (s: Schritt, form: KennzahlRechenform | null): Schritt =>
  (s === 4 && form === KZ.ZUSAMMENFASSUNG ? 2 : Math.max(s - 1, 1)) as Schritt;

// ------------------------------------------------------------------ Vorlage, Kopie, Entwurf

export const OHNE_VORLAGE = 'ohne';
export const KOPIE = 'kopie';

export type VorlagenKarte = { wert: string; titel: string; satz: string; form: string | null };

/** Schritt 1: die acht Vorlagen des Katalogs als Karten mit Satz, dazu „ohne Vorlage“. */
export const vorlagenKarten = (): VorlagenKarte[] => [
  ...KENNZAHL_VORLAGEN.map((v) => ({ wert: v.kennung, titel: vorlagenTitel(v), satz: v.hilfesatz, form: UEMS_RECHENFORM[v.rechenform] })),
  { wert: OHNE_VORLAGE, titel: OHNE_VORLAGE_TITEL, satz: OHNE_VORLAGE_SATZ, form: null },
];

/** Was eine Kopie von ihrer Quelle mitnimmt (K20, §5.2): Form (mit Komplement), Name, Zweck — nie die Eingänge. */
export type KopieQuelle = KZ.Quelle & { rechenform: KennzahlRechenform; komplement: boolean };

export const kopieQuelle = (k: Kennzahl, fassungen: readonly KennzahlFassung[]): KopieQuelle => {
  const heute = fassungen.find((f) => f.nummer === k.fassung) ?? fassungen[fassungen.length - 1] ?? null;
  return {
    kennzeichen: k.kennzeichen,
    name: k.name,
    zweck: k.zweck ?? '',
    rechenform: k.rechenform,
    geltung_name: k.geltung_name ?? '',
    komplement: heute?.komplement ?? false,
  };
};

export const kopieTitel = (q: KopieQuelle): string => `Kopie von ${q.kennzeichen}`;

export interface Entwurf {
  /** Kennung der Vorlage, {@link OHNE_VORLAGE} oder {@link KOPIE}. */
  wahl: string | null;
  rechenform: KennzahlRechenform | null;
  komplement: boolean;
  /** Kennzeichen der Menge (bzw. des Teils) — mehr als eines nur, bis der Hebel zum Gesamtwert greift. */
  menge: string[];
  /** Kennzeichen der Bezugsgröße (bzw. der Messstelle des Ganzen). */
  bezug: string | null;
  /** Kennzeichen der Kennzahlen einer Zusammenfassung. */
  paare: string[];
  /** Der Perioden-Wunsch; `null` = die Grundperiode der Eingänge. */
  periode: KennzahlPeriodeArt | null;
  /** {@link geltungWert} des Geltungsobjekts. */
  geltung: string | null;
  name: string;
  nameBeruehrt: boolean;
  verantwortlich: string;
  zweck: string;
  zweckBeruehrt: boolean;
}

export const leererEntwurf = (verantwortlich: string, quelle: KopieQuelle | null = null): Entwurf => ({
  wahl: quelle ? KOPIE : null,
  rechenform: quelle?.rechenform ?? null,
  komplement: quelle?.komplement ?? false,
  menge: [],
  bezug: null,
  paare: [],
  periode: null,
  geltung: null,
  name: '',
  nameBeruehrt: false,
  verantwortlich,
  zweck: quelle?.zweck ?? '',
  zweckBeruehrt: false,
});

const ohneEingaenge = { menge: [] as string[], bezug: null, paare: [] as string[], periode: null };

/** Schritt 1: eine Vorlage oder „ohne Vorlage“. Eine andere Wahl nimmt keine Eingänge still mit. */
export const waehle = (e: Entwurf, wahl: string): Entwurf => {
  if (wahl === e.wahl) return e;
  const v = kennzahlVorlage(wahl);
  return {
    ...e,
    ...ohneEingaenge,
    wahl,
    rechenform: v ? v.rechenform : wahl === OHNE_VORLAGE ? KZ.QUOTIENT : e.rechenform,
    komplement: v ? v.komplement : false,
    zweck: e.zweckBeruehrt ? e.zweck : (v?.zweck_vorschlag ?? ''),
  };
};

/** „Ohne Vorlage“: die Rechenform aus dem geschlossenen Satz (E2). */
export const rechenformWaehlen = (e: Entwurf, form: KennzahlRechenform): Entwurf =>
  form === e.rechenform ? e : { ...e, ...ohneEingaenge, rechenform: form, komplement: false };

const erwartungen = (e: Entwurf) => {
  const v = e.wahl ? kennzahlVorlage(e.wahl) : null;
  return { menge: v?.zaehler_erwartung ?? null, bezug: v?.nenner_erwartung ?? null };
};

export const mengeErwartung = (e: Entwurf): KennzahlVorlageMessstelle | null => {
  const m = erwartungen(e).menge;
  return m?.art === 'messstelle' ? m : null;
};

export const bezugErwartung = (e: Entwurf): KennzahlVorlageMessstelle | KennzahlVorlageBezugsgroesse | null => erwartungen(e).bezug;

// ------------------------------------------------------------------ Auswahl: Messstellen, Bezugsgrößen, Kennzahlen

export type Auswahl = { optionen: VpOption[]; passend: number; gesamt: number };

const OHNE_ORT = 'Ohne Ort';
const lebt = (z: MessstelleRegisterZeile) => z.lebenszyklus !== 'archiviert';

/** Passt eine Messstelle zur Erwartung der Vorlage (Art, Größe, Richtung, Wertart)? Ohne Vorlage passt jede. */
export const passtMessstelle = (z: MessstelleRegisterZeile, er: KennzahlVorlageMessstelle | null): boolean =>
  er === null ||
  (er.messstelle_arten.includes(z.art) &&
    z.hauptgroesse.groesse === er.groesse &&
    (er.richtungen === null || er.richtungen.includes(z.hauptgroesse.richtung)) &&
    er.wertarten.includes(z.hauptgroesse.wertart));

/** Messstellen und Gesamtwerte, gefiltert auf die Erwartung; ein Momentanwert bleibt sichtbar und nennt den Satz des Zwillings. */
export const messstellenAuswahl = (
  zeilen: readonly MessstelleRegisterZeile[],
  er: KennzahlVorlageMessstelle | null,
  gesperrt: string | null = null,
): Auswahl => {
  const alle = zeilen.filter(lebt);
  const passend = alle.filter((z) => passtMessstelle(z, er));
  return {
    passend: passend.length,
    gesamt: alle.length,
    optionen: passend.map((z) => {
      const momentan = z.hauptgroesse.wertart === KZ.MOMENTANWERT
        ? KZ.satz('einheit_momentanwert', { objekt: z.kennzeichen, einheit: z.hauptgroesse.einheit })
        : null;
      const grund = momentan ?? (z.kennzeichen === gesperrt ? SCHON_GEWAEHLT : null);
      return {
        value: z.kennzeichen,
        label: z.name ? `${z.kennzeichen} ${z.name}` : z.kennzeichen,
        sub: [z.art === 'berechnet' ? GESAMTWERT : UEMS_MESSSTELLE, z.hauptgroesse.groesse, z.hauptgroesse.richtung, z.ort.name ?? OHNE_ORT].join(' · '),
        group: z.ort.standort_name ?? (z.ort.grund === 'am_unternehmen' ? UEMS_UNTERNEHMEN : OHNE_ORT),
        disabled: grund !== null,
        disabledHint: grund,
        keywords: [z.ort.kennzeichen, z.ort.name].filter(Boolean).join(' '),
      };
    }),
  };
};

export const erwartungHinweis = (satz: string | null, a: Auswahl, wort = 'Messstellen'): string =>
  satz === null ? OHNE_ERWARTUNG : `Die Vorlage erwartet: ${satz}. ${a.passend} von ${a.gesamt} ${wort} passen.`;

const wertartWort = (b: Bezugsgroesse): string =>
  b.wertart === KZ.STAMMDATUM ? 'Stammdatum' : b.wertart === KZ.STAND ? 'Stände' : b.periode_art ? KZ.PERIODEN_WOERTER[b.periode_art].werte : 'Periodenwerte';

/**
 * Bezugsgrößen mit Kennzeichen, gefiltert auf Einheit und Wertart der Vorlage (die Art trägt die Route nicht);
 * Stände nennen den Satz des Zwillings. Flächen der Standortstruktur stehen gesperrt mit Grund daneben.
 */
export const bezugsgroessenAuswahl = (
  liste: readonly Bezugsgroesse[],
  flaechen: readonly Bezugsflaeche[],
  er: KennzahlVorlageBezugsgroesse | null,
): Auswahl => {
  const alle = liste.filter((b) => b.archiviert_am === null);
  const passend = alle.filter((b) => er === null || (er.einheiten.includes(b.einheit) && er.wertarten.includes(b.wertart as never)));
  const gruppe = `${UEMS_BEZUGSGROESSE}n`;
  const optionen: VpOption[] = passend.map((b) => {
    const grund = b.wertart === KZ.STAND ? KZ.satz('einheit_stand', { objekt: b.kennzeichen }) : null;
    return {
      value: b.kennzeichen,
      label: `${b.kennzeichen} ${b.name}`,
      sub: [b.einheit, wertartWort(b), `${GELTUNG_WORT[b.geltung_art]} ${b.geltung_name}`].join(' · '),
      group: gruppe,
      disabled: grund !== null,
      disabledHint: grund,
    };
  });
  if (er === null || er.einheiten.includes('m²')) {
    for (const f of flaechen) {
      optionen.push({
        value: `flaeche:${f.geltung_art}:${f.geltung_id}`,
        label: `${f.name} ${f.geltung_name}`,
        sub: ['m²', 'Stammdatum', `${GELTUNG_WORT[f.geltung_art]} ${f.geltung_kennzeichen ?? f.geltung_name}`].join(' · '),
        group: FLAECHEN_GRUPPE,
        disabled: true,
        disabledHint: FLAECHE_KEIN_EINGANG,
      });
    }
  }
  return { optionen, passend: passend.length, gesamt: alle.length };
};

export const bezugsgroessenGruppen: VpGruppe[] = [
  { key: `${UEMS_BEZUGSGROESSE}n`, label: `${UEMS_BEZUGSGROESSE}n` },
  { key: FLAECHEN_GRUPPE, label: FLAECHEN_GRUPPE },
];

/** Schritt 2 einer Zusammenfassung: Kennzahlen mit heutiger Berechnung; die Einheit prüft {@link pruefePaare}. */
export const kennzahlenAuswahl = (liste: readonly Kennzahl[]): Auswahl => {
  const alle = liste.filter((k) => k.archiviert_am === null);
  return {
    passend: alle.length,
    gesamt: alle.length,
    optionen: alle.map((k) => ({
      value: k.kennzeichen,
      label: `${k.kennzeichen} ${k.name}`,
      sub: [UEMS_RECHENFORM[k.rechenform], k.einheit ? KZ.einheitWort(k.einheit) : null, `${GELTUNG_WORT[k.geltung_art]} ${k.geltung_name ?? ''}`.trim()]
        .filter(Boolean)
        .join(' · '),
      disabled: k.einheit === null,
      disabledHint: k.einheit === null ? OHNE_BERECHNUNG : null,
    })),
  };
};

// ------------------------------------------------------------------ Hebel zum Gesamtwert-Assistenten (E2)

export type Anlage = { id: string; name: string | null };

/** Die Anlage, an der der Gesamtwert entsteht: die der ersten gewählten Messstelle mit elektrischer Stellung. */
export const hebelAnlage = (zeilen: readonly MessstelleRegisterZeile[], gewaehlt: readonly string[]): Anlage | null => {
  for (const kz of gewaehlt) {
    const s = zeilen.find((z) => z.kennzeichen === kz)?.elektrische_stellung;
    if (s) return { id: s.anlage, name: s.anlage_name };
  }
  return null;
};

export const hebelOrt = (a: Anlage): string | null => (a.name ? `Der ${GESAMTWERT} entsteht an der Anlage ${a.name}.` : null);

/** Zurück aus dem Gesamtwert-Assistenten: der neue Gesamtwert ist die Menge. */
export const nachGesamtwert = (e: Entwurf, kennzeichen: string): Entwurf => ({ ...e, menge: [kennzeichen], bezug: null, periode: null });

// ------------------------------------------------------------------ Prüfungen (live aus dem Zwilling)

/** Eine gewählte Seite der Berechnung. */
export type Seite = { art: 'messstelle'; zeile: MessstelleRegisterZeile } | { art: 'bezugsgroesse'; bg: Bezugsgroesse };

/** Die Grundperiode, in der eine Messstelle der Kennzahl ihre Menge liefert (Vektor K1: „MS-12 (Tag)“). */
export const MESSSTELLE_PERIODE: KennzahlPeriodeArt = 'tag';

const einheitSeite = (s: Seite): KZ.EinheitSeite =>
  s.art === 'messstelle'
    ? { art: KZ.MESSSTELLE, objekt: s.zeile.kennzeichen, einheit: s.zeile.hauptgroesse.einheit, groesse: s.zeile.hauptgroesse.groesse, wertart: s.zeile.hauptgroesse.wertart }
    : { art: KZ.BEZUGSGROESSE, objekt: s.bg.kennzeichen, einheit: s.bg.einheit, groesse: null, wertart: s.bg.wertart };

export const periodenEingang = (s: Seite): KZ.PeriodenEingang =>
  s.art === 'messstelle'
    ? { art: KZ.MESSSTELLE, objekt: s.zeile.kennzeichen, name: s.zeile.name, wertart: null, periode_art: MESSSTELLE_PERIODE }
    : { art: KZ.BEZUGSGROESSE, objekt: s.bg.kennzeichen, name: s.bg.name, wertart: s.bg.wertart, periode_art: s.bg.periode_art };

export type Pruefung = {
  /** Der Code des Zwillings (`periode_passt_nicht`, `einheit_unpassend` …) oder `null`. */
  fehler: string | null;
  /** Der rote Kundensatz des Zwillings (§5.8). */
  satz: string | null;
  einheit: string | null;
  einheitAnzeige: string | null;
  grundperiode: KennzahlPeriodeArt | null;
  perioden: KennzahlPeriodeArt[];
  /** „BZ-6 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet“. */
  hinweis: string | null;
};

const aufzaehlung = (woerter: string[]): string =>
  woerter.length <= 1 ? woerter.join('') : `${woerter.slice(0, -1).join(', ')} und ${woerter[woerter.length - 1]}`;

/** Der grüne Satz unter der Auswahl: der Eingang, der die Grundperiode trägt, und die Perioden der Kennzahl (P2). */
export const periodenHinweis = (eingaenge: readonly KZ.PeriodenEingang[], grund: string, perioden: readonly string[]): string => {
  const traeger = [...eingaenge].reverse().find((e) => e.wertart !== KZ.STAMMDATUM && e.periode_art === grund);
  const wer = traeger ? `${traeger.objekt} führt ${KZ.PERIODEN_WOERTER[grund].werte}` : KZ.PERIODEN_WOERTER[grund].werte;
  return `${wer} — die ${UEMS_KENNZAHL} wird je ${aufzaehlung(perioden.map((p) => PERIODEN_NAME[p as KennzahlPeriodeArt]))} gebildet`;
};

/** Schritt 3: Einheit (U1–U3), dann Periode (P1–P3) — beides der Zwilling, sofort unter der Auswahl. */
export const pruefeBerechnung = (
  form: KennzahlRechenform,
  menge: Seite | null,
  bezug: Seite | null,
  wunsch: KennzahlPeriodeArt | null,
): Pruefung | null => {
  if (menge === null || bezug === null) return null;
  const u = KZ.einheit(form, einheitSeite(menge), einheitSeite(bezug), null);
  if (u.fehler) {
    return { fehler: u.fehler, satz: u.kundensatz, einheit: null, einheitAnzeige: null, grundperiode: null, perioden: [], hinweis: null };
  }
  const eingaenge = [periodenEingang(menge), periodenEingang(bezug)];
  const p = KZ.periode(wunsch, eingaenge);
  const perioden = p.perioden as KennzahlPeriodeArt[];
  return {
    fehler: p.fehler,
    satz: p.kundensatz,
    einheit: u.einheit,
    einheitAnzeige: u.anzeige,
    grundperiode: p.grundperiode as KennzahlPeriodeArt | null,
    perioden,
    hinweis: p.fehler === null && p.grundperiode !== null ? periodenHinweis(eingaenge, p.grundperiode, perioden) : null,
  };
};

/** Schritt 2 einer Zusammenfassung: dieselbe Rechenform und Einheit (U1) — der Zwilling. */
export const pruefePaare = (paare: readonly Kennzahl[]): Pruefung | null => {
  if (paare.length === 0) return null;
  const u = KZ.einheit(KZ.ZUSAMMENFASSUNG, null, null, paare.map((k) => ({ objekt: k.kennzeichen, rechenform: k.rechenform, einheit: k.einheit ?? '' })));
  return {
    fehler: u.fehler,
    satz: u.kundensatz,
    einheit: u.einheit,
    einheitAnzeige: u.anzeige,
    grundperiode: null,
    perioden: [],
    hinweis: u.fehler === null && u.einheit !== null ? `${KZ.GEWICHTET} · ${KZ.einheitWort(u.einheit)}` : null,
  };
};

/** Die Perioden, die ein Wunsch wählen kann — alle vier; welche bildbar sind, sagt {@link pruefeBerechnung}. */
export const PERIODEN_WAHL: KennzahlPeriodeArt[] = KZ.PERIODEN as KennzahlPeriodeArt[];

export const einheitText = (anzeige: string): string => `${EINHEIT_WORT} aus den Eingängen: ${anzeige}`;

export type Befund = KennzahlVorschau['befunde'][number];

/** Der Satz eines Befunds der Vorschau: trägt er eine Kette (K16), spricht der Zwilling; sonst der Satz der Route. */
export const befundSatz = (b: Befund): string => {
  const kette = b.fakten?.kette;
  if (b.code === KZ.FORMEL_ZYKLUS && Array.isArray(kette)) return KZ.satz(KZ.FORMEL_ZYKLUS, { kette: (kette as string[]).join(' → ') });
  return b.message;
};

/** In welchem Schritt ein Befund zu beheben ist. */
export const befundSchritt = (code: string): Schritt =>
  (
    ({
      rechenform_unbekannt: 1,
      formel_zyklus: 2,
      groesse_unbekannt: 2,
      eingang_unbekannt: 3,
      einheit_unpassend: 3,
      periode_passt_nicht: 3,
    }) as Record<string, Schritt>
  )[code] ?? 4;

// ------------------------------------------------------------------ Geltungsbereich (G1, G3)

export type GeltungOrt = {
  wert: string;
  art: KennzahlGeltungArt;
  id: string;
  kennzeichen: string | null;
  name: string;
  standort_id: string | null;
  standort_name: string | null;
  gruppe: string;
  eltern: string | null;
};

export const geltungWert = (art: string, id: string): string => `${art}:${id}`;

const PROZESSE = `${UEMS_PROZESS}e`;
const KOSTENSTELLEN = `${UEMS_KOSTENSTELLE}n`;
const MESSSTELLEN = `${UEMS_MESSSTELLE}n`;

/** Die wählbaren Geltungsobjekte (E6): Unternehmen, Ortsbaum je Standort, Prozesse, Kostenstellen, Messstellen. */
export const geltungsOrte = (q: {
  unternehmen: Unternehmen | null;
  standorte: readonly StandortAmStichtag[];
  baeume: readonly OrtsbaumAmStichtag[];
  prozesse: readonly Prozess[];
  kostenstellen: readonly Kostenstelle[];
  messstellen: readonly MessstelleRegisterZeile[];
}): GeltungOrt[] => {
  const orte: GeltungOrt[] = [];
  const ort = (o: Omit<GeltungOrt, 'wert'>) => orte.push({ ...o, wert: geltungWert(o.art, o.id) });
  // Ein noch nicht angelegtes Unternehmen hat keine Kennung — dann gibt es keine Unternehmens-Kennzahl zu wählen.
  if (q.unternehmen?.id) {
    ort({
      art: 'unternehmen', id: q.unternehmen.id, kennzeichen: null, name: q.unternehmen.name ?? UEMS_UNTERNEHMEN,
      standort_id: null, standort_name: null, gruppe: UEMS_UNTERNEHMEN, eltern: null,
    });
  }
  for (const s of q.standorte.filter((x) => x.zustand !== 'archiviert')) {
    const im = { standort_id: s.id, standort_name: s.name, gruppe: s.name };
    ort({ art: 'standort', id: s.id, kennzeichen: s.kurzzeichen, name: s.name, eltern: null, ...im });
    const baum = q.baeume.find((b) => b.standort.id === s.id);
    for (const g of baum?.gebaeude ?? []) {
      ort({ art: 'gebaeude', id: g.id, kennzeichen: g.kurzzeichen, name: g.name, eltern: null, ...im });
      for (const b of g.bereiche) ort({ art: 'bereich', id: b.id, kennzeichen: b.kurzzeichen, name: b.name, eltern: g.name, ...im });
    }
    for (const b of baum?.direktAmStandort?.bereiche ?? []) {
      ort({ art: 'bereich', id: b.id, kennzeichen: b.kurzzeichen, name: b.name, eltern: s.name, ...im });
    }
  }
  for (const p of q.prozesse.filter((x) => x.gueltig_bis === null)) {
    ort({ art: 'prozess', id: p.id, kennzeichen: p.kennzeichen, name: p.name, standort_id: null, standort_name: null, gruppe: PROZESSE, eltern: null });
  }
  for (const k of q.kostenstellen.filter((x) => x.gueltig_bis === null)) {
    ort({ art: 'kostenstelle', id: k.id, kennzeichen: k.kennzeichen, name: k.name, standort_id: null, standort_name: null, gruppe: KOSTENSTELLEN, eltern: null });
  }
  for (const z of q.messstellen.filter(lebt)) {
    ort({
      art: 'messstelle', id: z.id, kennzeichen: z.kennzeichen, name: z.name ?? z.kennzeichen,
      standort_id: z.ort.standort_id, standort_name: z.ort.standort_name, gruppe: MESSSTELLEN, eltern: null,
    });
  }
  return orte;
};

export const geltungOptionen = (orte: readonly GeltungOrt[]): VpOption[] =>
  orte.map((o) => ({
    value: o.wert,
    label: o.name,
    sub: [`${GELTUNG_WORT[o.art]}${o.kennzeichen ? ` ${o.kennzeichen}` : ''}`, o.eltern].filter(Boolean).join(' · '),
    group: o.gruppe,
    keywords: o.kennzeichen,
  }));

/** Wie das Geltungsobjekt im Satz heißt: „Gebäude Halle 2 (G-2)“. */
export const geltungText = (o: GeltungOrt): string => `${GELTUNG_WORT[o.art]} ${o.name}${o.kennzeichen ? ` (${o.kennzeichen})` : ''}`;

/**
 * Der Vorschlag für Schritt 4: das Geltungsobjekt der Bezugsgröße (BZ-6 → Halle 2), sonst der Ort der Messstelle;
 * eine Zusammenfassung gilt fürs Unternehmen (§5.6). Ein Vorschlag, sichtbar und änderbar — nie ein Eingang.
 */
export const geltungVorschlag = (
  form: KennzahlRechenform | null,
  orte: readonly GeltungOrt[],
  menge: Seite | null,
  bezug: Seite | null,
): string | null => {
  if (form === KZ.ZUSAMMENFASSUNG) return orte.find((o) => o.art === 'unternehmen')?.wert ?? null;
  const von = (s: Seite | null): string | null => {
    if (s === null) return null;
    if (s.art === 'bezugsgroesse') return geltungWert(s.bg.geltung_art, s.bg.geltung_id);
    return s.zeile.ort.ort_art && s.zeile.ort.id ? geltungWert(s.zeile.ort.ort_art, s.zeile.ort.id) : null;
  };
  return [von(bezug), von(menge)].find((w) => w !== null && orte.some((o) => o.wert === w)) ?? null;
};

export type Rechte = { text: string | null; fehler: string | null };

/** G1: der Rechte-Geltungsbereich des gewählten Objekts — „Standort Werk Ahrenberg“ oder „Unternehmen“. */
export const rechteGeltung = (o: GeltungOrt): Rechte => {
  const u = KZ.geltung(o.art, o.standort_id);
  if (u.fehler) return { text: null, fehler: u.kundensatz };
  return { text: u.rechte_geltung === KZ.STANDORT ? `${UEMS_STANDORT} ${o.standort_name}` : UEMS_UNTERNEHMEN, fehler: null };
};

export type EingangOrt = { objekt: string; standort_id: string | null; standort_name: string | null };

export const eingangOrt = (s: Seite, orte: readonly GeltungOrt[]): EingangOrt => {
  if (s.art === 'messstelle') {
    return { objekt: s.zeile.kennzeichen, standort_id: s.zeile.ort.standort_id, standort_name: s.zeile.ort.standort_name };
  }
  const o = orte.find((x) => x.wert === geltungWert(s.bg.geltung_art, s.bg.geltung_id));
  return { objekt: s.bg.kennzeichen, standort_id: o?.standort_id ?? null, standort_name: o?.standort_name ?? null };
};

export const eingangOrtKennzahl = (k: Kennzahl, orte: readonly GeltungOrt[]): EingangOrt => ({
  objekt: k.kennzeichen,
  standort_id: k.standort_id,
  standort_name: orte.find((o) => o.art === 'standort' && o.id === k.standort_id)?.name ?? null,
});

/** G1 und G3: ein Standort-Geltungsbereich liest keinen Eingang eines anderen Standorts — der Satz des Zwillings. */
export const pruefeGeltung = (o: GeltungOrt, eingaenge: readonly EingangOrt[]): string | null => {
  const g = KZ.geltung(o.art, o.standort_id);
  if (g.fehler) return g.kundensatz;
  for (const e of eingaenge) {
    const u = KZ.eingangGeltung(
      { rechte_geltung: g.rechte_geltung, standort: g.standort, standort_name: o.standort_name ?? '', geltung_name: o.name },
      { objekt: e.objekt, standort: e.standort_id, standort_name: e.standort_name ?? '', im_geltungsobjekt: true, seit: null },
    );
    if (u.fehler) return u.kundensatz;
  }
  return null;
};

// ------------------------------------------------------------------ Name, Anfrage, Weiter

const ohneEndung = (q: KopieQuelle): string => {
  const endung = ` — ${q.geltung_name}`;
  return q.geltung_name && q.name.endsWith(endung) ? q.name.slice(0, -endung.length) : q.name;
};

/** Der Name-Vorschlag: aus der Vorlage (K20) bzw. der Kopie mit dem neuen Geltungsobjekt; ohne Vorlage keiner. */
export const nameVorschlag = (e: Entwurf, quelle: KopieQuelle | null, o: GeltungOrt | null): string => {
  const v = e.wahl ? kennzahlVorlage(e.wahl) : null;
  if (v) return o ? vorbelegung(v, { art: o.art, id: o.id, name: o.name }).name : vorlagenTitel(v);
  if (e.wahl === KOPIE && quelle) return o ? KZ.kopie(quelle, o.name).name : ohneEndung(quelle);
  return '';
};

export const eingaengeVon = (e: Entwurf): KennzahlEingang[] => {
  if (e.rechenform === KZ.ZUSAMMENFASSUNG) return e.paare.map((kennzeichen) => ({ rolle: 'paar', art: 'kennzahl', kennzeichen }));
  const aus: KennzahlEingang[] = [];
  if (e.menge.length === 1) aus.push({ rolle: 'zaehler', art: 'messstelle', kennzeichen: e.menge[0] });
  if (e.bezug) aus.push({ rolle: 'nenner', art: e.rechenform === KZ.ANTEIL ? 'messstelle' : 'bezugsgroesse', kennzeichen: e.bezug });
  return aus;
};

/** Der Körper von `POST …/vorschau` und `POST /api/v1/kennzahlen` — beide Male DERSELBE. Das Kennzeichen vergibt der Server. */
export const anfrage = (e: Entwurf, o: GeltungOrt): KennzahlAnfrage => ({
  kennzeichen: null,
  name: e.name.trim(),
  rechenform: e.rechenform as KennzahlRechenform,
  geltung_art: o.art,
  geltung_id: o.id,
  verantwortlich_name: e.verantwortlich.trim() || null,
  zweck: e.zweck.trim() || null,
  periode_art: e.periode,
  komplement: e.rechenform === KZ.ANTEIL ? e.komplement : null,
  eingaenge: eingaengeVon(e),
});

/** „Menge je Bezugsgröße · MS-12 je BZ-6“ (§5.3). */
export const berechnungText = (e: Entwurf): string => {
  if (e.rechenform === null) return STRICH;
  const form = UEMS_RECHENFORM[e.rechenform];
  if (e.rechenform === KZ.ZUSAMMENFASSUNG) return `${form} · ${e.paare.join(' + ')} · ${KZ.GEWICHTET}`;
  const menge = e.menge[0] ?? STRICH;
  const bezug = e.bezug ?? STRICH;
  if (e.rechenform === KZ.ANTEIL) return `${form} · ${e.komplement ? `100${NB}% − ` : ''}${menge} an ${bezug}`;
  return `${form} · ${menge} je ${bezug}`;
};

/** Darf „Weiter“? Schritt 5 schaltet „Anlegen“ über {@link anlegenMoeglich}. */
export const weiterMoeglich = (s: Schritt, e: Entwurf, pruefung: Pruefung | null, geltungFehler: string | null): boolean => {
  switch (s) {
    case 1:
      return e.rechenform !== null;
    case 2:
      return e.rechenform === KZ.ZUSAMMENFASSUNG ? e.paare.length >= 2 && pruefung?.fehler === null : e.menge.length === 1;
    case 3:
      return e.bezug !== null && pruefung !== null && pruefung.fehler === null;
    case 4:
      return e.geltung !== null && e.name.trim() !== '' && e.verantwortlich.trim() !== '' && geltungFehler === null;
    default:
      return false;
  }
};

export const anlegenMoeglich = (v: KennzahlVorschau | null): boolean => v !== null && v.befunde.length === 0;

// ------------------------------------------------------------------ Vorschau und Fertig

export type VorschauZeile = {
  schluessel: string;
  periode: string;
  zahl: string;
  zustand: string;
  ton: Ton;
  kennzeichen: string | null;
  satz: string | null;
};

/** Die letzten drei Perioden der Vorschau, wie der Server sie rechnet; „vor dem Bestehen“ ist ein Fall, kein Fehler. */
export const vorschauZeilen = (v: KennzahlVorschau): VorschauZeile[] =>
  v.letzte_perioden.map((p) => {
    const vorBestehen = p.grund === KZ.VOR_BESTEHEN;
    return {
      schluessel: p.schluessel,
      periode: p.beschriftung,
      zahl: p.wert === null ? STRICH : p.anzeige,
      zustand: vorBestehen ? VOR_BESTEHEN_WORT : p.zustand,
      ton: vorBestehen ? 'off' : tonVon(p.zustand),
      kennzeichen: p.kennzeichen.length > 0 ? KZ.ordne(p.kennzeichen).join(' · ') : null,
      satz: vorBestehen ? null : p.kundensatz,
    };
  });

export type KopfZeile = { wort: string; wert: string };

export const vorschauKopf = (e: Entwurf, o: GeltungOrt, rechte: string | null, v: KennzahlVorschau | null): KopfZeile[] => [
  { wort: NAME, wert: e.name.trim() },
  { wort: UEMS_GELTUNGSBEREICH, wert: geltungText(o) },
  { wort: RECHTE_TITEL, wert: rechte ?? STRICH },
  { wort: UEMS_VERANTWORTLICH, wert: e.verantwortlich.trim() },
  { wort: UEMS_BERECHNUNG, wert: berechnungText(e) },
  ...(v?.einheit ? [{ wort: EINHEIT_WORT, wert: v.einheit === PROZENT ? v.einheit : KZ.einheitWort(v.einheit) }] : []),
];

/** „KZ-0001 angelegt · Fassung 1 gilt seit Beginn“ (§5.1). */
export const fertigSatz = (k: Pick<Kennzahl, 'kennzeichen' | 'fassung'>): string =>
  `${k.kennzeichen} angelegt · ${UEMS_FASSUNG} ${k.fassung ?? 1} gilt seit Beginn`;

/**
 * Der Satz einer Ablehnung der Route (403 `rolle_noetig`, 404, 409, 422 — ein Fehler mit `status` trägt den Kundensatz
 * des Servers); ein Netz- oder Programmfehler spricht nie seine technische Meldung, sondern `sonst`.
 */
export const ablehnungSatz = (e: unknown, sonst: string): string =>
  e instanceof Error && typeof (e as { status?: unknown }).status === 'number' && e.message ? e.message : sonst;
