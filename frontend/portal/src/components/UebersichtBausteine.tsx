import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { GrenzHinweis, GrenzSatzBereich } from './GrenzSatz';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bericht, type Funktionen, type MessstellenRegister } from '../api';
import { darfAnsehen } from '../bewertung';
import { bewertungFristBaustein, type BewertungFristBild } from '../bewertungFrist';
import { bezugsbasisUebersichtBild, type BezugsbasisUebersicht, type BezugsbasisUebersichtBild } from '../bezugsbasisUebersicht';
import { misst } from '../ebenenNav';
import { bearbeiterStandorte, type ObenBaustein } from '../einstieg';
import { darfAnsehen as darfVerbesserungSehen } from '../energieziele';
import { UEMS_ENERGIEBILANZ, UEMS_GEBAEUDE, UEMS_KENNZAHLEN } from '../glossar';
import { heuteIn, listenKarte, ZUR_LISTE } from '../kennzahlKarte';
import {
  abweichungRoute,
  energiemanagementRoute,
  energiezielRoute,
  kennzahlRoute,
  massnahmeRoute,
  pageRoute,
  standortBereichRoute,
  verbesserungRoute,
  type Route,
} from '../nav';
import type { UebersichtEbene } from '../uebersicht';
import { verbesserungUebersichtBild, type VerbesserungUebersicht, type VerbesserungUebersichtBild } from '../verbesserungUebersicht';
import { wasStehtAn, wiedervorlageStatus, type WasStehtAnBild, type Wiedervorlage, type WiedervorlageStatus } from '../wiedervorlage';
import {
  BILANZ_PERIODEN,
  MESSSTELLEN_TITEL,
  NETZBEZUG,
  bausteineMitInhalt,
  blaettere,
  ende,
  energiebilanzBaustein,
  gebaeudeZeilen,
  kennzahlenDerEbene,
  laeuftNoch,
  letzterGebildeter,
  messstellenBaustein,
  zeitraumText,
  type AnlageBilanz,
  type BilanzPeriode,
  type GebaeudeEingang,
  type UebersichtBausteinId,
} from '../uebersichtBausteine';
import { useRollen } from '../rollen';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { BewertungBaustein } from './BewertungBaustein';
import { StandortKarte } from './EinstiegKarten';
import { BezugsbasisUebersichtKarte } from './BezugsbasisUebersichtKarte';
import { EnergiemanagementBaustein } from './EnergiemanagementBaustein';
import { ZeitSegment } from './HistorieWelt';
import { KennzahlKarte, useKennzahlenListe } from './KennzahlListe';
import { VerbesserungUebersichtKarte } from './VerbesserungUebersichtKarte';
import './UebersichtBausteine.css';

/**
 * Die Übersichts-Bausteine je Ebene (UEMS AP-13 IP-7, E3 = A, Ü1–Ü5): „Messstellen“, „Energiebilanz“ (am Standort
 * mit den Gebäude-Zeilen) und „Kennzahlen“ unter der Anlagen-Tabelle der Unternehmens- und der Standort-Übersicht.
 * Jede Ableitung steht im reinen Modul `uebersichtBausteine.ts`; hier wird nur geladen und gerendert.
 */

type Gebaeude = { id: string; kurzzeichen: string; name: string };

export interface UebersichtDaten {
  ebene: UebersichtEbene;
  heute: string;
  periode: BilanzPeriode;
  am: string;
  waehle: (periode: BilanzPeriode, am: string) => void;
  register: MessstellenRegister | null;
  /** Die zuletzt geladenen Bilanzen je Anlage — `laedt`: sie gehören (noch) nicht zum gewählten Zeitraum. */
  anlagen: AnlageBilanz[] | null;
  laedt: boolean;
  gebaeude: GebaeudeEingang[];
  kennzahlen: ReturnType<typeof useKennzahlenListe>;
  /** AP-16 IP-24: die gültige Bewertung am Unternehmen — nur mit `energieeinsatz.ansehen` und einem Stand. */
  bewertung: BewertungFristBild | null;
  /** AP-17 IP-17: laufende Bezugsbasen am Unternehmen — `null` ohne laufende Basis (R10: keine neue Kachel). */
  bezugsbasen?: BezugsbasisUebersichtBild | null;
  /** AP-18 IP-19: „Ziele und Maßnahmen“ am Unternehmen — `null` ohne Vorgang im Zaun (R13: keine neue Kachel). */
  zieleMassnahmen?: VerbesserungUebersichtBild | null;
  /** AP-19 IP-21 (WV5): „Was steht an“ am Unternehmen; `null` ohne jede Frist der Wiedervorlage. */
  energiemanagement?: WasStehtAnBild | null;
  /**
   * Konzept Wiedervorlage w1, Entscheid 9: die Eskalation für die Statuszeile der Übersicht (Status-Variante A des
   * Portfolio-Konzepts): nur bei Überfälligem, sonst `null`; dieselbe Wiedervorlage wie „Was steht an“.
   */
  wiedervorlageStatus?: WiedervorlageStatus | null;
  /** Die Bausteine MIT Inhalt — nur sie bietet die Fläche an. */
  inhalt: UebersichtBausteinId[];
  /** Die lebenden Standorte der Ebene und ob sie messen — für den Einstieg „Ihr Standort“ (K6). */
  standorte: { id: string; name: string; misst: boolean }[];
}

