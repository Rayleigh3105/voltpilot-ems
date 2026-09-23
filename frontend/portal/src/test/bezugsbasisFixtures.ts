import type { api, Bezugsbasis, BezugsbasisFassung, FaktorenVorschlag, Kennzahl, VariablenVorschlag } from '../api';

/**
 * Referenzfall R1 (UEMS AP-17, Kunststoffwerk Ahrenberg, `uems-referenzunternehmen.json` 1.8): Ines Kaltenbach bindet
 * KZ-0004 Spritzguss je kg an den Oktober 2026 — Verhältnis 0,2837 kWh je kg, vorläufig (1 von 12 Monaten), freigegeben
 * am 12.11.2026. API-förmige Antworten für vitest und die Bühne `e2e/bezugsbasis.tsx`; kein Dev-Seed.
 */
export const BB_IDS = {
  kz4: 'c0de0000-0000-4000-8000-00000000a004',
  bb1: 'bb000000-0000-4000-8000-000000000001',
  bz1: 'b2000000-0000-4000-8000-000000000001',
  bz3: 'b2000000-0000-4000-8000-000000000003',
  p1: 'a1000000-0000-4000-8000-000000000001',
} as const;

export function kz4(over: Partial<Kennzahl> = {}): Kennzahl {
  return {
    id: BB_IDS.kz4,
    kennzeichen: 'KZ-0004',
    name: 'Spritzguss je kg',
    rechenform: 'quotient',
    geltung_art: 'prozess',
    geltung_id: BB_IDS.p1,
    geltung_name: 'P-1 Spritzguss',
    rechte_geltung: 'unternehmen',
    standort_id: null,
    kennung: 'kennzahl.unternehmen_definieren',
    verantwortlich_name: 'Ines Kaltenbach',
    zweck: 'Stromeinsatz des Spritzgusses je Kilogramm Gutteil.',
    fassung: 1,
    einheit: 'kWh/kg',
    einheit_anzeige: 'kWh/kg',
    grundperiode: 'monat',
    perioden: ['monat', 'jahr'],
    hat_werte: true,
    archiviert_am: null,
    angelegt_am: '2026-10-01T08:00:00+02:00',
    ...over,
  };
}

/** Die Fassung 1 von BB-0001 nach R1 — als Entwurf, beantragt oder freigegeben. */
export function bb1Fassung(status: BezugsbasisFassung['freigabe_status'] = 'entwurf', over: Partial<BezugsbasisFassung> = {}): BezugsbasisFassung {
  return {
    bezugsbasis_id: BB_IDS.bb1,
    bezugsbasis: 'BB-0001',
    kennzahl_id: BB_IDS.kz4,
    kennzahl: 'KZ-0004',
    fassung: 1,
    referenzperiode: '2026-10/2026-10',
    methode: 'verhaeltnis',
    gilt_ab: '2026-11-01',
    monate: 1,
    mindest_monate: 12,
    datenlage: 'vorlaeufig',
    datenlage_gruende: [{ grund: 'monate', monate: 1, mindest_monate: 12, ohne_wert: [] }],
    vorbehalte: ['Bezugsbasis vorläufig (1 von 12 Monaten)'],
    basiswert: '0.2837',
    toleranz_prozent: '2',
    wiedervorlage_monate: 12,
    variablen: [{ position: 1, rolle: 'nenner', bezugsgroesse_id: BB_IDS.bz1, kennzeichen: 'BZ-1', fassung: 1, spannweite_von: '312400', spannweite_bis: '312400' }],
    faktoren: [],
    freigabe_status: status,
    gebildet_am: '2026-11-12T09:00:00+01:00',
    gebildet_von: 'Ines Kaltenbach',
    grundlage: {
      referenzperiode: '2026-10/2026-10',
      perioden: [
        {
          periode: '2026-10',
          kennzahl: { objekt: 'KZ-0004', wert: '0.28370', version: 1, definition_fassung: 1, zustand: 'endgueltig', menge_zustand: null, kennzeichen: [] },
          zaehler: '88630',
          nenner: '312400',
        },
      ],
    },
    pruefsumme: 'sha256:4e2d9c0a7f1b3e5d8c6a2b4f9e0d1c3a5b7e9f2d4c6a8b0e1f3d5c7a9b2e4f6a',
    // R1: Ahrenberg hat kein Vier-Augen (AP-08 E8) — Ines gibt selbst frei, die Fassung ist sofort wirksam.
    gilt_bis: null,
    anpassungsgruende: [],
    anpassung_wortlaut: null,
    begruendung: status === 'entwurf' ? null : 'Oktober 2026 ist der erste volle Monat mit erfasster Produktionsmenge.',
    vieraugen: false,
    freigabe: status === 'entwurf' ? null : { name: 'Ines Kaltenbach', rolle: 'energiemanager', am: '2026-11-12T10:00:00+01:00' },
    entscheidung: null,
    entscheidungs_begruendung: null,
    freigegeben_am: status === 'freigegeben' ? '2026-11-12T10:00:00+01:00' : null,
    ...over,
  };
}

