/**
 * „Berechnung ändern ab …“, „Stammdaten ändern“, Archivieren und Löschen einer Kennzahl (UEMS AP-11 IP-15, §5.4, §5.7)
 * — reine Ableitung, gezeichnet von `KennzahlAnlegenDialog` (Modus „ändern“) und `KennzahlSeite`.
 *
 * ⚠ Die Wahrheit bleibt die Route: `POST …/fassungen` trägt die Fassung mit `MessstelleFormelRegeln.fassungEintrag` ein
 * und antwortet mit ihrem Abzeichen; `DELETE …` lehnt mit `hat_werte`/`wird_gelesen` ab. Was hier vorab geprüft wird
 * (Tag, Begründung, Lösch-Sperre), zeigt nur früher, was die Route ohnehin sagen würde — gemessen an den K17-Prüfungen
 * der Vektor-Datei und an `schnittstelle.ablehnungen` (`kennzahlAendern.test.ts`).
 * ⚠ Die Vorschau rechnet die Route (`POST …/vorschau`, Nur-Lese-Transaktion) — zweimal, mit den neuen und mit den
 * heutigen Eingängen; hier wird nichts gerechnet, nur nebeneinandergestellt.
 */
import type { Kennzahl, KennzahlAnfrage, KennzahlEingang, KennzahlFassung, KennzahlPeriodeArt, KennzahlVorschau, KennzahlVorschauPeriode } from './api';
import { schluesselVon, spanneVon, tagPlus } from './bezugsPeriode';
import { UEMS_BERECHNUNG, UEMS_FASSUNG, UEMS_GELTUNGSBEREICH, UEMS_KENNZAHL, UEMS_RECHENFORM, UEMS_VERANTWORTLICH, UEMS_ZWECK } from './glossar';
import { eingaengeVon, geltungWert, STRICH, type Entwurf } from './kennzahlAnlegen';
import { ARCHIVIERT, tonVon } from './kennzahlKarte';
import { KEINE_WERTE, PROZENT } from './uemsErgebnis';
import * as KZ from './uemsKennzahl';
import { datumText, rueckwirkung } from './uemsOrtsbaum';
import type { Ton } from './uemsWerteKarte';

const NB = String.fromCharCode(160);

// ------------------------------------------------------------------ Berechnung ändern ab … (§5.4)

export const KNOPF_BERECHNUNG_AENDERN = `${UEMS_BERECHNUNG} ändern ab …`;
export const TITEL = `${UEMS_BERECHNUNG} ändern`;
/** `Entwurf.wahl` beim Ändern — keine Vorlage, keine Erwartung an die Eingänge. */
export const AENDERN = 'aendern';

export const S1_TITEL = `Ab welchem Tag gilt die neue ${UEMS_BERECHNUNG}?`;
export const S1_SUB = 'Vorgabe ist heute. Ein früherer Tag gilt rückwirkend.';
export const HEUTE_GILT = 'Heute gilt';
export const S2_SUB = `Vorbelegt mit den Eingängen von heute — ändern Sie, was die neue ${UEMS_FASSUNG} anders rechnet.`;
export const S5_TITEL = 'Vorschau und Begründung';
export const S5_SUB = 'Nichts wird vor „Speichern“ gespeichert';
export const VERGLEICH_TITEL = 'Die letzte abgeschlossene Periode — neu und bisher gerechnet, nicht gespeichert';
export const NEU = 'neu';
export const BISHER = 'bisher';
export const WIE_BISHER = 'wie bisher';
export const BEGRUENDUNG = 'Begründung';
export const BEGRUENDUNG_MINDESTENS = 10;
export const BEGRUENDUNG_HINT = `Pflicht, mindestens ${BEGRUENDUNG_MINDESTENS} Zeichen — sie steht an der ${UEMS_FASSUNG}.`;
export const UNVERAENDERT = `Die Eingänge sind dieselben wie heute — eine neue ${UEMS_FASSUNG} braucht eine andere ${UEMS_BERECHNUNG}.`;
export const SPEICHERN = 'Speichern';
export const SPEICHERN_LAEUFT = 'Wird gespeichert …';
export const SPEICHERN_FEHLER = 'Das Speichern ist gerade nicht gelungen. Bitte versuchen Sie es noch einmal.';
export const FERTIG_SUB = `Perioden ab diesem Tag, die noch vorläufig sind, bildet VoltPilot im nächsten Rechenlauf mit der neuen ${UEMS_FASSUNG}.`;

