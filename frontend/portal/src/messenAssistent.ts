import {
  deviceLiveStatus,
  type Device,
  type Funktionen,
  type FunktionStandort,
  type Messstelle,
  type MessstelleOrtAendern,
  type MessstelleRegisterZeile,
  type MessstelleVorschlag,
  type MessstelleVorschlagsliste,
  type MessstelleVorschlagUebernehmen,
  type MessstelleVorschlagUebernommen,
  type OrtsbaumAmStichtag,
  type StandortAmStichtag,
  type StandorteAmStichtag,
} from './api';
import { fortschritt } from './anlegenFlow';
import { UEMS_HAUPTZAEHLER, UEMS_UNTERZAEHLER_VON } from './glossar';
import { ortWahlen, type OrtWahl } from './messstelleDialog';
import { FUNKTIONEN } from './uemsFunktion';

/**
 * Der Assistent „Messen & Auswerten" je Standort — der RAHMEN (UEMS AP-01
 * IP-9a, Konzept §5.2): die Schrittleiste Standort · Datenquelle · Messstellen ·
 * Prüfen · Fertig, „Schritt n von 5", ein Entwurf, der einen Abbruch überlebt,
 * und der Wiedereinstieg auf dem richtigen Schritt. Rein — die Fläche
 * `components/MessenAssistent.tsx` rendert nur.
 *
 * Die Schritte 3 bis 5 kamen mit IP-9b. Der Rahmen betritt nur die GEBAUTEN
 * Schritte: {@link vor} führt nie in einen Schritt, den keine Fläche trägt
 * (eine Bühne kann mit `gebaut` weniger tragen).
 *
 * ⚠ Wo der Assistent steht, entscheidet zuerst der SERVER: kennt `GET
 * /funktionen` „Messen & Auswerten" am Standort (Zustand ≠ kein_objekt), ist
 * Schritt 1 erledigt, egal was im Browser liegt. Der Entwurf im Browser merkt
 * sich nur, WELCHER Standort gewählt war und wie weit der Kunde danach war.
 */

export const MESSEN_SCHRITTE = ['Standort', 'Datenquelle', 'Messstellen', 'Prüfen', 'Fertig'] as const;

export type MessenSchritt = 1 | 2 | 3 | 4 | 5;

export const MESSEN_TITEL = `${FUNKTIONEN.messen} einrichten`;

/**
 * Der Titel am Telefon: dort teilt er die Kopfzeile mit Zurück-Pfeil und Kreuz,
 * und „Messen & Auswerten einrichten" wurde bei 375 px zu „Messen & Auswerten
 * ein…" gekürzt. Die Funktion allein passt; dass eingerichtet wird, sagen Zähler
 * und Frage darunter (Variante B; Variante A — Titel umbrechen — hätte die
 * gemeinsame Kopf-CSS des Anlege-Dialogs geändert, nur als Foto gezeigt).
 */
export const MESSEN_TITEL_KURZ = FUNKTIONEN.messen;

/** Die Schritte, die eine Fläche heute trägt — IP-9a: Standort und Datenquelle, IP-9b: Messstellen, Prüfen, Fertig. */
export const GEBAUTE_SCHRITTE: readonly MessenSchritt[] = [1, 2, 3, 4, 5];

// ─────────────────────────────────────────────────────────────── Schrittfolge

/** „Schritt 2 von 5" — derselbe Zähler wie im Anlege-Dialog (`anlegenFlow.fortschritt`). */
export function schrittZaehler(schritt: MessenSchritt): string {
  return fortschritt([...MESSEN_SCHRITTE], schritt);
}

/** Der nächste Schritt — `null`, wenn es keinen gibt oder ihn noch keine Fläche trägt. */
export function vor(schritt: MessenSchritt, gebaut: readonly MessenSchritt[] = GEBAUTE_SCHRITTE): MessenSchritt | null {
  const n = schritt + 1;
  return n <= MESSEN_SCHRITTE.length && gebaut.includes(n as MessenSchritt) ? (n as MessenSchritt) : null;
}

/** Der vorige Schritt — `null` auf Schritt 1. */
export function zurueck(schritt: MessenSchritt): MessenSchritt | null {
  return schritt > 1 ? ((schritt - 1) as MessenSchritt) : null;
}

/** Der weiteste Schritt, der von Schritt 1 aus ohne Lücke erreichbar ist. */
export function weitesterSchritt(gebaut: readonly MessenSchritt[] = GEBAUTE_SCHRITTE): MessenSchritt {
  let s: MessenSchritt = 1;
  for (let n = vor(s, gebaut); n !== null; n = vor(s, gebaut)) s = n;
  return s;
}

// ────────────────────────────────────────────────────────── Entwurf im Browser

