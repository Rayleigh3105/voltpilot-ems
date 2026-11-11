/**
 * Fiktive Anlagensteuerungen für die Tests von UEMS EZ-10 - nachgebaut nach den zwei Anlagen des Konzepts
 * „Erzeuger am WAGO-Modbus-Server“ (Fassung 12): Gore (PV, drei Wechselrichter, Netzbetreiber über
 * Fernwirktechnik, kein Direktvermarkter) und Büttner (Biogas-BHKW, zwei Motoren, Direktvermarkter über
 * Relais und 4–20 mA, keine Messung am Netzpunkt - EW-16 C). Alle Zahlen sind Beispiele.
 */
import type {
  Anlagensteuerung,
  AnlagensteuerungVerlauf,
  AnlagensteuerungWert,
  AnlagensteuerungWerte,
  NetzVermarktung,
  UemsGeraet,
} from '../api';
import type { Programmstand } from '../programmstand';

export const SITE_GORE = '00000000-0000-4000-8000-00000000e201';
export const SITE_BUETTNER = '00000000-0000-4000-8000-00000000e202';
export const GERAET_GORE = '00000000-0000-4000-8000-00000000e211';
export const GERAET_BUETTNER = '00000000-0000-4000-8000-00000000e212';
export const ENTITY_GORE = '00000000-0000-4000-8000-00000000e221';
export const ENTITY_BUETTNER = '00000000-0000-4000-8000-00000000e222';
export const JETZT = '2026-10-21T12:00:00Z';

const vor = (s: number) => new Date(Date.parse(JETZT) - s * 1000).toISOString();

/** Der Programmstand wie EZ-16 ihn liefert: Ist gleich Soll der Bibliothek. */
function programmstand(jjmm: number): Programmstand {
  const text = `${String(jjmm).slice(0, 2)}.${String(jjmm).slice(2)}`;
  return { zustand: 'aktuell', ist: jjmm, ist_text: text, soll: jjmm, soll_text: text, soll_quelle: 'bibliothek', gemessen_am: vor(60), warnen: false };
}

export function gore(): Anlagensteuerung {
  return {
    geraet_id: GERAET_GORE,
    kennzeichen: 'G-7',
    einbau_kennzeichen: 'G-7',
    bezeichnung: 'Anlagensteuerung Gore',
    hersteller: 'WAGO',
    typ: 'PFC200 750-8212',
    eingebaut_am: '2026-10-21T08:00:00Z',
    entity_id: ENTITY_GORE,
    datenquelle: { id: 'dq-gore', kennzeichen: 'DQ-1', adresse: '192.168.1.50:503', unit_id: 1, box_id: 'box-gore' },
    fassung: {
      id: 'f-gore',
      bildart: 'erzeuger',
      basisadresse: 0,
      funktionscode: 4,
      wortfolge: 'big',
      te_anzahl: 3,
      anlagenart: 'pv',
      steuerung_kennung: null,
      rse_stufen: null,
      veraltet_netzpunkt_s: 30,
      programmstand_soll: null,
      gueltig_ab: '2026-10-21T08:00:00Z',
    },
    programmstand: programmstand(2610),
    einheiten: [3, 1, 2].map((n) => ({
      teil_id: `te-gore-${n}`,
      te_nr: n,
      einheit_art: 'pv_wechselrichter' as const,
      bezeichnung: n === 1 ? 'WR Dach Nord' : null,
      typ: n === 3 ? null : 'Growatt MAX 125KTL3-X',
      typ_bild: n === 2 ? 'Growatt MAX 125KTL3 X' : null,
      nennleistung_kw: n === 3 ? null : 125,
      registry_unit_id: n === 1 ? 'SEE912345678901' : null,
      eingebaut_am: '2026-10-21T08:00:00Z',
    })),
  };
}

export function buettner(): Anlagensteuerung {
  return {
    geraet_id: GERAET_BUETTNER,
    kennzeichen: 'G-8',
    einbau_kennzeichen: 'G-8',
    bezeichnung: null,
    hersteller: 'WAGO',
    typ: 'PFC200',
    eingebaut_am: '2026-10-21T08:00:00Z',
    entity_id: ENTITY_BUETTNER,
    datenquelle: { id: 'dq-buettner', kennzeichen: 'DQ-1', adresse: '10.0.0.20:502', unit_id: 1, box_id: 'box-buettner' },
    fassung: {
      id: 'f-buettner',
      bildart: 'erzeuger',
      basisadresse: 0,
      funktionscode: 4,
      wortfolge: 'big',
      te_anzahl: 2,
      anlagenart: 'bhkw',
      steuerung_kennung: null,
      rse_stufen: null,
      veraltet_netzpunkt_s: 30,
      programmstand_soll: null,
      gueltig_ab: '2026-10-21T08:00:00Z',
    },
    programmstand: programmstand(2611),
    einheiten: [
      {
        teil_id: 'te-buettner-1',
        te_nr: 1,
        einheit_art: 'bhkw_motor',
        bezeichnung: null,
        typ: 'MAN E0836LE',
        typ_bild: 'MAN E0836LE',
        nennleistung_kw: 66,
        registry_unit_id: null,
        eingebaut_am: '2026-10-21T08:00:00Z',
      },
      {
        teil_id: 'te-buettner-2',
        te_nr: 2,
        einheit_art: null,
        bezeichnung: null,
        typ: null,
        typ_bild: 'KW Energie Smartblock 33',
        nennleistung_kw: null,
        registry_unit_id: null,
        eingebaut_am: '2026-10-21T08:00:00Z',
      },
    ],
  };
}

