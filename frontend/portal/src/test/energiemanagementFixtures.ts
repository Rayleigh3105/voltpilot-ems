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
  type EnergiemanagementAufgabeBeenden,
  type EnergiemanagementPersonAendern,
  type EnergiemanagementPersonMitVerlauf,
  type EnergiemanagementVerantwortung,
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

  function zuordnen(
    p: EnergiemanagementPerson, aufgabe: string, gilt_ab: string, begruendung: string, von: string,
    mehr: Partial<Pick<EnergiemanagementZuordnung, 'vertretung' | 'entschieden_von' | 'beleg' | 'beschluss_kennung' | 'aufgabe_wortlaut'>> = {}, am = jetzt(),
  ) {
    const z: EnergiemanagementZuordnung = {
      id: `a1a00000-0000-4000-8000-${String(zuordnungen.length + 1).padStart(12, '0')}`, aufgabe, wort: WOERTER.aufgabe[aufgabe], aufgabe_wortlaut: null,
      person: kurz(p), vertretung: null, gilt_ab, gilt_bis: null, zustand: 'laufend', entschieden_von: null, begruendung, beleg: null,
      beschluss_kennung: null, beendet_begruendung: null, eingetragen: eingetragen(von, am), ...mehr,
    };
    if (aufgabe === 'weitere' && z.aufgabe_wortlaut) z.wort = z.aufgabe_wortlaut;
    zuordnungen.push(z);
    return z;
  }
  const verlauf: Record<string, EnergiemanagementPersonMitVerlauf['verlauf']> = {};
  const verlaufAn = (id: string, art: string, begruendung: string | null, alt: unknown = null, neu: unknown = null) => {
    (verlauf[id] ??= []).push({ id: Object.values(verlauf).flat().length + 1, art, alt, neu, begruendung, akteur: akteur(ich.name), zeit: jetzt() });
  };
  const laeuftAm = (z: EnergiemanagementZuordnung, tag: string) => z.gilt_ab <= tag && (!z.gilt_bis || z.gilt_bis >= tag);
  /** Wie `EnergiemanagementPersonenService#aufgaben(tag)` (IP-6): je Wort die laufenden Zuordnungen und der Satz. */
  const aufgabenAm = (tag: string): EnergiemanagementAufgaben['aufgaben'] =>
    VOKABULARE.aufgabe.map((a) => {
      const laufend = zuordnungen.filter((z) => z.aufgabe === a && laeuftAm(z, tag));
      return {
        aufgabe: a, wort: WOERTER.aufgabe[a], laufend: structuredClone(laufend),
        satz: laufend.length || a === 'weitere' ? null : satzText('aufgabe_ohne_person', { aufgabe: WOERTER.aufgabe[a] }),
      };
    });

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
    const am = '2026-12-15T09:00:00+01:00';
    zuordnen(rf, 'unternehmensleitung', '2026-10-01', 'Geschäftsführer der Kunststoffwerk Ahrenberg GmbH.', 'Ines Kaltenbach', {}, am);
    // R5: neun Zuordnungen „entschieden von Robert Falk“ mit der Bestellung als Beleg — Bezugsbasen ohne Person.
    const bestellung = { bezeichnung: 'Bestellung Energiemanagement vom 28.09.2026, unterschrieben', ablage: 'Personalakte (Personalabteilung)', kennung: null, adresse: null, sha256: null };
    const [ik, jw, ph, md, cb] = ['IK', 'JW', 'PH', 'MD', 'CB'].map((k) => personen.find((p) => p.kuerzel === k)!);
    const vonRf = { entschieden_von: kurz(rf), beleg: bestellung };
    zuordnen(ik, 'energiemanagement_leiten', '2026-10-01', 'Bestellung zur Energiemanagerin vom 28.09.2026.', 'Ines Kaltenbach', { ...vonRf, vertretung: kurz(jw) }, am);
    zuordnen(ik, 'energieteam', '2026-10-01', 'Bestellung ins Energieteam vom 28.09.2026.', 'Ines Kaltenbach', vonRf, am);
    zuordnen(ph, 'energieteam', '2026-10-15', 'Bestellung ins Energieteam vom 28.09.2026.', 'Ines Kaltenbach', vonRf, am);
    zuordnen(md, 'energieteam', '2026-10-01', 'Bestellung ins Energieteam vom 28.09.2026.', 'Ines Kaltenbach', vonRf, am);
    zuordnen(ik, 'energieziele_massnahmen', '2026-10-01', 'Bestellung Energiemanagement vom 28.09.2026.', 'Ines Kaltenbach', vonRf, am);
    zuordnen(ik, 'bewertung_messplanung', '2026-10-01', 'Bestellung Energiemanagement vom 28.09.2026.', 'Ines Kaltenbach', vonRf, am);
    zuordnen(ik, 'dokumente', '2026-10-01', 'Bestellung Energiemanagement vom 28.09.2026.', 'Ines Kaltenbach', vonRf, am);
    zuordnen(ik, 'managementbewertung', '2026-10-01', 'Bestellung Energiemanagement vom 28.09.2026.', 'Ines Kaltenbach', vonRf, am);
    zuordnen(cb, 'interne_audits', '2028-12-01', 'Claudia Berger plant und führt die internen Audits durch.', 'Ines Kaltenbach', { entschieden_von: kurz(rf) }, '2028-11-20T09:00:00+01:00');
  }
  /** R5: die Objekte, wie ihre Register sie am 12.02.2029 zeigen (gekürzt), und die acht Freigaben der Bezugsbasen. */
  const objekt = (art: string, n: number, kennzeichen: string, titel: string, name: string | null, zustand: string | null = null) => ({
    art, id: `0b100000-0000-4000-8000-${String(n).padStart(12, '0')}`, kennzeichen, titel, verantwortlich: name ? { sub: null, name } : null, zustand,
  });
  const NAMEN: Record<string, string> = { IK: 'Ines Kaltenbach', JW: 'Jonas Wendlinger', PH: 'Peter Hollerbach', MD: 'Murat Demirci' };
  const EINSAETZE = ['Spritzguss Halle 1', 'Extrusion Werk Lindach', 'Trockner', 'Druckluft Werk Ahrenberg', 'Druckluft Werk Lindach', 'Rechenzentrum', 'Beleuchtung', 'Heizung Werk Ahrenberg'];
  const objekte = lage !== 'ahrenberg' ? [] : [
    objekt('kennzahl', 1, 'KZ-0004', 'Spritzguss: Strom je Tonne', NAMEN.IK),
    ...['MD', 'PH', 'IK', 'IK', 'PH', 'JW', 'JW', 'IK'].map((k, i) => objekt('energieeinsatz', 10 + i, `EE-${i + 1}`, EINSAETZE[i], NAMEN[k])),
    ...['IK', 'IK', 'IK', 'JW', 'PH'].map((k, i) => objekt('bezugsbasis', 20 + i, `BB-000${i + 1}`, `Bezugsbasis ${i + 1}`, NAMEN[k])),
    objekt('energieziel', 30, 'EZ-2028-0001', 'Spritzguss: 5 % weniger Strom', NAMEN.IK, 'verfehlt'),
    objekt('massnahme', 31, 'M-2028-0001', 'Zeitschaltung der Trockner', NAMEN.JW, 'umgesetzt'),
    objekt('massnahme', 32, 'M-2028-0002', 'Druckluft-Leckagen', NAMEN.PH, 'umgesetzt'),
  ];
  const freigaben = lage !== 'ahrenberg' ? [] : [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2], [4, 1], [5, 1]].map(([b, f]) => ({
    bezugsbasis_id: `0b100000-0000-4000-8000-${String(19 + b).padStart(12, '0')}`, bezugsbasis: `BB-000${b}`,
    kennzahl_id: `0b100000-0000-4000-8000-${String(40 + b).padStart(12, '0')}`, kennzahl: `KZ-000${b}`, fassung: f,
    freigegeben_von: 'Ines Kaltenbach', freigegeben_am: f === 1 ? '2027-01-12T10:00:00+01:00' : '2028-01-12T10:00:00+01:00', vieraugen: false, zweite_person: null,
  }));

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

  const energiemanagementPersonLesen = async (id: string) => routen.energiemanagementPerson(id);
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
      return { tag: t, leitung: leitungAm(t), aufgaben: aufgabenAm(t), zuordnungen: structuredClone(zuordnungen) };
    },
    energiemanagementAufgabeZuordnen: async (b: EnergiemanagementAufgabeZuordnen) => {
      merke('POST /api/v1/energiemanagement/aufgaben', b);
      if (b.aufgabe !== 'unternehmensleitung' && !b.entschieden_von) {
        throw new ApiError(422, 'entschieden von fehlt', { code: 'entschieden_von_fehlt', message: 'entschieden von fehlt' });
      }
      const p = personen.find((x) => x.id === b.person_id)!;
      const person = (id: string | null | undefined) => (id ? kurz(personen.find((x) => x.id === id)!) : null);
      const z = zuordnen(p, b.aufgabe, b.gilt_ab, b.begruendung, ich.name, {
        vertretung: person(b.vertretung_person_id), entschieden_von: person(b.entschieden_von), beleg: b.beleg ?? null,
        beschluss_kennung: b.beschluss_kennung ?? null, aufgabe_wortlaut: b.aufgabe_wortlaut ?? null,
      });
      verlaufAn(p.id, 'aufgabe_zugeordnet', b.begruendung);
      return structuredClone(z);
    },
    energiemanagementAufgabeBeenden: async (id: string, b: EnergiemanagementAufgabeBeenden) => {
      merke(`POST /api/v1/energiemanagement/aufgaben/${id}/beenden`, b);
      const z = zuordnungen.find((x) => x.id === id)!;
      Object.assign(z, { gilt_bis: b.gilt_bis, zustand: 'beendet', beendet_begruendung: b.begruendung });
      return structuredClone(z);
    },
    energiemanagementPerson: async (id: string): Promise<EnergiemanagementPersonMitVerlauf> => {
      await bereit;
      const p = personen.find((x) => x.id === id);
      if (!p) throw new ApiError(404, 'Person unbekannt', { code: 'person_unbekannt', message: 'Diese Person gibt es nicht.' });
      const erfasst = { id: 0, art: 'person_erfasst', alt: null, neu: null, begruendung: null, akteur: p.eingetragen.akteur, zeit: p.eingetragen.am };
      return { person: structuredClone(p), verlauf: [erfasst, ...(verlauf[id] ?? [])] };
    },
    energiemanagementPersonAendern: async (id: string, b: EnergiemanagementPersonAendern) => {
      merke(`PUT /api/v1/energiemanagement/personen/${id}`, b);
      const p = personen.find((x) => x.id === id)!;
      const alt = structuredClone(p);
      Object.assign(p, {
        name: b.name, funktion: b.funktion, kuerzel: b.kuerzel, organisation: b.organisation, seit: b.seit,
        konto: b.konto_sub ? { sub: b.konto_sub, name: p.konto?.sub === b.konto_sub ? p.konto.name : b.konto_sub, zustand: 'aktiv' } : null,
      });
      if (b.bis) Object.assign(p, { bis: b.bis, zustand: 'beendet', beendet_begruendung: b.begruendung ?? null });
      verlaufAn(id, b.bis ? 'person_beendet' : 'person_geaendert', b.begruendung ?? null, alt, structuredClone(p));
      return energiemanagementPersonLesen(id);
    },
    energiemanagementVerantwortung: async (tag?: string): Promise<EnergiemanagementVerantwortung> => {
      await bereit;
      const t = tag ?? heute();
      const aufgaben = aufgabenAm(t);
      return {
        tag: t, leitung: leitungAm(t), aufgaben, ohne_person: aufgaben.filter((a) => a.satz).map((a) => a.aufgabe),
        objekte: structuredClone(objekte), bezugsbasen_freigaben: structuredClone(freigaben),
      };
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
