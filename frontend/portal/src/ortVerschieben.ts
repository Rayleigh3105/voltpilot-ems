import type {
  OrtFehler,
  OrtsbaumDanach,
  OrtVerschiebenAnfrage,
  OrtVerschiebenZiel,
  OrtVerschiebung,
  OrtVerschiebungKnoten,
  OrtVerschiebungMessstelle,
} from './api';
import type { ZeitstrahlAbschnitt } from './components/Zeitstrahl';
import { UEMS_BOX, UEMS_NETZANSCHLUSS } from './glossar';
import type { VpGruppe, VpOption } from './picker/optionen';
import { datumText, plusTage, type Tag } from './uemsOrtsbaum';

/**
 * Ein Gebäude oder einen Bereich verschieben (UEMS AP-02 IP-12, Mockups V1–V4, A13) — die reine Hälfte
 * des Dialogs. Die Folgen URTEILT der Server (`GET …/verschieben/vorschau`: dieselbe Regel und dieselben
 * Fakten wie der Eintrag); hier werden sie nur in Kundensätze gesetzt.
 *
 * Die Kernzusage (A13): ein Verschieben ist eine Aussage über den ORT. Die Karte nennt darum ausdrücklich,
 * was mitzieht (Bereiche, die Messstellen darin — sie bleiben an ihrem Ort) und was BLEIBT (Anlage,
 * Netzanschluss, eine Messstelle direkt am Standort), je mit dem Weg, und dass sich an Anlagen,
 * Netzanschlüssen und Boxen nichts ändert. Von Steuerung ist keine Rede: wer nur misst, verschiebt auch
 * nur einen Ort (Captain 14.09.2026).
 */

export type VerschiebenArt = 'gebaeude' | 'bereich';

export const KNOPF_SPEICHERN = 'Verschieben';
export const KNOPF_FERTIG = 'Fertig';
export const ERGEBNIS_TITEL = 'Verschiebung gespeichert';
export const LABEL_GUELTIG_AB = 'Gültig ab *';
export const LABEL_BEGRUENDUNG = 'Begründung (freiwillig)';
export const HINWEIS_BEGRUENDUNG = 'Steht im Änderungsprotokoll.';
export const FOLGEN_WAEHLEN = 'Wählen Sie Ziel und Tag — dann steht hier, was mitzieht und was bleibt.';
export const FOLGEN_PRUEFEN = 'Die Folgen werden geprüft …';
export const TITEL_ZIEHT_MIT = 'Das zieht mit';
export const TITEL_BLEIBT = 'Das bleibt, wo es ist';
export const TITEL_AUSWERTUNGEN = 'Auswertungen';
export const NICHTS_BLEIBT = 'Nichts bleibt zurück.';
export const KEINE_MESSSTELLE = 'Keine Messstelle wechselt den Standort.';
/** A13: „nichts ändert sich“ steht wörtlich in der Karte. */
export const NICHTS_AENDERT_SICH = `Nichts ändert sich an Anlagen, Netzanschlüssen und ${UEMS_BOX}en — verschoben wird nur der Ort.`;
export const WEG_ANLAGE = 'Soll sie mitziehen? „Anlage zuordnen“ ist ein eigener Schritt — in den Einstellungen der Anlage.';
export const WEG_MESSSTELLE = 'Soll sie mitziehen? Ziehen Sie die Messstelle um (Messstellen).';
export const ZEITSTRAHL_TITEL = 'Zuordnungen';
export const PROTOKOLL_TITEL = 'Im Änderungsprotokoll';
export const GRUPPE_STANDORTE = 'Direkt an einem Standort';
export const GRUPPE_GEBAEUDE = 'An einem Gebäude';
export const BEGRUENDUNG_MAX = 500;

export function verschiebenTitel(name: string): string {
  return `${name} verschieben`;
}

export function zielLabel(art: VerschiebenArt): string {
  return art === 'gebaeude' ? 'Neuer Standort *' : 'Hängt künftig an *';
}

export function vorspann(art: VerschiebenArt): string {
  return art === 'gebaeude'
    ? 'Das Gebäude gehört ab dem gewählten Tag zu einem anderen Standort — seine Bereiche ziehen mit. Anlagen und Netzanschlüsse ziehen nicht mit.'
    : 'Der Bereich hängt ab dem gewählten Tag an einem anderen Gebäude oder direkt an einem Standort.';
}