/** Die Fassung, die heute gilt (`Kennzahl.fassung`); ohne sie gibt es nichts zu ändern. */
export const aktuelleFassung = (k: Pick<Kennzahl, 'fassung'>, fassungen: readonly KennzahlFassung[]): KennzahlFassung | null =>
  fassungen.find((f) => f.nummer === k.fassung) ?? null;

/** Der Entwurf der neuen Fassung — Schritte 2 und 3 mit den HEUTIGEN Eingängen vorbelegt (§5.4). */
export const aenderEntwurf = (k: Kennzahl, f: KennzahlFassung): Entwurf => ({
  wahl: AENDERN,
  rechenform: f.rechenform,
  komplement: f.komplement,
  menge: f.eingaenge.filter((e) => e.rolle === 'zaehler').map((e) => e.kennzeichen),
  bezug: f.eingaenge.find((e) => e.rolle === 'nenner')?.kennzeichen ?? null,
  paare: f.eingaenge.filter((e) => e.rolle === 'paar').map((e) => e.kennzeichen),
  periode: null,
  geltung: geltungWert(k.geltung_art, k.geltung_id),
  name: k.name,
  nameBeruehrt: true,
  verantwortlich: k.verantwortlich_name,
  zweck: k.zweck ?? '',
  zweckBeruehrt: true,
});

// ---- Gilt ab (V1)

export type WirksameFassung = { nummer: number; ab: string | null; bis: string | null };

/** Die Form der Regel `fassung` in `kennzahl-vectors.json` (K17). */
export type FassungEintrag = {
  fehler: string | null;
  kundensatz: string | null;
  nummer: number | null;
  beenden: number | null;
  beenden_am: string | null;
  rueckwirkend: boolean;
  tage: number;
  abzeichen: string | null;
};

export const FASSUNG_UEBERLAPPT = 'fassung_ueberlappt';

/** Die wirksamen Fassungen einer Kennzahl — eine aufgehobene zählt nicht mit. */
export const wirksame = (fassungen: readonly KennzahlFassung[]): WirksameFassung[] =>
  fassungen.filter((f) => f.aufgehoben_am === null).map((f) => ({ nummer: f.nummer, ab: f.gueltig_ab, bis: f.gueltig_bis }));

/**
 * V1 vorab: beginnt die neue Fassung nicht NACH der jüngsten, sagt es der Satz der Route („Ab diesem Tag gilt schon
 * Fassung 2.“); sonst beendet sie die laufende am Vortag und trägt „rückwirkend (n Tage)“, wenn ihr Tag vor dem
 * Eintragstag liegt (`rueckwirkung`, der Zwilling der Ortsstruktur). Wortgleich mit `MessstelleFormelRegeln.fassungEintrag`
 * — die Route bleibt die Wahrheit, ihr 422 steht beim Speichern.
 */
export const fassungEintrag = (wirksam: readonly WirksameFassung[], ab: string, eingetragenUm: string, zone: string): FassungEintrag => {
  const juengste = wirksam.reduce<WirksameFassung | null>((m, f) => (m === null || f.nummer > m.nummer ? f : m), null);
  if (juengste !== null && juengste.ab !== null && ab <= juengste.ab) {
    const kundensatz =
      ab === juengste.ab
        ? `Ab diesem Tag gilt schon ${UEMS_FASSUNG} ${juengste.nummer}.`
        : `Ab dem ${datumText(juengste.ab)} gilt schon ${UEMS_FASSUNG} ${juengste.nummer} — eine neue ${UEMS_FASSUNG} beginnt nach diesem Tag.`;
    return { fehler: FASSUNG_UEBERLAPPT, kundensatz, nummer: null, beenden: null, beenden_am: null, rueckwirkend: false, tage: 0, abzeichen: null };
  }
  const beenden = juengste !== null && (juengste.bis === null || ab <= juengste.bis) ? juengste : null;
  const r = rueckwirkung({ eingetragenUm, giltAb: ab, giltBis: null, zeitzone: zone });
  const rueck = r.art === 'rueckwirkend';
  return {
    fehler: null,
    kundensatz: null,
    nummer: juengste === null ? 1 : juengste.nummer + 1,
    beenden: beenden?.nummer ?? null,
    beenden_am: beenden === null ? null : tagPlus(ab, -1),
    rueckwirkend: rueck,
    tage: rueck ? r.tage : 0,
    abzeichen: rueck ? r.abzeichen : null,
  };
};