/**
 * Lädt, was die Bausteine brauchen — nur mit einer messenden Ebene (`null`/ohne Messfunktion fragt nichts Neues ab):
 * das Register, je Anlage ihre Bilanz im Zeitraum der Leiste, am Standort Ortsbaum und Register je Gebäude (heute für
 * die Datenlage, am letzten Tag des Zeitraums für „im Gebäude“), und die Kennzahlen.
 */
export function useUebersichtBausteine(
  ebene: UebersichtEbene | null,
  anlagen: readonly { id: string; name: string }[],
  funktionen: Funktionen | null,
): UebersichtDaten | null {
  // E2/Q2/O18: auch vorhandene Gebäude begründen keinen Messdaten-Baustein.
  const standorte = ebene?.art === 'standort' ? [ebene.standort] : ebene?.standorte ?? [];
  const lm = { standorte, funktionen, kennzahlen: null };
  const an = standorte.some((s) => s.zustand !== 'archiviert' && misst(lm, s.id));
  const standortId = an && ebene?.art === 'standort' ? ebene.standort.id : null;
  const zone = ebene?.art === 'standort' ? ebene.standort.zeitzone : VORGABE_ZEITZONE;
  const heute = heuteIn(zone, Date.now());
  const [wahl, setWahl] = useState<{ periode: BilanzPeriode; am: string }>(() => ({
    periode: 'monat',
    am: letzterGebildeter('monat', heute),
  }));

  const [register, setRegister] = useState<MessstellenRegister | null>(null);
  useEffect(() => {
    if (!an) return;
    let aktiv = true;
    api.messstellenRegister().then(
      (r) => aktiv && setRegister(r),
      () => aktiv && setRegister(null),
    );
    return () => {
      aktiv = false;
    };
  }, [an]);

  const anlagenSchluessel = JSON.stringify(anlagen.map((a) => ({ id: a.id, name: a.name })));
  const bilanzSchluessel = `${anlagenSchluessel}|${wahl.periode}|${wahl.am}`;
  const [bilanzen, setBilanzen] = useState<{ schluessel: string; anlagen: AnlageBilanz[] } | null>(null);
  useEffect(() => {
    if (!an) return;
    let aktiv = true;
    const liste = JSON.parse(anlagenSchluessel) as { id: string; name: string }[];
    Promise.all(
      liste.map((a) =>
        api.anlageBilanz(a.id, wahl.periode, wahl.am).then(
          (bilanz): AnlageBilanz => ({ anlage: a, bilanz }),
          (): AnlageBilanz => ({ anlage: a, bilanz: null }),
        ),
      ),
    ).then((xs) => aktiv && setBilanzen({ schluessel: bilanzSchluessel, anlagen: xs }));
    return () => {
      aktiv = false;
    };
  }, [an, anlagenSchluessel, bilanzSchluessel, wahl.periode, wahl.am]);

  const [orte, setOrte] = useState<{ standortId: string; gebaeude: Gebaeude[] } | null>(null);
  useEffect(() => {
    if (!standortId) return;
    let aktiv = true;
    api.standortOrte(standortId).then(
      (o) => aktiv && setOrte({ standortId, gebaeude: o.gebaeude.map((g) => ({ id: g.id, kurzzeichen: g.kurzzeichen, name: g.name })) }),
      () => aktiv && setOrte({ standortId, gebaeude: [] }),
    );
    return () => {
      aktiv = false;
    };
  }, [standortId]);
  const gebaeudeListe = orte && orte.standortId === standortId ? orte.gebaeude : [];
  const orteSchluessel = JSON.stringify(gebaeudeListe);

  const [gebaeudeHeute, setGebaeudeHeute] = useState<{ schluessel: string; je: Record<string, MessstellenRegister | null> } | null>(null);
  useEffect(() => {
    const liste = JSON.parse(orteSchluessel) as Gebaeude[];
    if (liste.length === 0) return;
    let aktiv = true;
    Promise.all(
      liste.map((g) =>
        api.messstellenRegister({ ort: g.kurzzeichen }).then(
          (r): [string, MessstellenRegister | null] => [g.id, r],
          (): [string, MessstellenRegister | null] => [g.id, null],
        ),
      ),
    ).then((xs) => aktiv && setGebaeudeHeute({ schluessel: orteSchluessel, je: Object.fromEntries(xs) }));
    return () => {
      aktiv = false;
    };
  }, [orteSchluessel]);

  // „im Gebäude“ gilt am letzten Tag des Zeitraums (wie „Stand am …“) — nie nach heute.
  const stichtag = [ende(wahl.periode, wahl.am), heute].sort()[0];
  const zeitraumSchluessel = `${orteSchluessel}|${stichtag}`;
  const [gebaeudeImZeitraum, setGebaeudeImZeitraum] = useState<{ schluessel: string; je: Record<string, string[] | null> } | null>(null);
  useEffect(() => {
    const liste = JSON.parse(orteSchluessel) as Gebaeude[];
    if (liste.length === 0) return;
    let aktiv = true;
    Promise.all(
      liste.map((g) =>
        api.messstellenRegister({ ort: g.kurzzeichen, stichtag }).then(
          (r): [string, string[] | null] => [g.id, r.register.map((z) => z.kennzeichen)],
          (): [string, string[] | null] => [g.id, null],
        ),
      ),
    ).then((xs) => aktiv && setGebaeudeImZeitraum({ schluessel: zeitraumSchluessel, je: Object.fromEntries(xs) }));
    return () => {
      aktiv = false;
    };
  }, [orteSchluessel, stichtag, zeitraumSchluessel]);

  const kennzahlen = useKennzahlenListe(zone, standortId, 0, an);

  // AP-16 IP-24: „Bewertung“ nach der Berichte-Regel (misst) und nur, wer Energieeinsätze sehen darf (IP-6); nur am
  // Unternehmen. Frist und Zahlen leitet der Server beim Abruf ab — ohne Recht wird nichts abgefragt.
  const { selbst } = useRollen();
  const bewertungAn = an && ebene?.art === 'unternehmen' && darfAnsehen(selbst);
  const [berichte, setBerichte] = useState<Bericht[] | null>(null);
  useEffect(() => {
    if (!bewertungAn) {
      setBerichte(null);
      return;
    }
    let aktiv = true;
    api
      .berichte()
      .then((r) => aktiv && setBerichte(r.berichte))
      .catch(() => aktiv && setBerichte(null));
    return () => {
      aktiv = false;
    };
  }, [bewertungAn]);
  const bewertung = bewertungAn ? bewertungFristBaustein(berichte) : null;

  // AP-17 IP-17: „Bezugsbasen“ nur am Unternehmen; die Frist leitet der Server beim Abruf ab, die Sichtbarkeit folgt der
  // Kennzahl. Ohne laufende Basis bleibt die Kachel weg.
  const bezugsbasenAn = an && ebene?.art === 'unternehmen';
  const [bezugsbasisDaten, setBezugsbasisDaten] = useState<BezugsbasisUebersicht | null>(null);
  useEffect(() => {
    if (!bezugsbasenAn) {
      setBezugsbasisDaten(null);
      return;
    }
    let aktiv = true;
    api
      .bezugsbasisUebersicht()
      .then((r) => aktiv && setBezugsbasisDaten(r))
      .catch(() => aktiv && setBezugsbasisDaten(null));
    return () => {
      aktiv = false;
    };
  }, [bezugsbasenAn]);
  const bezugsbasen = bezugsbasenAn ? bezugsbasisUebersichtBild(bezugsbasisDaten) : null;

  // AP-18 IP-19: „Ziele und Maßnahmen“ nur am Unternehmen; Zähler und Fristen leitet der Server beim Abruf ab, der Zaun
  // folgt Standort und Kennzahl. Ohne Vorgang bleibt die Kachel weg (R13).
  const zieleAn = an && ebene?.art === 'unternehmen';
  const [zieleDaten, setZieleDaten] = useState<VerbesserungUebersicht | null>(null);
  useEffect(() => {
    if (!zieleAn) {
      setZieleDaten(null);
      return;
    }
    let aktiv = true;
    api
      .verbesserungUebersicht()
      .then((r) => aktiv && setZieleDaten(r))
      .catch(() => aktiv && setZieleDaten(null));
    return () => {
      aktiv = false;
    };
  }, [zieleAn]);
  const zieleMassnahmen = zieleAn ? verbesserungUebersichtBild(zieleDaten) : null;

  // AP-19 IP-21 (WV5): „Was steht an“ nur am Unternehmen; die Fristen liest der Server beim Abruf aus ihren Regeln,
  // der Zaun ist der jeder Quelle. Ohne jede Frist bleibt der Block weg (AP-13 E3).
  const energiemanagementAn = an && ebene?.art === 'unternehmen';
  const [wiedervorlage, setWiedervorlage] = useState<Wiedervorlage | null>(null);
  useEffect(() => {
    if (!energiemanagementAn) {
      setWiedervorlage(null);
      return;
    }
    let aktiv = true;
    api
      .energiemanagementWiedervorlage()
      .then((r) => aktiv && setWiedervorlage(r))
      .catch(() => aktiv && setWiedervorlage(null));
    return () => {
      aktiv = false;
    };
  }, [energiemanagementAn]);
  const energiemanagement = energiemanagementAn ? wasStehtAn(wiedervorlage) : null;
  const wvStatus = energiemanagementAn ? wiedervorlageStatus(wiedervorlage) : null;

  if (!ebene || !an) return null;
  const gebaeude: GebaeudeEingang[] = gebaeudeListe.map((g) => ({
    ...g,
    heute: gebaeudeHeute?.schluessel === orteSchluessel ? (gebaeudeHeute.je[g.id] ?? null) : null,
    imZeitraum: gebaeudeImZeitraum?.schluessel === zeitraumSchluessel ? (gebaeudeImZeitraum.je[g.id] ?? null) : null,
  }));
  const laedt = bilanzen?.schluessel !== bilanzSchluessel;
  const anlagenBilanz = bilanzen?.anlagen ?? null;
  const inhalt = bausteineMitInhalt({
    messstellen: messstellenBaustein(ebene, register),
    energiebilanz: energiebilanzBaustein({ ebene, periode: wahl.periode, am: wahl.am, heute, anlagen: anlagenBilanz }),
    gebaeude: standortId
      ? gebaeudeZeilen({ standortId, periode: wahl.periode, am: wahl.am, heute, anlagen: laedt ? null : anlagenBilanz, gebaeude })
      : [],
    kennzahlen: kennzahlenDerEbene(ebene, kennzahlen.liste),
    bewertung,
    zieleMassnahmen,
    energiemanagement,
  });
  return {
    ebene,
    heute,
    periode: wahl.periode,
    am: wahl.am,
    waehle: (periode, am) => setWahl({ periode, am }),
    register,
    anlagen: anlagenBilanz,
    laedt,
    gebaeude,
    kennzahlen,
    bewertung,
    bezugsbasen,
    zieleMassnahmen,
    energiemanagement,
    wiedervorlageStatus: wvStatus,
    inhalt,
    standorte: standorte.filter((s) => s.zustand !== 'archiviert').map((s) => ({ id: s.id, name: s.name, misst: misst(lm, s.id) })),
  };
}

