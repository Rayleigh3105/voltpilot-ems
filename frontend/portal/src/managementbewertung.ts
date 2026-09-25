/**
 * UEMS AP-19 IP-24 (§5.5, MG1–MG7, R13, R14): das reine Bild der Managementbewertung im Energiemanagement. Die
 * Managementbewertung ist ein Bericht der VoltPilot-Vorlage `managementbewertung` (Nr. 7, AP-19 IP-22) am Unternehmen
 * für ein Jahr — Anlegen, Entwurf, Freigabe, Stände und PDF sind die Routen der Berichte (AP-12). **Hier wird nichts
 * entschieden:** jeder Abschnitt zitiert, was der Abzug festhält (Kennzeichen, Nr., Prüfsumme, das Ergebnis wie
 * festgehalten), nie ein neu gerechnetes Urteil (MG2); die Sätze kommen über die Schablonen von `energiemanagement.ts`.
 * Reines Modul: kein React, kein Netz.
 */
import { ApiError, type Bericht, type BerichtStandKurz, type Managementbewertung, type ManagementbewertungBeschluss, type ManagementbewertungFolge } from './api';
import { ablehnungSatz as dokumentAblehnung } from './energiemanagementPortal';
import { satz, SAETZE, WOERTER } from './energiemanagement';
import { UEMS_MASSNAHME_ERGEBNISSE, UEMS_MASSNAHME_ZUSTAENDE, UEMS_ENERGIEZIEL_ERGEBNISSE, UEMS_ENERGIEZIEL_ZUSTAENDE } from './glossar';
import { HERKUNFT_WORT } from './massnahmen';
import type { MassnahmeHerkunft } from './api';
import { MANAGEMENTBEWERTUNG } from './uemsBericht';

// ------------------------------------------------------------------ Wörter

export const KNOPF_MB_ANLEGEN = 'Managementbewertung anlegen';
export const KNOPF_MB_OEFFNEN = 'Öffnen';
export const KNOPF_PDF = 'PDF';
export const ZUR_LISTE = 'Alle Managementbewertungen';
export const STAENDE = 'Stände';
export const ENTWURF = 'Entwurf';
export const EINGABEN = 'Eingaben';
export const JAHR = 'Jahr';
export const KEIN_STAND = 'Noch kein Stand freigegeben — die Eingaben zeigen den Entwurf von heute.';
export const ANLEGEN_HINWEIS =
  'Die Managementbewertung sammelt die Eingaben des Jahres aus VoltPilot. Sitzung und Beschlüsse hält fest, wer das Energiemanagement bearbeitet; entschieden hat die Leitung.';
export const LADEFEHLER = 'Die Managementbewertung ließ sich gerade nicht laden. Bitte versuchen Sie es noch einmal.';
export const PDF_FEHLER = 'Das PDF ließ sich gerade nicht abrufen. Bitte versuchen Sie es noch einmal.';

/** Die zwölf Abschnitte der Vorlage (MG2), in ihrer Reihenfolge — dieselben Wörter wie im PDF (`BerichtPdf`). */
export const ABSCHNITTE: readonly { key: string; titel: string }[] = [
  { key: 'vorige_beschluesse', titel: 'Beschlüsse der letzten Managementbewertung und ihre Folgen' },
  { key: 'grundlagen', titel: 'Grundlagen' },
  { key: 'energieziele', titel: 'Energieziele' },
  { key: 'energieleistung', titel: 'Energieleistung' },
  { key: 'massnahmen', titel: 'Maßnahmen' },
  { key: 'abweichungen', titel: 'Abweichungen und Auffälligkeiten' },
  { key: 'audits_feststellungen', titel: 'Interne Audits und Feststellungen' },
  { key: 'bewertung_messplanung', titel: 'Energetische Bewertung und Messplanung' },
  { key: 'wiedervorlage', titel: 'Wiedervorlage zum Stichtag' },
  { key: 'beschluesse', titel: 'Beschlüsse' },
  { key: 'sitzung', titel: 'Sitzung' },
  { key: 'quellenverzeichnis', titel: 'Quellenverzeichnis' },
];

