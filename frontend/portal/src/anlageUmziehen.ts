import type {
  AnlageUmzug,
  AnlageUmzugAnfrage,
  AnlageUmzugBleibt,
  AnlageUmzugStandort,
  OrtFehler,
  StandortAmStichtag,
  StandorteAmStichtag,
} from './api';
import type { AnlageStandort } from './anlageStandort';
import { UEMS_BOX, UEMS_FUNKTION_STEUERN } from './glossar';
import type { VpOption } from './picker/optionen';
import { adresseKurz } from './standorte';
import { datumText, type Tag } from './uemsOrtsbaum';

/**
 * Eine Anlage einem anderen Standort zuordnen (UEMS AP-02 IP-11, Mockup T6b, A11) — die reine
 * Hälfte des Dialogs. Die Folgen URTEILT der Server (`GET …/standort/vorschau`: dieselbe Regel und
 * dieselben Fakten wie der Eintrag); hier werden sie nur in Kundensätze gesetzt.
 *
 * Die Linie des Captains: lieber eine Aussage zu viel als eine Leerstelle. Die Folgen-Karte nennt
 * darum ausdrücklich, was NICHT passiert — Box, Datenwege, Freigaben, Betriebsmodell … bleiben, und
 * es wird kein Befehl gesendet. Das ist hier die beruhigende Information.
 */

export const UMZUG_TITEL = 'Anlage zuordnen';
export const UMZUG_GESPEICHERT_TITEL = 'Zuordnung gespeichert';
export const KNOPF_ANDEREM_STANDORT = 'Anderem Standort zuordnen';
export const KNOPF_ZUORDNUNG_KORRIGIEREN = 'Zuordnung korrigieren';
export const KNOPF_ZUORDNEN = 'Zuordnen';
export const KNOPF_FERTIG = 'Fertig';
export const UMZUG_VORSPANN =
  'Die Anlage gehört ab dem gewählten Tag zu einem anderen Standort. Das ist eine Aussage über die Zugehörigkeit — am Betrieb der Anlage ändert sich nichts.';
export const KORREKTUR_VORSPANN =
  'Die Anlage gehört seit ihrem ersten Tag zu einem anderen Standort? Hier ändern Sie das rückwirkend. Steuerung und Messwerte bleiben unberührt.';
export const FOLGEN_AENDERT_TITEL = 'Das ändert sich';
export const FOLGEN_BLEIBT_TITEL = 'Das bleibt, wie es ist';
export const FOLGEN_PRUEFEN = 'Die Folgen werden geprüft …';
export const FOLGEN_WAEHLEN = 'Wählen Sie Standort und Tag — dann steht hier, was die Zuordnung bewirkt.';
export const LABEL_ZIEL = 'Neuer Standort *';
export const LABEL_GUELTIG_AB = 'Gültig ab *';
export const LABEL_BEGRUENDUNG = 'Begründung (freiwillig)';
export const HINWEIS_BEGRUENDUNG = 'Steht im Änderungsprotokoll der Anlage und der beiden Standorte.';
export const VERLAUF_TITEL = 'Zuordnungen der Anlage';
export const BEGRUENDUNG_MAX = 500;

export interface UmzugForm {
  standortId: string | null;
  gueltigAb: Tag | null;
  begruendung: string;
}

export type UmzugFeld = 'standortId' | 'gueltigAb' | 'begruendung';
export type UmzugFehler = Partial<Record<UmzugFeld, string>>;

/** Der normale Umzug öffnet heute; die geführte Korrektur reicht den ersten Anlagentag ein. */
export function umzugStart(heute: Tag, gueltigAb = heute): UmzugForm {
  return { standortId: null, gueltigAb, begruendung: '' };
}

/**
 * Die Zielliste: jeder bestehende, nicht archivierte Standort. Der heutige bleibt wählbar (eine
 * geplante Zuordnung kann zurückführen) und sagt es — ob die Wahl geht, urteilt der Server.
 */
export function zielOptionen(antwort: StandorteAmStichtag | null, anlageId: string): VpOption[] {
  return (antwort?.standorte ?? [])
    .filter((s) => s.bestand === 'vorhanden' && s.zustand !== 'archiviert')
    .map((s) => ({ value: s.id, label: `${s.name} (${s.kurzzeichen})`, sub: zielSub(s, anlageId) }));
}