/** Die Bilder der Bausteine, wie das Layout sie zeigt — die eine Ableitung für Fläche und Einstieg (K6/K8). */
export function bausteinBilder(daten: UebersichtDaten, zeigen: readonly string[]) {
  const { ebene, periode, am, heute, laedt } = daten;
  const standortId = ebene.art === 'standort' ? ebene.standort.id : null;
  const zeigtEnergie = zeigen.includes('energiebilanz');
  return {
    standortId,
    messstellen: zeigen.includes('messstellen') ? messstellenBaustein(ebene, daten.register) : null,
    energie: zeigtEnergie ? energiebilanzBaustein({ ebene, periode, am, heute, anlagen: daten.anlagen }) : null,
    gebaeude:
      zeigtEnergie && standortId
        ? gebaeudeZeilen({ standortId, periode, am, heute, anlagen: laedt ? null : daten.anlagen, gebaeude: daten.gebaeude })
        : [],
    kennzahlen: zeigen.includes('kennzahlen') ? kennzahlenDerEbene(ebene, daten.kennzahlen.liste) : null,
    bewertung: zeigen.includes('bewertung') ? daten.bewertung : null,
    // Die Bezugsbasen gehören zur Welt der Kennzahlen: wer „Kennzahlen“ ausblendet, blendet sie mit aus.
    bezugsbasen: zeigen.includes('kennzahlen') ? (daten.bezugsbasen ?? null) : null,
    zieleMassnahmen: zeigen.includes('ziele-massnahmen') ? (daten.zieleMassnahmen ?? null) : null,
    energiemanagement: zeigen.includes('energiemanagement') ? (daten.energiemanagement ?? null) : null,
  };
}