/** Die vier Grundlagen, die der Abschnitt nennt (`BerichtManagementbewertung.GRUNDLAGEN`). */
export const GRUNDLAGEN = ['energiepolitik', 'anwendungsbereich', 'rechtliche_anforderungen', 'risiken_chancen'] as const;

/** Die leeren Abschnitte — wie im PDF, ohne Urteil über das Fehlen. */
export const LEER: Record<string, string> = {
  energieziele: 'Kein Energieziel in diesem Jahr.',
  leistungsvergleiche: 'Kein Leistungsvergleich mit Stand.',
  bezugsbasen: 'Keine Bezugsbasis mit Überprüfung.',
  massnahmen: 'Keine Maßnahme festgehalten.',
  abweichungen: 'Keine Abweichung in diesem Jahr.',
  auffaelligkeiten: 'Keine Auffälligkeit in diesem Jahr.',
  audits: 'Kein internes Audit festgehalten.',
  feststellungen: 'Keine Feststellung festgehalten.',
  bewertungen: 'Keine energetische Bewertung mit Stand.',
  messbedarfe: 'Kein Messbedarf festgehalten.',
  beschluesse: 'Noch kein Beschluss festgehalten.',
  sitzung: 'Noch keine Sitzung festgehalten.',
};

const ZUSTAND: Record<string, string> = {
  ...UEMS_ENERGIEZIEL_ZUSTAENDE,
  ...UEMS_MASSNAHME_ZUSTAENDE,
  entwurf: 'Entwurf',
  gueltig: 'gültig',
  aufgehoben: 'aufgehoben',
  geplant: 'geplant',
  durchgefuehrt: 'durchgeführt',
  abgeschlossen: 'abgeschlossen',
  abgesagt: 'abgesagt',
  offen: 'offen',
  eingeloest: 'eingelöst',
  laufend: 'laufend',
  beendet: 'beendet',
  freigegeben: 'freigegeben',
  abgeloest: 'abgelöst',
  beantragt: 'Freigabe beantragt',
  abgelehnt: 'abgelehnt',
  beantwortet: 'beantwortet',
  verworfen: 'verworfen',
};
const ERGEBNIS: Record<string, string> = {
  ...UEMS_ENERGIEZIEL_ERGEBNISSE,
  ...UEMS_MASSNAHME_ERGEBNISSE,
  wirksam: 'wirksam',
  nicht_wirksam: 'nicht wirksam',
  erklaert: 'erklärt',
  keine_abweichung: 'keine Abweichung',
  massnahme: 'Maßnahme',
  zurueckgenommen: 'zurückgenommen',
  ohne_massnahme: 'ohne Maßnahme abgeschlossen',
  besser: 'besser',
  schlechter: 'schlechter',
  im_band: 'im Band',
  zur_kenntnis: 'zur Kenntnis genommen',
};
const QUELLE: Record<string, string> = {
  internes_audit: 'aus einem internen Audit',
  eigene: 'selbst festgestellt',
  extern: 'von außen',
  managementbewertung: 'aus einer Managementbewertung',
};
/** Das Kundenwort eines Vertragsworts; ein unbekanntes Wort bleibt, wie es kommt (lieber ehrlich als leer). */
export const zustandWort = (w: string | null | undefined) => (w ? (ZUSTAND[w] ?? w.replace(/_/g, ' ')) : '—');
export const ergebnisWort = (w: string | null | undefined) => (w ? (ERGEBNIS[w] ?? w.replace(/_/g, ' ')) : '—');
export const quelleWort = (w: string) => QUELLE[w] ?? w.replace(/_/g, ' ');
export const herkunftWort = (art: string, kennung: string | null) =>
  [HERKUNFT_WORT[art as MassnahmeHerkunft] ?? art.replace(/_/g, ' '), kennung].filter(Boolean).join(' ');
export const aufgabeWort = (a: string) => WOERTER.aufgabe[a] ?? a;