export const ENTWURF_SCHLUESSEL = 'vp.uems.messen-assistent.entwurf.v1';

/** Was ein Abbruch bewahrt: der gewählte Standort und der Schritt, auf dem der Kunde stand. */
export interface MessenEntwurf {
  standortId: string | null;
  schritt: MessenSchritt;
}

export type EntwurfSpeicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Der Speicher des Browsers — `null`, wo es keinen gibt oder er gesperrt ist. */
export function browserSpeicher(): EntwurfSpeicher | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Liest den Entwurf; ein fehlender, fremder oder kaputter Eintrag ist `null`, nie ein Fehler. */
export function entwurfLesen(speicher: EntwurfSpeicher | null): MessenEntwurf | null {
  if (!speicher) return null;
  try {
    const roh = speicher.getItem(ENTWURF_SCHLUESSEL);
    if (!roh) return null;
    const e = JSON.parse(roh) as { standortId?: unknown; schritt?: unknown } | null;
    if (!e || typeof e.schritt !== 'number' || !Number.isInteger(e.schritt)) return null;
    if (e.schritt < 1 || e.schritt > MESSEN_SCHRITTE.length) return null;
    if (e.standortId !== null && typeof e.standortId !== 'string') return null;
    return { standortId: e.standortId, schritt: e.schritt as MessenSchritt };
  } catch {
    return null;
  }
}

/** Schreibt den Entwurf. Ohne Speicher bleibt, was der Server weiß — nie ein Fehler. */
export function entwurfSchreiben(speicher: EntwurfSpeicher | null, entwurf: MessenEntwurf): void {
  try {
    speicher?.setItem(ENTWURF_SCHLUESSEL, JSON.stringify(entwurf));
  } catch {
    // Gesperrter Speicher: der Wiedereinstieg fällt auf den Stand des Servers zurück.
  }
}

export function entwurfVerwerfen(speicher: EntwurfSpeicher | null): void {
  try {
    speicher?.removeItem(ENTWURF_SCHLUESSEL);
  } catch {
    // wie oben
  }
}

// ──────────────────────────────────────────────────────── Start und Wiedereinstieg

/** Wo der Assistent beginnt: der vorgewählte Standort und der Schritt. */
export interface MessenStart {
  standortId: string | null;
  schritt: MessenSchritt;
}

/** Der Schritt nach dem Einrichten: gemerkt, wenn der Entwurf zu diesem Standort gehört, sonst 2. */
function schrittNachEinrichten(
  standortId: string,
  entwurf: MessenEntwurf | null,
  gebaut: readonly MessenSchritt[],
): MessenSchritt {
  const gemerkt = entwurf?.standortId === standortId ? entwurf.schritt : 2;
  return Math.min(Math.max(gemerkt, 2), weitesterSchritt(gebaut)) as MessenSchritt;
}

/**
 * Wo der Assistent beginnt. `standortId` ist der Standort, aus dessen Zeile er
 * geöffnet wurde (ohne: der des Entwurfs).
 *
 * - kein Standort, oder einer, den `GET /funktionen` nicht (mehr) nennt → Schritt 1, ohne Vorwahl
 * - die Funktionen sind nicht abrufbar → Schritt 1 mit Vorwahl (Schritt 1 fragt beim Weitergehen den Server)
 * - „Messen & Auswerten" hat am Standort noch kein Objekt → Schritt 1 mit Vorwahl
 * - es gibt die Funktion → der gemerkte Schritt dieses Standorts, mindestens 2, höchstens der weiteste gebaute
 *
 * `wunsch` ist die Stelle, auf die ein Einstieg zeigt (der Satz „Daten kommen an“ → Schritt 2). Er gilt nur, wo
 * die Funktion schon besteht: ohne Objekt beginnt jeder Einstieg bei Schritt 1 — der Server entscheidet vor dem Knopf.
 */
export function startSchritt({
  standortId,
  funktionen,
  entwurf,
  gebaut = GEBAUTE_SCHRITTE,
  wunsch = null,
}: {
  standortId?: string | null;
  funktionen: Funktionen | null;
  entwurf: MessenEntwurf | null;
  gebaut?: readonly MessenSchritt[];
  wunsch?: MessenSchritt | null;
}): MessenStart {
  const id = standortId ?? entwurf?.standortId ?? null;
  if (!id) return { standortId: null, schritt: 1 };
  if (!funktionen) return { standortId: id, schritt: 1 };
  const fs = funktionen.standorte.find((s) => s.id === id);
  if (!fs || fs.messen.zustand === 'archiviert') return { standortId: null, schritt: 1 };
  if (fs.messen.zustand === 'kein_objekt') return { standortId: id, schritt: 1 };
  const schritt = wunsch
    ? (Math.min(Math.max(wunsch, 2), weitesterSchritt(gebaut)) as MessenSchritt)
    : schrittNachEinrichten(id, entwurf, gebaut);
  return { standortId: id, schritt };
}

