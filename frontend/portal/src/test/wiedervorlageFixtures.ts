import { UEMS_VERANTWORTUNG } from '../glossar';
import type { Wiedervorlage, WiedervorlageErledigt, WiedervorlageHerleitung, WiedervorlageZeile, WiedervorlageZuletzt, Zustaendig } from '../wiedervorlage';

/**
 * Antworten von `GET /api/v1/energiemanagement/wiedervorlage` (Vertrag 1.1) und `…/wiedervorlage/zuletzt` für das
 * Konzept Wiedervorlage w1, mit den Titeln, wie die Quellen sie bilden (`WiedervorlageBestand.java`,
 * `DokumentWiedervorlage.java` u. a.), und mit Herleitung, Gegenstand und Zuständig je Zeile:
 * R12 (Referenzstand 12.02.2029), der Stand der Demo am 30.04.2029 (zehn Korrekturen an einem Bericht, EINE Zeile) und
 * der Normalfall (nichts in den nächsten 30 Tagen, elf Fristen im Jahresplan).
 */
export const KZ = {
  stromMontageHalle2: 'k0170000-0000-4000-8000-000000000002',
  netzbezugHalle2: 'k0170000-0000-4000-8000-000000000003',
  gasVerwaltung: 'k0170000-0000-4000-8000-000000000004',
  stromMontageLindach: 'k0170000-0000-4000-8000-000000000005',
  stromSpritzguss: 'k0170000-0000-4000-8000-000000000001',
} as const;
export const DOK = { d1: 'd0190000-0000-4000-8000-000000000001', d2: 'd0190000-0000-4000-8000-000000000002' } as const;

type Mehr = Partial<Pick<WiedervorlageZeile, 'verantwortlich' | 'id' | 'kennzahl_id' | 'herleitung' | 'bezug' | 'einsatz_id' | 'aufgabe' | 'zustaendig'>>;

export const wvZeile = (art: WiedervorlageZeile['art'], kennzeichen: string, titel: string, faellig_am: string, tage: number, mehr: Mehr = {}): WiedervorlageZeile => ({
  art,
  kennzeichen,
  titel,
  faellig_am,
  tage,
  satz: tage > 0 ? `seit ${tage} Tagen fällig` : tage === 0 ? 'heute fällig' : `fällig in ${-tage} Tagen`,
  verantwortlich: mehr.verantwortlich ?? null,
  id: mehr.id ?? null,
  kennzahl_id: mehr.kennzahl_id ?? null,
  herleitung: mehr.herleitung ?? null,
  bezug: mehr.bezug ?? null,
  einsatz_id: mehr.einsatz_id ?? null,
  aufgabe: mehr.aufgabe ?? null,
  zustaendig: mehr.zustaendig ?? null,
});

/** Die Herleitung einer Zeile; was die Regel nicht kennt, bleibt `null`. */
export const herleitung = (basis: WiedervorlageHerleitung['basis'], am: string | null, mehr: Partial<WiedervorlageHerleitung> = {}): WiedervorlageHerleitung => ({
  basis,
  am,
  fassung: null,
  monate: null,
  kennung: null,
  quelle_art: null,
  anzahl: null,
  ...mehr,
});

const IK = 'Ines Kaltenbach';
const JW = 'Jonas Wendlinger';
/** Ines Kaltenbach ist die angemeldete Person der Fixtures (`rechteSeed('IK')`). */
const amObjekt = (name: string, ich = name === IK): Zustaendig => ({ name, herkunft: 'objekt', ich });
const lautAufgabe = (name: string, ich = name === IK): Zustaendig => ({ name, herkunft: 'aufgabe', ich });

