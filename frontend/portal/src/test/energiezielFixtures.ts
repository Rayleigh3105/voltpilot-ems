/**
 * UEMS AP-18 IP-8: Antworten der Energieziel-Routen (IP-6, OpenAPI `Energieziel*`) und der Bewertungs-Naht (IP-7) für
 * Tests und die E2E-Bühne `e2e/energieziele.tsx` — Referenzunternehmen Ahrenberg 1.9, R4 und R10: EZ-2028-0001 an
 * KZ-0004 × BB-0001 Fassung 2, Zielwert −5,0 %, Zielperiode 2028-01/2028-12, Verantwortlich Ines Kaltenbach.
 * Stand 10.07.2028: 2,9 % weniger nach 5 von 12 Monaten (März 2028 nicht bewertbar); Ende 15.01.2029: 2,7 % weniger
 * nach 11 von 12 Monaten, kein Vorschlag, Bewertung fällig seit 15 Tagen; bewertet „verfehlt“. Die Monate Juli bis
 * Dezember 2028 sind die Annahme-Reihe der Erweiterung 1.9 (Juli 2,5 % mehr, R11); die Summen Σ ÷ Σ stehen wie im
 * Report (R4: 410 400 ÷ 422 809 kWh). Die Zahlen stellt hier die Fixture — das Portal rechnet keine davon.
 */
import { ApiError, type api, type Energieziel, type EnergiezielBewertungSchritt, type EnergiezielErgebnis, type EnergiezielStand } from '../api';
import type { BezugsbasisVergleichMonat, VergleichUrteil } from '../bezugsbasisVergleich';
import { BB_IDS } from './bezugsbasisFixtures';

export const EZ_IDS = {
  ez1: 'e2000000-0000-4000-8000-000000000001',
  neu: 'e2000000-0000-4000-8000-0000000000aa',
} as const;