// ------------------------------------------------------------------ Sitzung, Beschlüsse, Folgen (IP-23, MG4–MG6)

export const KNOPF_SITZUNG = 'Sitzung festhalten';
export const KNOPF_SITZUNG_AENDERN = 'Sitzung ändern';
export const KNOPF_BESCHLUSS = 'Beschluss festhalten';
export const KNOPF_BESCHLUSS_AENDERN = 'Beschluss ändern';
export const KNOPF_FOLGE = 'Folge verknüpfen';
export const KNOPF_FREIGEBEN = 'Als Stand Nr. 1 freigeben';
export const FOLGEN = 'Folgen';
export const SITZUNG_UND_BESCHLUESSE = 'Sitzung und Beschlüsse der Leitung';
export const SITZUNG = 'Sitzung';
export const BESCHLUESSE = 'Beschlüsse';
export const TEILNEHMENDE = 'Teilnehmende';
export const LEITUNG = 'Leitung';
export const TAG_DER_SITZUNG = 'Tag der Sitzung';
export const ORT = 'Ort (wahlfrei)';
export const ART = 'Art';
export const WORTLAUT = 'Wortlaut';
export const ENTSCHIEDEN_VON = 'Entschieden von';
export const ZUSTAENDIG = 'Zuständig (wahlfrei)';
export const TERMIN = 'Termin (wahlfrei)';
export const OBJEKT = 'Was aus dem Beschluss entstanden ist';
export const WORTLAUT_HOECHSTENS = 2000;
export const LEER_FOLGE_OBJEKTE = 'Davon ist in VoltPilot noch nichts festgehalten.';
/** MG4/MG5: die Freigabe verlangt Sitzung, Leitung und einen Beschluss — die Route entscheidet (`sitzung_fehlt` …). */
export const FREIGABE_VORAUSSETZUNG = 'Freigeben lässt sich, sobald die Sitzung mit der Leitung und mindestens ein Beschluss festgehalten sind.';
export const SITZUNG_HINWEIS =
  'Die Leitung ist die Person, die am Tag der Sitzung die Aufgabe ‚Leitung des Unternehmens‘ hat — auch ohne Konto. VoltPilot hält fest, was die Leitung entschieden hat.';
export const BESCHLUSS_HINWEIS = 'Ein Beschluss ist eine Entscheidung der Leitung in dieser Sitzung; auch „bleibt, wie es ist“ ist ein Beschluss.';
export const FOLGE_HINWEIS =
  'Eine Folge verknüpft den Beschluss mit dem, was daraus entstanden ist; der Stand ändert sich dadurch nicht. Eine Maßnahme verknüpft sich selbst, wenn Sie sie mit dieser Herkunft anlegen.';
export const LEITUNG_GILT_NICHT =
  'Diese Person hat am Tag der Sitzung nicht die Aufgabe ‚Leitung des Unternehmens‘ — ordnen Sie die Leitung unter „Aufgaben“ zu, sonst lässt sich nicht freigeben.';

/** MG5: die Art eines Beschlusses als Kundenwort. */
export const BESCHLUSS_ART_WORT: Record<string, string> = {
  energieziel: 'Energieziel',
  massnahme: 'Maßnahme',
  dokument: 'Dokument',
  aufgabe: 'Aufgabe',
  ressourcen: 'Ressourcen',
  audit: 'Internes Audit',
  keine_aenderung: 'bleibt, wie es ist',
  weitere: 'weitere Entscheidung',
};
/** MG6: was eine Folge sein kann — die Maßnahme legt man mit Herkunft an, alles andere wird verknüpft. */
export const FOLGE_ART_WORT: Record<string, string> = {
  energieziel: 'Energieziel',
  massnahme: 'Maßnahme',
  dokument: 'Dokument-Fassung',
  aufgabe: 'Aufgabe',
  audit: 'Internes Audit',
};
export const FOLGE_VERKNUEPFBAR = ['energieziel', 'dokument', 'aufgabe', 'audit'] as const;
/** Wie die Folge zum Beschluss kam — von Hand verknüpft oder am Objekt mit der Kennung des Beschlusses festgehalten. */
export const FOLGE_WIE_WORT: Record<string, string> = {
  von_hand: 'verknüpft',
  herkunft: 'mit dieser Herkunft angelegt',
  zuordnung: 'mit diesem Beschluss zugeordnet',
  fassung: 'mit diesem Beschluss freigegeben',
  geprueft_bleibt: 'geprüft, bleibt — mit diesem Beschluss',
};