/** R12 am 12.02.2029: acht abgelaufene Fristen, M-2029-0001 in 16 Tagen und sechs Fristen im Jahresplan. */
export function wvR12(): Wiedervorlage {
  const bb = (kz: string, fassung: number, freigabe: string, faellig: string, tage: number, kennzahl: string, name: string) =>
    wvZeile('bezugsbasis_ueberpruefung', kz, `Bezugsbasis ${kz}, Fassung ${fassung} — Überprüfung (Freigabe ${freigabe.split('-').reverse().join('.')} + 12 Monate)`, faellig, tage, {
      verantwortlich: IK,
      id: `b-${kz}`,
      kennzahl_id: kennzahl,
      herleitung: herleitung('freigabe', freigabe, { fassung, monate: 12 }),
      bezug: name,
      aufgabe: 'bezugsbasen',
      zustaendig: amObjekt(IK),
    });
  const dok = (kz: string, name: string, id: string) =>
    wvZeile('dokument_ueberpruefung', kz, `${name} — Überprüfung`, '2028-12-10', 64, {
      id,
      herleitung: herleitung('geprueft_bleibt', '2027-12-10', { fassung: 1, monate: 12 }),
      aufgabe: 'dokumente',
      zustaendig: lautAufgabe(IK),
    });
  return {
    stichtag: '2029-02-12T08:00:00+01:00',
    vorschau_tage: 30,
    faellig: [
      bb('BB-0002', 2, '2026-11-13', '2027-11-13', 457, KZ.stromMontageHalle2, 'Stromeinsatz Montage je Stück'),
      bb('BB-0005', 1, '2026-11-20', '2027-11-20', 450, KZ.stromMontageLindach, 'Stromeinsatz Montage Lindach'),
      bb('BB-0003', 2, '2027-03-05', '2028-03-05', 344, KZ.netzbezugHalle2, 'Netzbezug je m²'),
      wvZeile('bericht_anstoss', 'BR-2028-0001', 'Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 — Revision angestoßen (K-2028-0001)', '2028-04-03', 315, {
        herleitung: herleitung('erkannt', '2028-04-03', { kennung: 'K-2028-0001', anzahl: 1 }),
        bezug: 'Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027',
        aufgabe: 'energiemanagement_leiten',
      }),
      bb('BB-0004', 1, '2027-11-24', '2028-11-24', 80, KZ.gasVerwaltung, 'Gasbezug Verwaltung je Gradtag'),
      wvZeile('bewertung_ueberpruefung', 'BR-2027-0001', 'Energetische Bewertung — Überprüfung', '2028-11-24', 80, {
        herleitung: herleitung('freigabe', '2027-11-24', { fassung: 1, monate: 12, kennung: 'BR-2027-0001' }),
        aufgabe: 'bewertung_messplanung',
      }),
      dok('D-0001', 'Energiepolitik', DOK.d1),
      dok('D-0002', 'Anwendungsbereich', DOK.d2),
    ],
    vorschau: [
      wvZeile('massnahme_termin', 'M-2029-0001', 'Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden', '2029-02-28', -16, {
        verantwortlich: JW,
        id: 'm-2029-0001',
        herleitung: herleitung('termin', '2029-02-28', { quelle_art: 'nichtkonformitaet', kennung: 'F-2029-0001' }),
        aufgabe: 'energieziele_massnahmen',
        zustaendig: amObjekt(JW),
      }),
    ],
    spaeter: [
      wvZeile('feststellung', 'F-2029-0001', 'Feststellung — Frist', '2029-04-22', -69, {
        verantwortlich: JW,
        id: 'f-2029-0001',
        herleitung: herleitung('festgestellt', '2029-01-22', { quelle_art: 'internes_audit', kennung: 'AU-2029-0001' }),
        bezug: 'Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt.',
        zustaendig: amObjekt(JW),
      }),
      wvZeile('dokument_ueberpruefung', 'D-0003', 'Rechtliche Anforderungen — Überprüfung', '2029-06-01', -109, {
        id: 'd-3',
        herleitung: herleitung('freigabe', '2028-06-01', { fassung: 1, monate: 12 }),
        aufgabe: 'dokumente',
        zustaendig: lautAufgabe(IK),
      }),
      wvZeile('massnahme_termin', 'M-2029-0002', 'Hinweis aus dem internen Audit: Bekanntmachung der Energiepolitik im Werk Lindach wiederholen', '2029-06-30', -138, {
        verantwortlich: IK,
        id: 'm-2029-0002',
        herleitung: herleitung('termin', '2029-06-30', { quelle_art: 'audit', kennung: 'AU-2029-0001' }),
        aufgabe: 'energieziele_massnahmen',
        zustaendig: amObjekt(IK),
      }),
      wvZeile('dokument_ueberpruefung', 'D-0004', 'Betrieb und Instandhaltung Spritzguss — Überprüfung', '2029-11-10', -271, {
        id: 'd-4',
        herleitung: herleitung('freigabe', '2028-11-10', { fassung: 1, monate: 12 }),
        aufgabe: 'dokumente',
        zustaendig: lautAufgabe(IK),
      }),
      wvZeile('bezugsbasis_ueberpruefung', 'BB-0001', 'Bezugsbasis BB-0001, Fassung 2 — Überprüfung (geprüft, bleibt 25.11.2028 + 12 Monate)', '2029-11-25', -286, {
        verantwortlich: IK,
        id: 'b-BB-0001',
        kennzahl_id: KZ.stromSpritzguss,
        herleitung: herleitung('geprueft_bleibt', '2028-11-25', { fassung: 2, monate: 12 }),
        bezug: 'Stromeinsatz Spritzguss je kg',
        aufgabe: 'bezugsbasen',
        zustaendig: amObjekt(IK),
      }),
      wvZeile('internes_audit', 'AU-2029-0001', 'Nächstes internes Audit', '2030-01-22', -344, {
        verantwortlich: 'Claudia Berger',
        id: 'au-2029-0001',
        herleitung: herleitung('durchgefuehrt', '2029-01-22', { monate: 12, kennung: 'AU-2029-0001' }),
        aufgabe: 'interne_audits',
        zustaendig: amObjekt('Claudia Berger'),
      }),
    ],
    anzahl_faellig: 8,
    anzahl_vorschau: 1,
    anzahl_ueberfaellig: 8,
    anzahl_naechste: 1,
    anzahl_spaeter: 6,
    nicht_in_liste: ['AU-2029-0001', 'BB-0001', 'D-0003', 'D-0004', 'F-2029-0001', 'M-2029-0002'],
    verantwortung: UEMS_VERANTWORTUNG,
    naechste_managementbewertung: null,
    aufgaben_lesbar: true,
  };
}