const IK = { sub: 'IK', name: 'Ines Kaltenbach' };
const KENNZEICHEN_BASIS = ['bereinigt um Produktionsmenge (Modell mit einer Einflussgröße, Bezugsbasis BB-0001, Fassung 2; Streuung ± 0,8 %)'];
const FASSUNG_2 = {
  fassung: 2,
  methode: 'regression_eine_variable' as const,
  referenzperiode: '2026-11/2027-10',
  datenlage: 'vollstaendig' as const,
  gilt_ab: '2027-11-01',
  gilt_bis: null,
};
const MONATSNAME = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const tausend = (n: string) => n.replace(/\.\d+$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Eine Monatszeile des Vergleich-Lesers (`BezugsbasisVergleichMonat`), wie IP-19 sie liefert. */
function monat(
  periode: string,
  kwh: string | null,
  kg: string | null,
  b: { erwartet?: string; delta?: string; urteil?: VergleichUrteil; grund?: BezugsbasisVergleichMonat['bereinigt']['grund']; satz?: string },
): BezugsbasisVergleichMonat {
  const beschriftung = `${MONATSNAME[Number(periode.slice(5, 7)) - 1]} ${periode.slice(0, 4)}`;
  const urteil = b.urteil ?? 'nicht_anwendbar';
  const richtung = b.delta === undefined ? null : b.delta.startsWith('-') ? ('weniger' as const) : ('mehr' as const);
  const wort = { besser: 'besser', schlechter: 'schlechter', im_rahmen: 'im Rahmen (± 2 %)' }[urteil as 'besser'] ?? '';
  return {
    periode,
    beschriftung,
    roh: { gemessen: kwh, vorher: null, delta_prozent: null, richtung: null, variable_delta_prozent: null, urteil: 'ohne_urteil' },
    bereinigt: {
      fassung: FASSUNG_2,
      gemessen: { wert: kwh, einheit: 'kWh', version: kwh === null ? null : 1, zustand: kwh === null ? null : 'vollstaendig' },
      bedingung: [{ position: 1, quelle: 'bezugsgroesse', kennzeichen: 'BZ-1', name: 'Produktionsmenge', wert: kg, einheit: 'kg', fassung: 1, version: 1, zustand: 'vollstaendig' }],
      erwartet: b.erwartet ?? null,
      delta_prozent: b.delta ?? null,
      band_prozent: b.erwartet ? '2.0' : null,
      richtung,
      urteil,
      grund: b.grund ?? null,
      kennzeichen: KENNZEICHEN_BASIS,
    },
    satz:
      b.satz ??
      `${beschriftung}: ${tausend(kwh!)} kWh gemessen, ${tausend(b.erwartet!)} kWh erwartet bei ${tausend(kg!)} kg — ${b.delta!.replace('-', '').replace('.', ',')} % ${richtung === 'weniger' ? 'weniger' : 'mehr'} als die Bezugsbasis erwarten lässt: ${wort}.`,
  };
}

const MAERZ = monat('2028-03', '100000', '390000', {
  grund: 'variable_ausserhalb',
  satz: 'Modell nicht anwendbar: Produktionsmenge im März 2028 (390 000 kg) liegt außerhalb der Bezugsbasis (228 600–375 100 kg).',
});
const ERSTES_HALBJAHR = [
  monat('2028-01', '78000', '300000', { erwartet: '80813', delta: '-3.5', urteil: 'besser' }),
  monat('2028-02', '81500', '305000', { erwartet: '81984.5', delta: '-0.6', urteil: 'im_rahmen' }),
  MAERZ,
  monat('2028-04', '81900', '318000', { erwartet: '85047', delta: '-3.7', urteil: 'besser' }),
  monat('2028-05', '83900', '326000', { erwartet: '86900', delta: '-3.5', urteil: 'besser' }),
  monat('2028-06', '85100', '331000', { erwartet: '88064.5', delta: '-3.4', urteil: 'besser' }),
];
const ZWEITES_HALBJAHR = [
  monat('2028-07', '86100', '300000', { erwartet: '84000', delta: '2.5', urteil: 'schlechter' }),
  monat('2028-08', '84000', '327000', { erwartet: '87000', delta: '-3.4', urteil: 'besser' }),
  monat('2028-09', '85500', '332000', { erwartet: '88300', delta: '-3.2', urteil: 'besser' }),
  monat('2028-10', '86000', '334000', { erwartet: '88900', delta: '-3.3', urteil: 'besser' }),
  monat('2028-11', '85000', '331000', { erwartet: '88100', delta: '-3.5', urteil: 'besser' }),
  monat('2028-12', '85100', '333000', { erwartet: '88591', delta: '-3.9', urteil: 'besser' }),
];
const offenerMonat = (periode: string) =>
  monat(periode, null, null, {
    grund: 'periode_nicht_zu_ende',
    satz: `${MONATSNAME[Number(periode.slice(5, 7)) - 1]} ${periode.slice(0, 4)}: nicht bewertbar — der Monat ist nicht zu Ende.`,
  });

export const STAND_SATZ_JULI =
  'Energieziel EZ-2028-0001 · Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt · Januar bis Dezember 2028 · Verantwortlich Ines Kaltenbach. Stand nach 5 von 12 Monaten: 2,9 % weniger (März 2028 nicht bewertbar: Produktionsmenge außerhalb der Bezugsbasis). Bezugsbasis BB-0001, Fassung 2.';
export const STAND_SATZ_ENDE =
  'Energieziel EZ-2028-0001 · Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt · Januar bis Dezember 2028 · Verantwortlich Ines Kaltenbach. Stand nach 11 von 12 Monaten: 2,7 % weniger (März 2028 nicht bewertbar: Produktionsmenge außerhalb der Bezugsbasis). Bezugsbasis BB-0001, Fassung 2.';

export function ez2028(over: Partial<Energieziel> = {}): Energieziel {
  return {
    id: EZ_IDS.ez1,
    kennzeichen: 'EZ-2028-0001',
    kennzahl: { id: BB_IDS.kz4, kennzeichen: 'KZ-0004', name: 'Stromeinsatz Spritzguss je kg' },
    bezugsbasis: { id: BB_IDS.bb1, kennzeichen: 'BB-0001', fassung: 2 },
    zielwert_prozent: '-5.0',
    zielperiode: '2028-01/2028-12',
    wortlaut: 'Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt — Jahresziel 2028.',
    begruendung: 'Jahresplanung 2028 nach der Freigabe der Fassung 2 (24.11.2027); Maßnahmen folgen aus den Auffälligkeiten.',
    verantwortlich: IK,
    standort_id: null,
    zustand: 'offen',
    angelegt_am: '2027-12-20',
    beendet_zum: null,
    beendet_grund: null,
    ergebnis: null,
    verlauf: [
      {
        art: 'energieziel_angelegt',
        alt: null,
        neu: { zielwert_prozent: '-5.0', zielperiode: '2028-01/2028-12' },
        begruendung: 'Jahresplanung 2028 nach der Freigabe der Fassung 2 (24.11.2027); Maßnahmen folgen aus den Auffälligkeiten.',
        person: 'Ines Kaltenbach',
        am: '2027-12-20T09:14:00+01:00',
      },
    ],
    frist: FRIST_OFFEN,
    bewertung: null,
    anstoesse: [],
    ...over,
  };
}

/** R4: der Stand am 10.07.2028 — Januar bis Juni endgültig, März nicht gezählt, kein Vorschlag. */
export function standJuli(ez: Energieziel = ez2028()): EnergiezielStand {
  return {
    energieziel: ez,
    abruf: '2028-07-10',
    zielperiode: ez.zielperiode,
    zielwert_prozent: ez.zielwert_prozent,
    monate: [
      ...ERSTES_HALBJAHR.map((v) => ({ periode: v.periode, endgueltig: true, vergleich: v })),
      ...['2028-07', '2028-08', '2028-09', '2028-10', '2028-11', '2028-12'].map((p) => ({ periode: p, endgueltig: false, vergleich: offenerMonat(p) })),
    ],
    monate_bewertbar: 5,
    monate_endgueltig: 6,
    monate_soll: 12,
    monate_text: '5 von 12',
    vollstaendig: false,
    nicht_gezaehlt: [{ monat: '2028-03', grund: 'variable_ausserhalb' }],
    summe: { gemessen: '410400', erwartet: '422809', delta_prozent: '-2.9', band_prozent: '2.0', richtung: 'weniger', urteil: 'besser', kennzeichen: [...KENNZEICHEN_BASIS, '5 von 12 Monaten'] },
    vorschlag: null,
    satz: STAND_SATZ_JULI,
    vorschlag_satz: null,
  };
}

/** R10: der Stand am 15.01.2029 — zwölf Monate endgültig, 11 von 12 bewertbar, darum kein Vorschlag (Z4). */
export function standEnde(ez: Energieziel = ez2028()): EnergiezielStand {
  return {
    ...standJuli(ez),
    abruf: '2029-01-15',
    monate: [...ERSTES_HALBJAHR, ...ZWEITES_HALBJAHR].map((v) => ({ periode: v.periode, endgueltig: true, vergleich: v })),
    monate_bewertbar: 11,
    monate_endgueltig: 12,
    monate_text: '11 von 12',
    summe: { gemessen: '922100', erwartet: '947700', delta_prozent: '-2.7', band_prozent: '2.0', richtung: 'weniger', urteil: 'besser', kennzeichen: [...KENNZEICHEN_BASIS, '11 von 12 Monaten'] },
    satz: STAND_SATZ_ENDE,
  };
}

/** Ein frisch gesetztes Energieziel ohne endgültigen Monat: keine Zahl, „0 von 12“, kein Satz (Invariante 5). */
export function standLeer(ez: Energieziel): EnergiezielStand {
  const [von] = ez.zielperiode.split('/');
  const jahr = von.slice(0, 4);
  const monate = Array.from({ length: 12 }, (_, i) => `${jahr}-${String(i + 1).padStart(2, '0')}`);
  return {
    energieziel: ez,
    abruf: ez.angelegt_am,
    zielperiode: ez.zielperiode,
    zielwert_prozent: ez.zielwert_prozent,
    monate: monate.map((p) => ({ periode: p, endgueltig: false, vergleich: offenerMonat(p) })),
    monate_bewertbar: 0,
    monate_endgueltig: 0,
    monate_soll: 12,
    monate_text: '0 von 12',
    vollstaendig: false,
    nicht_gezaehlt: [],
    summe: { gemessen: null, erwartet: null, delta_prozent: null, band_prozent: null, richtung: null, urteil: 'nicht_anwendbar', kennzeichen: [] },
    vorschlag: null,
    satz: null,
    vorschlag_satz: null,
  };
}

const FRIST_OFFEN = { termin: '2028-12-31', faellig: null, seit_tagen: null };
const PRUEFSUMME = 'sha256:3f9a61c2b7d04e18a5c6f0d29b7e3c41a8f5d6e27c90b1a34e5f6d7c8b9a0e12';
/** Die Kopie des Ziel-Stands zum Bewertungstag (kanonischer Text, gekürzt — die Bühne prüft sie nicht). */
const KOPIE = '{"energieziel":"EZ-2028-0001","abruf":"2029-01-15","monate":"11 von 12","summe":{"delta_prozent":"-2.7"}}';

/** Eine Bewertung wie IP-7 sie liefert (`EnergiezielBewertung`). */
function bewertung(over: Partial<NonNullable<Energieziel['bewertung']>> = {}): NonNullable<Energieziel['bewertung']> {
  return {
    status: 'bewertet', ergebnis: 'verfehlt', begruendung: BEGRUENDUNG_R10, vorschlag: null, vieraugen: false,
    person: IK, am: '2029-01-15T10:00:00+01:00', entscheidung: null, entschieden_am: null, entscheidungs_begruendung: null,
    kopie: KOPIE, pruefsumme: PRUEFSUMME, ...over,
  };
}

const BEGRUENDUNG_R10 = 'Zwei Maßnahmen wirken erst ab dem zweiten Halbjahr; der Juli (Sonderauftrag) und der März ohne Vergleich tragen den Rest.';

/** IP-20: ein offener Anstoß am Energieziel (Pfad 2, IP-17) — Bezugsbasis BB-0001 neu gefasst. */
export const ANSTOSS_NEU_GEFASST: NonNullable<Energieziel['anstoesse']>[number] = {
  id: 'ab000000-0000-4000-8000-00000000e201',
  art: 'messgrundlage_neu_gefasst',
  anlass_kennung: 'BB-0001/Fassung-3',
  angestossen_am: '2028-11-02T08:00:00+01:00',
  zustand: 'offen',
  antwort: null,
  antwort_begruendung: null,
  beantwortet_am: null,
  beantwortet_von: null,
};

export type EnergiezielLage = 'leer' | 'juli' | 'faellig' | 'beantragt' | 'bewertet' | 'anstoss';

/**
 * Die Routen der Bühne: `leer` (kein Energieziel, R13) · `juli` (R4) · `faellig` (R10 vor der Bewertung, fällig seit
 * 15 Tagen) · `beantragt` (Vier-Augen: IK hat „verfehlt“ beantragt) · `bewertet` (R10 nach dem 15.01.2029) · `anstoss`
 * (IP-20: wie `juli`, dazu ein offener Anstoß „Bezugsbasis neu gefasst“ BB-0001/Fassung-3 aus Pfad 2). Anlegen,
 * Beenden und Bewerten verändern den Zustand der Bühne wie die Route; mit `vieraugen` wird „bewerten“ ein Antrag.
 */
export function energiezielBuehne(lage: EnergiezielLage, vieraugen = false, sub = 'IK', name = 'Ines Kaltenbach'): Partial<typeof api> {
  const ende = lage !== 'juli' && lage !== 'leer' && lage !== 'anstoss';
  const start: Energieziel[] =
    lage === 'leer'
      ? []
      : [
          ez2028(
            lage === 'juli'
              ? {}
              : lage === 'anstoss'
                ? { anstoesse: [ANSTOSS_NEU_GEFASST] }
              : lage === 'bewertet'
                ? {
                    zustand: 'bewertet',
                    ergebnis: 'verfehlt',
                    bewertung: bewertung(),
                  }
                : {
                    frist: { termin: '2028-12-31', faellig: 'bewertung_faellig', seit_tagen: 15 },
                    ...(lage === 'beantragt' ? { bewertung: bewertung({ status: 'beantragt', vieraugen: true }) } : {}),
                  },
          ),
        ];
  const ziele = new Map(start.map((ez) => [ez.id, ez]));
  const stand = (ez: Energieziel) => (ez.id === EZ_IDS.ez1 ? (ende ? standEnde(ez) : standJuli(ez)) : standLeer(ez));
  const holen = (id: string) => {
    const ez = ziele.get(id);
    if (!ez) throw new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' });
    return ez;
  };
  const eintrag = (art: NonNullable<Energieziel['verlauf']>[number]['art'], begruendung: string) => ({
    art, alt: null, neu: null, begruendung, person: name, am: '2029-01-15T10:00:00+01:00',
  });
  return {
    energieziele: async () => ({ energieziele: [...ziele.values()].map((ez) => ({ ...ez, anstoesse: null, verlauf: null })) }),
    energieziel: async (id) => holen(id),
    energiezielStand: async (id) => stand(holen(id)),
    energiezielAnlegen: async (body) => {
      const jahr = body.zielperiode.slice(0, 4);
      const ez = ez2028({
        id: EZ_IDS.neu,
        kennzeichen: `EZ-${jahr}-0001`,
        zielwert_prozent: body.zielwert_prozent.toFixed(1),
        zielperiode: body.zielperiode,
        wortlaut: body.wortlaut,
        begruendung: body.begruendung,
        angelegt_am: '2026-09-24',
        verlauf: [{ art: 'energieziel_angelegt', alt: null, neu: null, begruendung: body.begruendung, person: name, am: '2026-09-24T10:00:00+02:00' }],
      });
      ziele.set(ez.id, ez);
      return ez;
    },
    energiezielBeenden: async (id, body) => {
      const ez = holen(id);
      const neu: Energieziel = {
        ...ez, zustand: 'beendet', beendet_zum: body.zum ?? '2029-01-15', beendet_grund: body.begruendung, frist: { ...ez.frist, faellig: null, seit_tagen: null },
        verlauf: [...(ez.verlauf ?? []), eintrag('energieziel_beendet', body.begruendung)],
      };
      ziele.set(id, neu);
      return neu;
    },
    // IP-17-NAHT (Z5): `bleibt` mit Begründung · `neu_bewertet` nur an Basis-Ende/-Neufassung, wie `bewerten`.
    energiezielAnstossAntwort: async (id, aid, body) => {
      const ez = holen(id);
      const a = (ez.anstoesse ?? []).find((x) => x.id === aid);
      if (!a) throw new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' });
      if (a.zustand !== 'offen') throw new ApiError(409, 'anstoss_beantwortet', { code: 'anstoss_beantwortet' });
      const basis = a.art === 'messgrundlage_beendet' || a.art === 'messgrundlage_neu_gefasst';
      if (body.antwort === 'neu_kopiert' || (body.antwort === 'neu_bewertet' && !basis)) {
        throw new ApiError(422, 'antwort_passt_nicht', { code: 'antwort_passt_nicht' });
      }
      const t = body.begruendung?.trim() ?? '';
      if (body.antwort === 'bleibt' && (t.length < 10 || t.length > 500)) throw new ApiError(422, 'begruendung_fehlt', { code: 'begruendung_fehlt' });
      const am = '2028-11-05T10:00:00+01:00';
      const beantwortet = { ...a, zustand: 'beantwortet' as const, antwort: body.antwort, antwort_begruendung: t || null, beantwortet_am: am, beantwortet_von: name };
      const neu: Energieziel = {
        ...ez,
        ...(body.antwort === 'neu_bewertet'
          ? vieraugen
            ? { bewertung: bewertung({ status: 'beantragt', ergebnis: body.ergebnis as EnergiezielErgebnis, begruendung: t, vieraugen: true, person: { sub, name }, am }) }
            : { zustand: 'bewertet' as const, ergebnis: body.ergebnis as EnergiezielErgebnis, bewertung: bewertung({ ergebnis: body.ergebnis as EnergiezielErgebnis, begruendung: t, person: { sub, name }, am }) }
          : {}),
        anstoesse: (ez.anstoesse ?? []).map((x) => (x.id === aid ? beantwortet : x)),
        verlauf: [...(ez.verlauf ?? []), { ...eintrag('anstoss_beantwortet', t), am }],
      };
      ziele.set(id, neu);
      return neu;
    },
    energiezielBewertung: async (id, schritt: EnergiezielBewertungSchritt, body) => {
      const ez = holen(id);
      const person = { sub, name };
      const am = '2029-01-15T10:00:00+01:00';
      const text = body.begruendung ?? null;
      // Wie IP-7: mit Vier-Augen lehnt `bewerten` ab (409 `vieraugen_beantragen`), ohne lehnt `beantragen` ab.
      if (schritt === 'bewerten' && vieraugen) throw new ApiError(409, 'vieraugen_beantragen', { code: 'vieraugen_beantragen' });
      if (schritt === 'beantragen' && !vieraugen) throw new ApiError(409, 'vieraugen_aus', { code: 'vieraugen_aus' });
      if ((schritt === 'freigeben' || schritt === 'ablehnen') && ez.bewertung?.person.sub === sub) {
        throw new ApiError(422, 'vieraugen_urheber', { code: 'vieraugen_urheber' });
      }
      let neu: Energieziel;
      if (schritt === 'beantragen') {
        neu = {
          ...ez,
          bewertung: bewertung({ status: 'beantragt', ergebnis: body.ergebnis!, begruendung: text!, vieraugen: true, person, am }),
          verlauf: [...(ez.verlauf ?? []), eintrag('bewertung_beantragt', text!)],
        };
      } else if (schritt === 'ablehnen') {
        neu = {
          ...ez,
          bewertung: { ...ez.bewertung!, status: 'abgelehnt', entscheidung: person, entschieden_am: am, entscheidungs_begruendung: text },
          verlauf: [...(ez.verlauf ?? []), eintrag('bewertung_abgelehnt', text!)],
        };
      } else {
        neu = {
          ...ez,
          zustand: 'bewertet',
          ergebnis: schritt === 'bewerten' ? body.ergebnis! : ez.bewertung!.ergebnis,
          frist: { ...ez.frist, faellig: null, seit_tagen: null },
          bewertung:
            schritt === 'bewerten'
              ? bewertung({ ergebnis: body.ergebnis!, begruendung: text!, person, am })
              : { ...ez.bewertung!, status: 'bewertet', entscheidung: person, entschieden_am: am, entscheidungs_begruendung: text },
          verlauf: [...(ez.verlauf ?? []), eintrag('energieziel_bewertet', text ?? '')],
        };
      }
      ziele.set(id, neu);
      return neu;
    },
  };
}