export function bb1(status: BezugsbasisFassung['freigabe_status'] | null = 'freigegeben'): Bezugsbasis {
  const f = status ? bb1Fassung(status) : null;
  return {
    id: BB_IDS.bb1,
    kennzeichen: 'BB-0001',
    kennzahl_id: BB_IDS.kz4,
    kennzahl: 'KZ-0004',
    zweck: null,
    verantwortlich_name: 'Ines Kaltenbach',
    beendet_zum: null,
    beendet_grund: null,
    angelegt_am: '2026-11-12T08:55:00+01:00',
    fassungen: f
      ? [{ fassung: 1, referenzperiode: f.referenzperiode, methode: f.methode, datenlage: f.datenlage, freigabe_status: f.freigabe_status, basiswert: f.basiswert, gilt_ab: f.gilt_ab, gilt_bis: null, pruefsumme: f.pruefsumme }]
      : [],
  };
}

/** R9: BZ-1 ist Variable 1, BZ-3 Betriebsstunden hängt an ihr (r = 0,997); die Leckagerate hat keine Zahl. */
export function variablenVorschlag(): VariablenVorschlag {
  const bz1 = { id: BB_IDS.bz1, kennzeichen: 'BZ-1', name: 'Produktionsmenge', art: 'produktionsmenge', wertart: 'periodenwert' as const, einheit: 'kg', periode_art: 'monat', hat_werte: true, hat_kanal: false };
  return {
    geltung_art: 'prozess',
    bezug: 'prozess',
    referenzperiode: '2026-10/2026-10',
    einsaetze: [{ id: 'ee000000-0000-4000-8000-000000000001', kennzeichen: 'EE-1', name: 'Spritzguss', traeger: 'strom' }],
    variable_1: bz1,
    kandidaten: [
      { bezugsgroesse: bz1, einfluss_art: 'produktion', vorschlag: 'variable_1', einsaetze: ['EE-1'], abhaengigkeit: null, satz: null },
      {
        bezugsgroesse: { id: BB_IDS.bz3, kennzeichen: 'BZ-3', name: 'Betriebsstunden', art: 'betriebszeit', wertart: 'periodenwert', einheit: 'h', periode_art: 'monat', hat_werte: true, hat_kanal: false },
        einfluss_art: 'betriebszeit',
        vorschlag: 'variable',
        einsaetze: ['EE-1'],
        abhaengigkeit: { ergebnis: 'variablen_abhaengig', r: 0.9971, paare: 12, grund: null, gegen: 'BZ-1', schwelle: 0.9 },
        satz: 'Betriebsstunden hängt an Produktionsmenge (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.',
      },
    ],
    ohne_zahl: [{ wortlaut: 'Leckagerate', einfluss_art: 'sonstige', einsatz: 'EE-1', satz: 'ohne Zahl — erst als Bezugsgröße erfassen' }],
    satz: null,
  };
}