/** Der Jahresplan der Demo am 30.04.2029 (bis 30.04.2030): elf Fristen, wie das Konzept sie zeigt. */
function jahresplanDemo(): WiedervorlageZeile[] {
  const tage = (faellig: string) => -Math.round((Date.parse(`${faellig}T00:00:00Z`) - Date.parse('2029-04-30T00:00:00Z')) / 86_400_000);
  const z = (art: WiedervorlageZeile['art'], kz: string, titel: string, faellig: string, mehr: Mehr) => wvZeile(art, kz, titel, faellig, tage(faellig), mehr);
  return [
    z('massnahme_termin', 'M-2029-0002', 'Bekanntmachung der Energiepolitik im Werk Lindach wiederholen', '2029-06-30', {
      verantwortlich: IK, id: 'm-2', herleitung: herleitung('termin', '2029-06-30', { quelle_art: 'audit', kennung: 'AU-2029-0001' }),
      aufgabe: 'energieziele_massnahmen', zustaendig: amObjekt(IK),
    }),
    z('massnahme_termin', 'M-2029-0003', 'Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal', '2029-06-30', {
      verantwortlich: IK, id: 'm-3', herleitung: herleitung('termin', '2029-06-30', { quelle_art: 'managementbewertung', kennung: 'BR-2029-0001/B2' }),
      aufgabe: 'energieziele_massnahmen', zustaendig: amObjekt(IK),
    }),
    z('dokument_ueberpruefung', 'D-0004', 'Kriterien für Betrieb und Instandhaltung — Überprüfung', '2029-11-10', {
      id: 'd-4', herleitung: herleitung('freigabe', '2028-11-10', { fassung: 1, monate: 12 }), aufgabe: 'dokumente', zustaendig: lautAufgabe(IK),
    }),
    z('dokument_ueberpruefung', 'D-0003', 'Rechtskataster — Überprüfung', '2029-12-05', {
      id: 'd-3', herleitung: herleitung('freigabe', '2028-12-05', { fassung: 1, monate: 12 }), aufgabe: 'dokumente', zustaendig: lautAufgabe(IK),
    }),
    z('energieziel_bewertung', 'EZ-2029-0001', 'Spritzguss 2029: 4 % weniger Strom', '2029-12-31', {
      verantwortlich: IK, id: 'ez-2029-0001', herleitung: herleitung('zielperiode', '2029-12-31'), aufgabe: 'energieziele_massnahmen', zustaendig: amObjekt(IK),
    }),
    z('internes_audit', 'AU-2029-0001', 'Nächstes internes Audit', '2030-01-22', {
      verantwortlich: IK, id: 'au-1', herleitung: herleitung('durchgefuehrt', '2029-01-22', { monate: 12, kennung: 'AU-2029-0001' }),
      aufgabe: 'interne_audits', zustaendig: amObjekt(IK),
    }),
    z('managementbewertung', 'BR-2029-0001', 'Nächste Managementbewertung', '2030-02-12', {
      verantwortlich: IK, herleitung: herleitung('sitzung', '2029-02-12', { monate: 12, kennung: 'BR-2029-0001' }),
      aufgabe: 'managementbewertung', zustaendig: lautAufgabe(IK),
    }),
    z('dokument_ueberpruefung', 'D-0002', 'Anwendungsbereich — Überprüfung', '2030-02-13', {
      id: DOK.d2, herleitung: herleitung('geprueft_bleibt', '2029-02-13', { fassung: 1, monate: 12 }), aufgabe: 'dokumente', zustaendig: lautAufgabe(IK),
    }),
    z('dokument_ueberpruefung', 'D-0001', 'Energiepolitik — Überprüfung', '2030-03-20', {
      id: DOK.d1, herleitung: herleitung('freigabe', '2029-03-20', { fassung: 2, monate: 12 }), aufgabe: 'dokumente', zustaendig: lautAufgabe(IK),
    }),
    z('bezugsbasis_ueberpruefung', 'BB-0001', 'Bezugsbasis BB-0001, Fassung 2 — Überprüfung (geprüft, bleibt 30.04.2029 + 12 Monate)', '2030-04-30', {
      verantwortlich: IK, id: 'b-1', kennzahl_id: KZ.stromSpritzguss, herleitung: herleitung('geprueft_bleibt', '2029-04-30', { fassung: 2, monate: 12 }),
      bezug: 'Stromeinsatz Spritzguss je kg', aufgabe: 'bezugsbasen', zustaendig: amObjekt(IK),
    }),
    z('bewertung_ueberpruefung', 'BR-2029-0002', 'Energetische Bewertung — Überprüfung', '2030-04-30', {
      herleitung: herleitung('freigabe', '2029-04-30', { fassung: 1, monate: 12, kennung: 'BR-2029-0002' }), aufgabe: 'bewertung_messplanung',
      zustaendig: lautAufgabe(IK),
    }),
  ];
}