/**
 * Der Einstieg aus der Karte „Funktionen" (Konzept §4.3/§5.5): „Messen &
 * Auswerten für Werk Lindach einrichten" ohne Objekt, „Einrichtung fortsetzen
 * (Schritt 2 von 5)" im Entwurf, sonst keiner. Die Fläche setzt ihn NICHT
 * selbst — die Karte aus IP-8 macht ihn zum Knopf ({@link messenEinstiegeDerKarte}).
 */
export function messenEinstieg(
  fs: FunktionStandort,
  entwurf: MessenEntwurf | null,
  gebaut: readonly MessenSchritt[] = GEBAUTE_SCHRITTE,
): { text: string; start: MessenStart } | null {
  if (fs.messen.zustand === 'kein_objekt') {
    return { text: `${FUNKTIONEN.messen} für ${fs.name} einrichten`, start: { standortId: fs.id, schritt: 1 } };
  }
  if (fs.messen.zustand !== 'entwurf') return null;
  const schritt = schrittNachEinrichten(fs.id, entwurf, gebaut);
  return { text: `Einrichtung fortsetzen (${schrittZaehler(schritt)})`, start: { standortId: fs.id, schritt } };
}

/**
 * Die Knöpfe der Karte „Funktionen“ (AP-01 E5 = A) je Standort. Ohne Anlage am Standort gibt es keinen: dort
 * nennt der Leerzustand der Standort-Übersicht den Schritt (wie `uebersicht.naechsterSchritt`), und Schritt 2
 * hätte nichts anzubinden. `null` = die Funktionen sind nicht abrufbar.
 */
export function messenEinstiegeDerKarte(
  funktionen: Funktionen | null,
  entwurf: MessenEntwurf | null,
  gebaut: readonly MessenSchritt[] = GEBAUTE_SCHRITTE,
): Map<string, { text: string; start: MessenStart }> {
  const einstiege = new Map<string, { text: string; start: MessenStart }>();
  for (const fs of funktionen?.standorte ?? []) {
    if (fs.steuern.anlagen.length === 0) continue;
    const e = messenEinstieg(fs, entwurf, gebaut);
    if (e) einstiege.set(fs.id, e);
  }
  return einstiege;
}

// ────────────────────────────────────────────────────────────── Schritt 1 · Standort

export const SCHRITT1_FRAGE = 'Wo wird gemessen?';
export const SCHRITT1_SATZ =
  'Wählen Sie den Standort oder legen Sie ihn an. Für ihn richten Sie Messen & Auswerten ein.';
export const STANDORT_ANLEGEN = 'Neuen Standort anlegen';
export const STANDORT_KEINER = 'Es gibt noch keinen Standort. Legen Sie ihn zuerst an.';
export const STANDORT_WAEHLEN = 'Bitte wählen Sie einen Standort.';

/**
 * Schritt 1 legt „Messen & Auswerten" nur an, wenn der Server es am Standort
 * nicht kennt. Unbekannt (`null`) heißt: fragen — ein 409 „bereits angelegt"
 * ist dann kein Fehler ({@link istBereitsAngelegt}).
 */
export function mussEinrichten(fs: FunktionStandort | null): boolean {
  return fs == null || fs.messen.zustand === 'kein_objekt';
}

/** Die Ablehnung `bereits_angelegt`: ein anderer Weg war schneller — die Funktion gibt es, es geht weiter. */
export function istBereitsAngelegt(e: unknown): boolean {
  const f = e as { status?: unknown; body?: { code?: unknown } | null } | null;
  return f?.status === 409 && f.body?.code === 'bereits_angelegt';
}

/** Der Satz unter der Wahl: der Zustand von „Messen & Auswerten" an diesem Standort, wie der Server ihn nennt. */
export function standortMessenSatz(fs: FunktionStandort | null): string | null {
  if (!fs) return null;
  const text = fs.messen.text;
  return text.startsWith(FUNKTIONEN.messen) ? text : `${FUNKTIONEN.messen}: ${text}`;
}

/** Ein Standort im Entwurf, dem die Adresse fehlt — der Weg ist „Adresse nachtragen" im Standort-Dialog. */
export function adresseFehlt(st: StandortAmStichtag | null): boolean {
  return st != null && st.zustand === 'entwurf' && st.esFehlt.includes('adresse');
}

// ─────────────────────────────────────────────────────────── Schritt 2 · Datenquelle

export const SCHRITT2_FRAGE = 'Womit wird gemessen?';
export const SCHRITT2_SATZ =
  'Verbinden Sie die VoltPilot-Box der Anlage und binden Sie Zähler oder Controller an. Beides können Sie jederzeit ergänzen.';
