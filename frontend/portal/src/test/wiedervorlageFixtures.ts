import type { EnergiemanagementVerzeichnis, EnergiemanagementVerzeichnisZeile } from '../api';
import { UEMS_VERANTWORTUNG } from '../glossar';
import type { Wiedervorlage, WiedervorlageZeile } from '../wiedervorlage';

/**
 * Antworten von `GET /api/v1/energiemanagement/wiedervorlage` und `/verzeichnis` für das Konzept Wiedervorlage w1, mit
 * den Titeln, wie die Quellen sie bilden (`WiedervorlageBestand.java`, `DokumentWiedervorlage.java` u. a.):
 * R12 (Referenzstand 12.02.2029), der Stand der Demo am 30.04.2029 (zehn Anstöße an einem Bericht) und der Normalfall
 * (nichts in den nächsten 30 Tagen, elf Fristen danach).
 */
export const KZ = {
  stromMontageHalle2: 'k0170000-0000-4000-8000-000000000002',
  netzbezugHalle2: 'k0170000-0000-4000-8000-000000000003',
  gasVerwaltung: 'k0170000-0000-4000-8000-000000000004',
  stromMontageLindach: 'k0170000-0000-4000-8000-000000000005',
} as const;
export const DOK = { d1: 'd0190000-0000-4000-8000-000000000001', d2: 'd0190000-0000-4000-8000-000000000002' } as const;

export const wvZeile = (
  art: WiedervorlageZeile['art'],
  kennzeichen: string,
  titel: string,
  faellig_am: string,
  tage: number,
  mehr: Partial<Pick<WiedervorlageZeile, 'verantwortlich' | 'id' | 'kennzahl_id'>> = {},
): WiedervorlageZeile => ({
  art,
  kennzeichen,
  titel,
  faellig_am,
  tage,
  satz: tage > 0 ? `seit ${tage} Tagen fällig` : tage === 0 ? 'heute fällig' : `fällig in ${-tage} Tagen`,
  verantwortlich: mehr.verantwortlich ?? null,
  id: mehr.id ?? null,
  kennzahl_id: mehr.kennzahl_id ?? null,
});

const IK = 'Ines Kaltenbach';

/** R12 am 12.02.2029: acht abgelaufene Fristen und M-2029-0001 in 16 Tagen. */
export function wvR12(): Wiedervorlage {
  const bb = (kz: string, fassung: number, freigabe: string, faellig: string, tage: number, kennzahl: string) =>
    wvZeile('bezugsbasis_ueberpruefung', kz, `Bezugsbasis ${kz}, Fassung ${fassung} — Überprüfung (Freigabe ${freigabe} + 12 Monate)`, faellig, tage, {
      verantwortlich: IK,
      id: `b-${kz}`,
      kennzahl_id: kennzahl,
    });
  return {
    stichtag: '2029-02-12T08:00:00+01:00',
    vorschau_tage: 30,
    faellig: [
      bb('BB-0002', 2, '13.11.2026', '2027-11-13', 457, KZ.stromMontageHalle2),
      bb('BB-0005', 1, '20.11.2026', '2027-11-20', 450, KZ.stromMontageLindach),
      bb('BB-0003', 2, '05.03.2027', '2028-03-05', 344, KZ.netzbezugHalle2),
      wvZeile('bericht_anstoss', 'BR-2028-0001', 'Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 — Revision angestoßen (K-2028-0001)', '2028-04-03', 315),
      bb('BB-0004', 1, '24.11.2027', '2028-11-24', 80, KZ.gasVerwaltung),
      wvZeile('bewertung_ueberpruefung', 'BR-2027-0001', 'Energetische Bewertung — Überprüfung', '2028-11-24', 80),
      wvZeile('dokument_ueberpruefung', 'D-0001', 'Energiepolitik — Überprüfung', '2028-12-10', 64, { id: DOK.d1 }),
      wvZeile('dokument_ueberpruefung', 'D-0002', 'Anwendungsbereich — Überprüfung', '2028-12-10', 64, { id: DOK.d2 }),
    ],
    vorschau: [
      wvZeile(
        'massnahme_termin',
        'M-2029-0001',
        'Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden',
        '2029-02-28',
        -16,
        { verantwortlich: 'Jonas Wendlinger', id: 'm-2029-0001' },
      ),
    ],
    anzahl_faellig: 8,
    anzahl_vorschau: 1,
    nicht_in_liste: ['AU-2029-0001', 'BB-0001', 'D-0003', 'D-0004', 'F-2029-0001', 'M-2029-0002'],
    verantwortung: UEMS_VERANTWORTUNG,
    naechste_managementbewertung: null,
  };
}

