import {
  ApiError,
  type Energieeinsatz,
  type Messbedarf,
  type MessbedarfAenderung,
  type MessbedarfAnlegen,
  type MessbedarfOrtZiel,
  type Messstelle,
  type MessstelleAnlegen,
  type MessstelleOrtAendern,
  type MessstelleRegisterZeile,
  type MessstelleStellungAendern,
} from '../api';
import { ortWahlen } from '../messstelleDialog';
import { komponentenHalle1, kanaeleK5Frei } from './messstelleDialogFixtures';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import { EE8_ID, MB1_WORTLAUT, MS23_ID, ms23, ms23Zeile } from './messplanungFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from './ortsbaumFixtures';
import { rechteSeed } from './rollenFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from './standorteFixtures';

/**
 * Die Bühne der Messplanung (UEMS AP-16 IP-20, R5) mit den Daten aus `messplanungFixtures.ts`: EE-8, MB-1 und die
 * Routen von Messbedarf (IP-19) und Messstellen-Dialog (AP-04). Nur für Komponententests und `e2e/bewertung.tsx`.
 */

const person = (kuerzel: string) => {
  const { benutzer } = rechteSeed(kuerzel);
  return { sub: benutzer.kennung, name: benutzer.name };
};

const fehler = (status: number, code: string, message: string) => new ApiError(status, message, { code, message });

/** EE-8 (R5): neuer Prozess P-7 der Erweiterung 1.6, noch ohne Messstelle — „keine Werte“, nie 0. */
export function ee8(): Energieeinsatz {
  return {
    id: EE8_ID,
    kennzeichen: 'EE-8',
    prozess: { id: '9a000000-0000-4000-8000-000000000007', kennzeichen: 'P-7', name: 'Gebäudetechnik Halle 1' },
    traeger: 'Strom',
    name: 'Gebäudetechnik Halle 1',
    wortlaut: null,
    verbraucher_wortlaut: 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1',
    verantwortlich: { sub: person('IK').sub, name: person('IK').name, konto: person('IK').sub, zustand: 'aktiv', ohne_konto_seit: null },
    einflussgroessen: [],
    messstellen: [],
    keine_werte: true,
    gueltig_ab: '2026-11-27',
    gueltig_bis: null,
    beendet_am: null,
    beendet_grund: null,
  };
}

/** MB-1 in einem Zustand; `messstelle` nur eingelöst. */
export function mb1(over: Partial<Messbedarf> = {}): Messbedarf {
  return {
    id: 'mb000000-0000-4000-8000-000000000001',
    kennzeichen: 'MB-1',
    energieeinsatz_id: EE8_ID,
    wortlaut: MB1_WORTLAUT,
    ort: 'G-1',
    groesse: 'Wirkenergie · Bezug',
    frist: '2027-03-31',
    zustand: 'offen',
    messstelle: null,
    begruendung: null,
    akteur: { ...person('IK'), rolle: 'energiemanager', art: 'kunde' },
    angelegt_am: '2026-11-27T09:30:00+01:00',
    geaendert_am: '2026-11-27T09:30:00+01:00',
    ...over,
  };
}

/**
 * Die Routen der Messplanung: Messbedarfe je Einsatz (erfassen, bearbeiten, einlösen, verwerfen, Protokoll — wie IP-19:
 * Pflicht-Wortlaut, Pflicht-Begründung, nur eine eingerichtete Messstelle löst ein; wie AP-16 P1: `ort_id` wird zu
 * `ort_ziel` mit Standort, fehlender Wortlaut entsteht aus der Struktur), die Standort-Route und der Messstellen-Dialog
 * (Vorschlag MS-23, Orte, Anlegen als Entwurf, Ort macht sie eingerichtet). `bedarfe` belegt den Anfang (etwa MB-1 offen
 * für die Ansicht — MB-1 hat nur Wortlaut, wie ein Bedarf aus der Fassung vor der Struktur).
 */
