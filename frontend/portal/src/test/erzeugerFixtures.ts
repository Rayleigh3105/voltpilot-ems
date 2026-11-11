/**
 * Fiktive Beispielwerte für das Cockpit einer Erzeugeranlage (Konzept „Erzeuger am WAGO-Modbus-Server“,
 * Bilder Cockpit Telefon 375 px und Rechner 1440 px; alle Zahlen sind Beispiele). Zwei Fälle wie im
 * Konzept (Namen fiktiv): Büttner (Biogas-BHKW, 2 Motoren, Netzbetreiber begrenzt 60 %, Direktvermarkter ruft 80 kW
 * ab, kein Netzpunkt nach EW-16 C) und Gore (PV, 3 Wechselrichter, Nulleinspeisung, Leitstelle
 * getrennt). Zeiten liegen relativ zu `now`, damit Tests und Bühnen mit fester Uhr dasselbe sehen.
 * Nur für Tests und `e2e/` - nie aus Produktionscode importieren.
 */
import { einheitPunkt, ERZEUGER_PUNKT as P, type ErzeugerJetzt, type ErzeugerWert } from '../erzeuger';
import type {
  ErzeugerVorgabeDetail,
  ErzeugerVorgabenHeute,
  HistoryEvent,
  HistoryRange,
  HistoryVorgabe,
  HistoryVorgaben,
} from '../api';

export type ErzeugerFall = 'buettner' | 'gore';