export const GERAET_VERBINDEN = 'Gerät verbinden';
export const GERAET_VERBINDEN_SATZ = 'Die VoltPilot-Box mit ihrer Geräte-ID';
export const GERAET_ANBINDEN = 'Gerät anbinden';
export const GERAET_ANBINDEN_SATZ = 'Zähler oder Controller an der Box';
export const SPAETER_FORTSETZEN = 'Später fortsetzen';
export const SPAETER_SATZ = 'Ihre Angaben bleiben erhalten. Sie setzen die Einrichtung dort fort, wo Sie aufgehört haben.';
export const ANDEREN_STANDORT = 'Anderen Standort wählen';

/** Ohne Anlage am Standort gibt es nichts anzubinden. */
export function keineAnlageSatz(standortName: string): string {
  return `An ${standortName} hängt noch keine Anlage.`;
}

/**
 * WO der Kunde die Anlage anlegt — ein benannter Weg ohne Knopf (firstmate 002,
 * Entscheid A): der Anlage-Assistent ist ein eigener Fluss und gehört nicht in
 * „Messen & Auswerten". An einem Standort, der nur misst, spricht er seit dem Modus
 * „nur messen“ (`anlegeNurMessen.ts`) nicht mehr von Steuern oder Geld. Still heißt
 * aber nicht Sackgasse: der Satz nennt den Knopf, den der Kunde heute sieht —
 * mit genau einer Anlage „Anlage hinzufügen" oben in der Kopfzeile
 * (`addAnlage.showAddAnlageButton`), sonst „Anlage anlegen" auf der Übersicht
 * (`PortfolioCockpit`). Der Standort wird dort im Schritt „Anlage" gewählt.
 */
export function keineAnlageWeg(standortName: string, anlagenZahl: number | null): string {
  const wo = anlagenZahl === 1 ? 'oben über „Anlage hinzufügen“' : 'auf der Übersicht über „Anlage anlegen“';
  return `Legen Sie ${wo} eine Anlage an und wählen Sie dort ${standortName} als Standort. Danach setzen Sie die Einrichtung hier fort.`;
}

/** Die Anlagen, die heute am Standort hängen — an ihnen bindet Schritt 2 an. */
export function anlagenAmStandort(st: StandortAmStichtag | null): { id: string; name: string }[] {
  return (st?.anlagen ?? []).map((a) => ({ id: a.id, name: a.name }));
}

/** „3 Komponenten angebunden" — `null`, solange die Zahl nicht bekannt ist (nie „0" statt „unbekannt"). */
export function komponentenSatz(anzahl: number | null): string | null {
  if (anzahl == null) return null;
  if (anzahl === 0) return 'Noch keine Komponente angebunden';
  return anzahl === 1 ? '1 Komponente angebunden' : `${anzahl.toLocaleString('de-DE')} Komponenten angebunden`;
}

/** „Für Werk Lindach fehlt noch die Adresse." — Schritt 1 unter der Wahl, Schritt 4 an der Zeile „Standort". */
export function adresseFehltSatz(standortName: string): string {
  return `Für ${standortName} fehlt noch die Adresse.`;
}

// ─────────────────────────────────────────────────────────── Schritt 3 · Messstellen
//
// Die Liste kommt fertig vom Server (`GET …/messstellen-vorschlag`, AP-04 IP-16): WAS
// vorgeschlagen wird, entscheidet allein die Regel `vorschlagsliste` (Java ⟷ `uemsMessstelle.ts`).
// Der Schritt wählt nur aus, benennt um und setzt den Ort — und schickt jede gewählte Zeile so
// zurück, wie sie gezeigt wurde (`POST …/uebernehmen`, eine Transaktion).

export const SCHRITT3_FRAGE = 'Was bedeutet jeder Messkanal?';
export const SCHRITT3_SATZ =
  'Aus den Komponenten und ihren Messkanälen schlagen wir Messstellen vor. Bestätigen Sie, benennen Sie um oder lassen Sie eine weg.';
export const VORSCHLAG_LADEFEHLER = 'Die Vorschläge konnten nicht geladen werden.';
export const UEBERNEHMEN_FEHLER = 'Die Messstellen konnten nicht übernommen werden. Bitte versuchen Sie es erneut.';
export const UEBERNEHMEN = 'Übernehmen';
export const KENNZEICHEN_AUTOMATISCH = 'automatisch';
export const NICHT_VORGESCHLAGEN = 'Nicht vorgeschlagen';
export const ZUR_DATENQUELLE = 'Zur Datenquelle';
export const ZU_DEN_MESSSTELLEN = 'Zu den Messstellen';

/** Woran der Server eine Zeile wiedererkennt: Komponente und Messwert (`MessstelleVorschlagService`). */
export function vorschlagSchluessel(v: { komponente: string; quelle: { kanal: string } }): string {
  return `${v.komponente}|${v.quelle.kanal}`;
}