/** Die Nummer der neuen Fassung — nie wiederverwendet, auch nicht die einer aufgehobenen (wie die Route). */
export const naechsteNummer = (fassungen: readonly KennzahlFassung[]): number => Math.max(0, ...fassungen.map((f) => f.nummer)) + 1;

/** Der Satz unter dem Tag: „Fassung 2 gilt ab 01.03.2027 — Fassung 1 endet am 28.02.2027.“; bei einem Nein steht der rote Satz. */
export const abSatz = (u: FassungEintrag, ab: string, heute: string, nummer: number): string | null => {
  if (u.fehler !== null) return null;
  const beginn = ab === heute ? 'ab heute' : `ab ${datumText(ab)}`;
  const ende = u.beenden === null || u.beenden_am === null ? '' : ` — ${UEMS_FASSUNG} ${u.beenden} endet am ${datumText(u.beenden_am)}`;
  return `${UEMS_FASSUNG} ${nummer} gilt ${beginn}${ende}.`;
};

// ---- Begründung

export const begruendungOk = (text: string): boolean => text.trim().length >= BEGRUENDUNG_MINDESTENS;

/** Der rote Satz unter dem Feld — erst, wenn der Kunde es angefasst hat. */
export const begruendungFehler = (text: string, beruehrt: boolean): string | null => {
  if (!beruehrt || begruendungOk(text)) return null;
  return `Noch ${BEGRUENDUNG_MINDESTENS - text.trim().length} Zeichen — warum rechnet die ${UEMS_KENNZAHL} ab diesem Tag anders?`;
};

// ---- Anfragen

export const eingaengeAus = (f: KennzahlFassung): KennzahlEingang[] => f.eingaenge.map(({ rolle, art, kennzeichen }) => ({ rolle, art, kennzeichen }));

const eingangsSchluessel = (xs: readonly KennzahlEingang[]): string =>
  xs.map((x) => `${x.rolle}|${x.art}|${x.kennzeichen}`).sort().join(',');

/** Dieselben Eingänge (und beim Anteil derselbe Rest bis 100 %) — dann wäre die neue Fassung keine andere Berechnung. */
export const unveraendert = (e: Entwurf, f: KennzahlFassung): boolean =>
  eingangsSchluessel(eingaengeVon(e)) === eingangsSchluessel(eingaengeAus(f)) && (f.rechenform !== KZ.ANTEIL || e.komplement === f.komplement);

/** Der Körper von `POST …/{id}/fassungen`. */
export const fassungAnfrage = (e: Entwurf, ab: string, begruendung: string) => ({
  gueltig_ab: ab,
  begruendung: begruendung.trim(),
  periode_art: e.periode,
  komplement: e.rechenform === KZ.ANTEIL ? e.komplement : null,
  eingaenge: eingaengeVon(e),
});

/** Der Körper von `POST …/vorschau` für die Kennzahl mit diesen Eingängen — ohne Kennzeichen (das gehört ihr schon). */
export const vorschauAnfrage = (
  k: Kennzahl,
  eingaenge: KennzahlEingang[],
  periode: KennzahlPeriodeArt | null,
  komplement: boolean,
): KennzahlAnfrage => ({
  kennzeichen: null,
  name: k.name,
  rechenform: k.rechenform,
  geltung_art: k.geltung_art,
  geltung_id: k.geltung_id,
  verantwortlich_name: k.verantwortlich_name,
  zweck: k.zweck,
  periode_art: periode,
  komplement: k.rechenform === KZ.ANTEIL ? komplement : null,
  eingaenge,
});

// ---- Vorschau: neu und bisher nebeneinander

export type VergleichSeite = { titel: string; zahl: string; zustand: string; ton: Ton; satz: string | null };

export type Vergleich = {
  schluessel: string;
  periode: string;
  /** „März 2027: 0,30 statt 0,29“ (§5.4). */
  satz: string;
  /** „kWh je kg“ — `null`, wenn die Zahlen ihre Einheit selbst tragen. */
  einheit: string | null;
  neu: VergleichSeite;
  bisher: VergleichSeite;
};

