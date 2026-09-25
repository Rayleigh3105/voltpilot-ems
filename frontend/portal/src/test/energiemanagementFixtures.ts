/**
 * UEMS AP-19 IP-9: die Routen des Energiemanagements (IP-6 Personen/Aufgaben, IP-7 Dokumente, IP-8 Verzeichnis) im
 * Browser gespielt — für die Bühne `e2e/energiemanagement.tsx` und die Vitest-Fälle. Referenz: Kunststoffwerk
 * Ahrenberg (`uems-referenzunternehmen.json` 1.10, AP-19 R1–R3). Die Sätze bildet die Bühne mit den Schablonen des
 * Vertrags (`energiemanagement.ts`), die Prüfsumme einer Fassung wie der Dienst über die kanonische Kopie (A1).
 *
 * Jeder Schreib-Körper landet in `gesendet` (auf der Bühne `window.__emGesendet`) — die Netzwerk-Probe von IP-9 liest
 * dort, was an der Grenze zur Route ankam: beim Verweis nur Ablage, Kennung, Angaben und die Prüfsumme, nie die Datei.
 *
 * Lagen: `start` — sechs Personen, keine Leitung, kein Dokument (der Weg Anlegen → Fassung → Freigabe);
 * `ahrenberg` — Stand 12.02.2029 mit D-0001 Energiepolitik (R1), D-0002 Anwendungsbereich (R2), D-0003 Rechtliche
 * Anforderungen als Verweis, Robert Falk als Leitung und Zeilen aus dem Bestand von AP-11 bis AP-18 (R3).
 */
import {
  ApiError,
  type EnergiemanagementAufgaben,
  type EnergiemanagementDokument,
  type EnergiemanagementDokumentAnlegen,
  type EnergiemanagementDokumentKurz,
  type EnergiemanagementEingetragen,
  type EnergiemanagementEntscheid,
  type EnergiemanagementFassung,
  type EnergiemanagementFassungEntwerfen,
  type EnergiemanagementPerson,
  type EnergiemanagementPersonAnlegen,
  type EnergiemanagementPersonKurz,
  type EnergiemanagementAufgabeZuordnen,
  type EnergiemanagementVergleich,
  type EnergiemanagementVerzeichnis,
  type EnergiemanagementVerzeichnisFilter,
  type EnergiemanagementVerzeichnisZeile,
  type EnergiemanagementZuordnung,
  type StandorteAmStichtag,
} from '../api';
import { DOKUMENT_ART_KLASSE, satz, ueberpruefung, verzeichnisZeile, VOKABULARE, WOERTER, SAETZE } from '../energiemanagement';
import { kanonisch, PRUEFSUMME_PRAEFIX } from '../uemsBericht';
import { werkAhrenberg, werkLindach } from './standorteFixtures';

export type EnergiemanagementLage = 'start' | 'ahrenberg';

const ST1 = werkAhrenberg();
const ST2 = werkLindach();
const kurzOrt = (s: typeof ST1) => ({ id: s.id, kurzzeichen: s.kurzzeichen, name: s.name });

/** Gruppe je Art — wie `DokumentVerzeichnis.GRUPPE` (IP-7). */
const GRUPPE: Record<string, string> = {
  energiepolitik: 'grundlagen', anwendungsbereich: 'grundlagen', kontext: 'grundlagen', rechtliche_anforderungen: 'grundlagen',
  verfahren: 'grundlagen', bestellung: 'verantwortung', risiken_chancen: 'risiken_chancen', kompetenz: 'kompetenz_kommunikation',
  kommunikation: 'kompetenz_kommunikation', betrieb: 'betrieb_auslegung_beschaffung', auslegung: 'betrieb_auslegung_beschaffung',
  beschaffung: 'betrieb_auslegung_beschaffung',
};
const GEFUEHRT = 'in VoltPilot geführt';
const WORTLAUT = 'Wortlaut in VoltPilot, Original bei Ihnen';
const VERWEIS = 'Verweis auf Ihr System';
/** Die Zeilen des Zuschnitts je Gruppe — wie `EnergiemanagementVerzeichnisService.ZUSCHNITT` (IP-8). */
const ZUSCHNITT: Record<string, { teil: string; stufe: string }[]> = {
  grundlagen: [
    { teil: 'Anwendungsbereich', stufe: GEFUEHRT }, { teil: 'Kontext und interessierte Parteien', stufe: VERWEIS },
    { teil: 'Rechtliche Anforderungen', stufe: VERWEIS }, { teil: 'Energiepolitik', stufe: WORTLAUT },
  ],
  verantwortung: [{ teil: 'Aufgaben im Energiemanagement', stufe: GEFUEHRT }],
  risiken_chancen: [{ teil: 'Risiken und Chancen', stufe: VERWEIS }],
  kompetenz_kommunikation: [{ teil: 'Kompetenz', stufe: VERWEIS }, { teil: 'Kommunikation', stufe: GEFUEHRT }],
  betrieb_auslegung_beschaffung: [
    { teil: 'Betrieb und Instandhaltung', stufe: VERWEIS }, { teil: 'Auslegung', stufe: VERWEIS }, { teil: 'Beschaffung', stufe: VERWEIS },
  ],
  bewertung_messplanung: [{ teil: 'Energetische Bewertung und Messplanung', stufe: GEFUEHRT }],
  kennzahlen_bezugsbasen: [{ teil: 'Kennzahlen, Bezugsbasen und Leistungsvergleiche', stufe: GEFUEHRT }],
  ziele_massnahmen_abweichungen: [{ teil: 'Energieziele, Maßnahmen und Abweichungen', stufe: GEFUEHRT }],
  audits_feststellungen: [{ teil: 'Interne Audits', stufe: GEFUEHRT }, { teil: 'Feststellung, Maßnahme, Wirksamkeit', stufe: GEFUEHRT }],
  managementbewertung: [{ teil: 'Eingaben, Sitzung, Beschlüsse', stufe: GEFUEHRT }],
  berichte: [{ teil: 'Berichte', stufe: GEFUEHRT }],
};