/** Zu Beginn ist jeder Vorschlag gewählt — der Kunde lässt weg, was er nicht will. */
export function alleGewaehlt(liste: MessstelleVorschlagsliste): Set<string> {
  return new Set(liste.vorschlaege.map(vorschlagSchluessel));
}

/** Die Stellung in den Wörtern des Registers: „Unterzähler von MS-0001"; `null` bleibt „ohne Stellung" — nie geraten. */
export function stellungWort(v: MessstelleVorschlag): string {
  if (v.stellung === null) return 'ohne Stellung';
  if (v.stellung === 'keine') return 'keine Stellung';
  if (v.stellung === 'Unterzähler' && v.unterzaehler_von) return `${UEMS_UNTERZAEHLER_VON} ${v.unterzaehler_von.messstelle}`;
  return v.stellung;
}

/** Die Zeilen je Anlage, in der Reihenfolge der Liste (je Anlage Hauptzähler → Erzeuger → Speicher → Unterzähler). */
export function vorschlaegeJeAnlage(
  liste: MessstelleVorschlagsliste,
): { anlage: string; name: string; vorschlaege: MessstelleVorschlag[] }[] {
  const out: { anlage: string; name: string; vorschlaege: MessstelleVorschlag[] }[] = [];
  for (const v of liste.vorschlaege) {
    let g = out.find((x) => x.anlage === v.anlage);
    if (!g) {
      g = { anlage: v.anlage, name: v.anlage_name ?? '', vorschlaege: [] };
      out.push(g);
    }
    g.vorschlaege.push(v);
  }
  return out;
}

/** Die gewählten Hauptzähler je Anlage — mehr als einer je Anlage und Richtung kommt aus der Liste nie. */
export function hauptzaehlerJeAnlage(
  liste: MessstelleVorschlagsliste,
  gewaehlt: ReadonlySet<string>,
): Map<string, MessstelleVorschlag[]> {
  const out = new Map<string, MessstelleVorschlag[]>();
  for (const v of liste.vorschlaege) {
    if (v.stellung !== UEMS_HAUPTZAEHLER || !gewaehlt.has(vorschlagSchluessel(v))) continue;
    out.set(v.anlage, [...(out.get(v.anlage) ?? []), v]);
  }
  return out;
}

/**
 * Die Hauptzähler-Regel der Übernahme (AP-04 Regel 8): ein Unterzähler, der auf einen Hauptzähler
 * DIESER Liste zeigt, geht nur zusammen mit ihm — sonst lehnt der Server die GANZE Übernahme ab
 * (422 `stellung_ungueltig`, `bezug_fehlt`). Je betroffener Zeile der Satz des Servers, Wort für
 * Wort (`MessstelleVorschlagService.bezug`, mit dem Namen des Vorschlags); leer = die Auswahl geht so.
 * Ein Unterzähler einer BESTEHENDEN Messstelle hängt an nichts, was hier fehlen könnte.
 */
export function hauptzaehlerFehlt(liste: MessstelleVorschlagsliste, gewaehlt: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of liste.vorschlaege) {
    const b = v.unterzaehler_von;
    if (!gewaehlt.has(vorschlagSchluessel(v)) || !b || b.bestehend || b.komponente === null || b.kanal === null) continue;
    if (gewaehlt.has(`${b.komponente}|${b.kanal}`)) continue;
    out.set(
      vorschlagSchluessel(v),
      `„${v.name}“ ist als ${UEMS_UNTERZAEHLER_VON} ${b.messstelle} vorgeschlagen — übernehmen Sie diesen ${UEMS_HAUPTZAEHLER} mit.`,
    );
  }
  return out;
}

/**
 * Die Anfrage an `POST …/messstellen-vorschlag/uebernehmen`: jede gewählte Zeile so, wie die Liste
 * sie zeigt (sonst 409 `vorschlag_geaendert`) — nur der Name darf anders sein. Ein leerer oder
 * unveränderter Name fehlt in der Anfrage; dann behält die Messstelle den vorgeschlagenen.
 */
export function uebernehmenAnfrage(
  liste: MessstelleVorschlagsliste,
  gewaehlt: ReadonlySet<string>,
  namen: Readonly<Record<string, string>>,
): MessstelleVorschlagUebernehmen {
  return {
    vorschlaege: liste.vorschlaege
      .filter((v) => gewaehlt.has(vorschlagSchluessel(v)))
      .map((v) => {
        const name = (namen[vorschlagSchluessel(v)] ?? '').trim();
        return {
          komponente: v.komponente,
          kanal: v.quelle.kanal,
          hauptgroesse: v.hauptgroesse,
          nebengroessen: v.nebengroessen,
          stellung: v.stellung,
          ab: v.ab,
          ...(name && name !== v.name ? { name } : {}),
        };
      }),
  };
}

