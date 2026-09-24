/**
 * UEMS AP-18 IP-18: Antworten der Routen für Auffälligkeiten und Abweichungen (IP-16, OpenAPI `Auffaelligkeit*`,
 * `Abweichung*`) für Tests und die E2E-Bühne `e2e/abweichungen.tsx` — Referenzunternehmen Ahrenberg 1.9, R1, R2, R8,
 * R11: der Vermerk Dezember 2027 an KZ-0004 × BB-0001 Fassung 2 (+12,9 %, schlechter, vermerkt am 07.01.2028), die
 * Abweichung AW-2028-0001 (Ines Kaltenbach, Frist 31.01.2028), die Ursache-Aussage von Murat Demirci und AW-2026-0001
 * an KZ-0005 (vorläufig, abgeschlossen „erklärt“). Zahlen, Sätze und Fristen stellt hier die Fixture — das Portal
 * rechnet keine. Die Ablehnungen spielen die Regeln der Route nach (einmalig, Begründung, aktives Konto, Maßnahme Pflicht).
 */
import { api, ApiError, type Abweichung, type AbweichungEintrag, type AbweichungVerweis, type Auffaelligkeit } from '../api';
import { BB_IDS } from './bezugsbasisFixtures';
import { R2_DEZEMBER } from './bezugsbasisVergleichFixtures';
import { kontenAhrenberg } from './massnahmeFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

export const AW_IDS = {
  aw1: 'a8000000-0000-4000-8000-000000000001',
  aw2026: 'a8000000-0000-4000-8000-000000002026',
  neu: 'a8000000-0000-4000-8000-0000000000aa',
  vDez: 'a9000000-0000-4000-8000-000000202712',
  vNov: 'a9000000-0000-4000-8000-000000202611',
  kz5: 'c0de0000-0000-4000-8000-00000000a005',
  bb3: 'c0de0000-0000-4000-8000-0000000bb003',
} as const;

const KZ4 = { id: BB_IDS.kz4, kennzeichen: 'KZ-0004', name: 'Stromeinsatz Spritzguss je kg' };
const BB1 = { id: BB_IDS.bb1, kennzeichen: 'BB-0001', name: null };
const KZ5 = { id: AW_IDS.kz5, kennzeichen: 'KZ-0005', name: 'Netzbezug je m² Halle 2' };
const BB3 = { id: AW_IDS.bb3, kennzeichen: 'BB-0003', name: null };
/** ST-1 Werk Ahrenberg — derselbe Standort wie in den Rechte-Fixtures (R1/R8: Halle 1 und Halle 2 liegen dort). */
const ST1 = FIXTURE_IDS.st1;

export const PRUEFSUMME_R1 = 'sha256:c06d6724544317514e20bd0c63b82429711d6f32939a938cee0dbcfd45612c53';
export const PRUEFSUMME_R8 = 'sha256:172e63d268cd443cf397fbfef5df45d00fd63670a4e0a80fbc721b98866f9a57';
const kanonisch = (o: unknown) => JSON.stringify(o);

/** R1: die Kopie des Vergleichs Dezember 2027, wie die Naht (IP-15) sie schreibt. */
const ANLASS_R1 = {
  kennzahl: 'KZ-0004',
  bezugsbasis: 'BB-0001',
  fassung: 2,
  monat: '2027-12',
  beschriftung: 'Dezember 2027',
  bereinigt: R2_DEZEMBER.bereinigt,
  satz: R2_DEZEMBER.satz,
};
/** R8: November 2026 an KZ-0005, Bezugsbasis vorläufig — der Vorbehalt wird geerbt. */
const ANLASS_R8 = {
  kennzahl: 'KZ-0005',
  bezugsbasis: 'BB-0003',
  fassung: 1,
  monat: '2026-11',
  beschriftung: 'November 2026',
  bereinigt: { urteil: 'schlechter', delta_prozent: '4.1', band_prozent: '2.0', kennzeichen: ['Bezugsbasis vorläufig (1 von 12 Monaten)', 'bereinigt um Bezugsfläche (Bezugsbasis BB-0003, Fassung 1)'] },
  satz: 'November 2026: 12,387 kWh je m² gemessen, 11,903 kWh je m² erwartet bei 3 100 m² — 4,1 % mehr als die Bezugsbasis erwarten lässt: schlechter.',
};