type Eintrag = number | Partial<AnlagensteuerungWert> & { wert: number | null };

/** Die Antwort der Route `…/werte` aus Rohwerten je Schlüssel; Vorgabe: gut und 5 s alt. */
export function werte(geraetId: string, je: Record<string, Eintrag>): AnlagensteuerungWerte {
  const liste = Object.entries(je).map(([key, e]): AnlagensteuerungWert => {
    const x = typeof e === 'number' ? { wert: e } : e;
    const m = /^erzeuger\.(te\[(\d+)]|[a-z]+)\.([a-z_]+)$/.exec(key);
    return {
      point_key: key,
      abschnitt: m?.[2] ? 'te[*]' : (m?.[1] ?? ''),
      feld: m?.[3] ?? key,
      te_nr: m?.[2] ? Number(m[2]) : null,
      art: 'gauge',
      einheit: null,
      gemessen_am: x.wert == null ? null : vor(5),
      qualitaet: x.wert == null ? null : 'good',
      zustand: x.wert == null ? 'keine_daten' : 'aktuell',
      wort: null,
      text: null,
      bits: null,
      ...x,
    };
  });
  return {
    geraet_id: geraetId,
    entity_id: geraetId === GERAET_GORE ? ENTITY_GORE : ENTITY_BUETTNER,
    stand: liste.some((w) => w.gemessen_am != null) ? 'daten' : 'noch_keine_daten',
    abgerufen_am: JETZT,
    werte: liste,
  };
}

/** Gore mittags: Netzbetreiber begrenzt auf 60 %, die Anlage folgt; Netzpunkt gemessen, 3 s alt. */
export function goreWerte(): AnlagensteuerungWerte {
  return werte(GERAET_GORE, {
    'erzeuger.kopf.programmstand': 2610,
    'erzeuger.a.a_gueltig': 0b01001,
    'erzeuger.a.a_alter_s': 3,
    'erzeuger.a.p_nvp_w': -41230,
    'erzeuger.a.p_erzeugung_w': 158900,
    'erzeuger.dv.d_kanal': 0,
    'erzeuger.nb.n_p_prozent': 60,
    'erzeuger.wirkung.s_bits': 0b11,
    'erzeuger.te[1].t_bits': 0b11,
    'erzeuger.te[1].t_zustand': 3,
    'erzeuger.te[1].t_p_ist_w': 52800,
    'erzeuger.te[1].t_p_soll_w': 53000,
    'erzeuger.te[2].t_bits': 0b11,
    'erzeuger.te[2].t_zustand': 3,
    'erzeuger.te[2].t_p_ist_w': 53100,
    'erzeuger.te[2].t_p_soll_w': 53000,
    // WR 3: Werte ungültig (Bit 0 = 0), Sollwert gültig - der Ist ist unbekannt, nie 0.
    'erzeuger.te[3].t_bits': 0b10,
    'erzeuger.te[3].t_zustand': 4,
    'erzeuger.te[3].t_p_ist_w': 0,
    'erzeuger.te[3].t_p_soll_w': 53000,
    'erzeuger.te[3].t_nenn_kw': 125,
  });
}

/**
 * Büttner: der Direktvermarkter ruft Motor 1 ab (bereit, aktiv); Motor 2 ist nicht bereit (Wartung, Gasspeicher
 * leer) und liegt über seinem Soll, die Anlage folgt nicht. Ohne Messung am Netzpunkt (EW-16 C).
 */