/** „4 von 4 Vorschlägen gewählt" */
export function auswahlSatz(gewaehlt: number, gesamt: number): string {
  return `${gewaehlt.toLocaleString('de-DE')} von ${gesamt.toLocaleString('de-DE')} ${gesamt === 1 ? 'Vorschlag' : 'Vorschlägen'} gewählt`;
}

/** „4 Messstellen übernommen" — und wie viele es schon gab (ein zweiter Aufruf legt nichts an). */
export function uebernahmeSatz(neu: number, unveraendert: number): string {
  const teil = neu === 1 ? '1 Messstelle übernommen' : `${neu.toLocaleString('de-DE')} Messstellen übernommen`;
  if (unveraendert === 0) return teil;
  return `${teil}, ${unveraendert.toLocaleString('de-DE')} gab es schon`;
}

/** Ohne Eingabe behält die Messstelle den vorgeschlagenen Namen. */
export function nameLeerSatz(vorgeschlagen: string): string {
  return `Ohne Eingabe heißt sie „${vorgeschlagen}“.`;
}

/** Die Ablehnung `vorschlag_geaendert`: die Liste ist neu zu laden, der Satz kommt vom Server. */
export function istVorschlagGeaendert(e: unknown): boolean {
  const f = e as { status?: unknown; body?: { code?: unknown } | null } | null;
  return f?.status === 409 && f.body?.code === 'vorschlag_geaendert';
}

/** Die Orte, die eine Zeile tragen kann: dieser Standort, seine Gebäude und Bereiche (die Wahl des Messstellen-Dialogs). */
export function ortWahlenAm(
  standorte: StandorteAmStichtag | null,
  baum: OrtsbaumAmStichtag | null,
  standortId: string,
): OrtWahl[] {
  if (!standorte) return [];
  return ortWahlen(standorte, baum ? { [standortId]: baum } : {}).filter((o) => o.standortId === standortId);
}

/** Eine Ort-Korrektur nach der Übernahme — über die AP-04-Route `PUT /api/v1/messstellen/{id}/ort`. */
export interface OrtKorrektur {
  messstelle: string;
  kennzeichen: string;
  anfrage: MessstelleOrtAendern;
}

/**
 * Die Orte, die nach der Übernahme noch zu schreiben sind. Die Übernahme trägt jede Messstelle am
 * STANDORT ein, ab dem Tag ihres Verlaufsbeginns; wer ein Gebäude oder einen Bereich gewählt hat,
 * bekommt denselben Tag als Korrektur (`korrektur: true` ersetzt die Zuordnung dieses Tages statt
 * sie am Vortag zu beenden). Die Antwort nennt die Messstellen in der Reihenfolge der Anfrage;
 * eine Messstelle, die nicht (mehr) am vorgeschlagenen Standort steht, bleibt unberührt.
 */
export function ortKorrekturen(
  liste: MessstelleVorschlagsliste,
  anfrage: MessstelleVorschlagUebernehmen,
  antwort: MessstelleVorschlagUebernommen<Messstelle>,
  orte: Readonly<Record<string, string>>,
): OrtKorrektur[] {
  const out: OrtKorrektur[] = [];
  anfrage.vorschlaege.forEach((b, i) => {
    const schluessel = `${b.komponente}|${b.kanal}`;
    const v = liste.vorschlaege.find((x) => vorschlagSchluessel(x) === schluessel);
    const ziel = orte[schluessel];
    const m = antwort.messstellen[i];
    if (!v || !m || !ziel || ziel === v.ort) return;
    const laufend = (m.orte ?? []).find((o) => o.kennzeichen === v.ort && o.gueltig_bis === null);
    if (!laufend) return;
    out.push({ messstelle: m.id, kennzeichen: m.kennzeichen, anfrage: { kennzeichen: ziel, gueltig_ab: laufend.gueltig_ab, korrektur: true } });
  });
  return out;
}

/** „MS-0002 bleibt am Standort Werk Ahrenberg: …" — der Satz der Ablehnung kommt vom Server. */
export function ortFehlerSatz(kennzeichen: string, standortName: string, satz: string): string {
  return `${kennzeichen} bleibt am Standort ${standortName}: ${satz}`;
}

// ─────────────────────────────────────────────────────────────── Schritt 4 · Prüfen

export const SCHRITT4_FRAGE = 'Ist alles da?';
export const SCHRITT4_SATZ =
  'Die Prüfliste zeigt, was heute feststeht. Ist jede Zeile erfüllt, ist Messen & Auswerten eingerichtet.';
export const ERNEUT_PRUEFEN = 'Erneut prüfen';
export const ADRESSE_NACHTRAGEN = 'Adresse nachtragen';

