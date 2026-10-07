/**
 * Der Stand je Teil für den Überblick von Nachweisen (Konzept Nachweisen n1, Runde 2, §6.3, Entscheide 3, 4 und 5).
 *
 * Reines Modul: es leitet aus vorhandenen Routen ab (Entscheid 4: erst Portal, eine eigene Route erst, wenn andere
 * Leser sie brauchen) - aus dem Verzeichnis (`…/verzeichnis`), den Dokumenten (`…/dokumente`), der Wiedervorlage
 * (`…/wiedervorlage`) und den Vermerken „Trifft bei uns zurzeit nicht zu“ (`…/teil-vermerke`). Kein React, kein Netz.
 *
 * Die Teile sind das Vokabular `teil` des Vertrags energiemanagement 1.3, Name und Kurzwort kommen aus `WOERTER`. Die
 * vier Gruppen ordnet nur das Portal. Vier Zustände je Teil: festgehalten, offen (noch nichts festgehalten), ein Entwurf
 * wartet, eine Frist ist abgelaufen. Gezählt wird nur, was offen oder überfällig ist (Entscheid 3, G4): nie eine Zahl über
 * das Ganze, nie ein Urteil - ein festgehaltener Teil ist festgehalten, nicht „erfüllt“.
 */
import type { EnergiemanagementDokumentKurz, EnergiemanagementTeilVermerk, EnergiemanagementVerzeichnis, Selbstauskunft } from './api';
import { darfAnsehen as darfBewertungSehen } from './bewertung';
import { darfAnsehen as darfVerbesserungSehen } from './energieziele';
import { artFilterSprung, seitenSprung, type Sprung } from './entscheid';
import { VOKABULARE, WOERTER } from './energiemanagement';
import { dokumentRoute, energiemanagementRoute, pageRoute, verbesserungRoute, type Route } from './nav';
import { ANSEHEN as KENNZAHLEN_ANSEHEN } from './uemsKennzahl';
import { arbeitsliste, berichtName, standTag, type Eintrag, type Wiedervorlage, type WiedervorlageArt } from './wiedervorlage';

// ------------------------------------------------------------------ Teile und Gruppen

export type TeilGruppeKey = 'grundlagen' | 'menschen_ablaeufe' | 'messen_verbessern' | 'pruefen_rueckblick';

/** Die vier Gruppen des Überblicks mit ihren Teilen, in der Reihenfolge des Vokabulars `teil`. */
export const TEIL_GRUPPEN: readonly { key: TeilGruppeKey; wort: string; teile: readonly string[] }[] = [
  { key: 'grundlagen', wort: 'Grundlagen', teile: ['energiepolitik', 'anwendungsbereich', 'rechtliche_anforderungen', 'kontext', 'risiken_chancen'] },
  { key: 'menschen_ablaeufe', wort: 'Menschen und Abläufe', teile: ['aufgaben', 'kompetenz', 'kommunikation', 'betrieb', 'auslegung', 'beschaffung'] },
  { key: 'messen_verbessern', wort: 'Messen und Verbessern', teile: ['energetische_bewertung', 'bezugsbasen', 'massnahmen'] },
  { key: 'pruefen_rueckblick', wort: 'Prüfen und Rückblick', teile: ['interne_audits', 'feststellungen', 'managementbewertung', 'berichte'] },
];

/**
 * Teile, die ein Dokument festhält, mit ihrer Dokument-Art: „Festhalten“ legt ein Dokument dieser Art an. Die übrigen
 * Teile entstehen an ihrem Ort (Aufgaben, Bewertung, Kennzahlen, Maßnahmen, Audits, Managementbewertung, Berichte).
 */
export const TEIL_DOKUMENT_ART: Readonly<Record<string, string>> = {
  energiepolitik: 'energiepolitik',
  anwendungsbereich: 'anwendungsbereich',
  rechtliche_anforderungen: 'rechtliche_anforderungen',
  kontext: 'kontext',
  risiken_chancen: 'risiken_chancen',
  kompetenz: 'kompetenz',
  kommunikation: 'kommunikation',
  betrieb: 'betrieb',
  auslegung: 'auslegung',
  beschaffung: 'beschaffung',
};

/** Die Dokument-Arten, die einen Teil festhalten - die „Bestellung“ gehört zu den Aufgaben, das „Vorgehen“ zu keinem. */
const ART_TEIL: Readonly<Record<string, string>> = {
  ...TEIL_DOKUMENT_ART,
  bestellung: 'aufgaben',
  aufgabe: 'aufgaben',
  bekanntmachung: 'kommunikation',
  betrachtungsumfang: 'energetische_bewertung',
  internes_audit: 'interne_audits',
  feststellung: 'feststellungen',
  wirksamkeit: 'feststellungen',
};