export function messplanungRouten(heute = '2026-11-27', ich = 'IK', bedarfe: Messbedarf[] = []) {
  const store = structuredClone(bedarfe);
  const orte = ortWahlen(ahrenbergHeute(), { [FIXTURE_IDS.st1]: ortsbaumAhrenberg(), [FIXTURE_IDS.st2]: ortsbaumLindach() });
  const ortZiel = (id: string | null | undefined): MessbedarfOrtZiel | null => {
    if (!id) return null;
    const o = orte.find((x) => x.id === id);
    if (!o) throw fehler(422, 'ort_unbekannt', 'Diesen Ort gibt es hier nicht.');
    return { id: o.id, art: o.art, kurzzeichen: o.kurzzeichen, name: o.name, standort_id: o.standortId, standort_name: o.standortName };
  };
  const felder = (a: MessbedarfAnlegen) => {
    if (!a.wortlaut.trim()) throw fehler(422, 'wortlaut_fehlt', 'Bitte beschreiben Sie den Messbedarf.');
    const z = ortZiel(a.ort_id);
    const g = a.messgroesse ?? null;
    const r = g ? (a.richtung ?? null) : null;
    return { wortlaut: a.wortlaut.trim(), ort: a.ort ?? z?.kurzzeichen ?? null, groesse: a.groesse ?? (g ? (r ? `${g} · ${r}` : g) : null),
      frist: a.frist, ort_ziel: z, messgroesse: g, richtung: r };
  };
  const schnappschuss = (b: Messbedarf): Record<string, unknown> => ({ wortlaut: b.wortlaut, ort: b.ort, groesse: b.groesse, frist: b.frist,
    zustand: b.zustand, begruendung: b.begruendung, standort_id: b.ort_ziel?.art === 'standort' ? b.ort_ziel.id : null,
    ort_id: b.ort_ziel && b.ort_ziel.art !== 'standort' ? b.ort_ziel.id : null, messgroesse: b.messgroesse ?? null, richtung: b.richtung ?? null });
  const protokoll = new Map<string, MessbedarfAenderung[]>();
  let nr = 0;
  const trage = (b: Messbedarf, art: MessbedarfAenderung['art'], alt: Record<string, unknown> | null, wer = b.akteur, zeitpunkt = b.geaendert_am) =>
    protokoll.set(b.id, [...(protokoll.get(b.id) ?? []), { id: ++nr, art, alt, neu: schnappschuss(b), akteur: wer, zeit: zeitpunkt }]);
  for (const b of store) trage(b, 'erfasst', null, b.akteur, b.angelegt_am);
  let angelegt: Messstelle | null = null;
  const akteur = () => ({ ...person(ich), rolle: ich === 'IK' ? 'energiemanager' : null, art: 'kunde' as const });
  const zeit = `${heute}T09:30:00+01:00`;
  const finde = (einsatzId: string, id: string) => {
    const b = store.find((x) => x.id === id && x.energieeinsatz_id === einsatzId);
    if (!b) throw fehler(404, 'nicht_gefunden', 'Messbedarf nicht gefunden.');
    if (b.zustand !== 'offen') throw fehler(409, 'messbedarf_abgeschlossen', 'Der Messbedarf ist abgeschlossen.');
    return b;
  };
  const registerZeile = (): MessstelleRegisterZeile | null => {
    if (!angelegt) return null;
    const geplant = store.filter((b) => b.messstelle?.id === angelegt!.id).map((b) => ({ id: b.energieeinsatz_id, kennzeichen: 'EE-8', name: 'Gebäudetechnik Halle 1' }));
    return { ...ms23Zeile(false), id: angelegt.id, kennzeichen: angelegt.kennzeichen, name: angelegt.name, lebenszyklus: angelegt.lebenszyklus,
      fehlt: angelegt.fehlt, beobachtung: { ...ms23Zeile().beobachtung!, seit: zeit }, geplant_fuer_einsaetze: geplant };
  };
  return {
    messbedarfe: async (einsatzId: string) => ({ messbedarfe: structuredClone(store.filter((b) => b.energieeinsatz_id === einsatzId)) }),
    messbedarfeAlle: async (standort?: string) => ({
      messbedarfe: structuredClone(store.filter((b) => !standort || b.ort_ziel?.standort_id === standort)),
    }),
    messbedarfErfassen: async (einsatzId: string, a: MessbedarfAnlegen) => {
      const f = felder(a);
      const n = store.length + 1;
      const b = mb1({ id: `mb000000-0000-4000-8000-00000000000${n}`, kennzeichen: `MB-${n}`, energieeinsatz_id: einsatzId, ...f,
        zustand: 'offen', akteur: akteur(), angelegt_am: zeit, geaendert_am: zeit });
      store.push(b);
      trage(b, 'erfasst', null);
      return structuredClone(b);
    },
    messbedarfBearbeiten: async (einsatzId: string, id: string, a: MessbedarfAnlegen) => {
      const b = finde(einsatzId, id);
      const f = felder(a);
      const alt = schnappschuss(b);
      Object.assign(b, f, { akteur: akteur(), geaendert_am: `${heute}T10:15:00+01:00` });
      trage(b, 'bearbeitet', alt);
      return structuredClone(b);
    },
    messbedarfProtokoll: async (einsatzId: string, id: string) => {
      if (!store.some((x) => x.id === id && x.energieeinsatz_id === einsatzId)) throw fehler(404, 'nicht_gefunden', 'Messbedarf nicht gefunden.');
      return { aenderungen: structuredClone(protokoll.get(id) ?? []) };
    },
    messbedarfEinloesen: async (einsatzId: string, id: string, messstelleId: string) => {
      const b = finde(einsatzId, id);
      if (!angelegt || angelegt.id !== messstelleId || angelegt.fehlt.length > 0)
        throw fehler(422, 'messstelle_nicht_eingerichtet', 'Die Messstelle ist nicht eingerichtet.');
      const alt = schnappschuss(b);
      Object.assign(b, { zustand: 'eingeloest', messstelle: { id: angelegt.id, kennzeichen: angelegt.kennzeichen, name: angelegt.name }, geaendert_am: zeit });
      trage(b, 'eingeloest', alt);
      return structuredClone(b);
    },
    messbedarfVerwerfen: async (einsatzId: string, id: string, begruendung: string) => {
      const b = finde(einsatzId, id);
      if (!begruendung.trim()) throw fehler(422, 'begruendung_fehlt', 'Bitte geben Sie eine Begründung an.');
      const alt = schnappschuss(b);
      Object.assign(b, { zustand: 'verworfen', begruendung: begruendung.trim(), geaendert_am: zeit });
      trage(b, 'verworfen', alt);
      return structuredClone(b);
    },
    // Der Messstellen-Dialog (AP-04): Vorschlag, Orte, Register, Anlegen als Entwurf, Ort → eingerichtet.
    kennzeichenVorschlag: async () => ({ kennzeichen: 'MS-23' }),
    standorte: async () => ahrenbergHeute(),
    standortOrte: async (id: string) => (id === FIXTURE_IDS.st1 ? ortsbaumAhrenberg() : ortsbaumLindach()),
    messstellenRegister: async () => {
      const r = ahrenbergRegister();
      const z = registerZeile();
      return { ...r, register: z ? [...r.register, z] : r.register };
    },
    messstelleAnlegen: async (a: MessstelleAnlegen) => {
      angelegt = ms23({ id: MS23_ID, kennzeichen: a.kennzeichen || 'MS-23', name: a.name, hauptgroesse: a.hauptgroesse, lebenszyklus: 'entwurf', fehlt: ['ort'], orte: [] });
      return structuredClone(angelegt);
    },
    messstelle: async () => structuredClone(angelegt ?? ms23()),
    messstelleOrtAendern: async (_id: string, o: MessstelleOrtAendern) => {
      angelegt = { ...angelegt!, lebenszyklus: 'eingerichtet', fehlt: [], orte: [{ ort_art: 'gebaeude', kennzeichen: o.kennzeichen, gueltig_ab: o.gueltig_ab, gueltig_bis: null }] };
      return structuredClone(angelegt);
    },
    messstelleStellungAendern: async (_id: string, s: MessstelleStellungAendern) => {
      angelegt = { ...angelegt!, elektrische_stellung: [{ anlage: s.anlage, stellung: s.stellung, unterzaehler_von: s.unterzaehler_von ?? null, gueltig_ab: s.gueltig_ab, gueltig_bis: null }] };
      return structuredClone(angelegt);
    },
    siteEntities: async () => komponentenHalle1(),
    komponenteMesskanaele: async () => kanaeleK5Frei(),
  };
}
