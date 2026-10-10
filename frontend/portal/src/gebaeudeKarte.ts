/**
 * Die Karte eines Gebäudes auf „Standort › Gebäude“ (UEMS AP-13 IP-10 = AP-10 IP-17 Portal-Teil; E4 = A, Ü6, B4) —
 * reine Hälfte.
 *
 * Die Hülle steht seit IP-2 im `Ortsbaum` (`gebaeudeKarte`); hier entstehen ihre drei Blöcke, und keiner rechnet
 * selbst eine Menge aus:
 * - **Energie** — die Gebäude-SICHT über den Zwilling `uemsBilanz.gebaeude` (AP-10 F17): je System (Anlage) mit einer
 *   zugeordneten Messstelle im Gebäude „gemessen im Gebäude … (n Messstellen)“ mit den Posten, „außerhalb des
 *   Gebäudes, im selben System: …“ und „Rest des Systems …: … nicht verortet“. `gebaeudeverbrauch` ist IMMER `null`
 *   (§4.8) — die Karte zeigt NIE eine Gebäude-Summe: ein Gebäude ist eine Sicht, keine Bilanzgrenze.
 * - **Messstellen** — der Satz des Registers mit Filter Ort = dieses Gebäude, wörtlich, plus der Sprung in genau
 *   dieses gefilterte Register (`#/standort/{id}/messstellen?ort=G-2`).
 * - **Kennzahlen** — die lebenden Kennzahlen, deren Geltung IN diesem Gebäude liegt (das Gebäude selbst und seine
 *   Bereiche), als Listen-Karten von AP-11 IP-13; dazu „Kennzahl anlegen“ mit vorgeschlagener Menge (AP-11 §6.6) —
 *   nur mit Recht (`kennzahl.standort_definieren`) und nie still: der Assistent aus AP-11 IP-14 läuft ganz durch.
 *
 * Nicht hier: die Zeile „Versorgung“ der Standort-Übersicht — siehe {@link VERSORGUNG_ROUTE}.
 *
 * Reines Modul: keine React-Importe, kein Netzwerk.
 */
