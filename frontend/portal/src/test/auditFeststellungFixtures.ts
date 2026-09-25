/**
 * UEMS AP-19 IP-20: die Routen des internen Audits (IP-18) und der Feststellung (IP-19) im Browser gespielt — für die
 * Bühne `e2e/energiemanagement.tsx` (`&seite=audits|feststellungen`) und die Vitest-Fälle. Referenz: Kunststoffwerk
 * Ahrenberg (`uems-referenzunternehmen.json` 1.10, AP-19 R9–R11). Frist, „nächstes internes Audit“ und die Sätze bildet
 * die Bühne mit dem Vertrags-Zwilling (`energiemanagement.ts`), die Prüfsumme wie der Dienst über die kanonische Kopie.
 * Die Maßnahmen einer Feststellung liest sie über `massnahmen()` aus den Routen der Maßnahme (Herkunft + Kennung, IP-17)
 * — so zeigt die Feststellungs-Seite dieselbe Maßnahme, die der AP-18-Dialog angelegt hat.
 *
 * Lagen: `leer` — kein Audit, keine Feststellung (der Weg Audit → Feststellung → Maßnahme → Wirksamkeit);
 * `r10` — AU-2029-0001 abgeschlossen, F-2029-0001 offen mit drei Einträgen (die Maßnahme M-2029-0001 legt die Bühne
 * über die Maßnahmen-Route an); `r11` — dazu Stand Nr. 1 „wirksam“ vom 15.04.2029, F-2029-0001 abgeschlossen.
 * Jeder Schreib-Körper landet in `gesendet`.
 */
import {
  ApiError,
  type api,
  type EnergiemanagementEingetragen,
  type EnergiemanagementPersonKurz,
  type Feststellung,
  type FeststellungAenderung,
  type FeststellungEintrag,
  type FeststellungMitVerlauf,
  type FeststellungStand,
  type InternesAudit,
  type InternesAuditAenderung,
  type InternesAuditHinweis,
  type InternesAuditMitVerlauf,
  type Massnahme,
} from '../api';
import { satz, ueberpruefung, STARTWERTE } from '../energiemanagement';
import { kanonisch, PRUEFSUMME_PRAEFIX } from '../uemsBericht';
import { EM_IDS } from './energiemanagementFixtures';

export type AuditLage = 'leer' | 'r10' | 'r11';
export const AF_IDS = { au1: 'a0190000-0000-4000-8000-00000000a001', f1: 'f0190000-0000-4000-8000-00000000f001' } as const;