function zielSub(s: StandortAmStichtag, anlageId: string): string | null {
  const adresse = adresseKurz(s);
  if (!s.anlagen.some((a) => a.id === anlageId)) return adresse;
  return adresse ? `Heute zugeordnet · ${adresse}` : 'Heute zugeordnet';
}

/** Was vor dem Senden fehlt — dieselben Grenzen wie der Server. */
export function pruefeUmzug(f: UmzugForm): UmzugFehler {
  const fehler: UmzugFehler = {};
  if (!f.standortId) fehler.standortId = 'Bitte wählen Sie den Standort, zu dem die Anlage gehören soll.';
  if (!f.gueltigAb) fehler.gueltigAb = 'Bitte geben Sie an, ab welchem Tag die Zuordnung gilt.';
  if ([...f.begruendung.trim()].length > BEGRUENDUNG_MAX) {
    fehler.begruendung = `Die Begründung darf höchstens ${BEGRUENDUNG_MAX} Zeichen lang sein.`;
  }
  return fehler;
}

/** Der Rumpf von `PUT …/standort`; `null`, solange etwas fehlt. Eine leere Begründung wird nicht gesendet. */
export function umzugAnfrage(f: UmzugForm): AnlageUmzugAnfrage | null {
  if (Object.keys(pruefeUmzug(f)).length > 0 || !f.standortId || !f.gueltigAb) return null;
  const begruendung = f.begruendung.trim();
  return { standortId: f.standortId, gueltigAb: f.gueltigAb, ...(begruendung ? { begruendung } : {}) };
}

/** Wohin der Satz des Servers gehört (`feld` der Ablehnung); `null`: über die ganze Form. */
export function umzugFeldAusServer(f: OrtFehler): UmzugFeld | null {
  const feld = (f as OrtFehler & { feld?: unknown }).feld;
  return feld === 'standortId' || feld === 'gueltigAb' || feld === 'begruendung' ? feld : null;
}

/** „Werk Ahrenberg Nord (ST-3)“ */
export function standortText(s: AnlageUmzugStandort): string {
  const name = s.name ?? 'Unbekannter Standort';
  return s.kurzzeichen ? `${name} (${s.kurzzeichen})` : name;
}