export function faktorenVorschlag(): FaktorenVorschlag {
  return {
    kennzahl_id: BB_IDS.kz4,
    kennzeichen: 'KZ-0004',
    geltung_art: 'prozess',
    geltung_id: BB_IDS.p1,
    geltung_name: 'Spritzguss',
    stichtag: '2026-11-01',
    faktoren: [
      { art: 'flaeche', objekt_id: 'g1000000-0000-4000-8000-000000000001', kennung: 'G-1', bezeichnung: 'Halle 1', wert: 4200, einheit: 'm²', gueltig_ab: '2026-01-01', gueltig_bis: null, satz: 'Fläche Halle 1 (G-1): 4 200 m² am 01.11.2026 · gültig ab 01.01.2026.' },
      { art: 'standort', objekt_id: 'st000000-0000-4000-8000-000000000001', kennung: 'ST-1', bezeichnung: 'Werk Ahrenberg', wert: null, einheit: null, gueltig_ab: '2026-01-01', gueltig_bis: null, satz: 'Standort Werk Ahrenberg (ST-1) · gültig ab 01.01.2026 · Verweis ohne Zahl.' },
    ],
    flaeche: { wert: 4200, einheit: 'm²', objekte: ['G-1'], ohne_flaeche: [], gueltig_ab: '2026-01-01', gueltig_bis: null, satz: 'Fläche der Geltung am 01.11.2026: 4 200 m² (G-1) · gültig ab 01.01.2026.' },
    hinweis: 'Vorschlag aus der Struktur am 01.11.2026 — nichts ist gespeichert. Statische Faktoren gelten erst mit der Bezugsbasis, die Sie freigeben.',
  };
}

/**
 * Die Routen der Bühne `e2e/bezugsbasis.tsx` als kleiner Zustand im Speicher — dieselben Antworten für die Bühne und für
 * `bezugsbasisSpecLocatoren.test.tsx`, der jeden Locator der Spec gegen genau diese Fläche zählt. Ahrenberg hat kein
 * Vier-Augen: „Freigeben“ wirkt sofort.
 */