const PERSONEN_ID = {
  RF: 'a1900000-0000-4000-8000-0000000000f1', IK: 'a1900000-0000-4000-8000-0000000000a1', JW: 'a1900000-0000-4000-8000-0000000000a2',
  PH: 'a1900000-0000-4000-8000-0000000000a3', MD: 'a1900000-0000-4000-8000-0000000000a4', CB: 'a1900000-0000-4000-8000-0000000000a5',
} as const;
export const EM_IDS = {
  ...PERSONEN_ID,
  d1: 'd1900000-0000-4000-8000-000000000001', d2: 'd1900000-0000-4000-8000-000000000002', d3: 'd1900000-0000-4000-8000-000000000003',
};

const akteur = (name: string, rolle = 'energiemanager') => ({ sub: null, name, rolle, art: 'kunde' as const });
const eingetragen = (name: string, am: string, rolle?: string): EnergiemanagementEingetragen => ({ akteur: akteur(name, rolle), am });

function person(k: keyof typeof PERSONEN_ID, name: string, funktion: string, konto: string | null, seit: string): EnergiemanagementPerson {
  return {
    id: PERSONEN_ID[k], name, funktion, kuerzel: k, organisation: null,
    konto: konto ? { sub: konto, name, zustand: 'aktiv' } : null,
    seit, bis: null, zustand: 'aktiv', beendet_begruendung: null, eingetragen: eingetragen('Ines Kaltenbach', `${seit}T09:00:00+02:00`),
  };
}
const kurz = (p: EnergiemanagementPerson): EnergiemanagementPersonKurz => ({ id: p.id, name: p.name, funktion: p.funktion, kuerzel: p.kuerzel, mit_konto: !!p.konto });

const tagText = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const satzText = (k: string, w: Record<string, string>) => satz(k, w).satz ?? '';