export function buettnerWerte(): AnlagensteuerungWerte {
  return werte(GERAET_BUETTNER, {
    'erzeuger.kopf.programmstand': 2611,
    'erzeuger.a.a_gueltig': 0b11000,
    'erzeuger.a.speicher_fuellstand': 12.5,
    'erzeuger.a.p_erzeugung_w': 85000,
    'erzeuger.dv.d_kanal': 1,
    'erzeuger.dv.d_soll_w': 81000,
    'erzeuger.wirkung.s_bits': 0b01,
    'erzeuger.wirkung.p_grenze_w': 81000,
    'erzeuger.te[1].t_bits': 0b1111,
    'erzeuger.te[1].t_zustand': { wert: 2, text: 'läuft' },
    'erzeuger.te[1].t_p_ist_w': 64000,
    'erzeuger.te[1].t_p_soll_w': 66000,
    'erzeuger.te[2].t_bits': 0b0110000011,
    'erzeuger.te[2].t_art': 2,
    'erzeuger.te[2].t_nenn_kw': 33,
    'erzeuger.te[2].t_zustand': 5,
    'erzeuger.te[2].t_p_ist_w': { wert: 21000, zustand: 'veraltet', gemessen_am: vor(300) },
    'erzeuger.te[2].t_p_soll_w': 15000,
  });
}

export function goreNv(): NetzVermarktung {
  return {
    site_id: SITE_GORE,
    netzbetreiber: 'N-ERGIE Netz GmbH',
    direktvermarkter: null,
    direktvermarkter_kanal: null,
    einspeisemanagement: 'fernwirk',
    einspeisemanagement_prozent: null,
    namen_aus_bild: { netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: null, gelesen_am: vor(3600) },
    hinweise: [],
    revision: 3,
  };
}

export function buettnerNv(): NetzVermarktung {
  return {
    site_id: SITE_BUETTNER,
    netzbetreiber: null,
    direktvermarkter: 'WVV',
    direktvermarkter_kanal: 'relais_ma',
    einspeisemanagement: 'stufen',
    einspeisemanagement_prozent: null,
    namen_aus_bild: { netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: 'WVV (Stadtwerke Würzburg)', gelesen_am: vor(3600) },
    hinweise: [
      {
        art: 'netzbetreiber_nicht_eingetragen',
        text: 'Die Steuerung nennt den Netzbetreiber „N-ERGIE Netz GmbH“; am Netzanschluss ist keiner eingetragen.',
        bild: 'N-ERGIE Netz GmbH',
        eintrag: null,
      },
    ],
    revision: 1,
  };
}

/** Das UEMS-Gerät der Anlagensteuerung Gore, wie `GET …/geraete` es liefert (Teile = Erzeugungseinheiten). */
export function goreGeraet(): UemsGeraet {
  const s = gore();
  return {
    id: s.geraet_id,
    kennzeichen: s.kennzeichen,
    einbau_kennzeichen: s.einbau_kennzeichen,
    ausgebaut_am: null,
    komponenten: [{ entity_id: ENTITY_GORE, gueltig_ab: s.eingebaut_am, gueltig_bis: null }],
    data_source_id: 'dq-gore',
    geraeteart: 'controller',
    hersteller: s.hersteller,
    typ: s.typ,
    seriennummer: null,
    bezeichnung: s.bezeichnung,
    eingebaut_am: s.eingebaut_am,
    aus_bestand: false,
    teile: s.einheiten.map((e) => ({
      id: e.teil_id,
      teilart: 'erzeugungseinheit',
      steckplatz: null,
      bezeichnung: e.bezeichnung,
      typ: e.typ,
      seriennummer: null,
      eingebaut_am: e.eingebaut_am,
      ausgebaut_am: null,
      te_nr: e.te_nr,
      einheit_art: e.einheit_art,
      nennleistung_kw: e.nennleistung_kw,
      registry_unit_id: e.registry_unit_id,
      typ_bild: e.typ_bild,
    })),
    vorgaenger: [],
  };
}

export function goreVerlauf(): AnlagensteuerungVerlauf {
  const kurve = (point_key: string, te_nr: number | null, einheit: 'W' | '%', werte: number[]) => ({
    point_key,
    abschnitt: te_nr ? 'te[*]' : point_key.split('.')[1],
    feld: point_key.split('.')[2],
    te_nr,
    einheit,
    eimer: werte.map((w, i) => ({
      start: new Date(Date.parse('2026-10-20T22:00:00Z') + i * 900_000).toISOString(),
      avg: w,
      min: w - 500,
      max: w + 500,
      last: w,
      n: 180,
    })),
  });
  return {
    geraet_id: GERAET_GORE,
    entity_id: ENTITY_GORE,
    range: 'day',
    from: '2026-10-20T22:00:00Z',
    to: '2026-10-21T22:00:00Z',
    bucket_minutes: 15,
    kurven: [
      kurve('erzeuger.te[1].t_p_ist_w', 1, 'W', [41000, 52800]),
      kurve('erzeuger.te[1].t_p_soll_w', 1, 'W', []),
      kurve('erzeuger.nb.n_p_prozent', null, '%', [100, 60]),
    ],
  };
}