export function bezugsbasisBuehne(lage: 'keine' | 'freigegeben' | 'modell'): Partial<typeof api> {
  let basis: Bezugsbasis | null = lage === 'keine' ? null : bb1('freigegeben');
  // IP-14: `modell` ist BB-0001 Fassung 2 nach R12/R4/R9 (Fassung 1 abgelöst, Fassung 2 mit BZ-3 abgelehnt).
  let fassung: BezugsbasisFassung | null = lage === 'modell' ? bb1Modell('freigegeben') : basis ? bb1Fassung('freigegeben') : null;
  const kurz = (f: BezugsbasisFassung) => ({
    fassung: f.fassung, referenzperiode: f.referenzperiode, methode: f.methode, datenlage: f.datenlage,
    freigabe_status: f.freigabe_status, basiswert: f.basiswert, gilt_ab: f.gilt_ab, gilt_bis: null, pruefsumme: f.pruefsumme,
  });
  if (lage === 'modell') basis = { ...basis!, fassungen: [kurz(bb1Fassung('freigegeben')), kurz(fassung!)] };
  const kennzahl = () =>
    kz4(
      basis && fassung
        ? { bezugsbasis: { kennzeichen: basis.kennzeichen, fassung: fassung.fassung, freigabe_status: fassung.freigabe_status, vorlaeufig: fassung.datenlage === 'vorlaeufig' } }
        : { bezugsbasis: null },
    );
  return {
    kennzahlen: async () => ({ kennzahlen: [kennzahl()] }),
    kennzahl: async () => kennzahl(),
    kennzahlFassungen: async () => ({ kennzahl_id: BB_IDS.kz4, kennzeichen: 'KZ-0004', fassungen: [] }),
    kennzahlWerte: async (_id, periode, von, bis) => ({
      kennzahl: { id: BB_IDS.kz4, kennzeichen: 'KZ-0004', name: 'Spritzguss je kg', einheit: 'kWh/kg' },
      periode, von, bis, zeitzone: 'Europe/Berlin', version: null, werte: [],
    }) as unknown as Awaited<ReturnType<typeof api.kennzahlWerte>>,
    kennzahlBezugsbasen: async () => ({ bezugsbasen: basis ? [basis] : [] }),
    bezugsbasisAnlegen: async () => {
      basis = bb1(null);
      return basis;
    },
    bezugsbasisEntwurf: async (_k, _b, body) => {
      const monate = body.referenzperiode === '2026-10/2026-10' ? 1 : 12;
      // IP-14: zwölf Monate tragen die Grundlage von R12; ein Modell rechnet die Fassung, BZ-3 hängt an BZ-1 (G4).
      const modell = bb1Modell('entwurf', { fassung: 1, anpassungsgruende: [], referenzperiode: body.referenzperiode });
      fassung =
        monate === 1
          ? bb1Fassung('entwurf', { referenzperiode: body.referenzperiode, monate })
          : body.methode === 'verhaeltnis'
            ? { ...modell, methode: 'verhaeltnis', koeffizienten: null, r2: null, streuung_prozent: null, abgelehnte_variablen: [] }
            : { ...modell, abgelehnte_variablen: body.variablen?.includes(BB_IDS.bz3) ? modell.abgelehnte_variablen : [] };
      basis = { ...(basis ?? bb1(null)), fassungen: [kurz(fassung)] };
      return fassung;
    },
    bezugsbasisFassung: async () => fassung!,
    bezugsbasisFreigabe: async () => {
      fassung =
        fassung!.monate === 1
          ? bb1Fassung('freigegeben', { referenzperiode: fassung!.referenzperiode, monate: fassung!.monate })
          : { ...fassung!, freigabe_status: 'freigegeben', freigabe: { name: 'Ines Kaltenbach', rolle: 'energiemanager', am: '2027-11-24T10:00:00+01:00' }, freigegeben_am: '2027-11-24T10:00:00+01:00' };
      basis = { ...basis!, fassungen: [kurz(fassung)] };
      return fassung;
    },
    kennzahlVariablenVorschlag: async () => variablenVorschlag(),
    kennzahlFaktorenVorschlag: async () => faktorenVorschlag(),
  };
}

// ------------------------------------------------------------------------------------------------ IP-14: Modelle

/** Die Monatspaare von BB-0001 Fassung 2 (Referenzdatei 1.8 `bezugsbasen[]`, 11/2026–10/2027): Strom MS-20 und BZ-1 in kg. */
export const R12_PAARE: ReadonlyArray<readonly [string, string, string]> = [
  ['2026-11', '85581', '318000'], ['2026-12', '71729', '262000'], ['2027-01', '81291', '298000'], ['2027-02', '81298', '305000'],
  ['2027-03', '88265', '331000'], ['2027-04', '82016', '309000'], ['2027-05', '86399', '322000'], ['2027-06', '86846', '327000'],
  ['2027-07', '80732', '296000'], ['2027-08', '69693', '254000'], ['2027-09', '89512', '336000'], ['2027-10', '89638', '341000'],
];
/** Die Gradtage von BB-0004 (BZ-8, G20/15) und das Gas MS-21 derselben Monate — zwei Sommermonate mit 0 Kd. */
export const R3_PAARE: ReadonlyArray<readonly [string, string, string]> = [
  ['2026-11', '1742', '415'], ['2026-12', '2169', '555'], ['2027-01', '2489', '605'], ['2027-02', '2037', '515'],
  ['2027-03', '1676', '395'], ['2027-04', '986', '245'], ['2027-05', '511', '95'], ['2027-06', '152', '15'],
  ['2027-07', '155', '0'], ['2027-08', '90', '0'], ['2027-09', '483', '85'], ['2027-10', '1205', '300'],
];