import type { BilanzEingang, Kennzahl, MessstellenRegister } from './api';
import { darf } from './anlageEnergiebilanz';
import type { BerichtRechte } from './berichtDialoge';
import { dez, dezText } from './bezugsdaten';
import { UEMS_GEBAEUDE, UEMS_KENNZAHLEN, UEMS_MESSSTELLE, UEMS_NICHT_VERORTET, UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { geltungWert, type MengenVorschlag } from './kennzahlAnlegen';
import { anlageRoute, hashForRoute, standortMessstellenRoute, type Route } from './nav';
import type { Ton } from './uebersicht';
import type { Sprung } from './uemsOberflaechen';
import {
  KEINE_WERTE,
  MESSSTELLEN_TITEL,
  laeuftNoch,
  tonDerDatenlage,
  zeitraumText,
  type AnlageBilanz,
  type BilanzPeriode,
} from './uebersichtBausteine';
import { gebaeude as gebaeudeSicht, type GebaeudeZeile } from './uemsBilanz';
import { zahl } from './uemsErgebnis';

export const ENERGIE_TITEL = 'Energie';
export const KENNZAHLEN_TITEL = UEMS_KENNZAHLEN;

/** Das Recht, eine Kennzahl mit Geltung im Standort zu definieren (AP-11 E10, `KennzahlController.anlegen`). */
export const RECHT_KENNZAHL = 'kennzahl.standort_definieren';

export const KNOPF_KENNZAHL_ANLEGEN = `${UEMS_KENNZAHLEN.slice(0, -2)} anlegen`;
export const KNOPF_MESSSTELLE_ANLEGEN = `${UEMS_MESSSTELLE} anlegen`;

/** AP-10 F15 — ein Gebäude ohne Messstelle ist „nicht messbar“; das ist kein Fehler, sondern eine Auskunft. */
export const NICHT_MESSBAR = `In diesem ${UEMS_GEBAEUDE} misst keine ${UEMS_MESSSTELLE}.`;

/** Messstellen ja, aber keine davon zählt in einem System mit Hauptzähler — dann gibt es keine Sicht, aber Werte. */
export const OHNE_SYSTEM = `Keine ${MESSSTELLEN_TITEL} dieses ${UEMS_GEBAEUDE}s ist einem Hauptzähler zugeordnet — eine Sicht auf das ${UEMS_GEBAEUDE} entsteht erst mit einer elektrischen Stellung.`;

/** Eine Anlage ohne Bilanz: ob sie im Gebäude misst, ist unbekannt — die Karte sagt es, statt vollständig zu wirken. */
export const offenSatz = (anlagen: readonly string[]): string =>
  `Nicht abrufbar: ${anlagen.join(', ')} — ob dort ${MESSSTELLEN_TITEL} dieses ${UEMS_GEBAEUDE}s zählen, ist offen.`;

/** Mit Stichtag gibt es keinen Schreibweg (AP-02 IP-13) — auch nicht aus dieser Karte heraus. */
export const MIT_STICHTAG_KEIN_WEG = 'Mit „Stand am …“ zeigt die Karte den Tag — angelegt wird heute.';

// ------------------------------------------------------------------------------------------------- Energie

/** Eine Messstelle des Gebäudes in der Sicht: ihr Name und ihre Menge im Zeitraum (`null` = keine Werte). */
export interface EnergiePosten {
  messstelle: string;
  name: string;
  menge: string | null;
}

/** Ein System (eine Anlage), das im Gebäude misst — die Sicht gilt IMMER je System, nie über Systeme hinweg. */
export interface EnergieSystem {
  key: string;
  anlage: string;
  /** „Gemessen im Gebäude 32.000 kWh (3 Messstellen)“ · „mindestens …“ · „keine Werte“. */
  gemessen: string;
  posten: EnergiePosten[];
  /** „Außerhalb des Gebäudes, im selben System: Ladepunkt Parkplatz 1.100 kWh“; `null` = alles misst im Gebäude. */
  ausserhalb: string | null;
  /** „Rest des Systems Werk Ahrenberg – Halle 2: 3.800 kWh nicht verortet“; `null` = die Anlage nennt keinen Rest. */
  rest: string | null;
  ton: Ton;
  /** Der Sprung in Anlage › Verlauf › Energiebilanz (AP-13 IP-8) — dort steht der Rest mit seiner Herkunft. */
  ziel: Route;
}

export interface EnergieBlock {
  zeitraum: string;
  /** Statt Zahlen ein Satz: „nicht messbar“ (F15), der laufende Zeitraum (E11) oder die fehlende Antwort. */
  hinweis: string | null;
  systeme: EnergieSystem[];
  /**
   * Anlagen des Standorts, deren Bilanz gerade nicht abrufbar ist: ob sie im Gebäude messen, ist unbekannt. Steht
   * unter der Sicht — sonst sähe die Karte vollständig aus, obwohl ein System fehlen könnte.
   */
  offen: string[];
}

const POSTEN_TRENNER = ' · ';

const anzahlWort = (n: number) => `${n} ${n === 1 ? UEMS_MESSSTELLE : MESSSTELLEN_TITEL}`;

/** Der Name, unter dem eine Messstelle im Gebäude erscheint — ihr Name aus dem Register, sonst ihr Kennzeichen. */
const namenVon = (kennzeichen: string, namen: ReadonlyMap<string, string>) => namen.get(kennzeichen) ?? kennzeichen;

/** Die zugeordneten Eingänge EINES Systems mit der Angabe, ob ihre Messstelle im Gebäude misst. */
function zeilen(eingaenge: readonly BilanzEingang[], imGebaeude: ReadonlySet<string>): GebaeudeZeile[] {
  return eingaenge
    .filter((e) => e.rolle === 'zugeordnet' && e.menge !== null)
    .map((e) => ({ messstelle: e.messstelle, rolle: e.rolle, menge: dez(String(e.menge)), im_gebaeude: imGebaeude.has(e.messstelle) }));
}

/**
 * Ü6/B4 — der Block „Energie“ der Gebäude-Karte. Er steht je System, weil die Sicht je System gilt: „gemessen im
 * Gebäude“ ist die Summe der zugeordneten Messstellen dieses Systems, die im Gebäude messen; „außerhalb“ sind seine
 * übrigen zugeordneten; der Rest gehört dem System, nicht dem Gebäude (AP-10 E9).
 *
 * `anlagen === null` = die Bilanzen sind noch nicht da; `imZeitraum === null` = das Register des Stichtags fehlt.
 * Beides ist kein Grund, eine Zahl zu erfinden — dann steht der Grund statt der Zahl.
 */
export function energieBlock(i: {
  gebaeudeName: string;
  periode: BilanzPeriode;
  am: string;
  heute: string;
  anlagen: readonly AnlageBilanz[] | null;
  /** Die Messstellen IM Gebäude am letzten Tag des Zeitraums (Kennzeichen → Name); `null` = nicht abrufbar. */
  imZeitraum: ReadonlyMap<string, string> | null;
}): EnergieBlock {
  const zeitraum = zeitraumText(i.periode, i.am);
  const leer = { zeitraum, systeme: [], offen: [] };
  if (i.imZeitraum !== null && i.imZeitraum.size === 0) return { ...leer, hinweis: NICHT_MESSBAR };
  if (laeuftNoch(i.periode, i.am, i.heute)) return { ...leer, hinweis: UEMS_NOCH_NICHT_GERECHNET_SATZ };
  if (i.anlagen === null || i.imZeitraum === null) return { ...leer, hinweis: null };

  const drin = new Set(i.imZeitraum.keys());
  const systeme: EnergieSystem[] = [];
  const offen: string[] = [];
  for (const a of i.anlagen) {
    // Die Bilanz dieser Anlage fehlt: ob sie im Gebäude misst, ist unbekannt — sie wird genannt, nicht verschwiegen.
    if (a.bilanz === null) {
      offen.push(a.anlage.name);
      continue;
    }
    const abschnitte = a.bilanz.hauptzaehler.flatMap((h) => h.abschnitte);
    // Die Namen stehen an den TERMEN der Stellung, nicht an den Eingängen; das Register des Stichtags ergänzt sie.
    const namen = new Map<string, string>(i.imZeitraum);
    for (const t of abschnitte.flatMap((ab) => ab.terme)) if (t.name && !namen.has(t.messstelle)) namen.set(t.messstelle, t.name);
    const werte = abschnitte.flatMap((ab) => ab.werte);
    const eingaenge = werte.flatMap((w) => w.eingaenge);
    const zugeordnetDrin = eingaenge.filter((e) => e.rolle === 'zugeordnet' && drin.has(e.messstelle));
    if (zugeordnetDrin.length === 0) continue;

    const sicht = gebaeudeSicht(i.gebaeudeName, a.anlage.id, 'kWh', zeilen(eingaenge, drin), null);
    const fehlen = zugeordnetDrin.filter((e) => e.menge === null).map((e) => namenVon(e.messstelle, namen));
    const menge = zahl(dezText(sicht.gemessen_im_gebaeude), 'kWh', i.periode);
    const anzahl = anzahlWort(zugeordnetDrin.length);
    const gemessen =
      fehlen.length === zugeordnetDrin.length
        ? `Gemessen im ${UEMS_GEBAEUDE}: ${KEINE_WERTE} (${anzahl})`
        : fehlen.length === 0
          ? `Gemessen im ${UEMS_GEBAEUDE} ${menge} (${anzahl})`
          : `Gemessen im ${UEMS_GEBAEUDE} mindestens ${menge} (${anzahl}, ${fehlen.join(', ')} ${fehlen.length === 1 ? 'fehlt' : 'fehlen'})`;

    const draussen = eingaenge.filter((e) => e.rolle === 'zugeordnet' && !drin.has(e.messstelle));
    const ausserhalb =
      draussen.length === 0
        ? null
        : `Außerhalb des ${UEMS_GEBAEUDE}s, im selben System: ` +
          draussen
            .map((e) => `${namenVon(e.messstelle, namen)} ${e.menge === null ? KEINE_WERTE : zahl(dezText(dez(String(e.menge))), 'kWh', i.periode)}`)
            .join(POSTEN_TRENNER);

    const restWert = werte.length === 1 ? werte[0].rest : null;
    const rest =
      restWert == null || restWert.menge === null
        ? null
        : `Rest des Systems ${a.anlage.name}: ${zahl(dezText(dez(String(restWert.menge))), 'kWh', i.periode)} ${UEMS_NICHT_VERORTET}`;

    systeme.push({
      key: a.anlage.id,
      anlage: a.anlage.name,
      gemessen,
      posten: zugeordnetDrin.map((e) => ({
        messstelle: e.messstelle,
        name: namenVon(e.messstelle, namen),
        menge: e.menge === null ? null : zahl(dezText(dez(String(e.menge))), 'kWh', i.periode),
      })),
      ausserhalb,
      rest,
      ton: fehlen.length === 0 ? 'ok' : fehlen.length === zugeordnetDrin.length ? 'off' : 'warn',
      ziel: anlageRoute(a.anlage.id, 'energiebilanz'),
    });
  }
  // Messstellen ja, aber keine davon ist einem Hauptzähler zugeordnet: es gibt nichts zu summieren, aber messbar ist
  // das Gebäude — „nicht messbar“ wäre hier falsch.
  const hinweis = systeme.length > 0 ? null : offen.length > 0 ? null : OHNE_SYSTEM;
  return { zeitraum, hinweis, systeme, offen };
}

// ---------------------------------------------------------------------------------------------- Messstellen

export interface MessstellenBlock {
  /** Der Satz des Registers, wörtlich („3 von 3 Messstellen liefern Daten“); `null` = keine Messstelle im Gebäude. */
  text: string | null;
  ton: Ton;
  /** Der Sprung in das Register MIT Filter Ort = dieses Gebäude. */
  ziel: Sprung;
  /** Der Weg „Messstelle anlegen“ (AP-04 IP-6) — nur im Leerzustand und nur ohne Stichtag. */
  anlegen: boolean;
}

/**
 * Ü6 — der Block „Messstellen“: die Datenlage, wie das Register sie mit Filter Ort zählt. Keine dritte Zählung: der
 * Satz kommt wörtlich aus dem Aggregat der gefilterten Antwort (E13 zählt berechnete und archivierte mit).
 */
export function messstellenBlock(i: {
  standortId: string;
  gebaeudeKurzzeichen: string | null;
  register: MessstellenRegister | null;
  mitStichtag: boolean;
}): MessstellenBlock {
  const ziel = registerZiel(i.standortId, i.gebaeudeKurzzeichen);
  const a = i.register?.aggregat.unternehmen ?? null;
  if (!a || a.gesamt === 0) return { text: null, ton: 'off', ziel, anlegen: !i.mitStichtag };
  return { text: a.text, ton: tonDerDatenlage(a), ziel, anlegen: false };
}

/**
 * Das Register des Standorts, vorgefiltert auf einen Ort: `#/standort/{id}/messstellen?ort=G-2`. Der Filter steht als
 * KURZZEICHEN in der Adresse — es ist lesbar und überlebt als Lesezeichen; das Register löst es gegen seine Antwort
 * auf (`messstellen.ortSchluessel`), damit die Filterleiste dieselbe Auswahl zeigt. Ohne Kurzzeichen (Zweig „direkt
 * am Standort“) bleibt es das ganze Register des Standorts.
 */
export function registerZiel(standortId: string, kurzzeichen: string | null): Sprung {
  const route = standortMessstellenRoute(standortId);
  const hash = hashForRoute(route);
  return { route, hash: kurzzeichen ? `${hash}?ort=${encodeURIComponent(kurzzeichen)}` : hash };
}

// ----------------------------------------------------------------------------------------------- Kennzahlen

/**
 * Ü6 — die Kennzahlen DIESES Gebäudes: Geltung ist das Gebäude selbst oder einer seiner Bereiche. Die §8-Zelle nennt
 * nur „Geltung Gebäude“; ein Bereich liegt aber IM Gebäude, und seine Kennzahl stünde sonst auf keiner Gebäude-Fläche
 * — sie erscheint hier mit ihrem eigenen Geltungs-Wort („Bereich Halle 2 Montage“), nie unter dem des Gebäudes.
 * Archivierte erscheinen nicht; `null` = keine — dann gibt es den Block nicht (nur den Weg „Kennzahl anlegen“).
 */
export function kennzahlenDesGebaeudes(liste: readonly Kennzahl[] | null, gebaeudeId: string, bereichIds: readonly string[]): Kennzahl[] | null {
  if (!liste) return null;
  const drin = new Set<string>([gebaeudeId, ...bereichIds]);
  const hier = liste.filter((k) => k.archiviert_am === null && (k.geltung_art === 'gebaeude' || k.geltung_art === 'bereich') && drin.has(k.geltung_id));
  return hier.length > 0 ? hier : null;
}

/**
 * AP-11 §6.6 — „Kennzahl anlegen“ aus der Gebäude-Sicht schlägt als Menge genau die Messstellen vor, deren Summe die
 * Karte eben genannt hat: die zugeordneten des Gebäudes. Kein Hauptzähler, kein Rest — sonst stünde im Assistenten
 * eine andere Zahl als in der Karte. Ohne solche Messstelle gibt es keinen Vorschlag (`null`), den Assistenten
 * trotzdem.
 */
export function kennzahlVorschlag(gebaeude: { id: string; name: string }, block: EnergieBlock): MengenVorschlag | null {
  const menge = [...new Set(block.systeme.flatMap((s) => s.posten.map((p) => p.messstelle)))];
  if (menge.length === 0) return null;
  return {
    menge,
    geltung: geltungWert('gebaeude', gebaeude.id),
    satz: `Vorgeschlagen: die ${anzahlWort(menge.length)}, die in ${gebaeude.name} messen (${menge.join(', ')}). Sie können das im Assistenten ändern.`,
  };
}

/**
 * G3 — „Kennzahl anlegen“ steht nur, wer eine Kennzahl mit Geltung in diesem Standort definieren darf (AP-11 E10:
 * Kundenadministrator, Energiemanager und Bearbeiter am Standort). `undefined` = die Selbstauskunft fehlt noch, dann
 * steht der Weg nicht (kein Aufblitzen für einen Leser); `null` = sie ist nicht zu haben, dann entscheidet die Route.
 */
export const darfKennzahlAnlegen = (rechte: BerichtRechte | null | undefined, standortId: string): boolean => darf(rechte, standortId, RECHT_KENNZAHL);

// ----------------------------------------------------------------------------------------------- Versorgung

/**
 * B4/Ü6 — die Zeile „Versorgung“ („Halle 1 ← System Halle 1“) gehört auf die Standort-Übersicht, **sobald**
 * `GET /api/v1/standorte/{id}/versorgung?stichtag=` antwortet. Die Route ist AP-10 IP-17 und heute NICHT gebaut:
 * `services/api` kennt sie nicht, `api.ts` hat keinen Aufrufer.
 *
 * Der Zwilling `uemsBilanz.versorgung` könnte den Satz rechnen — aber nur aus Verortungen je Tag samt Stellung, und
 * die liefert keine gebaute Antwort. Eine Zeile aus zusammengesuchten Eingängen wäre eine Behauptung über die
 * Versorgung eines Gebäudes; „unbekannt ist keine Null“ gilt auch hier. Deshalb baut IP-10 die Zeile NICHT, und
 * `gebaeudeKarte.test.ts` hält den Fall als benannten Test fest (`VERSORGUNG_ROUTE`): kommt die Route, wird er rot
 * und die Zeile ist zu bauen.
 */
export const VERSORGUNG_ROUTE = '/api/v1/standorte/{id}/versorgung';

/** Der Satz, den die Zeile sprechen wird — hier festgehalten, damit ihr Wortlaut mit der Route mitkommt (B4). */
export const VERSORGUNG_MUSTER = '{gebaeude} ← System {anlage}';