const zahlVon = (p: KennzahlVorschauPeriode, einheit: string | null): string => {
  if (p.wert === null) return STRICH;
  if (einheit === null || einheit === PROZENT) return p.anzeige;
  const ende = `${NB}${KZ.einheitWort(einheit)}`;
  return p.anzeige.endsWith(ende) ? p.anzeige.slice(0, -ende.length) : p.anzeige;
};

const seite = (p: KennzahlVorschauPeriode | null, einheit: string | null, titel: string): VergleichSeite =>
  p === null
    ? { titel, zahl: STRICH, zustand: KEINE_WERTE, ton: 'off', satz: null }
    : { titel, zahl: zahlVon(p, einheit), zustand: p.zustand, ton: tonVon(p.zustand), satz: p.wert === null ? p.kundensatz : null };

/**
 * Die jüngste Periode der Vorschau, mit der neuen und der heutigen Fassung gerechnet (§5.4 „März 2027: 0,30 statt
 * 0,28“). `null`, solange die neue Fassung Befunde hat — dann stehen die Befunde. Tragen beide dieselbe Einheit, steht
 * sie einmal darunter; sonst trägt jede Zahl ihre eigene.
 */
export const vergleich = (neu: KennzahlVorschau, bisher: KennzahlVorschau | null, nummerNeu: number, nummerBisher: number): Vergleich | null => {
  if (neu.befunde.length > 0) return null;
  const p = neu.letzte_perioden[0];
  if (p === undefined) return null;
  const alt =
    bisher !== null && bisher.befunde.length === 0
      ? (bisher.letzte_perioden.find((x) => x.schluessel === p.schluessel && x.periode_art === p.periode_art) ?? null)
      : null;
  const eine = bisher === null || bisher.einheit === neu.einheit ? neu.einheit : null;
  const n = seite(p, eine, `${UEMS_FASSUNG} ${nummerNeu} · ${NEU}`);
  const b = seite(alt, eine, `${UEMS_FASSUNG} ${nummerBisher} · ${BISHER}`);
  const satz = alt !== null && alt.anzeige === p.anzeige ? `${p.beschriftung}: ${n.zahl} — ${WIE_BISHER}` : `${p.beschriftung}: ${n.zahl} statt ${b.zahl}`;
  return {
    schluessel: p.schluessel,
    periode: p.beschriftung,
    satz,
    einheit: eine === null || eine === PROZENT ? null : KZ.einheitWort(eine),
    neu: n,
    bisher: b,
  };
};

/** V2: eine Periode liest die Fassung ihres letzten Tags — „Ab März 2027 gilt Fassung 2 — Februar 2027 und früher bleiben bei Fassung 1.“ */
export const wirkungSatz = (ab: string, art: KennzahlPeriodeArt | null, nummerNeu: number, nummerBisher: number): string | null => {
  if (art === null) return null;
  const erste = schluesselVon(ab, art);
  const davor = schluesselVon(tagPlus(spanneVon(erste, art)[0], -1), art);
  return `Ab ${KZ.periodeText(art, erste)} gilt ${UEMS_FASSUNG} ${nummerNeu} — ${KZ.periodeText(art, davor)} und früher bleiben bei ${UEMS_FASSUNG} ${nummerBisher}.`;
};

/** Die jüngste Fassung der Antwort — die eben eingetragene. */
export const neuesteFassung = (fassungen: readonly KennzahlFassung[]): KennzahlFassung | null =>
  fassungen.reduce<KennzahlFassung | null>((m, f) => (m === null || f.nummer > m.nummer ? f : m), null);

/** „Fassung 2 gilt seit 01.03.2027“ — das Abzeichen „rückwirkend (19 Tage)“ steht daneben, so wie die Route es sagt. */
export const fertigSatz = (f: KennzahlFassung): string =>
  `${UEMS_FASSUNG} ${f.nummer} gilt seit ${f.gueltig_ab === null ? 'Beginn' : datumText(f.gueltig_ab)}`;

// ------------------------------------------------------------------ Stammdaten ändern (§5.4, V4)