export const KOPF_R2 =
  'Abweichung AW-2028-0001 · KZ-0004 Stromeinsatz Spritzguss je kg, Dezember 2027: 12,9 % mehr als die Bezugsbasis erwarten lässt · Verantwortlich Ines Kaltenbach · Frist 31.01.2028 · offen.';
export const AUSSAGE_R2 =
  'Die Werkzeugheizungen der Maschinen 3 bis 6 liefen vom 23.12. bis 02.01. durch — keine Abschaltung in der Betriebspause programmiert.';
export const ZUR_KENNTNIS_R11 = 'Kleinserien-Sonderauftrag KW 27–29, im Produktionsplan dokumentiert; keine Abweichung des Prozesses.';

const tagDe = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');

export function vermerkDez(over: Partial<Auffaelligkeit> = {}): Auffaelligkeit {
  return {
    id: AW_IDS.vDez,
    kennzahl: KZ4,
    bezugsbasis: BB1,
    fassung: 2,
    periode: '2027-12',
    standort_id: ST1,
    anlass: kanonisch(ANLASS_R1),
    anlass_pruefsumme: PRUEFSUMME_R1,
    anlass_inhalt: ANLASS_R1,
    vorbehalte: [],
    vermerkt_am: '2028-01-07T04:12:00Z',
    zustand: 'offen',
    antwort: null,
    antwort_begruendung: null,
    abweichung: null,
    beantwortet_am: null,
    beantwortet_von: null,
    satz: null,
    ...over,
  };
}

const eintrag = (nr: number, art: AbweichungEintrag['art'], person: string, am: string, over: Partial<AbweichungEintrag> = {}): AbweichungEintrag => ({
  nr, art, alt: null, neu: null, begruendung: null, kommentar: null, aussage: null, person, am, ...over,
});

/** Die Frist wie die Operation `frist` der Route: überfällig ab dem Tag nach dem Termin (Kalendertage). */
function frist(termin: string, abruf: string, offen: boolean): Abweichung['frist'] {
  const tage = Math.round((Date.parse(abruf) - Date.parse(termin)) / 86_400_000);
  return offen && tage > 0 ? { abruf, termin, faellig: 'ueberfaellig', seit_tagen: tage } : { abruf, termin, faellig: null, seit_tagen: null };
}

function kopfSatz(a: Pick<Abweichung, 'kennzeichen' | 'verantwortlich' | 'zustand' | 'monate'>, termin: string, kz: AbweichungVerweis = KZ4): string | null {
  if (a.monate.length !== 1 || a.monate[0] !== '2027-12' || kz.id !== KZ4.id) return null;
  return `Abweichung ${a.kennzeichen} · KZ-0004 Stromeinsatz Spritzguss je kg, Dezember 2027: 12,9 % mehr als die Bezugsbasis erwarten lässt · Verantwortlich ${a.verantwortlich.name} · Frist ${tagDe(termin)} · ${a.zustand}.`;
}