/** Ein Baustein der Fläche; `bezugsbasen` hängt am Layout-Baustein „Kennzahlen“. */
type Block = ObenBaustein | 'bezugsbasen';

/** Die Reihenfolge der Fläche von vorher — der Einstieg (K6/K8) nimmt sich seine Bausteine nach oben. */
const STANDARD: readonly Block[] = ['messstellen', 'energiebilanz', 'kennzahlen', 'bewertung', 'bezugsbasen', 'ziele-massnahmen', 'energiemanagement'];
/** Dieselbe Reihenfolge für die Übersicht, die oben und unten verteilt. */
export const UEBERSICHT_REIHENFOLGE: readonly ObenBaustein[] = STANDARD.filter((id): id is ObenBaustein => id !== 'bezugsbasen');

/** Die Bausteine, die Grenz- und Verantwortungs-Satz tragen — mit einem davon steht der Hinweis „Was VoltPilot leistet“. */
const MIT_SAETZEN: readonly Block[] = ['bewertung', 'bezugsbasen', 'ziele-massnahmen', 'energiemanagement'];

/**
 * Hat ein Baustein Inhalt? Der Einstieg „Ihr Standort“ entscheidet selbst, ob er etwas zeigt. Fahrplan „Ihr
 * Energiemanagement“ und „Belege finden“ sind mit Konzept Nachweisen n1 (Entscheid 21) entfallen: der Überblick von
 * Nachweisen übernimmt sie.
 */