export const KNOPF_STAMMDATEN = 'Stammdaten ändern';
export const STAMMDATEN_SUB = `Name, ${UEMS_ZWECK} und ${UEMS_VERANTWORTLICH} ändern weder die ${UEMS_BERECHNUNG} noch einen Wert — es entsteht keine neue ${UEMS_FASSUNG}. Die Änderung steht im Protokoll.`;
export const STAMMDATEN_FEST = `${UEMS_GELTUNGSBEREICH} und ${UEMS_RECHENFORM} bleiben, wie sie sind.`;
export const NAME = 'Name';
export const PFLICHT = 'Bitte ausfüllen.';

export type StammdatenEntwurf = { name: string; verantwortlich: string; zweck: string };

export const stammdatenEntwurf = (k: Kennzahl): StammdatenEntwurf => ({ name: k.name, verantwortlich: k.verantwortlich_name, zweck: k.zweck ?? '' });

/** Der Körper von `PUT …/{id}`: die GANZEN Stammdaten, das Kennzeichen unverändert. */
export const stammdatenAnfrage = (k: Kennzahl, e: StammdatenEntwurf) => ({
  kennzeichen: k.kennzeichen,
  name: e.name.trim(),
  verantwortlich_name: e.verantwortlich.trim(),
  zweck: e.zweck.trim() || null,
});

export const stammdatenGeaendert = (k: Kennzahl, e: StammdatenEntwurf): boolean => {
  const a = stammdatenAnfrage(k, e);
  return a.name !== k.name || a.verantwortlich_name !== k.verantwortlich_name || a.zweck !== (k.zweck ?? null);
};

export const stammdatenSpeicherbar = (k: Kennzahl, e: StammdatenEntwurf): boolean =>
  e.name.trim() !== '' && e.verantwortlich.trim() !== '' && stammdatenGeaendert(k, e);

// ------------------------------------------------------------------ Archivieren und Löschen (§5.7, V5)

export const KARTE_LEBENSZYKLUS = 'Archivieren und löschen';
export const KNOPF_ARCHIVIEREN = 'Archivieren';
export const ARCHIVIEREN_TITEL = `${UEMS_KENNZAHL} archivieren`;
export const ARCHIVIEREN_SATZ = `Eine archivierte ${UEMS_KENNZAHL} behält ihre Werte und Versionen — VoltPilot rechnet sie nicht mehr.`;
export const KNOPF_LOESCHEN = `${UEMS_KENNZAHL} löschen`;
export const LOESCHEN_BESTAETIGEN = 'Endgültig löschen';
export const LOESCHEN_SATZ = `Löschen geht nur, solange eine ${UEMS_KENNZAHL} keinen einzigen Wert hat.`;
export const AKTION_FEHLER = 'Das ist gerade nicht gelungen. Bitte versuchen Sie es noch einmal.';

/** Die zwei Ablehnungen des Löschens, Wort für Wort aus `kennzahl-vectors.json → schnittstelle.ablehnungen`. */
export const ABLEHNUNG_SATZ = {
  hat_werte: '{kennzahl} hat Werte — archivieren Sie sie.',
  wird_gelesen: '{kennzahl} wird von {leser} gelesen — archivieren Sie sie stattdessen.',
} as const;

const MUSTER_EINGANG_ARCHIVIERT = (KZ.KENNZEICHEN.find((x) => x.schluessel === 'eingang_archiviert') as KZ.Kennzeichen).muster;

/** „Eingang archiviert (KZ-0001)“ — das Kennzeichen des Vertrags (`ergebnis-zustand` 1.9, Rang 82). */
export const eingangArchiviert = (kennzeichen: string): string => MUSTER_EINGANG_ARCHIVIERT.replace('{objekt}', kennzeichen);

const liest = (f: KennzahlFassung, k: Pick<Kennzahl, 'kennzeichen'>): boolean =>
  f.eingaenge.some((e) => e.art === 'kennzahl' && e.kennzeichen === k.kennzeichen);

/** Nur eine Zusammenfassung liest Kennzahlen (E2) — deren Fassungen braucht die Seite, um Leser zu kennen. */
export const moeglicheLeser = (k: Pick<Kennzahl, 'id'>, liste: readonly Kennzahl[]): Kennzahl[] =>
  liste.filter((x) => x.id !== k.id && x.rechenform === KZ.ZUSAMMENFASSUNG);