export function erzeugerBeispiel(fall: ErzeugerFall, now: Date): ErzeugerJetzt {
  const vor = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const mitternacht = new Date(now);
  mitternacht.setHours(0, 0, 0, 0);
  // Gelesen vor 3 s; „seit“ zählt ab der Lesung (Lesezeit − `…_seit_s`, §4.6), deshalb die − 3 unten.
  const gelesen = new Date(now.getTime() - 3000).toISOString();
  const werte: Record<string, ErzeugerWert> = {};
  const setze = (key: string, wert: number | null) => {
    werte[key] = { wert, gelesenAm: gelesen, qualitaet: wert == null ? 'invalid' : 'good' };
  };
  const einheit = (n: number, art: 1 | 2, nennKw: number, istKw: number, sollKw: number, zustand: number, bits: number) => {
    setze(einheitPunkt(n, 'art'), art);
    setze(einheitPunkt(n, 'nenn_kw'), nennKw);
    setze(einheitPunkt(n, 'p_ist_w'), istKw * 1000);
    setze(einheitPunkt(n, 'p_soll_w'), sollKw * 1000);
    setze(einheitPunkt(n, 'zustand'), zustand);
    setze(einheitPunkt(n, 'bits'), bits);
  };

  if (fall === 'buettner') {
    setze(P.anlagenart, 2);
    setze(P.teAnzahl, 2);
    // Bit 3 Erzeugung, Bit 4 Gasspeicher gültig; kein Netzpunkt (EW-16 C, Lesart 10).
    setze(P.aGueltig, 0b11000);
    setze(P.pNvpW, null);
    setze(P.pErzeugungW, 58_900);
    setze(P.anlageZustand, 3);
    setze(P.aBits, 0);
    setze(P.speicherFuellstand, 62);
    setze(P.pInstalliertKw, 99);
    setze(P.nbKanal, 2);
    setze(P.nbBits, 0b111);
    setze(P.nbProzent, 60);
    setze(P.nbSeitS, 72 * 60 - 3);
    setze(P.dvKanal, 1);
    setze(P.dvBits, 0b11011);
    setze(P.dvSollW, 80_000);
    setze(P.dvSeitS, 159 * 60 - 3);
    setze(P.quelleP, 1);
    setze(P.sBits, 0b11);
    setze(P.pGrenzeW, 59_400);
    einheit(1, 2, 66, 39.6, 39.6, 3, 0b1111);
    einheit(2, 2, 33, 19.3, 19.8, 3, 0b1111);
    return {
      steuerung: { geraetId: 'help-wago', name: 'Wago' },
      netzbetreiber: 'Netz Musterstadt GmbH',
      direktvermarkter: 'Stadtwerke Beispiel',
      einheiten: [
        { teNr: 1, art: 'bhkw', typName: 'MAN E0836LE', nennKw: 66, bezeichnung: null },
        { teNr: 2, art: 'bhkw', typName: 'Smartblock 33', nennKw: 33, bezeichnung: null },
      ],
      werte,
      wechselHeute: {
        [P.nbBits]: [{ ab: mitternacht.toISOString(), wert: 0b011 }, { ab: vor(340), wert: 0b111 }, { ab: vor(265), wert: 0b011 }, { ab: vor(72), wert: 0b111 }],
        [P.dvBits]: [{ ab: mitternacht.toISOString(), wert: 0b01001 }, { ab: vor(159), wert: 0b11011 }],
        [P.quelleP]: [{ ab: mitternacht.toISOString(), wert: 0 }, { ab: vor(340), wert: 1 }, { ab: vor(265), wert: 0 }, { ab: vor(159), wert: 2 }, { ab: vor(72), wert: 1 }],
      },
    };
  }

  setze(P.anlagenart, 1);
  setze(P.teAnzahl, 3);
  // Bit 0 Netzpunkt gültig, Bit 3 Erzeugung gültig.
  setze(P.aGueltig, 0b01001);
  setze(P.pNvpW, 100);
  setze(P.pErzeugungW, 41_000);
  setze(P.anlageZustand, 3);
  setze(P.aBits, 0);
  setze(P.speicherFuellstand, null);
  setze(P.pInstalliertKw, 265);
  setze(P.nbKanal, 3);
  // Vorgabe gültig, aber die Verbindung zur Leitstelle steht nicht (Bit 1 = 0): 100 % gehalten.
  setze(P.nbBits, 0b001);
  setze(P.nbProzent, 100);
  setze(P.nbSeitS, 12 * 60 - 3);
  setze(P.dvKanal, 0);
  setze(P.dvBits, 0);
  setze(P.quelleP, 3);
  setze(P.sBits, 0b11);
  setze(P.pGrenzeW, 41_200);
  einheit(1, 1, 125, 14.1, 14.2, 3, 0b11);
  einheit(2, 1, 125, 13.6, 13.7, 3, 0b11);
  einheit(3, 1, 125, 13.3, 13.3, 3, 0b11);
  return {
    steuerung: { geraetId: 'help-wago', name: 'Wago' },
    netzbetreiber: 'Netz Musterstadt GmbH',
    direktvermarkter: null,
    einheiten: [1, 2, 3].map((teNr) => ({ teNr, art: 'pv' as const, typName: 'Growatt', nennKw: 125, bezeichnung: null })),
    werte,
    wechselHeute: {
      [P.nbBits]: [{ ab: mitternacht.toISOString(), wert: 0b011 }, { ab: vor(12), wert: 0b001 }],
      [P.dvBits]: [{ ab: mitternacht.toISOString(), wert: 0 }],
      [P.quelleP]: [{ ab: mitternacht.toISOString(), wert: 0 }, { ab: vor(300), wert: 3 }],
    },
  };
}

/**
 * „Wer hat heute geregelt?“ vom Server (`GET …/erzeuger/vorgaben/heute`, EZ-7) — dieselben Vorgaben wie die
 * Zustandswechsel oben: Büttner Netzbetreiber 2× (75 + 72 min), Direktvermarkter 1× (159 min); Gore regelt seit
 * 5 h selbst (Nulleinspeisung).
 */
export function vorgabenHeuteBeispiel(fall: ErzeugerFall, now: Date): ErzeugerVorgabenHeute {
  const tag = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const stand = new Date(now.getTime() - 60_000).toISOString();
  return {
    site_id: 'help-site',
    tag,
    abgerufen_am: now.toISOString(),
    verarbeitet_bis: stand,
    je_urheber: fall === 'buettner'
      ? [
          { urheber: 'netzbetreiber', anzahl: 2, dauer_s: 147 * 60, energie_kwh: 76, wert_eur: null },
          { urheber: 'direktvermarkter', anzahl: 1, dauer_s: 159 * 60, energie_kwh: 0, wert_eur: null },
        ]
      : [{ urheber: 'anlage', anzahl: 1, dauer_s: 300 * 60, energie_kwh: null, wert_eur: null }],
    laufend: [],
  };
}