export interface VerschiebenForm {
  zielId: string | null;
  gueltigAb: Tag | null;
  begruendung: string;
}

export type VerschiebenFeld = 'zielId' | 'gueltigAb' | 'begruendung';
export type VerschiebenFehler = Partial<Record<VerschiebenFeld, string>>;

/** Der Dialog öffnet ohne Wahl, „gültig ab“ heute. */
export function verschiebenStart(heute: Tag): VerschiebenForm {
  return { zielId: null, gueltigAb: heute, begruendung: '' };
}

/**
 * Die Zielliste aus `aktionen.verschieben.ziele` des Servers — der bisherige Elternknoten ist dort schon
 * nicht dabei, ein Bereich nie. Ein Gebäude wählt einen Standort; ein Bereich ein Gebäude (mit seinem
 * Standort) oder einen Standort direkt.
 */
export function zielOptionen(
  art: VerschiebenArt,
  ziele: OrtVerschiebenZiel[],
): { options: VpOption[]; groups: VpGruppe[] | undefined } {
  const standorte = ziele.filter((z) => z.art === 'standort');
  if (art === 'gebaeude') {
    return { options: standorte.map((z) => ({ value: z.id, label: `${z.name} (${z.kurzzeichen})` })), groups: undefined };
  }
  const gebaeude = ziele.filter((z) => z.art === 'gebaeude');
  const groups: VpGruppe[] = [];
  if (gebaeude.length) groups.push({ key: 'gebaeude', label: GRUPPE_GEBAEUDE });
  if (standorte.length) groups.push({ key: 'standorte', label: GRUPPE_STANDORTE });
  return {
    options: [
      ...gebaeude.map((z) => ({ value: z.id, label: `${z.name} (${z.kurzzeichen})`, sub: z.standortName, group: 'gebaeude' })),
      ...standorte.map((z) => ({ value: z.id, label: `${z.name} (${z.kurzzeichen})`, group: 'standorte' })),
    ],
    groups,
  };
}

/** Was vor dem Senden fehlt — dieselben Grenzen wie der Server. */
export function pruefeVerschieben(f: VerschiebenForm, art: VerschiebenArt): VerschiebenFehler {
  const fehler: VerschiebenFehler = {};
  if (!f.zielId) {
    fehler.zielId =
      art === 'gebaeude'
        ? 'Bitte wählen Sie den Standort, zu dem das Gebäude gehören soll.'
        : 'Bitte wählen Sie, woran der Bereich künftig hängt.';
  }
  if (!f.gueltigAb) fehler.gueltigAb = 'Bitte geben Sie an, ab welchem Tag die Zuordnung gilt.';
  if ([...f.begruendung.trim()].length > BEGRUENDUNG_MAX) {
    fehler.begruendung = `Die Begründung darf höchstens ${BEGRUENDUNG_MAX} Zeichen lang sein.`;
  }
  return fehler;
}

/** Der Rumpf von `POST …/verschieben`; `null`, solange etwas fehlt. Eine leere Begründung wird nicht gesendet. */
export function verschiebenAnfrage(f: VerschiebenForm, art: VerschiebenArt): OrtVerschiebenAnfrage | null {
  if (Object.keys(pruefeVerschieben(f, art)).length > 0 || !f.zielId || !f.gueltigAb) return null;
  const begruendung = f.begruendung.trim();
  return { zielId: f.zielId, gueltigAb: f.gueltigAb, ...(begruendung ? { begruendung } : {}) };
}

/** Wohin der Satz des Servers gehört (`feld` der Ablehnung); `null`: über die ganze Form. */
export function verschiebenFeldAusServer(f: OrtFehler): VerschiebenFeld | null {
  const feld = (f as OrtFehler & { feld?: unknown }).feld;
  return feld === 'zielId' || feld === 'gueltigAb' || feld === 'begruendung' ? feld : null;
}