/** Die Demo am 30.04.2029: zehn Korrekturen an BR-2026-0001 als EINE Zeile, MB-1, BB-0006 und BB-0007; elf im Jahresplan. */
export function wvDemo(): Wiedervorlage {
  const spaeter = jahresplanDemo();
  return {
    stichtag: '2029-04-30T14:53:00+02:00',
    vorschau_tage: 30,
    faellig: [
      wvZeile('bericht_anstoss', 'BR-2026-0001', 'Monatsbericht Standort Werk Ahrenberg Oktober 2026 — Revision angestoßen (10 Korrekturen, zuerst K-2026-0014)', '2026-10-05', 938, {
        herleitung: herleitung('erkannt', '2026-10-05', { kennung: 'K-2026-0014', anzahl: 10 }),
        bezug: 'Monatsbericht Standort Werk Ahrenberg Oktober 2026',
        aufgabe: 'energiemanagement_leiten',
      }),
      wvZeile('messbedarf_frist', 'MB-1', 'Messbedarf MB-1 — Frist', '2027-03-31', 761, {
        id: 'mb-1',
        herleitung: herleitung('termin', '2027-03-31'),
        bezug: 'Wärmemengenzähler am Trockner der Spritzgießmaschine 4',
        einsatz_id: 'ee-8',
        aufgabe: 'bewertung_messplanung',
        zustaendig: lautAufgabe(IK),
      }),
      ...(['BB-0006', 'BB-0007'] as const).map((kz, i) =>
        wvZeile('bezugsbasis_ueberpruefung', kz, `Bezugsbasis ${kz}, Fassung 1 — Überprüfung (Freigabe 05.10.2026 + 12 Monate)`, '2027-10-05', 573, {
          verantwortlich: IK,
          id: `b-${6 + i}`,
          kennzahl_id: `k-2${1 + i}`,
          herleitung: herleitung('freigabe', '2026-10-05', { fassung: 1, monate: 12 }),
          bezug: i === 0 ? 'Stromeinsatz Montage je Stück - Halle 2' : 'Netzbezug je m² - Halle 2',
          aufgabe: 'bezugsbasen',
          zustaendig: amObjekt(IK),
        }),
      ),
    ],
    vorschau: [],
    spaeter,
    anzahl_faellig: 4,
    anzahl_vorschau: 0,
    anzahl_ueberfaellig: 4,
    anzahl_naechste: 0,
    anzahl_spaeter: spaeter.length,
    nicht_in_liste: ['AU-2029-0001', 'BB-0001', 'BR-2029-0001', 'BR-2029-0002', 'D-0001', 'D-0002', 'D-0003', 'D-0004', 'EZ-2029-0001', 'M-2029-0002', 'M-2029-0003'],
    verantwortung: UEMS_VERANTWORTUNG,
    naechste_managementbewertung: { faellig_am: '2030-02-12', kennzeichen: 'BR-2029-0001', sitzung_am: '2029-02-12', rhythmus_monate: 12 },
    aufgaben_lesbar: true,
  };
}