/** Eine Verzeichnis-Zeile, deren Art keinen Teil nennt, gehört zum Teil ihrer Gruppe (der Berichtsstand etwa). */
const GRUPPE_TEIL: Readonly<Record<string, string>> = {
  verantwortung: 'aufgaben',
  risiken_chancen: 'risiken_chancen',
  bewertung_messplanung: 'energetische_bewertung',
  kennzahlen_bezugsbasen: 'bezugsbasen',
  ziele_massnahmen_abweichungen: 'massnahmen',
  managementbewertung: 'managementbewertung',
  berichte: 'berichte',
};

/** Der Teil einer Zeile des Verzeichnisses; `null`, wo sie keinen nennt (das „Vorgehen“) oder ein Vermerk ist. */
export function teilDerZeile(z: { gruppe: string; art: string }): string | null {
  if (z.art === 'teil_vermerk') return null;
  if (z.art !== 'berichtsstand' && ART_TEIL[z.art]) return ART_TEIL[z.art];
  return GRUPPE_TEIL[z.gruppe] ?? null;
}

/** Der Teil einer Frist der Wiedervorlage; eine Überprüfung gehört zum Teil ihres Dokuments, die Ablesung zu keinem. */
const FRIST_TEIL: Readonly<Record<WiedervorlageArt, string | null>> = {
  dokument_ueberpruefung: null,
  internes_audit: 'interne_audits',
  managementbewertung: 'managementbewertung',
  feststellung: 'feststellungen',
  bewertung_ueberpruefung: 'energetische_bewertung',
  bezugsbasis_ueberpruefung: 'bezugsbasen',
  energieziel_bewertung: 'massnahmen',
  massnahme_termin: 'massnahmen',
  abweichung_frist: 'massnahmen',
  messbedarf_frist: 'energetische_bewertung',
  bericht_anstoss: 'berichte',
  zaehlerablesung: null,
};

/** Wo ein Teil lebt: dorthin führt seine Zeile im Blatt der Gruppe. */
const TEIL_ORT: Readonly<Record<string, Route>> = {
  aufgaben: energiemanagementRoute('aufgaben'),
  energetische_bewertung: pageRoute('portfolio-bewertung'),
  bezugsbasen: pageRoute('portfolio-kennzahlen'),
  massnahmen: verbesserungRoute('massnahmen'),
  interne_audits: energiemanagementRoute('audits'),
  feststellungen: energiemanagementRoute('feststellungen'),
  managementbewertung: energiemanagementRoute('managementbewertung'),
  berichte: pageRoute('portfolio-berichte'),
};

type Rechte = Pick<Selbstauskunft, 'standorte' | 'unternehmen_rechte'>;

/**
 * Die Orte außerhalb des Energiemanagements, die ein eigenes Recht zum Ansehen brauchen (Review Nachweisen r1, P1-5):
 * dieselben Rechte, mit denen die Navigation diese Bereiche zeigt (`ebenenNav.ebenenBereiche`) bzw. die Route der
 * Kennzahlen liest. Unbekannte Rechte (ohne Selbstauskunft) sind nein.
 */
const ORT_RECHT: Readonly<Record<string, (s: Rechte | null | undefined) => boolean>> = {
  energetische_bewertung: darfBewertungSehen,
  bezugsbasen: (s) => !!s && (s.unternehmen_rechte.includes(KENNZAHLEN_ANSEHEN) || s.standorte.some((st) => st.rechte.includes(KENNZAHLEN_ANSEHEN))),
  massnahmen: darfVerbesserungSehen,
};

// ------------------------------------------------------------------ Wörter

export const TEILE_OFFEN = 'Teile offen';
export const TEIL_OFFEN = 'Teil offen';
export const FRISTEN_UEBERFAELLIG = 'Fristen überfällig';
export const FRIST_UEBERFAELLIG = 'Frist überfällig';
export const TRIFFT_NICHT_ZU = 'Trifft bei uns zurzeit nicht zu';
/** Der Fakt eines Teils mit Vermerk, kurz für die Zeile im Blatt. */
export const TRIFFT_NICHT_ZU_KURZ = 'trifft zurzeit nicht zu';
export const ENTWURF_WARTET = 'Entwurf wartet';
export const FESTHALTEN = 'Festhalten';
export const DEMNAECHST = 'Demnächst';
export const TEILE = 'Teile';
export const IN_DER_WIEDERVORLAGE = 'In der Wiedervorlage';
export const WIEDERVORLAGE_LINK = 'Alle';