/** „Werk Ahrenberg Nord (ST-3)“ */
export function knotenText(k: OrtVerschiebungKnoten | null): string {
  if (!k) return 'unbekannt';
  const name = k.name ?? 'unbekannt';
  return k.kurzzeichen ? `${name} (${k.kurzzeichen})` : name;
}

function gross(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function aufzaehlung(worte: string[]): string {
  return worte.length <= 1 ? (worte[0] ?? '') : `${worte.slice(0, -1).join(', ')} und ${worte[worte.length - 1]}`;
}

/** V2: was der gewählte Tag bedeutet — so, wie der Server ihn eingeordnet hat. */
export function zeitpunktSatz(v: OrtVerschiebung): string {
  if (v.rueckwirkung.art === 'geplant') {
    return `Geplant: bis ${datumText(plusTage(v.gueltigAb, -1))} bleibt alles, wie es ist.`;
  }
  if (v.rueckwirkung.art === 'rueckwirkend') {
    const abzeichen = v.rueckwirkung.abzeichen ?? `rückwirkend (${v.rueckwirkung.tage} Tage)`;
    return `${gross(abzeichen)}: wird im Änderungsprotokoll so gekennzeichnet.`;
  }
  return 'Gilt ab heute.';
}

export interface VerschiebenKarte {
  ziehtMit: string[];
  bleibt: { satz: string; weg: string | null }[];
  auswertungen: string[];
  nichts: string;
}

function messstelleName(m: OrtVerschiebungMessstelle): string {
  return m.name ? `${m.kennzeichen} ${m.name}` : m.kennzeichen;
}

/** V3: die Folgen-Karte aus der Antwort des Servers — Vorschau und Ergebnis sprechen gleich. */
export function folgenKarte(v: OrtVerschiebung): VerschiebenKarte {
  const ab = datumText(v.gueltigAb);
  const vortag = datumText(plusTage(v.gueltigAb, -1));
  const gebaeude = v.art === 'gebaeude';
  const f = v.folgen;

  const ziehtMit = [
    gebaeude
      ? `Ab ${ab} gehört ${v.name} zu ${knotenText(v.neuStandort ?? v.neu)}.`
      : `Ab ${ab} hängt ${v.name} an ${knotenText(v.neu)}.`,
    `Bis ${vortag} bleibt es bei ${knotenText(gebaeude ? (v.bisherStandort ?? v.bisher) : v.bisher)}.`,
  ];
  if (v.gueltigBis) {
    ziehtMit.push(
      v.danach
        ? `Die neue Zuordnung endet am ${datumText(v.gueltigBis)}: ab ${datumText(plusTage(v.gueltigBis, 1))} gilt die schon geplante zu ${knotenText(v.danach)}.`
        : `Die neue Zuordnung endet am ${datumText(v.gueltigBis)}.`,
    );
  }
  const bereiche = f.ziehenMit.map((k) => k.name ?? k.kurzzeichen ?? 'unbekannt');
  if (bereiche.length === 1) ziehtMit.push(`Der Bereich ${bereiche[0]} zieht mit.`);
  if (bereiche.length > 1) ziehtMit.push(`Die Bereiche ${aufzaehlung(bereiche)} ziehen mit.`);
  const ms = f.messstellenWechselnStandort.map((m) => m.kennzeichen);
  if (ms.length === 1) {
    ziehtMit.push(`Die Messstelle ${ms[0]} wechselt ab ${ab} den Standort — sie bleibt an ihrem Ort.`);
  } else if (ms.length > 1) {
    ziehtMit.push(`Die Messstellen ${aufzaehlung(ms)} wechseln ab ${ab} den Standort — sie bleiben an ihrem Ort.`);
  } else {
    ziehtMit.push(KEINE_MESSSTELLE);
  }

  const bleibt: VerschiebenKarte['bleibt'] = [
    ...f.bleibenAnlagen.map((a) => ({
      satz: `Die Anlage „${a.name}“ bleibt bei ${knotenText(a.standort)}.`,
      weg: WEG_ANLAGE,
    })),
    ...f.bleibenNetzanschluesse.map((n) => ({ satz: `Der ${UEMS_NETZANSCHLUSS} ${n.kennzeichen} bleibt, wo er ist.`, weg: null })),
    ...f.bleibenMessstellen.map((m) => ({
      satz:
        m.ort?.art === 'standort'
          ? `${messstelleName(m)} hängt direkt am Standort ${m.ort.name ?? ''} und bleibt dort.`
          : `${messstelleName(m)} hängt an ${m.ort?.name ?? 'ihrem Ort'} und bleibt dort.`,
      weg: WEG_MESSSTELLE,
    })),
  ];

  const auswertungen: string[] = [];
  const vorher = v.bisherStandort;
  const nachher = v.neuStandort;
  if (vorher && nachher && vorher.id !== nachher.id) {
    auswertungen.push(`Auswertungen bis ${vortag} zählen ${v.name} bei ${vorher.name}, ab ${ab} bei ${nachher.name}.`);
  } else {
    auswertungen.push(`Die Auswertungen der Standorte ändern sich nicht — ${v.name} bleibt bei ${nachher?.name ?? vorher?.name ?? 'seinem Standort'}.`);
  }
  if (v.rueckwirkung.art === 'rueckwirkend' && v.rueckwirkendBetroffen) {
    const abzeichen = v.rueckwirkung.abzeichen ?? `rückwirkend (${v.rueckwirkung.tage} Tage)`;
    auswertungen.push(
      `${gross(abzeichen)}: Auswertungen vom ${datumText(v.rueckwirkendBetroffen.von)} bis ${datumText(v.rueckwirkendBetroffen.bis)} zählen nachträglich anders.`,
    );
  }
  return { ziehtMit, bleibt, auswertungen, nichts: NICHTS_AENDERT_SICH };
}

/** V4: der Kopf nach dem Speichern. */
export function ergebnisSatz(v: OrtVerschiebung): string {
  return v.art === 'gebaeude'
    ? `${v.name} gehört ab ${datumText(v.gueltigAb)} zu ${knotenText(v.neuStandort ?? v.neu)}.`
    : `${v.name} hängt ab ${datumText(v.gueltigAb)} an ${knotenText(v.neu)}.`;
}

const ZUSTAND: Record<'gueltig' | 'geplant' | 'beendet', ZeitstrahlAbschnitt['zustand']> = {
  gueltig: 'gilt',
  geplant: 'geplant',
  beendet: 'beendet',
};

/** V4: der Zeitstrahl — die Zuordnungen, wie der Server sie nach dem Eintrag gelesen hat, ohne aufgehobene. */
export function zeitstrahl(v: OrtVerschiebung): ZeitstrahlAbschnitt[] {
  return v.zuordnungen.flatMap((z) =>
    z.zustand === 'aufgehoben'
      ? []
      : [
          {
            schluessel: `${z.gueltigAb}-${z.eltern.id ?? z.eltern.kurzzeichen}`,
            titel: knotenText(z.eltern),
            zeitraum: z.gueltigBis ? `${datumText(z.gueltigAb)} – ${datumText(z.gueltigBis)}` : `ab ${datumText(z.gueltigAb)}`,
            zustand: ZUSTAND[z.zustand],
          },
        ],
  );
}

export interface ProtokollZeile {
  zeit: string;
  was: string;
  giltAb: string;
  wer: string;
}

/** V4: der Protokolleintrag — Zeit · was · gilt ab · wer; die Zeit, wie der Server sie am Standort nennt. */
export function protokollZeile(v: OrtVerschiebung, e: OrtVerschiebung['protokoll'][number]): ProtokollZeile {
  const [tag, uhr = ''] = e.eingetragenAm.split('T');
  const abzeichen = e.rueckwirkend ? ` · ${v.rueckwirkung.abzeichen ?? 'rückwirkend'}` : '';
  return {
    zeit: uhr ? `${datumText(tag)}, ${uhr.slice(0, 5)} Uhr` : datumText(tag),
    was: e.text,
    giltAb: `gilt ab ${datumText(e.giltAb)}${abzeichen}`,
    wer: e.wer,
  };
}

/** V4: das Abzeichen am Knoten, der bis zum Stichtag noch beim alten Elternknoten steht. */
export function danachAbzeichen(d: OrtsbaumDanach): string {
  return `ab ${datumText(d.ab)} → ${d.elternName ?? d.standortName ?? 'neuer Ort'}`;
}