/** Die Demo am 30.04.2029: zehn Anstöße an BR-2026-0001, MB-1, BB-0006 und BB-0007; elf Fristen nach dem Fenster. */
export function wvDemo(): Wiedervorlage {
  const anstoss = (k: string) =>
    wvZeile('bericht_anstoss', 'BR-2026-0001', `Monatsbericht Standort Werk Ahrenberg Oktober 2026 — Revision angestoßen (${k})`, '2026-10-05', 938);
  return {
    stichtag: '2029-04-30T14:53:00+02:00',
    vorschau_tage: 30,
    faellig: [
      ...['K-2026-0020', 'K-2026-0019', 'K-2026-0017', 'K-2026-0015', 'K-2026-0014', 'K-2026-0018', 'K-2026-0016', 'K-2026-0023', 'K-2026-0021', 'K-2026-0022'].map(anstoss),
      wvZeile('messbedarf_frist', 'MB-1', 'Messbedarf MB-1 — Frist', '2027-03-31', 761, { id: 'mb-1' }),
      wvZeile('bezugsbasis_ueberpruefung', 'BB-0006', 'Bezugsbasis BB-0006, Fassung 1 — Überprüfung (Freigabe 05.10.2026 + 12 Monate)', '2027-10-05', 573, {
        verantwortlich: IK,
        id: 'b-6',
        kennzahl_id: 'k-21',
      }),
      wvZeile('bezugsbasis_ueberpruefung', 'BB-0007', 'Bezugsbasis BB-0007, Fassung 1 — Überprüfung (Freigabe 05.10.2026 + 12 Monate)', '2027-10-05', 573, {
        verantwortlich: IK,
        id: 'b-7',
        kennzahl_id: 'k-22',
      }),
    ],
    vorschau: [],
    anzahl_faellig: 13,
    anzahl_vorschau: 0,
    nicht_in_liste: ['AU-2029-0001', 'BB-0001', 'BR-2029-0001', 'BR-2029-0002', 'D-0001', 'D-0002', 'D-0003', 'D-0004', 'EZ-2029-0001', 'M-2029-0002', 'M-2029-0003'],
    verantwortung: UEMS_VERANTWORTUNG,
    naechste_managementbewertung: { faellig_am: '2030-02-12', kennzeichen: 'BR-2029-0001', sitzung_am: '2029-02-12', rhythmus_monate: 12 },
  };
}

/** Der Normalfall: nichts abgelaufen, nichts in den nächsten 30 Tagen, elf Fristen danach. */
export function wvNormal(): Wiedervorlage {
  return { ...wvDemo(), faellig: [], vorschau: [], anzahl_faellig: 0, anzahl_vorschau: 0 };
}

/** Ohne jede Frist. */
export function wvLeer(): Wiedervorlage {
  return { ...wvNormal(), nicht_in_liste: [], naechste_managementbewertung: null };
}

const vz = (
  gruppe: string,
  art: string,
  kennzeichen: string,
  titel: string,
  nr: number | null,
  tag: string | null,
  entschieden_von: string | null,
  eingetragen_von: string | null,
): EnergiemanagementVerzeichnisZeile & { gruppe: string } => ({
  gruppe,
  art,
  kennzeichen,
  titel,
  nr,
  entschieden_von,
  eingetragen_von,
  tag,
  pruefsumme: null,
  ort: 'in_voltpilot',
  gruppe_wort: gruppe,
  ort_satz: 'in VoltPilot',
});

/** Das Verzeichnis der Demo am 30.04.2029 (Auszug): was eine Frist beendet und was nicht. */
export function verzeichnisDemo(): EnergiemanagementVerzeichnis {
  const zeilen = [
    vz('kennzahlen_bezugsbasen', 'kennzahl_fassung', 'KZ-0025', 'Gasbezug Verwaltung je Gradtag', 1, '2029-04-30', null, 'ines'),
    vz('bewertung_messplanung', 'kriterien_fassung', 'Kriterien', 'Kriterien der energetischen Bewertung', 3, '2029-04-30', null, 'ines'),
    vz('bewertung_messplanung', 'berichtsstand', 'BR-2029-0002', 'Kunststoffwerk Ahrenberg GmbH · 2028-04/2029-03', 1, '2029-04-30', null, 'ines'),
    vz('audits_feststellungen', 'wirksamkeit', 'F-2029-0001', 'Wirksamkeit: wirksam', 1, '2029-04-15', IK, IK),
    vz('grundlagen', 'energiepolitik', 'D-0001', 'Energiepolitik', 2, '2029-03-20', 'Robert Falk', IK),
    vz('verantwortung', 'aufgabe', 'Bezugsbasen pflegen und freigeben', 'Bezugsbasen pflegen und freigeben: Ines Kaltenbach', null, '2029-03-01', 'Robert Falk', 'Jonas Wendlinger'),
    vz('managementbewertung', 'berichtsstand', 'BR-2029-0001', 'Managementbewertung 2028', 1, '2029-02-12', 'Robert Falk', IK),
    vz('audits_feststellungen', 'internes_audit', 'AU-2029-0001', 'Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen', null, '2029-01-31', IK, IK),
    vz('audits_feststellungen', 'feststellung', 'F-2029-0001', 'Wer die Bezugsbasen pflegt und freigibt, ist nicht festgelegt', null, '2029-01-22', 'Claudia Berger', IK),
    vz('ziele_massnahmen_abweichungen', 'energieziel_bewertung', 'EZ-2028-0001', 'Spritzguss: 5 % weniger Strom', null, '2029-01-15', null, IK),
    vz('kompetenz_kommunikation', 'kompetenz', 'D-0005', 'Unterweisung Zeitschaltung Werkzeugheizungen', 1, '2028-01-25', IK, IK),
    vz('kennzahlen_bezugsbasen', 'berichtsstand', 'BR-2028-0001', 'Kunststoffwerk Ahrenberg GmbH · 2027-12', 1, '2028-01-20', null, IK),
    vz('kennzahlen_bezugsbasen', 'bezugsbasis_fassung', 'BB-0001', 'Bezugsbasis BB-0001 (KZ-0004)', 2, '2027-11-25', null, IK),
  ];
  const gruppen = [...new Set(zeilen.map((z) => z.gruppe))].map((gruppe) => ({
    gruppe,
    gruppe_wort: gruppe,
    zuschnitt: [],
    satz: null,
    zeilen: zeilen.filter((z) => z.gruppe === gruppe),
  }));
  return {
    stichtag: '2029-04-30T16:16:00+02:00',
    verantwortung: UEMS_VERANTWORTUNG,
    filter: { gruppe: null, von: null, bis: null, person: null, person_name: null },
    gruppen,
  };
}