/** §5.8 „Beschluss“: „Beschluss 3 — entschieden von Robert Falk, eingetragen von Ines Kaltenbach: …“. */
export function beschlussSatz(b: Pick<ManagementbewertungBeschluss, 'nr' | 'entschieden_von' | 'eingetragen_von' | 'wortlaut'>): string {
  return (
    satz('beschluss', {
      nr: String(b.nr),
      entschieden_von: b.entschieden_von.name ?? '—',
      eingetragen_von: b.eingetragen_von ?? '—',
      wortlaut: b.wortlaut,
    }).satz ?? `Beschluss ${b.nr}: ${b.wortlaut}`
  );
}

/** Art, zuständig und Termin eines Beschlusses: „Dokument · zuständig Ines Kaltenbach · Termin 31.03.2029“. */
export const beschlussAngaben = (b: Pick<ManagementbewertungBeschluss, 'art' | 'zustaendig' | 'termin'>) =>
  [BESCHLUSS_ART_WORT[b.art] ?? b.art, b.zustaendig?.name ? `zuständig ${b.zustaendig.name}` : null, b.termin ? `Termin ${tag(b.termin)}` : null]
    .filter(Boolean)
    .join(' · ');

/** Die Sitzung als Satz: „Sitzung am 12.02.2029 · Leitung Robert Falk · Teilnehmende … · Werk Ahrenberg, Besprechungsraum“. */
export function sitzungSatz(s: NonNullable<Managementbewertung['sitzung']>): string {
  const teil = s.teilnehmende.map((p) => p.name).filter(Boolean);
  return [`Sitzung am ${tag(s.tag)}`, `Leitung ${s.leitung.name ?? '—'}`, teil.length ? `Teilnehmende ${teil.join(', ')}` : null, s.ort || null]
    .filter(Boolean)
    .join(' · ');
}