const periodeMit = (kz: string, [periode, zaehler, nenner]: readonly [string, string, string], zweite?: { objekt: string; wert: string; einheit: string }) => ({
  periode,
  kennzahl: { objekt: kz, wert: nenner === '0' ? '0' : String(Number(zaehler) / Number(nenner)), version: 1, definition_fassung: 1, zustand: 'endgueltig', menge_zustand: null, kennzeichen: [] },
  zaehler,
  nenner,
  ...(zweite ? { variablen: [{ position: 2, objekt: zweite.objekt, wert: zweite.wert, einheit: zweite.einheit, fassung: 1, kennzeichen: [] }] } : {}),
});

/**
 * R12/R4/R9: BB-0001 Fassung 2 — Modell mit einer Einflussgröße, a = 10 522,6206 (Datei 10 523), b = 0,2343, R² 0,991,
 * Streuung 0,8 %, Spannweite 254 000–341 000 kg (toleriert 228 600–375 100); BZ-3 Betriebsstunden abgelehnt (r = 0,997).
 * Die API-Form (`bezugsbasis.md` §13) mit den Zahlen von `BezugsbasisApiTest`.
 */
export function bb1Modell(status: BezugsbasisFassung['freigabe_status'] = 'freigegeben', over: Partial<BezugsbasisFassung> = {}): BezugsbasisFassung {
  return bb1Fassung(status, {
    fassung: 2,
    referenzperiode: '2026-11/2027-10',
    methode: 'regression_eine_variable',
    gilt_ab: '2027-11-01',
    monate: 12,
    datenlage: 'vollstaendig',
    datenlage_gruende: [],
    vorbehalte: [],
    basiswert: '0.2685',
    koeffizienten: { a: '10522.6206', b: '0.2343' },
    r2: '0.991',
    streuung_prozent: '0.8',
    abgelehnte_variablen: [{ objekt: 'BZ-3', position: 2, grund: 'variablen_abhaengig', r: 0.997, startwert_r: 0.9 }],
    kennzeichen: [],
    variablen: [{ position: 1, rolle: 'nenner', bezugsgroesse_id: BB_IDS.bz1, kennzeichen: 'BZ-1', fassung: 1, spannweite_von: '254000', spannweite_bis: '341000' }],
    anpassungsgruende: ['referenzperiode_vervollstaendigt', 'methode_geaendert'],
    gebildet_am: '2027-11-24T09:00:00+01:00',
    freigegeben_am: status === 'freigegeben' ? '2027-11-24T10:00:00+01:00' : null,
    grundlage: {
      referenzperiode: '2026-11/2027-10',
      methode: 'regression_eine_variable',
      perioden: R12_PAARE.map((p) => periodeMit('KZ-0004', p)),
      variablen: [{ position: 1, rolle: 'nenner', objekt: 'BZ-1', fassung: 1, spannweite: { von: 254000, bis: 341000, toleriert_von: 228600, toleriert_bis: 375100 } }],
    },
    pruefsumme: 'sha256:631ad82b172485032428a9233d26ba2f8a1351ce425fba81133416349ba1344e',
    ...over,
  });
}