const VORGABE_LEER: HistoryVorgabe = {
  id: null, urheber: 'netzbetreiber', art: null, teNr: null, einheitName: null, beginn: null, beginnGenau: false,
  ende: null, laeuft: false, vorgabeProzent: null, vorgabeW: null, bindung: null, wertEur: null, unvollstaendig: 0,
  luecken: 0, weitereWechsel: null, gruende: [],
};

/**
 * Die Vorgaben im Verlauf (EZ-9) — wie der Server sie schickt: am Tag je Vorgabe ein Ereignis (Büttner: zwei
 * Begrenzungen des Netzbetreibers, ein Abruf des Direktvermarkters, Motor 2 nicht bereit, eine Datenlücke mit einem
 * weiteren Wechsel; Gore: eine Begrenzung mit Euro-Schätzung), ab der Woche je Tag gebündelt, dazu die Zählung
 * „Nach Art“. Zahlen sind Beispiele.
 */
export function vorgabenVerlaufBeispiel(
  fall: ErzeugerFall,
  range: HistoryRange,
  now: Date,
): { events: HistoryEvent[]; vorgaben: HistoryVorgaben } {
  const vor = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const verarbeitetBis = vor(1);
  const ereignis = (type: HistoryEvent['type'], start: string, end: string, text: string, value: number | null,
    vorgabe: Partial<HistoryVorgabe>, count = 1): HistoryEvent => ({
    type, start, end, text, value, unit: value == null ? null : 'kWh', planned: false,
    minutes: Math.round((Date.parse(end) - Date.parse(start)) / 60_000), count, days: 1, facts: [],
    vorgabe: { ...VORGABE_LEER, urheber: type === 'nicht-bereit' ? 'anlage' : (type as 'netzbetreiber'), ...vorgabe },
  });
  const zaehlung = (z: Partial<HistoryVorgaben['zaehlung'][number]> & Pick<HistoryVorgaben['zaehlung'][number], 'type' | 'anzahl' | 'minutes'>) => ({
    periode: null, teNr: null, einheitName: null, energyKwh: null, wertEur: null, ohneSchaetzung: 0, unvollstaendig: 0,
    arten: {}, luecken: 0, weitereWechsel: null, ...z,
  });
  if (fall === 'gore') {
    const events = range === 'day'
      ? [ereignis('netzbetreiber', vor(400), vor(330), 'Netzbetreiber begrenzt auf 60 %, geschätzt 18,4 kWh nicht erzeugt', 18.4,
          { id: 'vg-gore-1', art: 'p_begrenzung', beginn: vor(400), beginnGenau: true, ende: vor(330), vorgabeProzent: 60, bindung: 'bindend', wertEur: 1.47 })]
      : [];
    return {
      events,
      vorgaben: { verarbeitetBis, zaehlung: range === 'day'
        ? [zaehlung({ type: 'netzbetreiber', anzahl: 1, minutes: 70, energyKwh: 18.4, wertEur: 1.47, arten: { p_begrenzung: 1 } })]
        : [] },
    };
  }
  if (range === 'day') {
    return {
      events: [
        ereignis('netzbetreiber', vor(600), vor(586), 'Netzbetreiber: 1 weiterer Wechsel während einer Datenlücke', null,
          { beginn: vor(600), ende: vor(586), luecken: 1, weitereWechsel: 1 }, 0),
        ereignis('nicht-bereit', vor(500), vor(455), 'Motor 2 nicht bereit für den Direktvermarkter: Gasspeicher leer', null,
          { id: 'vg-bue-nb', urheber: 'anlage', art: 'nicht_bereit', teNr: 2, einheitName: 'Motor 2', beginn: vor(500), ende: vor(455), gruende: ['Gasspeicher leer'] }),
        ereignis('netzbetreiber', vor(340), vor(265), 'Netzbetreiber begrenzt auf 30 %, geschätzt 51,0 kWh nicht erzeugt', 51,
          { id: 'vg-bue-1', art: 'p_begrenzung', beginn: vor(340), beginnGenau: true, ende: vor(265), vorgabeProzent: 30, bindung: 'bindend' }),
        ereignis('direktvermarkter', vor(159), vor(1), 'Direktvermarkter ruft 80,0 kW ab (nicht bindend)', 0,
          { id: 'vg-bue-dv', urheber: 'direktvermarkter', art: 'dv_aktivierung', beginn: vor(159), beginnGenau: true, laeuft: true, vorgabeW: 80_000, bindung: 'nicht_bindend' }),
        ereignis('netzbetreiber', vor(72), vor(1), 'Netzbetreiber begrenzt auf 60 %, geschätzt 25,0 kWh nicht erzeugt', 25,
          { id: 'vg-bue-2', art: 'p_begrenzung', beginn: vor(72), beginnGenau: true, laeuft: true, vorgabeProzent: 60, bindung: 'bindend' }),
      ],
      vorgaben: { verarbeitetBis, zaehlung: [
        zaehlung({ type: 'netzbetreiber', anzahl: 2, minutes: 146, energyKwh: 76, arten: { p_begrenzung: 2 }, ohneSchaetzung: 0, luecken: 1, weitereWechsel: 1 }),
        zaehlung({ type: 'direktvermarkter', anzahl: 1, minutes: 158, energyKwh: 0, arten: { dv_aktivierung: 1 } }),
        zaehlung({ type: 'direktvermarkter', teNr: 1, einheitName: 'Motor 1', anzahl: 1, minutes: 158, arten: { dv_aktivierung: 1 }, ohneSchaetzung: 1 }),
        zaehlung({ type: 'direktvermarkter', teNr: 2, einheitName: 'Motor 2', anzahl: 1, minutes: 113, arten: { dv_aktivierung: 1 }, ohneSchaetzung: 1 }),
        zaehlung({ type: 'nicht-bereit', anzahl: 1, minutes: 45, arten: { nicht_bereit: 1 }, ohneSchaetzung: 1 }),
        zaehlung({ type: 'nicht-bereit', teNr: 2, einheitName: 'Motor 2', anzahl: 1, minutes: 45, arten: { nicht_bereit: 1 }, ohneSchaetzung: 1 }),
      ] },
    };
  }
  // Ab der Woche: je Tag des Monats bis heute ein Bündel je Art (Muster aus den Beispielen der Konzeptseite).
  const events: HistoryEvent[] = [];
  const heute = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let d = 1; d <= now.getDate(); d++) {
    const t = new Date(now.getFullYear(), now.getMonth(), d, 0, 0);
    const um = (h: number, m = 0) => new Date(t.getFullYear(), t.getMonth(), d, h, m).toISOString();
    if (t.getTime() > heute.getTime()) break;
    if (d % 3 === 1) {
      events.push(ereignis('netzbetreiber', um(10), um(11, 30), 'Netzbetreiber: 1 Std 30 Min; geschätzt 40,0 kWh nicht erzeugt', 40, { urheber: 'netzbetreiber' }));
    }
    if (d % 2 === 0) {
      events.push(ereignis('direktvermarkter', um(9), um(13, 5), 'Direktvermarkter: 2×, zusammen 4 Std 5 Min', 0, { urheber: 'direktvermarkter' }, 2));
    }
    if (d === 4 || d === 8) {
      events.push(ereignis('nicht-bereit', um(6), um(6, 45), 'Nicht bereit: 45 Min', null, { urheber: 'anlage', unvollstaendig: d === 8 ? 1 : 0 }));
    }
  }
  const n = (type: HistoryEvent['type']) => events.filter((e) => e.type === type);
  const summe = (xs: HistoryEvent[], f: (e: HistoryEvent) => number) => xs.reduce((a, e) => a + f(e), 0);
  const nb = n('netzbetreiber');
  const dv = n('direktvermarkter');
  const nbr = n('nicht-bereit');
  return {
    events,
    vorgaben: { verarbeitetBis, zaehlung: [
      zaehlung({ type: 'netzbetreiber', anzahl: nb.length, minutes: summe(nb, (e) => e.minutes ?? 0), energyKwh: summe(nb, (e) => e.value ?? 0), arten: { p_begrenzung: nb.length - 1, abschaltung: 1 } }),
      zaehlung({ type: 'direktvermarkter', anzahl: summe(dv, (e) => e.count ?? 1), minutes: summe(dv, (e) => e.minutes ?? 0), energyKwh: 0, arten: { dv_aktivierung: summe(dv, (e) => e.count ?? 1) - 4, dv_stopp: 4 } }),
      zaehlung({ type: 'direktvermarkter', teNr: 1, einheitName: 'Motor 1', anzahl: summe(dv, (e) => e.count ?? 1), minutes: summe(dv, (e) => e.minutes ?? 0) }),
      zaehlung({ type: 'direktvermarkter', teNr: 2, einheitName: 'Motor 2', anzahl: summe(dv, (e) => e.count ?? 1) - 3, minutes: summe(dv, (e) => e.minutes ?? 0) - 240 }),
      ...(nbr.length ? [
        zaehlung({ type: 'nicht-bereit' as const, anzahl: nbr.length, minutes: summe(nbr, (e) => e.minutes ?? 0), unvollstaendig: 1 }),
        zaehlung({ type: 'nicht-bereit' as const, teNr: 2, einheitName: 'Motor 2', anzahl: nbr.length, minutes: summe(nbr, (e) => e.minutes ?? 0) }),
      ] : []),
    ] },
  };
}