/** „4 Teile offen“ - Einzahl und Mehrzahl. */
export const offenWort = (n: number) => (n === 1 ? TEIL_OFFEN : TEILE_OFFEN);
/** „6 Fristen überfällig“ - Einzahl und Mehrzahl. */
export const ueberfaelligWort = (n: number) => (n === 1 ? FRIST_UEBERFAELLIG : FRISTEN_UEBERFAELLIG);

/** Der Knopf des nächsten Schritts je Art einer Frist aus Nachweisen. */
const NAECHST_KNOPF: Partial<Record<WiedervorlageArt, string>> = {
  bericht_anstoss: 'Entscheiden',
  dokument_ueberpruefung: 'Prüfen',
  internes_audit: 'Planen',
  managementbewertung: 'Vorbereiten',
  feststellung: 'Prüfen',
};

// ------------------------------------------------------------------ Bild

export type TeilZustand = 'festgehalten' | 'offen' | 'entwurf' | 'ueber';

export interface TeilStand {
  teil: string;
  /** Der Name des Teils (Blatt einer Gruppe), `WOERTER.teil`. */
  wort: string;
  /** Das Kurzwort (Chip), `WOERTER.teil_kurz` (Entscheid 23). */
  kurz: string;
  zustand: TeilZustand;
  /** Höchstens ein kurzer Fakt für die Zeile im Blatt: „Fassung 2“, „seit 13.11.2027“; ohne Eintrag `null`. */
  fakt: string | null;
  /** Die abgelaufenen Fristen dieses Teils, die älteste zuerst. */
  ueberfaellig: Eintrag[];
  /** Der geltende Vermerk „Trifft bei uns zurzeit nicht zu“. */
  vermerk: EnergiemanagementTeilVermerk | null;
  /** Die Dokument-Art, unter der „Festhalten“ ein Dokument anlegt; `null`: der Teil entsteht an seinem Ort. */
  dokumentArt: string | null;
  /** Wo der Teil lebt: das eine Dokument, die Liste der Dokumente oder die Fläche, auf der er entsteht. */
  ort: Route;
  /** Darf die Person diesen Ort sehen? Sonst führt nichts dorthin (die Seite hätte für sie keinen Inhalt). */
  ortSichtbar: boolean;
  /** Der Sprung eines überfälligen Teils: die eine Frist mit offenem Entscheid, sonst die Wiedervorlage nach Art. */
  fristSprung: Sprung | null;
}

export interface TeilGruppe {
  key: TeilGruppeKey;
  wort: string;
  teile: TeilStand[];
}

export type AlsNaechstes =
  | { art: 'frist'; eintrag: Eintrag; titel: string; knopf: string; sprung: Sprung | null }
  | { art: 'entwurf'; titel: string; knopf: string; sprung: Sprung }
  | { art: 'festhalten'; teil: TeilStand; titel: string; knopf: string };

export interface NachweisStand {
  /** Der Tag des Abrufs, „30.04.2029“ - der Tag der Route, nie der des Browsers (Entscheid 13). */
  stand: string;
  gruppen: TeilGruppe[];
  /** Alle Teile in der Reihenfolge des Vokabulars. */
  teile: TeilStand[];
  /** Teile, zu denen noch nichts festgehalten ist (ein Vermerk zählt als festgehalten). */
  offen: number;
  /** Die abgelaufenen Fristen aller Teile, die älteste zuerst; „6 Fristen überfällig“ zählt sie. */
  ueberfaellig: Eintrag[];
  naechstes: AlsNaechstes | null;
  /** Die nächsten Fristen aus Nachweisen (nicht abgelaufen), ohne die von „Als Nächstes“. */
  demnaechst: Eintrag[];
}

export interface NachweisEingang {
  verzeichnis: EnergiemanagementVerzeichnis;
  dokumente: readonly EnergiemanagementDokumentKurz[];
  /** Ohne Wiedervorlage (Ladefehler) gibt es keine Fristen - sie werden nicht geraten, und es gibt kein „Als Nächstes“. */
  wiedervorlage: Wiedervorlage | null;
  vermerke: readonly EnergiemanagementTeilVermerk[];
  /** Die Rechte der Person aus `/me`: sie entscheiden, wohin ein Teil führt (`ortSichtbar`). */
  rechte?: Rechte | null;
}