/** Ein Kalendertag plus n Tage — Tage, keine Zeitpunkte (Zeitzone spielt keine Rolle). */
export function tagPlus(t: Tag, tage: number): Tag {
  const d = new Date(`${t}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

export interface FolgenKarte {
  aendert: string[];
  bleibt: string[];
  /** „Es wird kein Befehl an die Anlage gesendet.“ — `null` nur, wenn der Server anderes meldet. */
  befehl: string | null;
}

/** Was bleibt — je Code des Servers (`AnlageUmzugService.BLEIBT`), in dessen Reihenfolge. */
export const BLEIBT_SATZ: Record<AnlageUmzugBleibt, (u: AnlageUmzug) => string> = {
  box: (u) =>
    u.boxen > 1
      ? `Die ${u.boxen} ${UEMS_BOX}en bleiben mit der Anlage verbunden — nichts wird neu eingerichtet.`
      : `Die ${UEMS_BOX} bleibt mit der Anlage verbunden — nichts wird neu eingerichtet.`,
  topics: () => 'Die Datenwege bleiben gleich: Messwerte kommen weiter auf demselben Weg an.',
  freigaben: () => 'Die Freigaben zum Steuern bleiben, wie sie sind.',
  betriebsmodell: () => 'Das Betriebsmodell und Ihre Regeln bleiben, wie sie sind.',
  ladepark_rahmen: () => 'Der Ladepark-Rahmen bleibt, wie er ist.',
  fahrplaene: () => 'Fahrpläne bleiben, wie sie sind.',
  messstellen: () => 'Messstellen bleiben an ihrem Ort.',
};

/** Die Folgen-Karte (T6b) aus der Antwort des Servers — Vorschau und Ergebnis sprechen gleich. */
export function folgenKarte(u: AnlageUmzug): FolgenKarte {
  const ab = datumText(u.gueltigAb);
  const aendert = [`Ab ${ab} gehört die Anlage zu ${standortText(u.neu)}.`];
  if (u.bisher) {
    aendert.push(`Bis ${datumText(tagPlus(u.gueltigAb, -1))} gehört sie weiter zu ${standortText(u.bisher)}.`);
  }
  if (u.gueltigBis) {
    aendert.push(
      u.danach
        ? `Die neue Zuordnung endet am ${datumText(u.gueltigBis)}: ab ${datumText(tagPlus(u.gueltigBis, 1))} gilt die schon geplante zu ${standortText(u.danach)}.`
        : `Die neue Zuordnung endet am ${datumText(u.gueltigBis)}.`,
    );
  }
  aendert.push(`Die Standort-Karten zählen die Anlage ab ${ab} bei ${u.neu.name ?? standortText(u.neu)}.`);
  if (u.rueckwirkung.art === 'rueckwirkend') {
    const abzeichen = u.rueckwirkung.abzeichen ?? `rückwirkend (${u.rueckwirkung.tage} Tage)`;
    aendert.push(`${abzeichen.charAt(0).toUpperCase()}${abzeichen.slice(1)}: Auswertungen ab dem ${ab} zählen nachträglich anders.`);
  } else if (u.rueckwirkung.art === 'geplant') {
    aendert.push('Geplant: bis dahin ändert sich nichts.');
  }

  const bleibt = u.bleibt.map((code) => BLEIBT_SATZ[code](u));
  if (u.netzanschluss) bleibt.push(`Die Anlage bleibt an ihrem Netzanschluss ${u.netzanschluss.kennzeichen}.`);
  if (u.steuern) {
    const teilnahme = `Die Teilnahme an „${UEMS_FUNKTION_STEUERN}“ bleibt, wie sie ist`;
    bleibt.push(
      u.steuern.standort.id === u.neu.id
        ? `${teilnahme}.`
        : `${teilnahme} — geführt wird sie weiter bei ${standortText(u.steuern.standort)}.`,
    );
  }
  return { aendert, bleibt, befehl: u.befehle === 0 ? 'Es wird kein Befehl an die Anlage gesendet.' : null };
}

/** Der Kopf nach dem Speichern. */
export function ergebnisSatz(u: AnlageUmzug): string {
  return `${u.anlageName} gehört ab ${datumText(u.gueltigAb)} zu ${standortText(u.neu)}.`;
}

export interface VerlaufZeile {
  standort: string;
  zeitraum: string;
  zustand: 'gilt' | 'geplant' | 'beendet';
}

const ZUSTAND_WORT: Record<'gueltig' | 'geplant' | 'beendet', VerlaufZeile['zustand']> = {
  gueltig: 'gilt',
  geplant: 'geplant',
  beendet: 'beendet',
};

/** Die Zuordnungen nach dem Eintrag, wie der Server sie gelesen hat — ohne aufgehobene. */
export function verlaufZeilen(u: AnlageUmzug): VerlaufZeile[] {
  return u.zuordnungen.flatMap((z) =>
    z.zustand === 'aufgehoben'
      ? []
      : [
          {
            standort: standortText(z.standort),
            zeitraum: z.gueltigBis
              ? `${datumText(z.gueltigAb)} – ${datumText(z.gueltigBis)}`
              : `ab ${datumText(z.gueltigAb)}`,
            zustand: ZUSTAND_WORT[z.zustand],
          },
        ],
  );
}

/**
 * „Meine Anlage“ nach einer geplanten Zuordnung: endet die heutige, sagt die Zeile, wann und wohin
 * es geht („bis 28.02.2027 · ab 01.03.2027: Werk Ahrenberg Nord (ST-3)“) — sonst stünde dort
 * unverändert der alte Standort, als wäre nichts gespeichert. `null` bei offener Zuordnung.
 */
export function geplantZeile(a: AnlageStandort, danach: AnlageStandort | null): string | null {
  const bis = a.zuordnung.gueltigBis;
  if (!bis) return null;
  const naechster = datumText(tagPlus(bis, 1));
  return danach
    ? `bis ${datumText(bis)} · ab ${naechster}: ${danach.standort.name} (${danach.standort.kurzzeichen})`
    : `bis ${datumText(bis)} · ab ${naechster} keinem Standort zugeordnet`;
}