export function bausteinDa(b: ReturnType<typeof bausteinBilder>, id: Block): boolean {
  switch (id) {
    case 'messstellen':
      return !!b.messstellen;
    case 'energiebilanz':
      return !!b.energie || b.gebaeude.length > 0;
    case 'kennzahlen':
      return !!b.kennzahlen;
    case 'bewertung':
      return !!b.bewertung;
    case 'bezugsbasen':
      return !!b.bezugsbasen;
    case 'ziele-massnahmen':
      return !!b.zieleMassnahmen;
    case 'energiemanagement':
      return !!b.energiemanagement;
    default:
      return true;
  }
}

/** Trägt die Übersicht irgendwo einen Baustein mit den Sätzen? Dann gehört der Hinweis einmal auf die Seite (K7). */
export function traegtSaetze(b: ReturnType<typeof bausteinBilder>, dazu: readonly ObenBaustein[] = []): boolean {
  return [...STANDARD, ...dazu].some((id) => MIT_SAETZEN.includes(id) && bausteinDa(b, id));
}

export function UebersichtBausteine({
  daten,
  zeigen,
  onNavigate,
  nur,
  ohne = [],
  grenzHinweis,
}: {
  daten: UebersichtDaten;
  /** Die sichtbaren Bausteine des Layouts (`Anpassen` darf sie ausblenden). */
  zeigen: readonly string[];
  onNavigate: (route: Route) => void;
  /** K6/K8: nur diese Bausteine, in dieser Reihenfolge — der Einstieg oben auf der Übersicht. */
  nur?: readonly ObenBaustein[];
  /** K6/K8: diese Bausteine stehen schon oben — hier nicht noch einmal. */
  ohne?: readonly ObenBaustein[];
  /** Der Hinweis „Was VoltPilot leistet“ (K7): ohne Angabe, sobald ein Baustein mit den Sätzen dasteht. */
  grenzHinweis?: boolean;
}) {
  const { selbst } = useRollen();
  const { periode, am, heute, laedt } = daten;
  const b = bausteinBilder(daten, zeigen);
  const { standortId, messstellen, energie, gebaeude, kennzahlen, bewertung, bezugsbasen, zieleMassnahmen, energiemanagement } = b;
  const reihenfolge = (nur ?? STANDARD).filter((id) => !ohne.includes(id as ObenBaustein) && (id !== 'bezugsbasen' || !ohne.includes('kennzahlen')));
  const sichtbar = reihenfolge.filter((id) => bausteinDa(b, id));
  if (sichtbar.length === 0) return null;
  const bearbeiter = bearbeiterStandorte(selbst);
  const bloecke: Record<Block, ReactNode> = {
    messstellen: messstellen && (
      <section className="vp-ub-baustein" aria-labelledby="vp-ub-messstellen" data-testid="baustein-messstellen">
        <h2 id="vp-ub-messstellen" className="vp-ub-titel">
          {MESSSTELLEN_TITEL}
        </h2>
        <ul className="vp-ub-zeilen">
          {messstellen.map((z) => (
            <li key={z.key}>
              <button type="button" className={`vp-ub-zeile is-${z.ton}`} onClick={() => onNavigate(z.ziel)} data-testid={`datenlage-${z.key}`}>
                <span className="vp-ub-punkt" aria-hidden="true" />
                <span className="vp-ub-text">
                  {z.name && <span className="vp-ub-name">{z.name}</span>}
                  <span className="vp-ub-satz">{z.text}</span>
                </span>
                <Icon name="chevron-right" size={16} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    ),
    energiebilanz: (energie || gebaeude.length > 0) && (
      <section className="vp-ub-baustein" aria-labelledby="vp-ub-energiebilanz" data-testid="baustein-energiebilanz">
        <div className="vp-ub-kopf">
          <h2 id="vp-ub-energiebilanz" className="vp-ub-titel">
            {UEMS_ENERGIEBILANZ}
          </h2>
          <div className="vp-ub-zeitwahl" role="group" aria-label="Zeitraum">
            <ZeitSegment label="Zeitraum" optionen={BILANZ_PERIODEN} wert={periode} onWert={(p) => daten.waehle(p, letzterGebildeter(p, heute))} />
            <div className="vp-ub-datumzeile">
              <button type="button" className="vp-ub-schritt" aria-label="Vorheriger Zeitraum" onClick={() => daten.waehle(periode, blaettere(periode, am, -1))}>
                <Icon name="chevron-left" size={18} />
              </button>
              <span className="vp-ub-zeitraum" aria-live="polite" data-testid="energiebilanz-zeitraum">
                {zeitraumText(periode, am)}
              </span>
              <button
                type="button"
                className="vp-ub-schritt"
                aria-label="Nächster Zeitraum"
                disabled={laeuftNoch(periode, am, heute)}
                onClick={() => daten.waehle(periode, blaettere(periode, am, 1))}
              >
                <Icon name="chevron-right" size={18} />
              </button>
            </div>
          </div>
        </div>
        {laedt ? (
          <p className="vp-ub-hinweis">Wird geladen …</p>
        ) : energie?.hinweis ? (
          <p className="vp-ub-hinweis" data-testid="energiebilanz-hinweis">
            {energie.hinweis}
          </p>
        ) : (
          energie && (
            <>
              {energie.summe && (
                <p className={`vp-ub-summe is-${energie.summe.ton}`} data-testid="energiebilanz-summe">
                  <strong>{NETZBEZUG}</strong> {energie.summe.text}
                </p>
              )}
              {energie.gruppen.map((g) => (
                <div key={g.key} className="vp-ub-gruppe" data-testid={`energiebilanz-gruppe-${g.key}`}>
                  {g.name && (
                    <p className={`vp-ub-gruppe-kopf is-${g.summe?.ton ?? 'off'}`}>
                      <span className="vp-ub-name">{g.name}</span>
                      {g.summe && <span className="vp-ub-satz">{g.summe.text}</span>}
                    </p>
                  )}
                  <ul className="vp-ub-zeilen">
                    {g.systeme.map((s) => (
                      <li key={s.key}>
                        <button type="button" className={`vp-ub-zeile is-${s.ton}`} onClick={() => onNavigate(s.ziel)} data-testid={`system-${s.key}`}>
                          <span className="vp-ub-punkt" aria-hidden="true" />
                          <span className="vp-ub-text">
                            <span className="vp-ub-name">{s.name}</span>
                            {s.zusatz && <span className="vp-ub-satz">{s.zusatz}</span>}
                          </span>
                          <span className="vp-ub-zahl">{s.zahl}</span>
                          <Icon name="chevron-right" size={16} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )
        )}
        {gebaeude.length > 0 && (
          <div className="vp-ub-gruppe" data-testid="gebaeude-zeilen">
            <h3 className="vp-ub-unter">{UEMS_GEBAEUDE}</h3>
            <ul className="vp-ub-zeilen">
              {gebaeude.map((g) => (
                <li key={g.key}>
                  <button type="button" className={`vp-ub-zeile is-${g.ton}`} onClick={() => onNavigate(g.ziel)} data-testid={`gebaeude-${g.key}`}>
                    <span className="vp-ub-punkt" aria-hidden="true" />
                    <span className="vp-ub-text">
                      <span className="vp-ub-name">{g.name}</span>
                      {g.gemessen && <span className="vp-ub-satz">{g.gemessen}</span>}
                      {g.datenlage && <span className="vp-ub-satz">{g.datenlage}</span>}
                    </span>
                    <Icon name="chevron-right" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    ),
    kennzahlen: kennzahlen && (
      <section className="vp-ub-baustein" aria-labelledby="vp-ub-kennzahlen" data-testid="baustein-kennzahlen">
        <div className="vp-ub-kopf">
          <h2 id="vp-ub-kennzahlen" className="vp-ub-titel">
            {UEMS_KENNZAHLEN}
          </h2>
          <button
            type="button"
            className="vp-ub-alle"
            onClick={() => onNavigate(standortId ? standortBereichRoute(standortId, 'kennzahlen') : pageRoute('portfolio-kennzahlen'))}
          >
            {ZUR_LISTE}
            <Icon name="chevron-right" size={16} />
          </button>
        </div>
        <ul className="vp-kz-liste">
          {kennzahlen.map((k) => (
            <li key={k.id}>
              <KennzahlKarte
                karte={listenKarte(k, daten.kennzahlen.werte[k.id] ?? { art: 'laedt' })}
                onOeffnen={() => onNavigate(kennzahlRoute(k.id, standortId))}
              />
            </li>
          ))}
        </ul>
      </section>
    ),
    bewertung: bewertung && <BewertungBaustein bild={bewertung} onOeffnen={() => onNavigate(pageRoute('portfolio-bewertung'))} />,
    bezugsbasen: bezugsbasen && (
      <BezugsbasisUebersichtKarte
        bild={bezugsbasen}
        onOeffnen={() => onNavigate(pageRoute('portfolio-kennzahlen'))}
        onKennzahl={(id) => onNavigate(kennzahlRoute(id, null))}
      />
    ),
    'ziele-massnahmen': zieleMassnahmen && (
      <VerbesserungUebersichtKarte
        bild={zieleMassnahmen}
        onOeffnen={() => onNavigate(verbesserungRoute())}
        onSprung={(s) =>
          onNavigate(
            s.art === 'energieziel'
              ? energiezielRoute(s.id)
              : s.art === 'massnahme'
                ? massnahmeRoute(s.id)
                : abweichungRoute(s.id),
          )
        }
      />
    ),
    energiemanagement: energiemanagement && (
      <EnergiemanagementBaustein bild={energiemanagement} onOeffnen={() => onNavigate(energiemanagementRoute('wiedervorlage'))} />
    ),
    standort: (
      <StandortKarte
        standorte={daten.standorte.filter((s) => bearbeiter.includes(s.id))}
        abweichungen={darfVerbesserungSehen(selbst)}
        onNavigate={onNavigate}
      />
    ),
  };
  const mitSaetzen = grenzHinweis ?? sichtbar.some((id) => MIT_SAETZEN.includes(id));

  return (
    <GrenzSatzBereich>
      <div className="vp-ub" data-testid={nur ? 'uebersicht-oben' : 'uebersicht-bausteine'}>
        {sichtbar.map((id) => (
          <Fragment key={id}>{bloecke[id]}</Fragment>
        ))}
        {/* K7: die Sätze der UEMS-Bausteine einmal für alle, statt unter jedem Baustein. */}
        {mitSaetzen && <GrenzHinweis />}
      </div>
    </GrenzSatzBereich>
  );
}