/** Eine Folge: „Dokument-Fassung D-0001/2 · freigegeben · mit diesem Beschluss freigegeben am 20.03.2029“. */
export function folgeZeile(f: ManagementbewertungFolge): string {
  const wie = FOLGE_WIE_WORT[f.wie] ?? f.wie;
  const wann = f.wie === 'von_hand' ? f.verknuepft_am : f.tag;
  return [
    `${FOLGE_ART_WORT[f.art] ?? f.art} ${f.objekt}`,
    f.angabe || null,
    zustandWort(f.zustand),
    `${wie}${wann ? ` am ${tag(wann)}` : ''}${f.wie === 'von_hand' && f.eingetragen_von ? ` von ${f.eingetragen_von}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Die Ablehnungen der Routen von IP-23 sprechen ihren eigenen Satz (Tag, Person, Kennung des Beschlusses) — er wird nie
 * durch einen Satz der Dokument-Freigabe mit demselben Code ersetzt (`leitung_fehlt` heißt dort etwas anderes).
 */
const EIGENER_SATZ = [
  'sitzung_fehlt', 'leitung_fehlt', 'beschluss_fehlt', 'managementbewertung_freigegeben', 'managementbewertung_nicht_freigegeben',
  'folge_art', 'objekt_unbekannt', 'tag_in_der_zukunft', 'person_unbekannt', 'nicht_gefunden',
];
export function ablehnungSatz(e: unknown): string {
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { code?: unknown; message?: unknown }) : null;
  if (body && typeof body.code === 'string' && EIGENER_SATZ.includes(body.code) && typeof body.message === 'string' && body.message) return body.message;
  return dokumentAblehnung(e);
}

/** Freigeben erst mit Sitzung, Leitung am Tag und einem Beschluss — so sieht es die Seite, entscheiden tut die Route. */
export const freigabeBereit = (mb: Managementbewertung | null) =>
  !!mb && !!mb.sitzung && mb.sitzung.leitung_gilt && mb.beschluesse.length > 0;

/**
 * MG7 „nächste fällig“: die Frist rechnet die Wiedervorlage (letzte Sitzung + Rhythmus der Einstellung) — hier wird sie nur
 * gelesen. Steht sie im Fenster, mit Tag und Satz; liegt sie später, sagt die Route nur, DASS es eine gibt.
 */
export function naechsteSatz(
  w: { faellig: { art: string; kennzeichen: string; faellig_am: string; satz: string }[]; vorschau: { art: string; kennzeichen: string; faellig_am: string; satz: string }[]; nicht_in_liste: string[]; vorschau_tage: number } | null,
  liste: readonly Pick<Bericht, 'kennung' | 'neueste_nr'>[],
): string {
  const zeile = w ? [...w.faellig, ...w.vorschau].find((z) => z.art === 'managementbewertung') : undefined;
  if (zeile) return `Nächste Managementbewertung fällig am ${tag(zeile.faellig_am)} — ${zeile.satz} (aus der Sitzung von ${zeile.kennzeichen}).`;
  const spaeter = w ? liste.find((b) => b.neueste_nr && w.nicht_in_liste.includes(b.kennung)) : undefined;
  if (spaeter && w) return `Nächste Managementbewertung: nicht in den nächsten ${w.vorschau_tage} Tagen fällig (aus der Sitzung von ${spaeter.kennung}).`;
  return 'Ohne freigegebene Managementbewertung mit Sitzung nennt VoltPilot keine nächste.';
}

// ------------------------------------------------------------------ Zahlen und Tage

/** „2028-02-12“ → „12.02.2028“; ein Zeitpunkt wird auf seinen Tag gekürzt. */
export const tag = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '—');