/** Wer diese Kennzahl in IRGENDEINER Fassung liest — auch archiviert: so zählt es das Löschen (`wird_gelesen`). */
export const leserVon = (k: Kennzahl, liste: readonly Kennzahl[], fassungenJe: Readonly<Record<string, readonly KennzahlFassung[]>>): Kennzahl[] =>
  liste.filter((x) => x.id !== k.id && (fassungenJe[x.id] ?? []).some((f) => liest(f, k)));

/** Wer sie HEUTE rechnet — nicht archiviert, die geltende Fassung nennt sie; diese zeigen nach dem Archivieren das Kennzeichen. */
export const heutigeLeser = (k: Kennzahl, liste: readonly Kennzahl[], fassungenJe: Readonly<Record<string, readonly KennzahlFassung[]>>): Kennzahl[] =>
  liste.filter((x) => x.id !== k.id && x.archiviert_am === null && (fassungenJe[x.id] ?? []).some((f) => f.nummer === x.fassung && liest(f, k)));

export const archivierenIntro = (k: Kennzahl): string => `${k.kennzeichen} bleibt lesbar, wird aber nicht mehr gerechnet.`;

export const archivierenFolgen = (k: Kennzahl, leser: readonly Kennzahl[]): string[] => [
  'Alle Werte und Versionen bleiben lesbar.',
  'VoltPilot bildet keine neuen Werte mehr.',
  `${UEMS_BERECHNUNG} und Stammdaten lassen sich danach nicht mehr ändern.`,
  `In der Liste steht „${ARCHIVIERT}“; das Kennzeichen ${k.kennzeichen} wird nicht neu vergeben.`,
  ...leser.map((l) => `${l.kennzeichen} ${l.name} liest ${k.kennzeichen} und zeigt danach „${eingangArchiviert(k.kennzeichen)}“.`),
  `Zurückholen lässt sich eine archivierte ${UEMS_KENNZAHL} heute nicht.`,
];

/** „Archiviert am 20.03.2027 — …“ an der Seite einer archivierten Kennzahl. */
export const archiviertSatz = (k: Pick<Kennzahl, 'archiviert_am'>): string | null =>
  k.archiviert_am === null ? null : `Archiviert am ${datumText(k.archiviert_am.slice(0, 10))} — die Werte bleiben lesbar, VoltPilot rechnet sie nicht mehr.`;

export const loeschenFolgen = (k: Kennzahl): string[] => [
  `${k.kennzeichen} ${k.name} verschwindet aus der Liste.`,
  `Das Kennzeichen ${k.kennzeichen} wird nicht wieder vergeben.`,
];

/**
 * Warum „Löschen“ gesperrt ist — oder `null`. Mit Werten: „KZ-0001 hat Werte — archivieren Sie sie.“ (§5.7); gelesen
 * von einer anderen Kennzahl: der Satz von `wird_gelesen`. Eine schon archivierte Kennzahl bleibt archiviert. Kennt die
 * Seite die Leser nicht (`null`), entscheidet die Route und ihr Satz steht nach dem Versuch.
 */
export const loeschenSperre = (k: Kennzahl, leser: readonly Kennzahl[] | null): string | null => {
  const namen = (leser ?? []).map((l) => l.kennzeichen).join(', ');
  if (k.hat_werte) {
    return k.archiviert_am === null ? ABLEHNUNG_SATZ.hat_werte.replace('{kennzahl}', k.kennzeichen) : `${k.kennzeichen} hat Werte und bleibt archiviert.`;
  }
  if (namen === '') return null;
  return k.archiviert_am === null
    ? ABLEHNUNG_SATZ.wird_gelesen.replace('{kennzahl}', k.kennzeichen).replace('{leser}', namen)
    : `${k.kennzeichen} wird von ${namen} gelesen und bleibt archiviert.`;
};

/** An einer Kennzahl, deren geltende Fassung eine archivierte Kennzahl liest: je Eingang „Eingang archiviert (KZ-0001)“. */
export const archivierteEingaenge = (f: KennzahlFassung | null, liste: readonly Kennzahl[]): string[] =>
  f === null
    ? []
    : f.eingaenge
        .filter((e) => e.art === 'kennzahl' && liste.some((x) => x.kennzeichen === e.kennzeichen && x.archiviert_am !== null))
        .map((e) => eingangArchiviert(e.kennzeichen));