/** Der Fakt eines Teils: nur das Besondere bekommt ein Wort (§0.3 Regel 3). */
function faktVon(
  zustand: TeilZustand,
  ueber: Eintrag[],
  vermerk: EnergiemanagementTeilVermerk | null,
  dokumente: EnergiemanagementDokumentKurz[],
  zuletzt: string | null,
): string | null {
  if (zustand === 'ueber') return ueber.length === 1 ? `seit ${ueber[0].frist.tag}${ueber[0].frist.jahr}` : `${ueber.length} überfällig`;
  if (zustand === 'entwurf') return ENTWURF_WARTET;
  if (zustand === 'offen') return null;
  const gueltig = dokumente.filter((d) => d.zustand === 'gueltig');
  if (gueltig.length === 1 && gueltig[0].gueltige_fassung) return `Fassung ${gueltig[0].gueltige_fassung}`;
  if (gueltig.length > 1) return gueltig.every((d) => d.klasse === 'nachweis') ? `${gueltig.length} Nachweise` : `${gueltig.length} Dokumente`;
  if (zuletzt) return `zuletzt ${standTag(zuletzt)}`;
  return vermerk ? TRIFFT_NICHT_ZU_KURZ : null;
}

/**
 * Das Bild des Überblicks aus den vier Routen. Zustand je Teil: abgelaufene Frist vor wartendem Entwurf vor
 * festgehalten (Verzeichnis, gültiges Dokument oder Vermerk) vor offen.
 */
export function nachweisStand(e: NachweisEingang): NachweisStand {
  const liste = e.wiedervorlage ? arbeitsliste(e.wiedervorlage) : null;
  const dokumentArt = new Map(e.dokumente.map((d) => [d.kennzeichen, d.art]));
  const fristTeil = (x: Eintrag): string | null =>
    x.art === 'dokument_ueberpruefung' ? (ART_TEIL[dokumentArt.get(x.kennzeichen) ?? ''] ?? null) : FRIST_TEIL[x.art] ?? null;

  // Ein aufgehobenes Dokument hält seinen Teil nicht mehr fest: seine Zeilen bleiben im Verzeichnis (dort ist es
  // Geschichte), zählen hier aber nicht (Review Nachweisen r1, P1-8).
  const aufgehoben = new Set(e.dokumente.filter((d) => d.zustand === 'aufgehoben').map((d) => d.kennzeichen));
  const zeilenJeTeil = new Map<string, string[]>();
  for (const g of e.verzeichnis.gruppen) {
    for (const z of g.zeilen) {
      const teil = teilDerZeile(z);
      if (!teil || aufgehoben.has(z.kennzeichen)) continue;
      const tage = zeilenJeTeil.get(teil) ?? [];
      tage.push(z.tag ?? '');
      zeilenJeTeil.set(teil, tage);
    }
  }
  const geltend = new Map(e.vermerke.filter((v) => !v.aufgehoben).map((v) => [v.teil, v]));
  // EINE Menge für den Zähler „Fristen überfällig“, sein Blatt und „Als Nächstes“: was einen Teil hat und was aus
  // Nachweisen selbst kommt (die Überprüfung eines Vorgehens etwa hat keinen Teil). Zwei Mengen widersprachen sich:
  // „Keine Frist überfällig“ neben einer Frist im Warnton (Review Nachweisen r1, P1-3).
  const ueberAlle = liste ? liste.ueberfaellig.filter((x) => fristTeil(x) !== null || x.bereich === 'nachweisen') : [];

  const teile: TeilStand[] = VOKABULARE.teil.map((teil) => {
    const art = TEIL_DOKUMENT_ART[teil] ?? (teil === 'aufgaben' ? 'bestellung' : null);
    const docs = e.dokumente.filter((d) => art !== null && d.art === art && d.zustand !== 'aufgehoben');
    const ueber = ueberAlle.filter((x) => fristTeil(x) === teil);
    const tage = zeilenJeTeil.get(teil) ?? [];
    const vermerk = geltend.get(teil) ?? null;
    const festgehalten = tage.length > 0 || docs.some((d) => d.zustand === 'gueltig') || vermerk !== null;
    const zustand: TeilZustand =
      ueber.length > 0 ? 'ueber' : docs.some((d) => d.zustand === 'entwurf') && !docs.some((d) => d.zustand === 'gueltig') ? 'entwurf' : festgehalten ? 'festgehalten' : 'offen';
    const zuletzt = tage.filter(Boolean).sort().pop() ?? null;
    const ort = TEIL_ORT[teil] ?? (docs.length === 1 ? dokumentRoute(docs[0].id) : energiemanagementRoute('dokumente'));
    const arten = [...new Set(ueber.map((x) => x.art))];
    const fristSprung =
      ueber.length === 1 ? ueber[0].sprung : arten.length === 1 && ueber.length > 1 ? artFilterSprung(energiemanagementRoute('wiedervorlage'), arten[0]) : ueber.length > 0 ? seitenSprung(ort) : null;
    return {
      teil,
      wort: WOERTER.teil[teil],
      kurz: WOERTER.teil_kurz[teil],
      zustand,
      fakt: faktVon(zustand, ueber, vermerk, docs, zuletzt),
      ueberfaellig: ueber,
      vermerk,
      dokumentArt: TEIL_DOKUMENT_ART[teil] ?? null,
      ort,
      ortSichtbar: ORT_RECHT[teil]?.(e.rechte) ?? true,
      fristSprung,
    };
  });
  const jeTeil = new Map(teile.map((t) => [t.teil, t]));
  const gruppen = TEIL_GRUPPEN.map((g) => ({ key: g.key, wort: g.wort, teile: g.teile.map((t) => jeTeil.get(t)!) }));

  // Ohne Wiedervorlage ist unbekannt, ob etwas überfällig ist - dann steht kein nächster Schritt da (P1-2).
  const naechstes = liste ? alsNaechstes(e, ueberAlle, teile) : null;
  const kommend = liste ? [...liste.bald, ...liste.jahresplan].filter((x) => x.bereich === 'nachweisen') : [];
  const demnaechst = kommend.filter((x) => !(naechstes?.art === 'frist' && naechstes.eintrag.key === x.key));

  return {
    stand: e.wiedervorlage ? standTag(e.wiedervorlage.stichtag) : standTag(e.verzeichnis.stichtag),
    gruppen,
    teile,
    offen: teile.filter((t) => t.zustand === 'offen').length,
    ueberfaellig: ueberAlle,
    naechstes,
    demnaechst,
  };
}