export type MessenPruefArt = 'standort' | 'box' | 'datenlage' | 'hauptzaehler';

/**
 * Zu welcher Zeile der Prüfliste ein Wort aus `messen().fehlt` gehört. Die Wörter bildet allein die
 * Regel (`uemsFunktion.ts` ⟷ `FunktionZustandAbleitung`, Vektoren `funktion-zustand-vectors.json`):
 * die Prüfliste urteilt nicht selbst, sie ordnet nur zu. `null` = ein Wort, das die Regel heute
 * nicht spricht (der Test hält jedes Wort der Vektoren daran fest).
 */
export function fehltArt(wort: string): MessenPruefArt | null {
  if (wort.startsWith('Standort-Angaben ')) return 'standort';
  if (wort.startsWith('Verbindung ')) return 'box';
  if (wort === 'Messstelle mit Daten' || wort.startsWith('erste Daten ') || wort.startsWith('Daten ')) return 'datenlage';
  if (wort.startsWith(`${UEMS_HAUPTZAEHLER} `) || wort.startsWith(`eindeutiger ${UEMS_HAUPTZAEHLER} `)) return 'hauptzaehler';
  return null;
}

export type MessenWegZiel = 'adresse' | 2 | 3;

/** Eine Zeile der Prüfliste: die Fakten als Satz, was die Regel vermisst, und der Weg dorthin. */
export interface MessenPruefZeile {
  art: MessenPruefArt;
  /** Das Urteil der Regel (keine Wörter dieser Art in `fehlt`); `null` = nicht prüfbar, nie „erfüllt". */
  bestanden: boolean | null;
  /** Die Fakten: „Standort Werk Ahrenberg", „Box Halle 2 verbunden", „4 von 4 Messstellen liefern Daten", „Hauptzähler MS-0001". */
  text: string;
  /** Die Wörter der Regel zu dieser Zeile („Hauptzähler Werk Ahrenberg – Halle 2"). */
  fehlt: string[];
  /** Rote Fakten je Messstelle oder Box („MS-0003 Montage Linie M1: Wartet auf erste Daten"). */
  details: string[];
  weg: { text: string; ziel: MessenWegZiel } | null;
}

function aufzaehlung(worte: string[]): string {
  if (worte.length <= 1) return worte.join('');
  return `${worte.slice(0, -1).join(', ')} und ${worte[worte.length - 1]}`;
}

const boxName = (d: Device): string => d.name?.trim() || d.externalRef;

/**
 * Die Prüfliste aus Fakten (Konzept §5.2 Schritt 4): Standort · Box · Datenlage · Hauptzähler.
 * Das URTEIL jeder Zeile ist das der Regel (`funktion.messen.fehlt`, vom Server gebildet); die
 * SÄTZE kommen aus den Fakten, die das Portal liest — Standort (AP-02), Boxen (`/devices`),
 * Register (AP-04) und die Datenlage des Servers. Die Zeile „Hauptzähler" gibt es nur, wo die Regel
 * einen verlangt oder das Register einen kennt (eine Anlage ohne Netzanschluss braucht keinen).
 */