/** Ein Zeitpunkt in der Zone des Berichts: „12.02.2029, 14:10“. */
export function zeitpunkt(iso: string, zone: string): string {
  const d = new Date(iso);
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat('de-DE', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${teile.day}.${teile.month}.${teile.year}, ${teile.hour}:${teile.minute}`;
}

/** „−2,7“ → „2,7 % weniger“, „12,9“ → „12,9 % mehr“ — die Zahl wie festgehalten, mit ihrer Richtung. */
export function prozent(wert: number | null | undefined): string {
  if (wert === null || wert === undefined) return '—';
  const betrag = Math.abs(wert).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return wert === 0 ? '0,0 %' : `${betrag} % ${wert < 0 ? 'weniger' : 'mehr'}`;
}

/** Prüfsumme gekürzt: „sha256:3f1f…9b9b“ → „3f1f…9b9b“ (die ganze steht im `title`). */
export const pruefsummeKurz = (p: string | null | undefined) => {
  if (!p) return '—';
  const s = p.startsWith('sha256:') ? p.slice(7) : p;
  return s.length <= 9 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
};

// ------------------------------------------------------------------ Die Liste je Jahr (MG1)

/** Die Managementbewertungen, die das Konto lesen darf — je Jahr, das jüngste zuerst; archivierte fallen weg. */
export function managementbewertungen(berichte: readonly Bericht[] | null | undefined): Bericht[] {
  return (berichte ?? [])
    .filter((b) => b.vorlage === MANAGEMENTBEWERTUNG && b.archiviert_am === null)
    .sort((a, b) => b.zeitraum.localeCompare(a.zeitraum) || b.kennung.localeCompare(a.kennung));
}

/** Der Zustand einer Managementbewertung in der Liste: „Stand Nr. 1“ oder „Entwurf“ (MG7). */
export const listenZustand = (b: Pick<Bericht, 'neueste_nr'>) => (b.neueste_nr ? `Stand Nr. ${b.neueste_nr}` : ENTWURF);

/** Die Jahre zur Wahl beim Anlegen: das Vorjahr zuerst (vorgewählt), dann das laufende und die davor. */
export function jahreZurWahl(heute: string, anzahl = 5): { id: string; label: string }[] {
  const jahr = Number(heute.slice(0, 4));
  const jahre = [jahr - 1, jahr, ...Array.from({ length: anzahl - 2 }, (_, n) => jahr - 2 - n)];
  return jahre.map((j) => ({ id: String(j), label: j === jahr ? `${j} (läuft)` : String(j) }));
}

// ------------------------------------------------------------------ Kopf und Stand (§5.8)

/** Der gültige Stand: der jüngste, den keiner ersetzt hat. */
export const gueltigerStand = (staende: readonly BerichtStandKurz[]) =>
  [...staende].filter((s) => s.ersetzt_durch_nr === null).sort((a, b) => b.nr - a.nr)[0] ?? null;

export type Sitzung = { tag: string; leitung: string };

/**
 * Der Kopf (§5.8 „Managementbewertung, Kopf“): mit Sitzung und Stand der Satz des Vertrags, sonst „Managementbewertung
 * 2028 · Entwurf“ — nichts wird erfunden, was noch nicht festgehalten ist.
 */
export function kopfSatz(jahr: string, sitzung: Sitzung | null, stand: Pick<BerichtStandKurz, 'nr' | 'freigegeben_am'> | null, zone: string): string {
  if (sitzung && stand) {
    const r = satz('managementbewertung_kopf', {
      jahr,
      sitzung: tag(sitzung.tag),
      leitung: sitzung.leitung,
      nr: String(stand.nr),
      stand_vom: zeitpunkt(stand.freigegeben_am, zone),
    });
    if (r.satz) return r.satz;
  }
  const teile = [`Managementbewertung ${jahr}`];
  if (sitzung) teile.push(`Sitzung am ${tag(sitzung.tag)}`, `Leitung ${sitzung.leitung}`);
  teile.push(stand ? `Stand Nr. ${stand.nr} vom ${zeitpunkt(stand.freigegeben_am, zone)}, mit Prüfsumme` : ENTWURF);
  return `${teile.join(' · ')}.`;
}

/** §5.8 „Stand seines Tages“: „Dieser Stand zeigt die Eingaben vom 12.02.2029, 14:00. …“ */
export const standSeinesTages = (datenstand: string, zone: string) =>
  satz('stand_seines_tages', { datenstand: zeitpunkt(datenstand, zone) }).satz ?? '';

/** Die Zeile eines Stands: „Stand Nr. 1 · freigegeben am 12.02.2029, 14:10 von Ines Kaltenbach“. */
export const standZeile = (s: Pick<BerichtStandKurz, 'nr' | 'freigegeben_am' | 'freigegeben_von' | 'ersetzt_durch_nr'>, zone: string) =>
  `Stand Nr. ${s.nr} · freigegeben am ${zeitpunkt(s.freigegeben_am, zone)} von ${s.freigegeben_von.name}${s.ersetzt_durch_nr ? ` · ersetzt durch Nr. ${s.ersetzt_durch_nr}` : ''}`;

/** Die Zeile des Entwurfs: „Entwurf — Eingaben am 12.02.2029, 14:00“. */
export const entwurfZeile = (datenstand: string, zone: string) => `${ENTWURF} — Eingaben am ${zeitpunkt(datenstand, zone)}`;

export const KEINE_VORIGE = SAETZE.managementbewertung_erste;

// ------------------------------------------------------------------ Der Abzug (IP-22, `BerichtManagementbewertung`)

export type Frist = { faellig_am: string; satz: string } | null;
export type MbDokument = {
  dokument: string; titel: string; zustand: string; fassung: number | null; pruefsumme: string | null;
  entschieden_am: string | null; freigegeben_am: string | null; entschieden_von: string | null;
  form?: string; ablage?: string | null; fassungsangabe?: string | null; ueberpruefung: Frist;
};
export type MbAbzug = {
  kopf?: { stichtag?: string; datenstand?: string };
  vorige_beschluesse?: {
    managementbewertung: { kennung: string; zeitraum: string; stand_nr: number; pruefsumme: string; freigegeben_am: string | null } | null;
    satz: string | null;
    beschluesse: {
      nr: number; kennung: string; art: string; wortlaut: string; entschieden_von: string | null;
      folgen: ManagementbewertungFolge[]; satz: string | null;
    }[];
  };
  grundlagen?: Record<string, string | MbDokument[] | { laufend: number; ohne_person: string[] }>;
  energieziele?: {
    kennzeichen: string; zielwert_prozent: number; zielperiode: string; zustand: string; ergebnis: string | null;
    bewertet_am: string | null; person: string | null; pruefsumme: string | null; stand: { delta_prozent: number | null; monate: string } | null;
  }[];
  energieleistung?: {
    leistungsvergleiche: {
      kennung: string; zeitraum: string; stand: number; freigegeben_am: string | null; delta_prozent: number | null;
      urteil: string | null; pruefsumme: string; anstoesse_offen: { anlass: string; erkannt_am: string | null }[];
    }[];
    bezugsbasen: { kennzeichen: string; titel: string; ueberpruefung: Frist }[];
  };
  massnahmen?: {
    kennzeichen: string; titel: string; herkunft_art: string; herkunft_kennung: string | null; zustand: string;
    termin: string | null; umgesetzt_am: string | null;
    bewertung: { stand: number; ergebnis: string; am: string | null; wirkung_prozent: number | null; monate_bewertbar: number | null; erwartet_prozent: number | null; pruefsumme: string | null } | null;
  }[];
  abweichungen?: {
    im_jahr: { kennzeichen: string; monate: string[]; zustand: string; ergebnis: string | null; abgeschlossen_am: string | null; massnahme: string | null }[];
    auffaelligkeiten: { kennzahl: string; monat: string; zustand: string; antwort: string | null; am: string | null }[];
    offen: number;
  };
  audits_feststellungen?: {
    audits: { kennzeichen: string; titel: string; termin: string; zustand: string; durchgefuehrt_am: string | null; abgeschlossen_am: string | null; pruefsumme: string | null }[];
    feststellungen: { kennzeichen: string; quelle: string; festgestellt_am: string; frist: string; zustand: string; wirksamkeit: { stand: number; ergebnis: string; pruefsumme: string | null } | null }[];
    offen: number;
  };
  bewertung_messplanung?: {
    bewertungen: { kennung: string; zeitraum: string; stand: number; freigegeben_am: string | null; pruefsumme: string; ueberpruefung: Frist }[];
    messbedarfe: { kennzeichen: string; zustand: string; frist: string | null }[];
    messbedarfe_offen: number;
  };
  wiedervorlage?: {
    stichtag: string; vorschau_tage: number; anzahl_faellig: number; anzahl_vorschau: number;
    faellig: { art: string; kennzeichen: string; titel: string; faellig_am: string; satz: string }[];
    vorschau: { art: string; kennzeichen: string; titel: string; faellig_am: string; satz: string }[];
  };
  beschluesse?: Record<string, unknown>[];
  sitzung?: Record<string, unknown> | null;
  quellenverzeichnis?: { art: string; kennzeichen: string; name_zum_datenstand: string | null; bezug: string; version: number | null; fassung: number | null }[];
};

/** Der Abzug in seiner Form — alles Unbekannte bleibt draußen, nichts wird geraten. */
export const abzug = (roh: unknown): MbAbzug => (roh && typeof roh === 'object' ? (roh as MbAbzug) : {});

/** Die Dokumente einer Grundlage — oder der Satz „Hier ist noch nichts festgehalten.“, wie der Abzug ihn trägt. */
export function grundlage(a: MbAbzug, art: string): { dokumente: MbDokument[]; satz: string | null } {
  const g = a.grundlagen?.[art];
  if (typeof g === 'string') return { dokumente: [], satz: g };
  return { dokumente: Array.isArray(g) ? g : [], satz: Array.isArray(g) && g.length ? null : SAETZE.verzeichnis_leer };
}

/** „Aufgaben im Energiemanagement: 10 laufende Zuordnungen; keine Person festgelegt für …“ (die Wörter des Vokabulars). */
export function aufgabenSatz(a: MbAbzug): string | null {
  const g = a.grundlagen?.aufgaben;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const { laufend, ohne_person } = g as { laufend: number; ohne_person: string[] };
  const zahl = laufend === 1 ? '1 laufende Zuordnung' : `${laufend} laufende Zuordnungen`;
  return ohne_person.length
    ? `Aufgaben im Energiemanagement: ${zahl}; keine Person festgelegt für ${ohne_person.map(aufgabeWort).join(', ')}.`
    : `Aufgaben im Energiemanagement: ${zahl}.`;
}

/** Der Dokument-Satz einer Grundlage: „D-0001 · Fassung 1 · entschieden von Robert Falk am 15.12.2026“. */
export function dokumentZeile(d: MbDokument): string {
  if (d.fassung === null) return `${d.dokument} · keine freigegebene Fassung`;
  const von = d.entschieden_von ? ` · entschieden von ${d.entschieden_von}${d.entschieden_am ? ` am ${tag(d.entschieden_am)}` : ''}` : '';
  return `${d.dokument} · Fassung ${d.fassung}${von}`;
}

/** Die Frist wie festgehalten: „Überprüfung seit 64 Tagen fällig (10.12.2028)“ — ohne Frist nichts. */
export const fristZeile = (f: Frist, was = 'Überprüfung') => (f ? `${was} ${f.satz} (${tag(f.faellig_am)})` : null);

/** Energieziel, Ergebnis wie festgehalten: „verfehlt · 2,7 % weniger in 11 von 12 Monaten · festgehalten am … von …“. */
export function energiezielErgebnis(e: NonNullable<MbAbzug['energieziele']>[number]): string {
  const teile: string[] = [];
  if (e.ergebnis) teile.push(ergebnisWort(e.ergebnis));
  if (e.stand) teile.push(`${prozent(e.stand.delta_prozent)} in ${e.stand.monate} Monaten`);
  if (e.bewertet_am) teile.push(`festgehalten am ${tag(e.bewertet_am)}${e.person ? ` von ${e.person}` : ''}`);
  return teile.length ? teile.join(' · ') : 'noch ohne Ergebnis';
}

/** Maßnahme, Stand wie festgehalten: „Stand Nr. 1 · belegt · 2,4 % weniger“ — ohne Stand der Termin. */
export function massnahmeStand(m: NonNullable<MbAbzug['massnahmen']>[number]): string {
  if (m.bewertung) {
    const b = m.bewertung;
    return [`Stand Nr. ${b.stand}`, ergebnisWort(b.ergebnis), b.wirkung_prozent !== null ? prozent(b.wirkung_prozent) : null, b.am ? `am ${tag(b.am)}` : null]
      .filter(Boolean)
      .join(' · ');
  }
  if (m.umgesetzt_am) return `umgesetzt am ${tag(m.umgesetzt_am)}`;
  return m.termin ? `Termin ${tag(m.termin)}` : '—';
}

/** Leistungsvergleich wie festgehalten: „12,9 % mehr als erwartet · Urteil: schlechter“. */
export function leistungsvergleichZeile(v: NonNullable<MbAbzug['energieleistung']>['leistungsvergleiche'][number]): string {
  const teile = [v.delta_prozent !== null ? `${prozent(v.delta_prozent)} als erwartet` : null, v.urteil ? `Urteil wie festgehalten: ${ergebnisWort(v.urteil)}` : null];
  return teile.filter(Boolean).join(' · ') || '—';
}

/** Die Zahl offener Dinge als Satz ohne Urteil: „keine offene Abweichung“, „1 offene Feststellung“. */
export const offenSatz = (n: number, einzahl: string, mehrzahl: string) =>
  n === 0 ? `keine offene ${einzahl}` : n === 1 ? `1 offene ${einzahl}` : `${n} offene ${mehrzahl}`;