/**
 * Wohin ein Teil führt, für eine Person (Review Nachweisen r1, P1-4/P1-5): ein überfälliger zur Frist, ein offener ins
 * Festhalten - aber nur, wer das Energiemanagement bearbeitet; ein Teil mit Vermerk ins Blatt des Vermerks (lesen
 * dürfen alle, aufheben nur mit Recht); sonst an seinen Ort, wenn die Person ihn sehen darf. `null`: nichts zu öffnen.
 */
export type TeilZiel = 'frist' | 'festhalten' | 'vermerk' | 'ort';

export function teilZiel(t: TeilStand, darfFesthalten: boolean): TeilZiel | null {
  if (t.zustand === 'ueber' && t.fristSprung) return 'frist';
  if (t.zustand === 'offen' && darfFesthalten) return 'festhalten';
  if (t.vermerk) return 'vermerk';
  return t.ortSichtbar ? 'ort' : null;
}

/**
 * „Als Nächstes“ (§6.3, Regel der ersten Fassung): zuerst das am längsten Überfällige aus Nachweisen selbst (Bericht,
 * Dokument, Audit, Managementbewertung, Feststellung), dann ein wartender Entwurf, dann der erste offene Teil. Was die
 * Nachbarn schulden (Bezugsbasen in Auswerten, Maßnahmen in Verbessern), steht im Warnton an seinem Teil und führt
 * dorthin, wo es erledigt wird. Ist nichts offen und nichts überfällig, steht nichts da - die nächste Frist zeigt
 * „Demnächst“.
 */
function alsNaechstes(e: NachweisEingang, ueberfaellig: readonly Eintrag[], teile: TeilStand[]): AlsNaechstes | null {
  const frist = ueberfaellig.find((x) => x.bereich === 'nachweisen');
  if (frist) {
    const zeile = e.wiedervorlage?.faellig.find((z) => z.art === frist.art && z.kennzeichen === frist.kennzeichen);
    const titel = frist.art === 'bericht_anstoss' && zeile ? `${berichtName(zeile)} entscheiden` : frist.aufgabe;
    return { art: 'frist', eintrag: frist, titel, knopf: NAECHST_KNOPF[frist.art] ?? frist.schritt, sprung: frist.sprung };
  }
  const entwurf = e.dokumente.find((d) => d.zustand === 'entwurf');
  if (entwurf) return { art: 'entwurf', titel: `${entwurf.titel} freigeben`, knopf: 'Freigeben', sprung: seitenSprung(dokumentRoute(entwurf.id)) };
  const offen = teile.find((t) => t.zustand === 'offen');
  if (offen) return { art: 'festhalten', teil: offen, titel: `${offen.kurz} festhalten`, knopf: FESTHALTEN };
  return null;
}