export function messenPruefliste(e: {
  standort: StandortAmStichtag;
  funktion: FunktionStandort;
  geraete: Device[] | null;
  register: MessstelleRegisterZeile[] | null;
  jetzt?: Date;
}): MessenPruefZeile[] {
  const { standort: st, funktion: fs } = e;
  const jetzt = e.jetzt ?? new Date();
  const woerter = (art: MessenPruefArt) => fs.messen.fehlt.filter((w) => fehltArt(w) === art);
  const anlagen = new Set(st.anlagen.map((a) => a.id));
  const zeilen: MessenPruefZeile[] = [];

  const fStandort = woerter('standort');
  zeilen.push({
    art: 'standort',
    bestanden: fStandort.length === 0,
    text: `Standort ${st.name}`,
    fehlt: fStandort,
    details: fStandort.length > 0 && adresseFehlt(st) ? [adresseFehltSatz(st.name)] : [],
    weg: fStandort.length > 0 && adresseFehlt(st) ? { text: ADRESSE_NACHTRAGEN, ziel: 'adresse' } : null,
  });

  const fBox = woerter('box');
  if (e.geraete === null) {
    zeilen.push({
      art: 'box',
      bestanden: fBox.length > 0 ? false : null,
      text: 'Die Boxen konnten nicht gelesen werden.',
      fehlt: fBox,
      details: [],
      weg: fBox.length > 0 ? { text: ZUR_DATENQUELLE, ziel: 2 } : null,
    });
  } else {
    const boxen = e.geraete.filter((d) => anlagen.has(d.siteId) && d.status !== 'ausgebaut');
    const offen = boxen.filter((d) => deviceLiveStatus(d, jetzt) !== 'online');
    const bestanden = boxen.length > 0 && fBox.length === 0;
    const verbunden = boxen.length - offen.length;
    zeilen.push({
      art: 'box',
      bestanden,
      text:
        boxen.length === 0
          ? 'Noch keine Box verbunden'
          : bestanden || offen.length === 0
            ? `${aufzaehlung(boxen.map(boxName))} verbunden`
            : `${verbunden.toLocaleString('de-DE')} von ${boxen.length.toLocaleString('de-DE')} ${boxen.length === 1 ? 'Box' : 'Boxen'} verbunden`,
      fehlt: fBox,
      details: bestanden
        ? []
        : offen.map((d) => `${boxName(d)}: ${deviceLiveStatus(d, jetzt) === 'waiting' ? 'wartet auf erste Daten' : 'offline'}`),
      weg: bestanden ? null : { text: ZUR_DATENQUELLE, ziel: 2 },
    });
  }

  const fDaten = woerter('datenlage');
  const reihen = (e.register ?? []).filter(
    (z) => z.art === 'gemessen' && z.lebenszyklus !== 'archiviert' && z.ort.standort_id === st.id,
  );
  const ohneDaten = reihen.filter(
    (z) => z.beobachtung?.zustand === 'wartet_auf_erste_daten' || z.beobachtung?.zustand === 'liefert_nicht_seit',
  );
  zeilen.push({
    art: 'datenlage',
    bestanden: fDaten.length === 0,
    text: fs.messen.datenlage ?? 'Noch keine Messstellen',
    fehlt: fDaten,
    details:
      fDaten.length === 0
        ? []
        : ohneDaten.map((z) => {
            const wer = [z.kennzeichen, z.name].filter(Boolean).join(' ');
            const woher = z.quelle.fuehrend?.komponente_name;
            return `${wer}: ${z.beobachtung!.text}${woher ? ` · ${woher}` : ''}`;
          }),
    weg:
      fDaten.length === 0
        ? null
        : e.register !== null && reihen.length === 0
          ? { text: ZU_DEN_MESSSTELLEN, ziel: 3 }
          : { text: ZUR_DATENQUELLE, ziel: 2 },
  });

  const fHaupt = woerter('hauptzaehler');
  const haupt = (e.register ?? []).filter(
    (z) =>
      z.art === 'gemessen' &&
      z.lebenszyklus !== 'archiviert' &&
      z.elektrische_stellung?.stellung === UEMS_HAUPTZAEHLER &&
      z.hauptgroesse.richtung === 'Bezug' &&
      anlagen.has(z.elektrische_stellung.anlage),
  );
  if (haupt.length > 0 || fHaupt.length > 0) {
    const jeAnlage = st.anlagen
      .map((a) => ({ name: a.name, kennzeichen: haupt.filter((z) => z.elektrische_stellung!.anlage === a.id).map((z) => z.kennzeichen) }))
      .filter((x) => x.kennzeichen.length > 0);
    zeilen.push({
      art: 'hauptzaehler',
      bestanden: fHaupt.length === 0,
      text:
        haupt.length === 0
          ? `Noch kein ${UEMS_HAUPTZAEHLER}`
          : st.anlagen.length > 1
            ? `${UEMS_HAUPTZAEHLER} ${jeAnlage.map((x) => `${x.kennzeichen.join(', ')} (${x.name})`).join(', ')}`
            : `${UEMS_HAUPTZAEHLER} ${haupt.map((z) => z.kennzeichen).join(', ')}`,
      fehlt: fHaupt,
      details: [],
      weg: fHaupt.length === 0 ? null : { text: ZU_DEN_MESSSTELLEN, ziel: 3 },
    });
  }
  return zeilen;
}

/** Eingerichtet ist, was die Regel „aktiv" nennt — Messen startet mit der Einrichtung von selbst (kein Start-Knopf). */
export function messenEingerichtet(fs: FunktionStandort | null): boolean {
  return fs?.messen.zustand === 'aktiv';
}

// ─────────────────────────────────────────────────────────────── Schritt 5 · Fertig

export const FERTIG = 'Fertig';
export const FERTIG_AUSWERTUNG = 'Die Auswertung beginnt mit den ersten Viertelstundenwerten.';
export const FERTIG_WEITERE = 'Weitere Standorte richten Sie mit demselben Assistenten ein.';
export const MESSSTELLEN_ANSEHEN = 'Messstellen ansehen';

/** „Messen & Auswerten ist für Werk Ahrenberg eingerichtet und aktiv." (Konzept §5.2 Schritt 5) */
export function fertigSatz(standortName: string): string {
  return `${FUNKTIONEN.messen} ist für ${standortName} eingerichtet und aktiv.`;
}