/** R2: AW-2028-0001 offen, eröffnet am 12.01.2028 aus dem Vermerk Dezember 2027. */
export function aw1(abruf = '2028-01-15', over: Partial<Abweichung> = {}): Abweichung {
  const basis: Abweichung = {
    id: AW_IDS.aw1,
    kennzeichen: 'AW-2028-0001',
    kennzahl: KZ4,
    bezugsbasis: BB1,
    fassung: 2,
    monate: ['2027-12'],
    herkunft: { art: 'auffaelligkeit', wortlaut: null },
    anlass: kanonisch(ANLASS_R1),
    anlass_pruefsumme: PRUEFSUMME_R1,
    anlass_inhalt: ANLASS_R1,
    vorbehalte: [],
    verantwortlich: { sub: 'IK', name: 'Ines Kaltenbach' },
    frist: frist('2028-01-31', abruf, true),
    standort_id: ST1,
    zustand: 'offen',
    eroeffnet_am: '2028-01-12',
    eroeffnet_von: 'Ines Kaltenbach',
    abschluss: null,
    kopf_satz: KOPF_R2,
    vermerke: [vermerkDez({ zustand: 'beantwortet', antwort: 'abweichung', abweichung: { id: AW_IDS.aw1, kennzeichen: 'AW-2028-0001', name: null }, beantwortet_am: '2028-01-12T09:00:00Z', beantwortet_von: 'Ines Kaltenbach' })],
    verlauf: [
      eintrag(1, 'abweichung_eroeffnet', 'Ines Kaltenbach', '2028-01-12T09:00:00Z'),
      eintrag(2, 'kommentar', 'Ines Kaltenbach', '2028-01-12T09:05:00Z', {
        kommentar: 'Produktion 21,9 % unter November, Strom nur 8,8 % — der Grundlast-Anteil ist gestiegen. Bitte Halle 1 prüfen: liefen Werkzeugheizungen über die Feiertage?',
      }),
    ],
  };
  return { ...basis, ...over };
}

/** R8: AW-2026-0001 an KZ-0005, abgeschlossen „erklärt“ am 20.12.2026 — mit geerbtem Vorbehalt. */
export function aw2026(abruf = '2028-01-15'): Abweichung {
  const begruendung = 'Baustellenstrom des Anbaus über MS-10 (Aussage JW); keine Maßnahme am Gebäude.';
  return {
    id: AW_IDS.aw2026,
    kennzeichen: 'AW-2026-0001',
    kennzahl: KZ5,
    bezugsbasis: BB3,
    fassung: 1,
    monate: ['2026-11'],
    herkunft: { art: 'auffaelligkeit', wortlaut: null },
    anlass: kanonisch(ANLASS_R8),
    anlass_pruefsumme: PRUEFSUMME_R8,
    anlass_inhalt: ANLASS_R8,
    vorbehalte: ['Bezugsbasis vorläufig (1 von 12 Monaten)'],
    verantwortlich: { sub: 'JW', name: 'Jonas Wendlinger' },
    frist: frist('2027-01-08', abruf, false),
    standort_id: ST1,
    zustand: 'abgeschlossen',
    eroeffnet_am: '2026-12-09',
    eroeffnet_von: 'Ines Kaltenbach',
    abschluss: {
      ergebnis: 'erklaert',
      massnahme: null,
      begruendung,
      am: '2026-12-20',
      person: 'Ines Kaltenbach',
      satz: `Abgeschlossen am 20.12.2026 von Ines Kaltenbach: erklärt — ‚${begruendung}‘`,
    },
    kopf_satz: 'Abweichung AW-2026-0001 · KZ-0005 Netzbezug je m² Halle 2, November 2026: 4,1 % mehr als die Bezugsbasis erwarten lässt · Verantwortlich Jonas Wendlinger · Frist 08.01.2027 · abgeschlossen.',
    vermerke: [],
    verlauf: [
      eintrag(1, 'abweichung_eroeffnet', 'Ines Kaltenbach', '2026-12-09T09:00:00Z'),
      eintrag(2, 'ursache_aussage', 'Ines Kaltenbach', '2026-12-10T09:00:00Z', {
        aussage: {
          wortlaut: 'Der Anbau der Halle 2 läuft seit Mitte November; Baustellenstrom hängt am Unterverteiler von MS-10 und ist nicht getrennt gemessen.',
          sub: 'JW',
          name: 'Jonas Wendlinger',
          am: '2026-12-10',
          beleg_kennung: null,
          kennzeichen: 'Aussage von Jonas Wendlinger, 10.12.2026 — keine Messung',
          satz: 'Ursache — Aussage von Jonas Wendlinger, 10.12.2026 (keine Messung): ‚Der Anbau der Halle 2 läuft seit Mitte November; Baustellenstrom hängt am Unterverteiler von MS-10 und ist nicht getrennt gemessen.‘',
        },
      }),
      eintrag(3, 'abweichung_abgeschlossen', 'Ines Kaltenbach', '2026-12-20T09:00:00Z', { begruendung }),
    ],
  };
}