/** Das Detail einer Vorgabe (`GET …/erzeuger/vorgaben/{id}`, EZ-7): die 60-%-Begrenzung mit Rohsignalen und Zählern. */
export function vorgabeDetailBeispiel(id: string, now: Date): ErzeugerVorgabeDetail {
  const vor = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const laeuft = id === 'vg-bue-2' || id === 'vg-bue-dv';
  return {
    vorgabe: {
      id, geraet_id: 'help-wago', te_nr: null, einheit_name: null, urheber: 'netzbetreiber', art: 'p_begrenzung',
      beginn: vor(72), beginn_genau: true, ende: laeuft ? null : vor(2), ende_genau: !laeuft, gesehen_bis: vor(1), dauer_s: 71 * 60,
      vorgabe_prozent: 60, vorgabe_w: 59_400, ist_mittel_w: 58_900, verfuegbar_mittel_w: 79_600, energie_kwh: 25,
      methode: 'nennleistung_bereite_motoren', wert_eur: null, kanal: 'stufen', bindung: 'bindend', unvollstaendig: false,
      neustart: false, zaehler_beginn: 41, zaehler_ende: 42, gruende: [],
    },
    roh_beginn: [
      { point_key: 'erzeuger.nb.n_bits', feld: 'n_bits', te_nr: null, wert: 7, wort: null, text: null,
        bits: [{ bit: 0, wort: 'vorgabe_gueltig', text: 'Vorgabe gültig' }, { bit: 1, wort: 'verbunden', text: 'Verbindung steht' }, { bit: 2, wort: 'p_begrenzt', text: 'Wirkleistung begrenzt' }] },
      { point_key: 'erzeuger.nb.n_p_prozent', feld: 'n_p_prozent', te_nr: null, wert: 60, wort: null, text: null, bits: null },
      { point_key: 'erzeuger.nb.n_kanal', feld: 'n_kanal', te_nr: null, wert: 2, wort: 'stufen', text: 'Stufen', bits: null },
    ],
    roh_ende: [],
    signale: Array.from({ length: 37 }, (_, i) => ({ point_key: 'erzeuger.nb.n_bits', gemessen_am: vor(72 - i * 2), wert: 7, qualitaet: 'good' })),
    signale_gekuerzt: false,
  };
}