async function sha256Hex(text: string) {
  const summe = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(summe)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Die Bestandszeilen anderer Register am 12.02.2029 (R3, gekürzt: je Gruppe die ersten Zeilen). */
function bestand(lage: EnergiemanagementLage): EnergiemanagementVerzeichnisZeile[] {
  const z = (e: Omit<EnergiemanagementVerzeichnisZeile, 'gruppe_wort' | 'ort_satz'> & { ablage?: string | null }) =>
    verzeichnisZeile({ ablage: null, ...e }) as EnergiemanagementVerzeichnisZeile;
  const zeilen = [
    z({ gruppe: 'kennzahlen_bezugsbasen', art: 'kennzahl', kennzeichen: 'KZ-0004', titel: 'Spritzguss: Strom je Tonne', nr: 1, entschieden_von: null, eingetragen_von: 'Ines Kaltenbach', tag: '2026-11-02', pruefsumme: null, ort: 'in_voltpilot' }),
    z({ gruppe: 'kennzahlen_bezugsbasen', art: 'bezugsbasis', kennzeichen: 'BB-0001', titel: 'Spritzguss 2027', nr: 2, entschieden_von: 'Ines Kaltenbach', eingetragen_von: 'Ines Kaltenbach', tag: '2028-01-12', pruefsumme: 'sha256:7c41d0a95f2b36e1c8d4a7f0b91e2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3', ort: 'in_voltpilot' }),
    z({ gruppe: 'bewertung_messplanung', art: 'bewertung', kennzeichen: 'BR-2027-0003', titel: 'Energetische Bewertung 2027', nr: 1, entschieden_von: 'Ines Kaltenbach', eingetragen_von: 'Ines Kaltenbach', tag: '2027-11-04', pruefsumme: 'sha256:2f6a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a', ort: 'in_voltpilot' }),
    z({ gruppe: 'ziele_massnahmen_abweichungen', art: 'energieziel', kennzeichen: 'EZ-2028-0001', titel: 'Spritzguss: 5 % weniger Strom', nr: 1, entschieden_von: 'Ines Kaltenbach', eingetragen_von: 'Ines Kaltenbach', tag: '2027-12-18', pruefsumme: null, ort: 'in_voltpilot' }),
    z({ gruppe: 'ziele_massnahmen_abweichungen', art: 'massnahme', kennzeichen: 'M-2028-0001', titel: 'Zeitschaltung der Trockner', nr: 1, entschieden_von: 'Jonas Wendlinger', eingetragen_von: 'Ines Kaltenbach', tag: '2028-02-01', pruefsumme: null, ort: 'in_voltpilot' }),
    z({ gruppe: 'berichte', art: 'bericht', kennzeichen: 'BR-2028-0007', titel: 'Leistungsvergleich 2028', nr: 1, entschieden_von: 'Ines Kaltenbach', eingetragen_von: 'Ines Kaltenbach', tag: '2029-01-15', pruefsumme: 'sha256:0a52c97d3e1f4b6a8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d', ort: 'in_voltpilot' }),
  ];
  return lage === 'ahrenberg' ? zeilen : zeilen.slice(0, 1);
}

export function energiemanagementBuehne(lage: EnergiemanagementLage, ich: { kennung: string; name: string }, jetzt: () => string = () => new Date().toISOString()) {
  const heute = () => jetzt().slice(0, 10);
  const gesendet: { route: string; koerper: unknown }[] = [];
  const merke = (route: string, koerper: unknown) => {
    gesendet.push({ route, koerper: structuredClone(koerper) });
  };
  const personen: EnergiemanagementPerson[] = [
    person('IK', 'Ines Kaltenbach', 'Energiemanagement', 'IK', '2026-10-01'),
    person('JW', 'Jonas Wendlinger', 'IT-Leitung', 'JW', '2026-10-01'),
    person('PH', 'Peter Hollerbach', 'Standortleiter Werk Lindach', 'PH', '2026-10-15'),
    person('MD', 'Murat Demirci', 'Schichtführer Halle 1', 'MD', '2026-10-01'),
    person('CB', 'Claudia Berger', 'Controlling', 'CB', '2028-12-01'),
  ];
  // Die Konten der Bühne: das Subject des angemeldeten Kontos trägt die Person mit seinem Kürzel.
  for (const p of personen) if (p.konto && p.kuerzel === ich.kennung) p.konto.sub = ich.kennung;
  const zuordnungen: EnergiemanagementZuordnung[] = [];
  const dokumente: EnergiemanagementDokument[] = [];
  let zaehler = 0;
  let personNr = 0;

  const leitungAm = (tag: string) =>
    zuordnungen.filter((z) => z.aufgabe === 'unternehmensleitung' && z.gilt_ab <= tag && (!z.gilt_bis || z.gilt_bis >= tag)).map((z) => z.person);

  function zuordnen(p: EnergiemanagementPerson, aufgabe: string, gilt_ab: string, begruendung: string, von: string) {
    const z: EnergiemanagementZuordnung = {
      id: `a1a00000-0000-4000-8000-${String(zuordnungen.length + 1).padStart(12, '0')}`, aufgabe, wort: WOERTER.aufgabe[aufgabe], aufgabe_wortlaut: null,
      person: kurz(p), vertretung: null, gilt_ab, gilt_bis: null, zustand: 'laufend', entschieden_von: null, begruendung, beleg: null,
      beschluss_kennung: null, beendet_begruendung: null, eingetragen: eingetragen(von, jetzt()),
    };
    zuordnungen.push(z);
    return z;
  }

  /** Überprüfung und Sätze wie der Dienst (DK5, §5.8) — gerechnet beim Abruf. */
  function abgerufen(d: EnergiemanagementDokument): EnergiemanagementDokument {
    const fassungen = d.fassungen.map((f) => ({ ...f, status: f.status === 'freigegeben' && f.nr !== d.gueltige_fassung ? ('abgeloest' as const) : f.status }));
    const gueltig = fassungen.find((f) => f.nr === d.gueltige_fassung) ?? null;
    const abruf = heute();
    const u = d.zustand === 'aufgehoben'
      ? null
      : (ueberpruefung({
          art: 'dokument', dokument_art: d.art, monate: d.ueberpruefung_monate,
          fassungen: fassungen.filter((f) => f.status === 'freigegeben' || f.status === 'abgeloest').map((f) => ({ nr: f.nr, freigegeben_am: f.entschieden_am! })),
          geprueft_bleibt: d.eintraege.filter((e) => e.art === 'geprueft_bleibt').map((e) => ({ fassung: e.fassung!, am: e.am! })),
          abruf,
        }) as Exclude<ReturnType<typeof ueberpruefung>, { fehler: string }>);
    const kopf = gueltig
      ? satzText('dokument_kopf', {
          art: d.art_wort, kennzeichen: d.kennzeichen, fassung: String(gueltig.nr), am: tagText(gueltig.entschieden_am!),
          entschieden_von: `${gueltig.entschieden_von!.name} (${gueltig.entschieden_von!.funktion})`, eingetragen_von: gueltig.freigabe!.akteur.name,
        })
      : null;
    const gesperrt = ['energiepolitik', 'anwendungsbereich', 'bestellung'].includes(d.art) && leitungAm(abruf).length === 0 && fassungen.some((f) => f.status === 'entwurf')
      ? SAETZE.freigabe_ohne_leitung
      : null;
    return {
      ...structuredClone(d), fassungen,
      ueberpruefung: u ? ({ abruf, ...u } as EnergiemanagementDokument['ueberpruefung']) : null,
      saetze: { kopf, ueberpruefung: u?.tage != null && u.tage > 0 ? satzText('ueberpruefung', { tage: String(u.tage) }) : null, freigabe_gesperrt: gesperrt },
    };
  }
  const kurzform = (d: EnergiemanagementDokument): EnergiemanagementDokumentKurz => {
    const a = abgerufen(d);
    return { id: a.id, kennzeichen: a.kennzeichen, art: a.art, art_wort: a.art_wort, klasse: a.klasse, titel: a.titel, bezug: a.bezug, zustand: a.zustand, gueltige_fassung: a.gueltige_fassung, ueberpruefung: a.ueberpruefung, eingetragen: a.eingetragen };
  };
  const finde = (id: string) => {
    const d = dokumente.find((x) => x.id === id);
    if (!d) throw new ApiError(404, 'Nicht gefunden.', { code: 'nicht_gefunden', message: 'Nicht gefunden.' });
    return d;
  };

  function neuesDokument(b: EnergiemanagementDokumentAnlegen, id?: string, am = jetzt()): EnergiemanagementDokument {
    zaehler += 1;
    const st = b.bezug.art === 'standort' ? [ST1, ST2].find((s) => s.id === b.bezug.standort_id) ?? null : null;
    const d: EnergiemanagementDokument = {
      id: id ?? `d1900000-0000-4000-8000-${String(100 + zaehler).padStart(12, '0')}`, kennzeichen: `D-${String(zaehler).padStart(4, '0')}`, art: b.art,
      art_wort: WOERTER.dokument_art[b.art], klasse: DOKUMENT_ART_KLASSE[b.art] as 'vorgabe' | 'nachweis', titel: b.titel,
      bezug: { art: b.bezug.art, standort: st ? kurzOrt(st) : null }, zustand: 'entwurf',
      ueberpruefung_monate: DOKUMENT_ART_KLASSE[b.art] === 'vorgabe' ? (b.ueberpruefung_monate ?? 12) : null, beleg: b.beleg ?? null,
      gueltige_fassung: null, fassungen: [], eintraege: [], ueberpruefung: null, saetze: { kopf: null, ueberpruefung: null, freigabe_gesperrt: null },
      eingetragen: eingetragen(ich.name, am), verlauf: [],
    };
    dokumente.push(d);
    return d;
  }

  function entwerfen(d: EnergiemanagementDokument, b: EnergiemanagementFassungEntwerfen, am = jetzt()) {
    const offen = d.fassungen.find((f) => f.status === 'entwurf');
    const nr = offen?.nr ?? d.fassungen.length + 1;
    const ab = b.anwendungsbereich
      ? { standorte: [ST1, ST2].filter((s) => b.anwendungsbereich!.standort_ids.includes(s.id)).map(kurzOrt), traeger: b.anwendungsbereich.traeger, ausschluesse: b.anwendungsbereich.ausschluesse ?? [] }
      : null;
    const f: EnergiemanagementFassung = {
      nr, form: b.form, wortlaut: b.form === 'wortlaut' ? (b.wortlaut ?? null) : null,
      verweis: b.form === 'verweis' ? { bezeichnung: null, kennung: null, adresse: null, fassungsangabe: null, datum: null, sha256: null, ...b.verweis } : null,
      anwendungsbereich: ab, status: 'entwurf', begruendung: b.begruendung ?? null, beschluss_kennung: b.beschluss_kennung ?? null, pruefsumme: null,
      vieraugen: false, entschieden_von: null, entschieden_am: null, freigabe_begruendung: null, freigabe: null, zweite_person: null,
      ablehnung_begruendung: null, freigegeben_am: null, eingetragen: eingetragen(ich.name, am),
    };
    d.fassungen = offen ? d.fassungen.map((x) => (x.nr === nr ? f : x)) : [...d.fassungen, f];
    return !offen;
  }

  async function freigeben(d: EnergiemanagementDokument, nr: number, b: EnergiemanagementEntscheid, am = jetzt()) {
    const f = d.fassungen.find((x) => x.nr === nr)!;
    const p = personen.find((x) => x.id === b.entschieden_von);
    const tag = b.entschieden_am ?? am.slice(0, 10);
    if (['energiepolitik', 'anwendungsbereich', 'bestellung'].includes(d.art) && !leitungAm(tag).some((l) => l.id === p?.id)) {
      throw new ApiError(422, SAETZE.freigabe_ohne_leitung, { code: 'leitung_fehlt', message: SAETZE.freigabe_ohne_leitung });
    }
    const kopie = {
      nr: f.nr, form: f.form, wortlaut: f.wortlaut, verweis: f.verweis,
      anwendungsbereich: f.anwendungsbereich ? { standorte: f.anwendungsbereich.standorte.map((s) => s.kurzzeichen), traeger: f.anwendungsbereich.traeger, ausschluesse: f.anwendungsbereich.ausschluesse } : null,
    };
    Object.assign(f, {
      status: 'freigegeben', entschieden_von: p ? kurz(p) : null, entschieden_am: tag, freigabe_begruendung: b.begruendung ?? null,
      freigabe: eingetragen(ich.name, am), freigegeben_am: am, pruefsumme: PRUEFSUMME_PRAEFIX + (await sha256Hex(kanonisch(kopie))),
    });
    d.gueltige_fassung = nr;
    d.zustand = 'gueltig';
  }

  if (lage === 'ahrenberg') {
    const rf = person('RF', 'Robert Falk', 'Geschäftsführer', null, '2026-10-01');
    personen.unshift(rf);
    zuordnen(rf, 'unternehmensleitung', '2026-10-01', 'Geschäftsführer der Kunststoffwerk Ahrenberg GmbH.', 'Ines Kaltenbach');
    zuordnen(personen[1], 'energiemanagement_leiten', '2026-10-01', 'Bestellung zur Energiemanagerin vom 28.09.2026.', 'Ines Kaltenbach');
  }

  /** Der Stand von R1–R3 am 12.02.2029 — gebaut über dieselben Wege wie jede Handlung der Bühne. */
  const bereit = (async () => {
    if (lage !== 'ahrenberg') return;
    const d1 = neuesDokument(
      { art: 'energiepolitik', titel: 'Energiepolitik', bezug: { art: 'unternehmen' }, beleg: { bezeichnung: 'Energiepolitik Fassung 1, unterschrieben', ablage: 'QM-Laufwerk, Ordner Energiemanagement/Politik', kennung: 'EP-2026', adresse: null, sha256: '3f1f253d0c40224028a65d3cd9409b689463ff4feab3282db32f83252bf73b9b' } },
      EM_IDS.d1, '2026-12-15T10:00:00+01:00',
    );
    entwerfen(d1, { form: 'wortlaut', wortlaut: 'Die Kunststoffwerk Ahrenberg GmbH will ihren Energieeinsatz in beiden Werken kennen und ihre energiebezogene Leistung Jahr für Jahr verbessern. Wir messen den Energieeinsatz, setzen uns jährlich Energieziele und stellen die Informationen und Mittel bereit, die dafür nötig sind. Wir legen fest, wer im Energiemanagement wofür zuständig ist. Wir halten die für uns geltenden rechtlichen Anforderungen zum Energieeinsatz ein.' }, '2026-12-15T10:05:00+01:00');
    await freigeben(d1, 1, { entschieden_von: EM_IDS.RF, entschieden_am: '2026-12-15', begruendung: 'Erste Fassung zum Start des Energiemanagements.' }, '2026-12-15T10:10:00+01:00');
    const bekannt = (weg: string, id: number) => ({
      id, art: 'bekannt_gemacht' as const, fassung: 1, am: '2026-12-18', person: kurz(personen[1]), entschieden_von: null, kreis: 'alle Mitarbeitenden beider Werke',
      weg, weg_wortlaut: null, begruendung: null, beschluss_kennung: null, kommentar: null, satz: null, eingetragen: eingetragen('Ines Kaltenbach', '2026-12-18T09:00:00+01:00'),
    });
    d1.eintraege.push(bekannt('aushang', 1), bekannt('intranet', 2), {
      id: 3, art: 'geprueft_bleibt', fassung: 1, am: '2027-12-10', person: kurz(personen[1]), entschieden_von: kurz(personen[0]), kreis: null, weg: null, weg_wortlaut: null,
      begruendung: 'Mit der Jahresplanung 2028 durchgesehen; die Politik gilt unverändert.', beschluss_kennung: null, kommentar: null,
      satz: satzText('geprueft_bleibt', { person: 'Robert Falk', am: '10.12.2027', begruendung: 'Mit der Jahresplanung 2028 durchgesehen; die Politik gilt unverändert.' }),
      eingetragen: eingetragen('Ines Kaltenbach', '2027-12-10T09:00:00+01:00'),
    });
    const d2 = neuesDokument({ art: 'anwendungsbereich', titel: 'Anwendungsbereich', bezug: { art: 'unternehmen' } }, EM_IDS.d2, '2026-12-15T11:00:00+01:00');
    entwerfen(d2, { form: 'wortlaut', wortlaut: 'Das Energiemanagement umfasst beide Werke der Kunststoffwerk Ahrenberg GmbH und die Energieträger Strom und Gas. Es gibt keine Ausschlüsse.', anwendungsbereich: { standort_ids: [ST1.id, ST2.id], traeger: ['Strom', 'Gas'] } }, '2026-12-15T11:05:00+01:00');
    await freigeben(d2, 1, { entschieden_von: EM_IDS.RF, entschieden_am: '2026-12-15', begruendung: 'Erste Fassung zum Start des Energiemanagements.' }, '2026-12-15T11:10:00+01:00');
    // R12: auch der Anwendungsbereich ist seit 64 Tagen fällig — „geprüft, bleibt“ am 10.12.2027 wie die Energiepolitik.
    d2.eintraege.push({ ...d1.eintraege[2], id: 4, begruendung: 'Mit der Jahresplanung 2028 durchgesehen; beide Werke, Strom und Gas.',
      satz: satzText('geprueft_bleibt', { person: 'Robert Falk', am: '10.12.2027', begruendung: 'Mit der Jahresplanung 2028 durchgesehen; beide Werke, Strom und Gas.' }) });
    const d3 = neuesDokument({ art: 'rechtliche_anforderungen', titel: 'Rechtskataster Energie', bezug: { art: 'unternehmen' } }, EM_IDS.d3, '2027-03-01T09:00:00+01:00');
    entwerfen(d3, { form: 'verweis', verweis: { bezeichnung: 'Rechtskataster Energie und Umwelt', ablage: 'Rechtskataster-Dienst, Mandant Ahrenberg', kennung: 'RK-EN-01', adresse: null, fassungsangabe: 'Stand 02/2027', datum: '2027-02-28', sha256: null } }, '2027-03-01T09:05:00+01:00');
    await freigeben(d3, 1, { entschieden_von: EM_IDS.IK, entschieden_am: '2027-03-01', begruendung: 'Kataster zum Start übernommen und durchgesehen.' }, '2027-03-01T09:10:00+01:00');
  })();

  const verzeichnis = (filter: EnergiemanagementVerzeichnisFilter): EnergiemanagementVerzeichnis => {
    const zeilen: EnergiemanagementVerzeichnisZeile[] = [];
    for (const d of dokumente) {
      for (const f of d.fassungen.filter((x) => x.status === 'freigegeben' || x.status === 'abgeloest')) {
        const verweis = f.form === 'verweis';
        zeilen.push(verzeichnisZeile({
          gruppe: GRUPPE[d.art], art: d.art, kennzeichen: d.kennzeichen, titel: d.titel, nr: f.nr, entschieden_von: f.entschieden_von?.name ?? null,
          eingetragen_von: f.freigabe?.akteur.name ?? null, tag: f.entschieden_am, pruefsumme: verweis ? (f.verweis?.sha256 ?? null) : f.pruefsumme,
          ort: verweis ? 'verweis' : d.beleg ? 'wortlaut_original_beim_kunden' : 'in_voltpilot', ablage: verweis ? (f.verweis?.ablage ?? null) : (d.beleg?.ablage ?? null),
        }) as EnergiemanagementVerzeichnisZeile);
      }
      for (const e of d.eintraege.filter((x) => x.art === 'bekannt_gemacht')) {
        zeilen.push(verzeichnisZeile({
          gruppe: 'kompetenz_kommunikation', art: 'bekanntmachung', kennzeichen: d.kennzeichen, titel: `${d.titel}: bekannt gemacht an ${e.kreis}`, nr: e.fassung,
          entschieden_von: null, eingetragen_von: e.person?.name ?? null, tag: e.am, pruefsumme: null, ort: 'in_voltpilot', ablage: null,
        }) as EnergiemanagementVerzeichnisZeile);
      }
    }
    for (const z of zuordnungen.filter((x) => x.zustand === 'laufend')) {
      zeilen.push(verzeichnisZeile({
        gruppe: 'verantwortung', art: 'aufgabe', kennzeichen: z.wort, titel: `${z.wort}: ${z.person.name}`, nr: null, entschieden_von: z.entschieden_von?.name ?? null,
        eingetragen_von: z.eingetragen.akteur.name, tag: z.gilt_ab, pruefsumme: null, ort: 'in_voltpilot', ablage: null,
      }) as EnergiemanagementVerzeichnisZeile);
    }
    zeilen.push(...bestand(lage));
    const person = filter.person ? personen.find((p) => p.id === filter.person) ?? null : null;
    const passt = (z: EnergiemanagementVerzeichnisZeile) =>
      (!filter.von || (z.tag !== null && z.tag >= filter.von)) &&
      (!filter.bis || (z.tag !== null && z.tag <= filter.bis)) &&
      (!person || (z.entschieden_von ?? z.eingetragen_von) === person.name);
    const gruppen = VOKABULARE.verzeichnis_gruppe.filter((g) => !filter.gruppe || g === filter.gruppe).map((g) => {
      const diese = zeilen.filter((z) => z.gruppe === g && passt(z));
      return { gruppe: g, gruppe_wort: WOERTER.verzeichnis_gruppe[g], zuschnitt: ZUSCHNITT[g], satz: diese.length ? null : SAETZE.verzeichnis_leer, zeilen: diese };
    });
    return {
      stichtag: `${new Date(jetzt()).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 16).replace(' ', 'T')}+01:00`, verantwortung: SAETZE.verantwortung,
      filter: { gruppe: filter.gruppe || null, von: filter.von || null, bis: filter.bis || null, person: person?.id ?? null, person_name: person?.name ?? null },
      gruppen,
    };
  };

  const routen = {
    standorte: async (): Promise<StandorteAmStichtag> => ({ stichtag: heute(), standorte: [ST1, ST2], nichtGezeigt: [], nochNichtZugeordnet: null }),
    energiemanagementPersonen: async () => {
      await bereit;
      return { personen: structuredClone(personen) };
    },
    energiemanagementPersonAnlegen: async (b: EnergiemanagementPersonAnlegen) => {
      merke('POST /api/v1/energiemanagement/personen', b);
      personNr += 1;
      const p: EnergiemanagementPerson = {
        id: `a1900000-0000-4000-8000-${String(900 + personNr).padStart(12, '0')}`, name: b.name, funktion: b.funktion, kuerzel: b.kuerzel ?? null,
        organisation: b.organisation ?? null, konto: null, seit: b.seit ?? null, bis: null, zustand: 'aktiv', beendet_begruendung: null, eingetragen: eingetragen(ich.name, jetzt()),
      };
      personen.push(p);
      return { person: structuredClone(p) };
    },
    energiemanagementAufgaben: async (tag?: string): Promise<EnergiemanagementAufgaben> => {
      await bereit;
      const t = tag ?? heute();
      return { tag: t, leitung: leitungAm(t), aufgaben: [], zuordnungen: structuredClone(zuordnungen) };
    },
    energiemanagementAufgabeZuordnen: async (b: EnergiemanagementAufgabeZuordnen) => {
      merke('POST /api/v1/energiemanagement/aufgaben', b);
      const p = personen.find((x) => x.id === b.person_id)!;
      return structuredClone(zuordnen(p, b.aufgabe, b.gilt_ab, b.begruendung, ich.name));
    },
    energiemanagementVerzeichnis: async (filter: EnergiemanagementVerzeichnisFilter = {}) => {
      await bereit;
      return verzeichnis(filter);
    },
    energiemanagementVerzeichnisCsv: async (filter: EnergiemanagementVerzeichnisFilter = {}) => {
      await bereit;
      const v = verzeichnis(filter);
      const zeilen = v.gruppen.flatMap((g) => g.zeilen.map((z) => [g.gruppe_wort, z.art, z.kennzeichen, z.titel, z.nr ?? '', z.entschieden_von ?? '', z.eingetragen_von ?? '', z.tag ?? '', z.pruefsumme ?? '', z.ort_satz].join(';')));
      return new Blob([`﻿# ${v.verantwortung}\r\nGruppe;Art;Kennzeichen;Titel;Fassung oder Nr.;entschieden von;eingetragen von;Tag;Prüfsumme;Ort\r\n${zeilen.join('\r\n')}\r\n`], { type: 'text/csv' });
    },
    energiemanagementDokumente: async () => {
      await bereit;
      return { dokumente: dokumente.map(kurzform) };
    },
    energiemanagementDokument: async (id: string) => {
      await bereit;
      return abgerufen(finde(id));
    },
    energiemanagementVergleich: async (id: string): Promise<EnergiemanagementVergleich> => {
      await bereit;
      const d = abgerufen(finde(id));
      const f = d.fassungen.find((x) => x.nr === d.gueltige_fassung) ?? null;
      const umfang = { fassung: 1, gueltig_ab: '2026-11-04', standorte: [kurzOrt(ST1), kurzOrt(ST2)], traeger: ['Strom', 'Gas'], begruendung: null };
      const ab = f?.anwendungsbereich ?? null;
      if (!ab) return { abruf: heute(), fassung: null, anwendungsbereich: null, betrachtungsumfang: umfang, vergleich: null, saetze: [] };
      const nurAb = ab.traeger.filter((t) => !umfang.traeger.includes(t));
      const vergleich = {
        standorte_nur_im_anwendungsbereich: ab.standorte.filter((s) => !umfang.standorte.some((u) => u.id === s.id)),
        standorte_nur_im_betrachtungsumfang: umfang.standorte.filter((s) => !ab.standorte.some((u) => u.id === s.id)),
        traeger_nur_im_anwendungsbereich: nurAb, traeger_nur_im_betrachtungsumfang: umfang.traeger.filter((t) => !ab.traeger.includes(t)),
        deckungsgleich: false,
      };
      vergleich.deckungsgleich = !vergleich.standorte_nur_im_anwendungsbereich.length && !vergleich.standorte_nur_im_betrachtungsumfang.length && !nurAb.length && !vergleich.traeger_nur_im_betrachtungsumfang.length;
      const saetze = vergleich.deckungsgleich
        ? [satzText('anwendungsbereich_deckungsgleich', { fassung: '1', ab: tagText(umfang.gueltig_ab) })]
        : [...vergleich.standorte_nur_im_anwendungsbereich.map((s) => s.name ?? ''), ...nurAb].map((was) => satzText('anwendungsbereich_unterschied', { was, fassung: '1' }));
      return { abruf: heute(), fassung: f!.nr, anwendungsbereich: ab, betrachtungsumfang: umfang, vergleich, saetze };
    },
    energiemanagementDokumentAnlegen: async (b: EnergiemanagementDokumentAnlegen) => {
      await bereit;
      merke('POST /api/v1/energiemanagement/dokumente', b);
      return abgerufen(neuesDokument(b));
    },
    energiemanagementFassungEntwerfen: async (id: string, b: EnergiemanagementFassungEntwerfen) => {
      merke(`POST /api/v1/energiemanagement/dokumente/${id}/fassungen`, b);
      const d = finde(id);
      entwerfen(d, b);
      return abgerufen(d);
    },
    energiemanagementFassungBeantragen: async (id: string, nr: number, b: EnergiemanagementEntscheid) => {
      merke(`POST /api/v1/energiemanagement/dokumente/${id}/fassungen/${nr}/beantragen`, b);
      throw new ApiError(409, 'Vier-Augen ist bei Ihnen aus.', { code: 'vieraugen_aus', message: 'Vier-Augen ist bei Ihnen aus.' });
    },
    energiemanagementFassungFreigeben: async (id: string, nr: number, b: EnergiemanagementEntscheid) => {
      merke(`POST /api/v1/energiemanagement/dokumente/${id}/fassungen/${nr}/freigeben`, b);
      const d = finde(id);
      await freigeben(d, nr, b);
      return abgerufen(d);
    },
  };
  return { routen, gesendet, bereit };
}