/** M2 (konstruiert, `bezugsbasis-vectors.json`): die Spritzguss-Reihe mit der Gradtagzahl als zweiter, unabhängiger Größe. */
export function bb1ZweiGroessen(): BezugsbasisFassung {
  return bb1Modell('entwurf', {
    methode: 'regression_zwei_variablen',
    koeffizienten: { a: '10511.8791', b: '0.2343', c: '0.021' },
    abgelehnte_variablen: [],
    variablen: [
      { position: 1, rolle: 'nenner', bezugsgroesse_id: BB_IDS.bz1, kennzeichen: 'BZ-1', fassung: 1, spannweite_von: '254000', spannweite_bis: '341000' },
      { position: 2, rolle: 'variable', bezugsgroesse_id: 'b2000000-0000-4000-8000-000000000008', kennzeichen: 'BZ-8', fassung: 1, spannweite_von: '0', spannweite_bis: '605' },
    ],
    grundlage: {
      referenzperiode: '2026-11/2027-10',
      methode: 'regression_zwei_variablen',
      perioden: R12_PAARE.map((p, i) => periodeMit('KZ-0004', p, { objekt: 'BZ-8', wert: R3_PAARE[i][2], einheit: 'Kd' })),
      variablen: [
        { position: 1, rolle: 'nenner', objekt: 'BZ-1', fassung: 1, spannweite: { von: 254000, bis: 341000, toleriert_von: 228600, toleriert_bis: 375100 } },
        { position: 2, rolle: 'variable', objekt: 'BZ-8', fassung: 1, spannweite: { von: 0, bis: 605, toleriert_von: 0, toleriert_bis: 665.5 } },
      ],
    },
  });
}

/** R3: KZ-0006 Gasbezug je Gradtag der Verwaltung (P-6), BZ-8 Gradtagzahl am Standort ST-1. */
export function kz6(over: Partial<Kennzahl> = {}): Kennzahl {
  return kz4({ id: 'c0de0000-0000-4000-8000-00000000a006', kennzeichen: 'KZ-0006', name: 'Gasbezug je Gradtag', geltung_name: 'P-6 Verwaltung', zweck: null, einheit: 'm³/Kd', einheit_anzeige: 'm³/Kd', ...over });
}

/**
 * R3: BB-0004 Fassung 1 — Wetterbereinigung über Gradtage, a = 118,9104 (Datei 119) als witterungsunabhängiger Anteil,
 * b = 3,8041 m³ je Kd, R² 0,997, Streuung 4,6 %; Spannweite 0–605 Kd (toleriert 0–665,5), wie die API sie rechnet
 * (die Referenzdatei trägt dort `null`, §12).
 */
export function bb4Gas(): BezugsbasisFassung {
  return bb1Fassung('freigegeben', {
    bezugsbasis_id: 'bb000000-0000-4000-8000-000000000004',
    bezugsbasis: 'BB-0004',
    kennzahl_id: 'c0de0000-0000-4000-8000-00000000a006',
    kennzahl: 'KZ-0006',
    referenzperiode: '2026-11/2027-10',
    methode: 'gradtage',
    gilt_ab: '2027-11-01',
    monate: 12,
    datenlage: 'vollstaendig',
    datenlage_gruende: [],
    vorbehalte: [],
    basiswert: '4.2465',
    koeffizienten: { a: '118.9104', b: '3.8041' },
    r2: '0.997',
    streuung_prozent: '4.6',
    abgelehnte_variablen: [],
    kennzeichen: [],
    variablen: [{ position: 1, rolle: 'nenner', bezugsgroesse_id: 'b2000000-0000-4000-8000-000000000008', kennzeichen: 'BZ-8', fassung: 1, spannweite_von: '0', spannweite_bis: '605' }],
    grundlage: {
      referenzperiode: '2026-11/2027-10',
      methode: 'gradtage',
      perioden: R3_PAARE.map((p) => periodeMit('KZ-0006', p)),
      variablen: [{ position: 1, rolle: 'nenner', objekt: 'BZ-8', fassung: 1, spannweite: { von: 0, bis: 605, toleriert_von: 0, toleriert_bis: 665.5 } }],
    },
    pruefsumme: 'sha256:0b4147e5c65ada5219b36de8fda7c514be6f15765a811757103055d5453d3998',
  });
}