const P = {
  IK: { id: EM_IDS.IK, name: 'Ines Kaltenbach', funktion: 'Energiemanagement', kuerzel: 'IK', mit_konto: true },
  JW: { id: EM_IDS.JW, name: 'Jonas Wendlinger', funktion: 'IT-Leitung', kuerzel: 'JW', mit_konto: true },
  CB: { id: EM_IDS.CB, name: 'Claudia Berger', funktion: 'Controlling', kuerzel: 'CB', mit_konto: true },
  RF: { id: EM_IDS.RF, name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', mit_konto: false },
  PH: { id: EM_IDS.PH, name: 'Peter Hollerbach', funktion: 'Standortleiter Werk Lindach', kuerzel: 'PH', mit_konto: true },
  MD: { id: EM_IDS.MD, name: 'Murat Demirci', funktion: 'Schichtführer Halle 1', kuerzel: 'MD', mit_konto: true },
} satisfies Record<string, EnergiemanagementPersonKurz>;
const KONTEN: Record<string, string> = { IK: 'Ines Kaltenbach', JW: 'Jonas Wendlinger', MD: 'Murat Demirci' };

const akteur = (name: string) => ({ sub: Object.keys(KONTEN).find((k) => KONTEN[k] === name) ?? null, name, rolle: 'energiemanager', art: 'kunde' as const });
const eingetragen = (name: string, am: string): EnergiemanagementEingetragen => ({ akteur: akteur(name), am });
const person = (id: string): EnergiemanagementPersonKurz => {
  const p = Object.values(P).find((x) => x.id === id);
  if (!p) throw new ApiError(422, 'person_unbekannt', { code: 'person_unbekannt', message: 'Diese Person gibt es nicht.' });
  return p;
};
const verantwortlich = (sub: string) => {
  if (!KONTEN[sub]) throw new ApiError(422, 'konto_unbekannt', { code: 'konto_unbekannt', message: 'Dieses Konto gibt es nicht.' });
  return { sub, name: KONTEN[sub] };
};
const fehler = (status: number, code: string) => new ApiError(status, code, { code, message: code });
const plusTage = (tag: string, n: number) => new Date(Date.parse(`${tag}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function sha256Hex(text: string) {
  const summe = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(summe)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const R9_AUDIT = {
  titel: 'Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen',
  unabhaengigkeit: 'Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.',
  was: 'Bezugsbasen BB-0001 bis BB-0005, Energieziel EZ-2028-0001, Maßnahmen M-2028-0001 und M-2028-0002, Energiepolitik D-0001, Anwendungsbereich D-0002, Aufgaben im Energiemanagement',
  woran: 'Energiepolitik D-0001 Fassung 1, Anwendungsbereich D-0002 Fassung 1, Aufgaben im Energiemanagement (Stand 22.01.2029)',
};
export const R9_HINWEIS = 'Die Energiepolitik wurde im Dezember 2026 bekannt gemacht; wer seitdem eingestellt wurde, lernt sie in der Einarbeitung nicht kennen.';
/** Der Wortlaut aus R10, gekürzt wie im Titel des Falls („…“) — die Bühne zeigt ihn, sie prüft ihn nicht. */
export const R10_WORTLAUT =
  'Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt: freigegeben hat alle fünf dieselbe Person ohne zweite Prüfung.';
export const R10_MASSNAHME = 'Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden';

/**
 * Die Routen von IP-18/IP-19 im Gedächtnis. `massnahmen` liest die Maßnahmen-Routen (für FS3/FS4); `vieraugen` stellt
 * Vier-Augen ein — bei Ahrenberg dürfen nur IK und JW freigeben, also ist es an F-2029-0001 nicht erfüllbar (W15).
 */
export function auditFeststellungBuehne(
  lage: AuditLage,
  ich: { kennung: string; name: string },
  jetzt: () => string,
  massnahmen: () => Promise<Massnahme[]>,
  { vieraugen = false }: { vieraugen?: boolean } = {},
) {
  const heute = () => jetzt().slice(0, 10);
  const gesendet: { route: string; koerper: unknown }[] = [];
  const merke = (route: string, koerper: unknown) => gesendet.push({ route, koerper: structuredClone(koerper) });
  const audits: InternesAudit[] = [];
  const hinweise = new Map<string, InternesAuditHinweis[]>();
  const auditVerlauf = new Map<string, InternesAuditAenderung[]>();
  const feststellungen: Feststellung[] = [];
  const eintraege = new Map<string, FeststellungEintrag[]>();
  const staende = new Map<string, FeststellungStand[]>();
  const fsVerlauf = new Map<string, FeststellungAenderung[]>();
  let zeile = 0;
  const auditLog = (id: string, art: InternesAuditAenderung['art'], zeit: string, begruendung: string | null = null, wer = ich.name) =>
    (auditVerlauf.get(id) ?? auditVerlauf.set(id, []).get(id)!).push({ id: ++zeile, art, alt: null, neu: null, begruendung, akteur: akteur(wer), zeit });
  const fsLog = (id: string, art: FeststellungAenderung['art'], zeit: string, begruendung: string | null = null, wer = ich.name) =>
    (fsVerlauf.get(id) ?? fsVerlauf.set(id, []).get(id)!).push({ id: ++zeile, art, alt: null, neu: null, begruendung, akteur: akteur(wer), zeit });
  const kennung = (praefix: string, liste: { kennzeichen: string }[], jahr: string) =>
    `${praefix}-${jahr}-${String(liste.filter((x) => x.kennzeichen.startsWith(`${praefix}-${jahr}-`)).length + 1).padStart(4, '0')}`;

  function auditFinden(id: string) {
    const a = audits.find((x) => x.id === id);
    if (!a) throw fehler(404, 'nicht_gefunden');
    return a;
  }
  const auditLesen = (id: string): InternesAuditMitVerlauf => {
    const a = auditFinden(id);
    const fs = feststellungen.filter((f) => f.quelle.audit_id === id).map((f) => f.kennzeichen);
    return structuredClone({ audit: { ...a, hinweise: (hinweise.get(id) ?? []).length, feststellungen: fs }, hinweise: hinweise.get(id) ?? [], verlauf: auditVerlauf.get(id) ?? [] });
  };
  function fsFinden(id: string) {
    const f = feststellungen.find((x) => x.id === id);
    if (!f) throw fehler(404, 'nicht_gefunden');
    return f;
  }
  const fsMassnahmen = async (f: Feststellung) =>
    (await massnahmen())
      .filter((m) => m.herkunft.art === 'nichtkonformitaet' && m.herkunft.kennung === f.kennzeichen)
      .map((m) => ({ id: m.id, kennzeichen: m.kennzeichen, titel: m.titel, zustand: m.zustand, termin: m.termin, umgesetzt_am: m.umgesetzt_am ?? null, verantwortlich: m.verantwortlich }));
  /** Wie `FeststellungService#lesen`: Frist über die Vertrags-Operation `ueberpruefung` (Art `feststellung`) am Abruf-Tag. */
  async function fsLesen(id: string): Promise<FeststellungMitVerlauf> {
    const f = fsFinden(id);
    const abruf = heute();
    const u = ueberpruefung({ art: 'feststellung', festgestellt_am: f.festgestellt_am, frist: f.frist, frist_tage: STARTWERTE.feststellung_frist_tage, zustand: f.zustand, abruf });
    const lage = 'fehler' in u ? f.lage : { abruf, faellig_am: u.faellig_am, tage: u.tage, satz: u.satz, grund: u.grund };
    const ms = await fsMassnahmen(f);
    const beteiligt = [f.verantwortlich.sub];
    const zweite = ['IK', 'JW'].filter((s) => !beteiligt.includes(s) && s !== ich.kennung).map(verantwortlich);
    return structuredClone({
      feststellung: { ...f, lage, eintraege: (eintraege.get(id) ?? []).length, massnahmen: ms.map((m) => m.kennzeichen) },
      eintraege: eintraege.get(id) ?? [],
      massnahmen: ms,
      wirksamkeit: staende.get(id) ?? [],
      vieraugen: {
        an: vieraugen, erfuellbar: !vieraugen || zweite.length > 0, berechtigte: ['IK', 'JW'].map(verantwortlich), zweite_person: vieraugen ? zweite : [],
        satz: vieraugen && !zweite.length ? satz('vieraugen_nicht_erfuellbar', { personen: 'Ines Kaltenbach und Jonas Wendlinger', beteiligt: 'beide' }).satz ?? null : null,
      },
      verlauf: fsVerlauf.get(id) ?? [],
    });
  }
  async function standFesthalten(f: Feststellung, ergebnis: FeststellungStand['ergebnis'], begruendung: string, von: string, am: string, status: FeststellungStand['status']) {
    const ms = await fsMassnahmen(f);
    const kopie = { feststellung: f.kennzeichen, wortlaut: f.wortlaut, eintraege: (eintraege.get(f.id) ?? []).length, massnahmen: ms.map((m) => ({ kennzeichen: m.kennzeichen, zustand: m.zustand, umgesetzt_am: m.umgesetzt_am })), aufgabe: null, am };
    const liste = staende.get(f.id) ?? staende.set(f.id, []).get(f.id)!;
    const s: FeststellungStand = {
      nr: liste.length + 1, ergebnis, begruendung, am, entschieden_von: person(von), kopie, pruefsumme: PRUEFSUMME_PRAEFIX + (await sha256Hex(kanonisch(kopie))),
      vieraugen: status === 'beantragt', status, eingetragen: eingetragen(ich.name, jetzt()), zweite_person: null, ablehnung_begruendung: null,
    };
    liste.push(s);
    return s;
  }
  const schliesst = (e: FeststellungStand['ergebnis']) => e !== 'nicht_wirksam';

  // ------------------------------------------------------------------ Lagen R9–R11
  const bereit = (async () => {
    if (lage === 'leer') return;
    const a: InternesAudit = {
      id: AF_IDS.au1, kennzeichen: 'AU-2029-0001', ...R9_AUDIT, termin: '2029-01-22', auditoren: [P.CB], verantwortlich: verantwortlich('IK'),
      standort_ids: [], zustand: 'abgeschlossen', durchgefuehrt_am: '2029-01-22', abgesagt_begruendung: null, hinweise: 1, feststellungen: ['F-2029-0001'],
      abschluss: null, eingetragen: eingetragen('Ines Kaltenbach', '2029-01-10T09:00:00+01:00'),
    };
    audits.push(a);
    hinweise.set(a.id, [{ nr: 1, am: '2029-01-22', festgestellt_von: P.CB, wortlaut: R9_HINWEIS, eingetragen: eingetragen('Ines Kaltenbach', '2029-01-22T16:00:00+01:00') }]);
    const bericht = { bezeichnung: 'Auditbericht AU-2029-0001, unterschrieben', ablage: 'QM-Laufwerk, Ordner Energiemanagement/Audits', kennung: 'AU-2029-0001', adresse: null, sha256: null };
    const kopie = { kennzeichen: a.kennzeichen, hinweise: [{ nr: 1, am: '2029-01-22', festgestellt_von: 'CB', eingetragen_von: 'IK', wortlaut: R9_HINWEIS, massnahme: null }], feststellungen: ['F-2029-0001'], bericht };
    a.abschluss = {
      am: '2029-01-31', entschieden_von: P.IK, zusammenfassung: 'Ein Hinweis und eine Feststellung; der unterschriebene Bericht liegt im QM-Laufwerk.', bericht, kopie,
      pruefsumme: PRUEFSUMME_PRAEFIX + (await sha256Hex(kanonisch(kopie))), eingetragen: eingetragen('Ines Kaltenbach', '2029-01-31T15:00:00+01:00'),
    };
    auditLog(a.id, 'audit_geplant', '2029-01-10T09:00:00+01:00', null, 'Ines Kaltenbach');
    auditLog(a.id, 'audit_durchgefuehrt', '2029-01-22T17:00:00+01:00', null, 'Ines Kaltenbach');
    auditLog(a.id, 'hinweis', '2029-01-22T17:05:00+01:00', null, 'Ines Kaltenbach');
    auditLog(a.id, 'audit_abgeschlossen', '2029-01-31T15:00:00+01:00', null, 'Ines Kaltenbach');
    const f: Feststellung = {
      id: AF_IDS.f1, kennzeichen: 'F-2029-0001', quelle: { art: 'internes_audit', audit_id: a.id, kennung: a.kennzeichen, wortlaut: null }, wortlaut: R10_WORTLAUT,
      vorgabe: { dokument_id: EM_IDS.d1, dokument: 'D-0001', fassung: 1, wortlaut: '„Wir legen fest, wer im Energiemanagement wofür zuständig ist.“' },
      bezug: { standort_id: null, aufgabe: 'bezugsbasen', dokument_id: null, dokument: null, objekte: ['BB-0001', 'BB-0002', 'BB-0003', 'BB-0004', 'BB-0005'] },
      festgestellt_von: P.CB, festgestellt_am: '2029-01-22', verantwortlich: verantwortlich('JW'), frist: '2029-04-22', zustand: 'offen',
      lage: { abruf: heute(), faellig_am: '2029-04-22', tage: null, satz: null, grund: null }, ergebnis: null, eintraege: 3, massnahmen: [],
      eingetragen: eingetragen('Ines Kaltenbach', '2029-01-23T08:30:00+01:00'),
    };
    feststellungen.push(f);
    const e = (id: number, art: FeststellungEintrag['art'], am: string, wortlaut: string): FeststellungEintrag => ({
      id, art, am, person: P.IK, wortlaut, eingetragen: eingetragen('Ines Kaltenbach', `${am}T10:00:00+01:00`),
    });
    eintraege.set(f.id, [
      e(1, 'behebung', '2029-01-23', 'Bis zur Festlegung gibt Ines Kaltenbach keine Bezugsbasis ohne Rücksprache mit Jonas Wendlinger frei.'),
      e(2, 'ursache_aussage', '2029-01-25', 'Die Aufgabenliste entstand zum Start, bevor es Bezugsbasen gab; sie wurde nicht nachgeführt.'),
      e(3, 'aehnliche_faelle', '2029-01-25', 'Kein weiterer Fall: alle übrigen Aufgaben haben eine Person.'),
    ]);
    fsLog(f.id, 'feststellung_erfasst', '2029-01-23T08:30:00+01:00', null, 'Ines Kaltenbach');
    if (lage === 'r11') {
      await standFesthalten(f, 'wirksam', 'Aufgabe seit 01.03.2029 festgelegt, Vertretung benannt; die Freigaben seit März nennen beide.', P.IK.id, '2029-04-15', 'freigegeben');
      f.zustand = 'abgeschlossen';
      f.ergebnis = 'wirksam';
      fsLog(f.id, 'feststellung_abgeschlossen', '2029-04-15T11:00:00+02:00', null, 'Ines Kaltenbach');
    }
  })();

  const routen: Partial<typeof api> = {
    energiemanagementAudits: async (tag) => {
      await bereit;
      const abruf = tag ?? heute();
      const tage = audits.filter((a) => a.durchgefuehrt_am && a.durchgefuehrt_am <= abruf).map((a) => a.durchgefuehrt_am!);
      const u = ueberpruefung({ art: 'internes_audit', monate: STARTWERTE.audit_rhythmus_monate, tage, abruf });
      const n = 'fehler' in u ? { faellig_am: null, basis: null, tage: null, satz: null, grund: 'kein_audit' } : u;
      return {
        tag: abruf,
        audits: [...audits].sort((x, y) => y.termin.localeCompare(x.termin)).map((a) => auditLesen(a.id).audit),
        naechstes: { rhythmus_monate: STARTWERTE.audit_rhythmus_monate, faellig_am: n.faellig_am, basis: n.basis, tage: n.tage, satz: n.satz, grund: n.grund },
      };
    },
    energiemanagementAudit: async (id) => {
      await bereit;
      return auditLesen(id);
    },
    energiemanagementAuditPlanen: async (b) => {
      await bereit;
      merke('POST /api/v1/energiemanagement/audits', b);
      const id = `a0190000-0000-4000-8000-${String(900 + audits.length).padStart(12, '0')}`;
      audits.push({
        id, kennzeichen: kennung('AU', audits, heute().slice(0, 4)), titel: b.titel, termin: b.termin, auditoren: b.auditor_ids.map(person),
        unabhaengigkeit: b.unabhaengigkeit, was: b.was, woran: b.woran, verantwortlich: verantwortlich(b.verantwortlich), standort_ids: b.standort_ids ?? [],
        zustand: 'geplant', durchgefuehrt_am: null, abgesagt_begruendung: null, hinweise: 0, feststellungen: [], abschluss: null, eingetragen: eingetragen(ich.name, jetzt()),
      });
      auditLog(id, 'audit_geplant', jetzt());
      return auditLesen(id);
    },
    energiemanagementAuditDurchgefuehrt: async (id, am) => {
      merke(`POST /api/v1/energiemanagement/audits/${id}/durchgefuehrt`, { am });
      const a = auditFinden(id);
      if (a.zustand !== 'geplant') throw fehler(409, 'audit_nicht_geplant');
      if (am > heute()) throw fehler(422, 'tag_in_zukunft');
      Object.assign(a, { zustand: 'durchgefuehrt', durchgefuehrt_am: am });
      auditLog(id, 'audit_durchgefuehrt', jetzt());
      return auditLesen(id);
    },
    energiemanagementAuditHinweis: async (id, b) => {
      merke(`POST /api/v1/energiemanagement/audits/${id}/hinweise`, b);
      const a = auditFinden(id);
      if (a.zustand !== 'durchgefuehrt') throw fehler(409, 'audit_nicht_durchgefuehrt');
      const liste = hinweise.get(id) ?? hinweise.set(id, []).get(id)!;
      liste.push({ nr: liste.length + 1, am: b.am ?? a.durchgefuehrt_am!, festgestellt_von: person(b.festgestellt_von), wortlaut: b.wortlaut, eingetragen: eingetragen(ich.name, jetzt()) });
      auditLog(id, 'hinweis', jetzt());
      return auditLesen(id);
    },
    energiemanagementAuditAbschliessen: async (id, b) => {
      merke(`POST /api/v1/energiemanagement/audits/${id}/abschliessen`, b);
      const a = auditFinden(id);
      if (a.zustand !== 'durchgefuehrt') throw fehler(409, 'audit_nicht_durchgefuehrt');
      if (!b.bericht?.ablage && !b.zusammenfassung) throw fehler(422, 'bericht_oder_zusammenfassung');
      const gelesen = auditLesen(id);
      const kopie = {
        kennzeichen: a.kennzeichen,
        hinweise: gelesen.hinweise.map((h) => ({ nr: h.nr, am: h.am, festgestellt_von: h.festgestellt_von.kuerzel, eingetragen_von: 'IK', wortlaut: h.wortlaut, massnahme: b.massnahmen?.find((m) => m.hinweis === h.nr)?.massnahme ?? null })),
        feststellungen: gelesen.audit.feststellungen, bericht: b.bericht ?? null,
      };
      a.abschluss = {
        am: b.am ?? heute(), entschieden_von: person(b.entschieden_von), zusammenfassung: b.zusammenfassung ?? null, bericht: b.bericht ?? null, kopie,
        pruefsumme: PRUEFSUMME_PRAEFIX + (await sha256Hex(kanonisch(kopie))), eingetragen: eingetragen(ich.name, jetzt()),
      };
      a.zustand = 'abgeschlossen';
      auditLog(id, 'audit_abgeschlossen', jetzt());
      return auditLesen(id);
    },
    energiemanagementAuditAbsagen: async (id, begruendung) => {
      merke(`POST /api/v1/energiemanagement/audits/${id}/absagen`, { begruendung });
      const a = auditFinden(id);
      if (a.zustand !== 'geplant') throw fehler(409, 'audit_nicht_geplant');
      Object.assign(a, { zustand: 'abgesagt', abgesagt_begruendung: begruendung });
      auditLog(id, 'audit_abgesagt', jetzt(), begruendung);
      return auditLesen(id);
    },
    energiemanagementFeststellungen: async (tag) => {
      await bereit;
      const gelesen = await Promise.all(feststellungen.map((f) => fsLesen(f.id)));
      const liste = gelesen.map((g) => g.feststellung);
      const offen = liste.filter((f) => f.zustand === 'offen').sort((x, y) => x.frist.localeCompare(y.frist));
      return { tag: tag ?? heute(), feststellungen: [...offen, ...liste.filter((f) => f.zustand !== 'offen')] };
    },
    energiemanagementFeststellung: async (id) => {
      await bereit;
      return fsLesen(id);
    },
    energiemanagementFeststellungErfassen: async (b) => {
      await bereit;
      merke('POST /api/v1/energiemanagement/feststellungen', b);
      const audit = b.quelle.art === 'internes_audit' ? audits.find((a) => a.id === b.quelle.audit_id) : null;
      if (b.quelle.art === 'internes_audit' && !audit) throw fehler(422, 'audit_unbekannt');
      if (audit && audit.zustand !== 'durchgefuehrt') throw fehler(409, 'audit_nicht_durchgefuehrt');
      if (!b.vorgabe.dokument_id && !b.vorgabe.wortlaut) throw fehler(422, 'vorgabe_fehlt');
      const am = b.festgestellt_am ?? heute();
      const id = `f0190000-0000-4000-8000-${String(900 + feststellungen.length).padStart(12, '0')}`;
      feststellungen.push({
        id, kennzeichen: kennung('F', feststellungen, heute().slice(0, 4)),
        quelle: { art: b.quelle.art, audit_id: audit?.id ?? null, kennung: audit?.kennzeichen ?? null, wortlaut: b.quelle.wortlaut ?? null },
        wortlaut: b.wortlaut,
        vorgabe: { dokument_id: b.vorgabe.dokument_id ?? null, dokument: b.vorgabe.dokument_id === EM_IDS.d1 ? 'D-0001' : b.vorgabe.dokument_id ? 'D-0002' : null, fassung: b.vorgabe.fassung ?? null, wortlaut: b.vorgabe.wortlaut ?? null },
        bezug: { standort_id: null, aufgabe: b.bezug?.aufgabe ?? null, dokument_id: null, dokument: null, objekte: b.bezug?.objekte ?? [] },
        festgestellt_von: person(b.festgestellt_von), festgestellt_am: am, verantwortlich: verantwortlich(b.verantwortlich),
        frist: b.frist ?? plusTage(am, STARTWERTE.feststellung_frist_tage), zustand: 'offen', lage: { abruf: heute(), faellig_am: null, tage: null, satz: null, grund: null },
        ergebnis: null, eintraege: 0, massnahmen: [], eingetragen: eingetragen(ich.name, jetzt()),
      });
      fsLog(id, 'feststellung_erfasst', jetzt());
      return fsLesen(id);
    },
    energiemanagementFeststellungEintrag: async (id, b) => {
      merke(`POST /api/v1/energiemanagement/feststellungen/${id}/eintraege`, b);
      const f = fsFinden(id);
      if (f.zustand !== 'offen') throw fehler(409, 'feststellung_abgeschlossen');
      const liste = eintraege.get(id) ?? eintraege.set(id, []).get(id)!;
      liste.push({ id: ++zeile, art: b.art, am: b.am ?? heute(), person: person(b.person_id), wortlaut: b.wortlaut, eingetragen: eingetragen(ich.name, jetzt()) });
      fsLog(id, 'eintrag', jetzt());
      return fsLesen(id);
    },
    energiemanagementFeststellungStand: async (id, weg, b) => {
      merke(`POST /api/v1/energiemanagement/feststellungen/${id}/${weg}`, b);
      const f = fsFinden(id);
      if (f.zustand !== 'offen') throw fehler(409, 'feststellung_abgeschlossen');
      if ((staende.get(id) ?? []).some((s) => s.status === 'beantragt')) throw fehler(409, 'wirksamkeit_beantragt');
      if (weg === 'wirksamkeit/beantragen' && !vieraugen) throw fehler(409, 'vieraugen_aus');
      if (weg !== 'wirksamkeit/beantragen' && vieraugen) throw fehler(409, 'vieraugen_beantragen');
      if (weg === 'wirksamkeit/beantragen') {
        const g = await fsLesen(id);
        if (!g.vieraugen.erfuellbar) throw new ApiError(409, 'vieraugen_nicht_erfuellbar', { code: 'vieraugen_nicht_erfuellbar', satz: g.vieraugen.satz, berechtigte: g.vieraugen.berechtigte });
      }
      if (b.ergebnis === 'wirksam' || b.ergebnis === 'nicht_wirksam') {
        const ms = await fsMassnahmen(f);
        const ok = ms.length > 0 && ms.every((m) => m.zustand !== 'geplant') && ms.some((m) => m.zustand === 'umgesetzt' || m.zustand === 'bewertet');
        if (!ok) throw fehler(409, 'wirksamkeit_noch_nicht');
      }
      const n = b.begruendung.trim().length;
      if (n < 10 || n > 500) throw fehler(422, 'begruendung_fehlt');
      const status = weg === 'wirksamkeit/beantragen' ? 'beantragt' : 'freigegeben';
      await standFesthalten(f, b.ergebnis, b.begruendung, b.entschieden_von, b.am ?? heute(), status);
      if (status === 'freigegeben' && schliesst(b.ergebnis)) {
        f.zustand = 'abgeschlossen';
        f.ergebnis = b.ergebnis as Feststellung['ergebnis'];
        fsLog(id, 'feststellung_abgeschlossen', jetzt());
      } else fsLog(id, status === 'beantragt' ? 'wirksamkeit_beantragt' : 'wirksamkeit_geprueft', jetzt());
      return fsLesen(id);
    },
    energiemanagementFeststellungFreigeben: async (id) => {
      merke(`POST /api/v1/energiemanagement/feststellungen/${id}/wirksamkeit/freigeben`, {});
      const f = fsFinden(id);
      const s = (staende.get(id) ?? []).find((x) => x.status === 'beantragt');
      if (!s) throw fehler(409, 'kein_antrag');
      if (s.eingetragen.akteur.name === ich.name) throw fehler(422, 'vieraugen_urheber');
      if (f.verantwortlich.sub === ich.kennung) throw fehler(422, 'vieraugen_verantwortlich');
      Object.assign(s, { status: 'freigegeben', zweite_person: eingetragen(ich.name, jetzt()) });
      if (schliesst(s.ergebnis)) Object.assign(f, { zustand: 'abgeschlossen', ergebnis: s.ergebnis });
      fsLog(id, schliesst(s.ergebnis) ? 'feststellung_abgeschlossen' : 'wirksamkeit_geprueft', jetzt());
      return fsLesen(id);
    },
    energiemanagementFeststellungAblehnen: async (id, begruendung) => {
      merke(`POST /api/v1/energiemanagement/feststellungen/${id}/wirksamkeit/ablehnen`, { begruendung });
      const s = (staende.get(id) ?? []).find((x) => x.status === 'beantragt');
      if (!s) throw fehler(409, 'kein_antrag');
      Object.assign(s, { status: 'abgelehnt', zweite_person: eingetragen(ich.name, jetzt()), ablehnung_begruendung: begruendung });
      fsLog(id, 'wirksamkeit_abgelehnt', jetzt(), begruendung);
      return fsLesen(id);
    },
  };
  return { routen, gesendet, bereit };
}