export type AbweichungLage = 'leer' | 'vermerk' | 'offen' | 'register';

/**
 * Die Routen im Gedächtnis: `leer` (nichts) · `vermerk` (Dezember 2027 offen an KZ-0004, keine Abweichung — R1 vor der
 * Antwort) · `offen` (AW-2028-0001 offen, Vermerk beantwortet) · `register` (AW-2028-0001 offen und überfällig,
 * AW-2026-0001 abgeschlossen „erklärt“). `heute` ist der Tag der Route; `name` trägt ein.
 */
export function abweichungBuehne(lage: AbweichungLage, heute: string, name = 'Ines Kaltenbach'): Partial<typeof api> {
  const vermerke = new Map<string, Auffaelligkeit>(lage === 'vermerk' ? [[AW_IDS.vDez, vermerkDez()]] : lage === 'leer' ? [] : [[AW_IDS.vDez, aw1(heute).vermerke![0]]]);
  const start: Abweichung[] = lage === 'offen' ? [aw1(heute)] : lage === 'register' ? [aw1(heute), aw2026(heute)] : [];
  const liste = new Map(start.map((a) => [a.id, a]));
  let zaehler = 0;
  const konten = kontenAhrenberg();
  const jetzt = `${heute}T10:00:00Z`;
  const holen = (id: string) => {
    const a = liste.get(id);
    if (!a) throw new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' });
    return a;
  };
  const nurOffen = (a: Abweichung) => {
    if (a.zustand !== 'offen') throw new ApiError(409, 'abweichung_abgeschlossen', { code: 'abweichung_abgeschlossen' });
  };
  const begruendet = (t: string | undefined) => {
    if (!t || t.trim().length < 10 || t.trim().length > 500) throw new ApiError(422, 'begruendung_fehlt', { code: 'begruendung_fehlt' });
  };
  const aktiv = (sub: string | undefined) => {
    const k = konten.find((x) => x.sub === sub && x.zustand === 'aktiv');
    if (!k) throw new ApiError(422, 'benutzer_unbekannt', { code: 'benutzer_unbekannt' });
    return { sub: k.sub, name: k.anzeigename };
  };
  const weiter = (a: Abweichung, art: AbweichungEintrag['art'], over: Partial<AbweichungEintrag>) => [
    ...(a.verlauf ?? []),
    eintrag((a.verlauf?.length ?? 0) + 1, art, name, jetzt, over),
  ];
  const plus30 = () => new Date(Date.parse(heute) + 30 * 86_400_000).toISOString().slice(0, 10);
  const neueAbweichung = (teil: Pick<Abweichung, 'monate' | 'herkunft' | 'anlass' | 'anlass_inhalt' | 'anlass_pruefsumme' | 'vermerke' | 'verantwortlich'>, termin: string): Abweichung => {
    zaehler += 1;
    const kennzeichen = `AW-${heute.slice(0, 4)}-${String(zaehler).padStart(4, '0')}`;
    const a: Abweichung = {
      ...aw1(heute),
      ...teil,
      id: zaehler === 1 ? AW_IDS.neu : `${AW_IDS.neu.slice(0, -2)}${String(zaehler).padStart(2, '0')}`,
      kennzeichen,
      frist: frist(termin, heute, true),
      eroeffnet_am: heute,
      eroeffnet_von: name,
      verlauf: [eintrag(1, 'abweichung_eroeffnet', name, jetzt)],
    };
    a.kopf_satz = kopfSatz(a, termin);
    liste.set(a.id, a);
    return a;
  };
  return {
    auffaelligkeiten: async (kennzahlId) => {
      const v = [...vermerke.values()].filter((x) => x.kennzahl.id === kennzahlId);
      return { kennzahl: KZ4, abruf: heute, offen: v.filter((x) => x.zustand === 'offen').length, vermerke: v };
    },
    auffaelligkeitAntworten: async (_kz, aid, body) => {
      const v = vermerke.get(aid);
      if (!v) throw new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' });
      if (v.zustand !== 'offen') throw new ApiError(409, 'auffaelligkeit_beantwortet', { code: 'auffaelligkeit_beantwortet' });
      if (body.antwort === 'zur_kenntnis') {
        begruendet(body.begruendung);
        const neu: Auffaelligkeit = {
          ...v,
          zustand: 'beantwortet',
          antwort: 'zur_kenntnis',
          antwort_begruendung: body.begruendung.trim(),
          beantwortet_am: jetzt,
          beantwortet_von: name,
          satz: `Auffälligkeit Dezember 2027: 12,9 % mehr als die Bezugsbasis erwarten lässt (schlechter, Band ± 2 %) — zur Kenntnis genommen von ${name} am ${tagDe(heute)}: ‚${body.begruendung.trim()}‘`,
        };
        vermerke.set(aid, neu);
        return { vermerk: neu, abweichung: null };
      }
      const person = aktiv(body.verantwortlich);
      const mit = [...vermerke.values()].filter((x) => x.zustand === 'offen' && x.fassung === v.fassung && x.kennzahl.id === v.kennzahl.id);
      const a = neueAbweichung(
        {
          monate: mit.map((x) => x.periode).sort(),
          herkunft: { art: 'auffaelligkeit', wortlaut: null },
          anlass: mit.length === 1 ? v.anlass : kanonisch({ vermerke: mit.map((x) => x.anlass_inhalt) }),
          anlass_inhalt: mit.length === 1 ? v.anlass_inhalt : { vermerke: mit.map((x) => x.anlass_inhalt) },
          anlass_pruefsumme: v.anlass_pruefsumme,
          vermerke: [],
          verantwortlich: person,
        },
        body.frist ?? plus30(),
      );
      for (const x of mit) {
        vermerke.set(x.id, { ...x, zustand: 'beantwortet', antwort: 'abweichung', abweichung: { id: a.id, kennzeichen: a.kennzeichen, name: null }, beantwortet_am: jetzt, beantwortet_von: name });
      }
      a.vermerke = mit.map((x) => vermerke.get(x.id)!);
      return { vermerk: vermerke.get(aid)!, abweichung: a };
    },
    abweichungen: async () => ({ abruf: heute, abweichungen: [...liste.values()].map((a) => ({ ...a, vermerke: null, verlauf: null })) }),
    abweichung: async (id) => holen(id),
    abweichungEroeffnen: async (body) => {
      if (!body.wortlaut || body.wortlaut.trim().length < 10) throw new ApiError(422, 'wortlaut_fehlt', { code: 'wortlaut_fehlt' });
      const person = aktiv(body.verantwortlich);
      const monat = body.monate.split('/')[0];
      const zeile = { periode: monat, bereinigt: R2_DEZEMBER.bereinigt, satz: R2_DEZEMBER.satz };
      const inhalt = { kennzahl: 'KZ-0004', bezugsbasis: body.bezugsbasis ?? 'BB-0001', fassung: 2, monate: body.monate, vergleich: [zeile] };
      return neueAbweichung(
        {
          monate: [monat],
          herkunft: { art: 'von_hand', wortlaut: body.wortlaut.trim() },
          anlass: kanonisch(inhalt),
          anlass_inhalt: inhalt,
          anlass_pruefsumme: 'sha256:5e1f0c2b7a9d4e6f8a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f',
          vermerke: [],
          verantwortlich: person,
        },
        body.frist ?? plus30(),
      );
    },
    abweichungEintrag: async (id, body) => {
      const a = holen(id);
      nurOffen(a);
      let neu: Abweichung;
      if (body.art === 'kommentar') {
        if (!body.text?.trim()) throw new ApiError(422, 'text_ungueltig', { code: 'text_ungueltig' });
        neu = { ...a, verlauf: weiter(a, 'kommentar', { kommentar: body.text }) };
      } else {
        if (!body.wortlaut || body.wortlaut.trim().length < 10) throw new ApiError(422, 'wortlaut_fehlt', { code: 'wortlaut_fehlt' });
        if (body.aussage_am > heute) throw new ApiError(422, 'aussage_in_der_zukunft', { code: 'aussage_in_der_zukunft' });
        const wer = body.aussage_sub ? aktiv(body.aussage_sub) : body.aussage_name ? { sub: null, name: body.aussage_name } : null;
        if (!wer) throw new ApiError(422, 'aussage_ohne_person', { code: 'aussage_ohne_person' });
        const beleg = body.beleg_kennung ?? null;
        const am = tagDe(body.aussage_am);
        neu = {
          ...a,
          verlauf: weiter(a, 'ursache_aussage', {
            aussage: {
              wortlaut: body.wortlaut,
              sub: wer.sub,
              name: wer.name,
              am: body.aussage_am,
              beleg_kennung: beleg,
              kennzeichen: `Aussage von ${wer.name}, ${am} — ${beleg ? `mit Beleg ${beleg}` : 'keine Messung'}`,
              satz: `Ursache — Aussage von ${wer.name}, ${am} (${beleg ? `mit Beleg: ${beleg}` : 'keine Messung'}): ‚${body.wortlaut}‘`,
            },
          }),
        };
      }
      liste.set(id, neu);
      return neu;
    },
    abweichungFrist: async (id, body) => {
      const a = holen(id);
      nurOffen(a);
      begruendet(body.begruendung);
      if (body.frist < a.eroeffnet_am) throw new ApiError(422, 'frist_vor_eroeffnung', { code: 'frist_vor_eroeffnung' });
      const neu: Abweichung = {
        ...a,
        frist: frist(body.frist, heute, true),
        verlauf: weiter(a, 'abweichung_geaendert', { begruendung: body.begruendung, alt: { frist: a.frist.termin }, neu: { frist: body.frist } }),
      };
      neu.kopf_satz = kopfSatz(neu, body.frist, a.kennzahl);
      liste.set(id, neu);
      return neu;
    },
    abweichungVerantwortlicher: async (id, body) => {
      const a = holen(id);
      nurOffen(a);
      begruendet(body.begruendung);
      const person = aktiv(body.benutzer);
      const neu: Abweichung = { ...a, verantwortlich: person, verlauf: weiter(a, 'verantwortlicher_geaendert', { begruendung: body.begruendung }) };
      neu.kopf_satz = kopfSatz(neu, a.frist.termin, a.kennzahl);
      liste.set(id, neu);
      return neu;
    },
    abweichungAbschliessen: async (id, body) => {
      const a = holen(id);
      nurOffen(a);
      begruendet(body.begruendung);
      let massnahme: AbweichungVerweis | null = null;
      if (body.ergebnis === 'massnahme') {
        if (!body.massnahme) throw new ApiError(422, 'massnahme_fehlt', { code: 'massnahme_fehlt' });
        const m = await api.massnahme(body.massnahme).catch(() => {
          throw new ApiError(422, 'massnahme_unbekannt', { code: 'massnahme_unbekannt' });
        });
        massnahme = { id: m.id, kennzeichen: m.kennzeichen, name: m.titel };
      }
      const b = body.begruendung.trim();
      const neu: Abweichung = {
        ...a,
        zustand: 'abgeschlossen',
        frist: frist(a.frist.termin, heute, false),
        abschluss: {
          ergebnis: body.ergebnis,
          massnahme,
          begruendung: b,
          am: heute,
          person: name,
          satz:
            body.ergebnis === 'massnahme'
              ? `Abgeschlossen am ${tagDe(heute)} von ${name}: Maßnahme ${massnahme!.kennzeichen} — ‚${b}‘`
              : body.ergebnis === 'erklaert'
                ? `Abgeschlossen am ${tagDe(heute)} von ${name}: erklärt — ‚${b}‘`
                : null,
        },
        verlauf: weiter(a, 'abweichung_abgeschlossen', { begruendung: b }),
      };
      neu.kopf_satz = kopfSatz(neu, a.frist.termin, a.kennzahl);
      liste.set(id, neu);
      return neu;
    },
  };
}