/** Der Normalfall: nichts abgelaufen, nichts in den nächsten 30 Tagen, elf Fristen im Jahresplan. */
export function wvNormal(): Wiedervorlage {
  return { ...wvDemo(), faellig: [], vorschau: [], anzahl_faellig: 0, anzahl_vorschau: 0, anzahl_ueberfaellig: 0, anzahl_naechste: 0 };
}

/** Ohne jede Frist. */
export function wvLeer(): Wiedervorlage {
  return { ...wvNormal(), spaeter: [], anzahl_spaeter: 0, nicht_in_liste: [], naechste_managementbewertung: null };
}

const erledigt = (
  art: string,
  gruppe: string | null,
  kennzeichen: string,
  titel: string,
  nr: number | null,
  am: string,
  entschieden_von: string | null,
  eingetragen_von: string | null,
): WiedervorlageErledigt => ({ art, gruppe, kennzeichen, titel, nr, am, entschieden_von, eingetragen_von });

/** „Zuletzt erledigt“ der Demo am 30.04.2029: die fünf jüngsten Entscheidungen der letzten 90 Tage. */
export function zuletztDemo(): WiedervorlageZuletzt {
  return {
    stichtag: '2029-04-30T14:53:00+02:00',
    tage: 90,
    eintraege: [
      erledigt('berichtsstand', 'bewertung_messplanung', 'BR-2029-0002', 'Kunststoffwerk Ahrenberg GmbH · 2028-04/2029-03', 1, '2029-04-30', null, IK),
      erledigt('bezugsbasis_geprueft_bleibt', null, 'BB-0001', 'Bezugsbasis BB-0001 (KZ-0004 Stromeinsatz Spritzguss je kg)', 2, '2029-04-30', null, IK),
      erledigt('wirksamkeit', 'audits_feststellungen', 'F-2029-0001', 'Wirksamkeit: wirksam', 1, '2029-04-15', IK, IK),
      erledigt('energiepolitik', 'grundlagen', 'D-0001', 'Energiepolitik', 2, '2029-03-20', 'Robert Falk', IK),
      erledigt('dokument_geprueft_bleibt', null, 'D-0002', 'Anwendungsbereich', 1, '2029-02-13', 'Robert Falk', IK),
    ],
  };
}

/** Ohne Entscheidung in den letzten 90 Tagen. */
export function zuletztLeer(): WiedervorlageZuletzt {
  return { stichtag: '2029-04-30T14:53:00+02:00', tage: 90, eintraege: [] };
}
