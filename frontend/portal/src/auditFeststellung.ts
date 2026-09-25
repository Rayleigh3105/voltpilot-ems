/**
 * UEMS AP-19 IP-20 (§4.6 IA1–IA5, §4.7 FS1–FS7, §5.4, §5.8, SP5): das reine Bild der Reiter „Audits“ und
 * „Feststellungen“ — Wörter, Sätze und die Körper der Routen aus IP-18/IP-19. **Hier wird nichts entschieden:** Frist,
 * „überfällig seit n Tagen“, „nächstes internes Audit“, Vier-Augen und die Voraussetzung der Wirksamkeit kommen von der
 * Route; die Sätze sind die Schablonen des Vertrags (`energiemanagement.ts`). Das interne Wort der Maßnahme-Herkunft
 * (`nichtkonformitaet`) wird hier nie zu Text — das Kundenwort ist „Feststellung“ (SP5).
 */
import type {
  EnergiemanagementBeleg,
  EnergiemanagementPersonKurz,
  Feststellung,
  FeststellungEintrag,
  FeststellungErfassen,
  FeststellungErgebnis,
  FeststellungMassnahme,
  FeststellungStand,
  InternesAudit,
  InternesAuditAbschliessen,
  InternesAuditHinweis,
  InternesAuditStand,
  MassnahmeHerkunft,
} from './api';
import { STARTWERTE } from './energiemanagement';
import { begruendungFehler, satzText, tagText, verweisKoerper, type Feldfehler, type VerweisEntwurf } from './energiemanagementPortal';
import { UEMS_FESTSTELLUNG, UEMS_INTERNES_AUDIT, UEMS_MANAGEMENTBEWERTUNG } from './glossar';

// ------------------------------------------------------------------ Wörter

export const KNOPF_AUDIT_PLANEN = 'Audit planen';
export const KNOPF_DURCHGEFUEHRT = 'Durchgeführt melden';
export const KNOPF_HINWEIS = 'Hinweis festhalten';
export const KNOPF_AUDIT_ABSCHLIESSEN = 'Audit abschließen';
export const KNOPF_AUDIT_ABSAGEN = 'Audit absagen';
export const KNOPF_FESTSTELLUNG = 'Feststellung erfassen';
export const KNOPF_EINTRAG = 'Eintrag festhalten';
export const KNOPF_WIRKSAMKEIT = 'Wirksamkeit prüfen';
export const KNOPF_OHNE_MASSNAHME = 'Ohne Maßnahme abschließen';
export const KNOPF_ZURUECKNEHMEN = 'Zurücknehmen';
export const KNOPF_ANTRAG_BESTAETIGEN = 'Bestätigen';
export const KNOPF_ANTRAG_ABLEHNEN = 'Ablehnen';

export const AUDITPROGRAMM = 'Auditprogramm';
export const AUDIT_ZUSTAND_WORT: Record<InternesAudit['zustand'], string> = {
  geplant: 'geplant', durchgefuehrt: 'durchgeführt', abgeschlossen: 'abgeschlossen', abgesagt: 'abgesagt',
};
export const FESTSTELLUNG_ZUSTAND_WORT: Record<Feststellung['zustand'], string> = { offen: 'offen', abgeschlossen: 'abgeschlossen' };
export const EINTRAG_WORT: Record<FeststellungEintrag['art'], string> = {
  kommentar: 'Kommentar', behebung: 'Sofortige Behebung', ursache_aussage: 'Ursache — Aussage', aehnliche_faelle: 'Ähnliche Fälle geprüft',
};
export const ERGEBNIS_WORT: Record<FeststellungErgebnis, string> = {
  wirksam: 'wirksam', nicht_wirksam: 'nicht wirksam', ohne_massnahme: 'ohne Maßnahme abgeschlossen', zurueckgenommen: 'zurückgenommen',
};
export const STAND_STATUS_WORT: Record<FeststellungStand['status'], string> = {
  beantragt: 'beantragt — wartet auf die zweite Person', freigegeben: 'festgehalten', abgelehnt: 'abgelehnt',
};
export const QUELLE_WAHL: { value: Feststellung['quelle']['art']; label: string }[] = [
  { value: 'eigene', label: 'eigene Feststellung' },
  { value: 'extern', label: 'von außen (etwa eine Behörde oder ein Kunde)' },
  { value: 'internes_audit', label: `aus einem ${UEMS_INTERNES_AUDIT}` },
];
export const AUDIT_VERLAUF_WORT: Record<string, string> = {
  audit_geplant: 'geplant', audit_geaendert: 'geändert', audit_durchgefuehrt: 'durchgeführt gemeldet', hinweis: 'Hinweis festgehalten',
  audit_abgeschlossen: 'abgeschlossen', audit_abgesagt: 'abgesagt',
};
export const FESTSTELLUNG_VERLAUF_WORT: Record<string, string> = {
  feststellung_erfasst: 'erfasst', eintrag: 'Eintrag', feststellung_geaendert: 'geändert', wirksamkeit_beantragt: 'Wirksamkeit beantragt',
  wirksamkeit_geprueft: 'Wirksamkeit geprüft', wirksamkeit_abgelehnt: 'Antrag abgelehnt', feststellung_abgeschlossen: 'abgeschlossen',
};

// ------------------------------------------------------------------ Sätze (§5.8)

const personName = (p: EnergiemanagementPersonKurz) => p.name;
const auditorenWort = (a: Pick<InternesAudit, 'auditoren'>) => a.auditoren.map(personName).join(', ');

/**
 * „Internes Audit AU-2029-0001 · durchgeführt am 22.01.2029 von Claudia Berger (Controlling).“ — in der Klammer die
 * Funktion der Prüfenden; ob jemand zum Energieteam gehört, urteilt das Portal nicht: die Unabhängigkeit steht als
 * Wortlaut darunter (IA1). Vor der Durchführung steht der Plan.
 */
export function auditKopf(a: InternesAudit): string {
  if (a.durchgefuehrt_am) {
    return satzText('audit_kopf', {
      kennzeichen: a.kennzeichen, am: tagText(a.durchgefuehrt_am), auditor: auditorenWort(a),
      unabhaengigkeit: a.auditoren.map((p) => p.funktion).filter(Boolean).join('; ') || a.unabhaengigkeit,
    });
  }
  const wann = a.zustand === 'abgesagt' ? 'abgesagt, geplant war' : 'geplant am';
  return `Internes Audit ${a.kennzeichen} · ${wann} ${tagText(a.termin)} · ${auditorenWort(a)}.`;
}

/** „Hinweis — festgestellt von Claudia Berger, eingetragen von Ines Kaltenbach am 22.01.2029.“ (IA5, G2) */
export const hinweisSatz = (h: InternesAuditHinweis) =>
  satzText('hinweis', { festgestellt_von: h.festgestellt_von.name, eingetragen_von: h.eingetragen.akteur.name, am: tagText(h.am) });

/** Die Quelle im Kopf: „aus dem internen Audit AU-2029-0001“ · „eigene Feststellung“ · „von außen: …“ (FS1). */
export function quelleWort(q: Feststellung['quelle']): string {
  switch (q.art) {
    case 'internes_audit':
      return `aus dem internen Audit${q.kennung ? ` ${q.kennung}` : ''}`;
    case 'extern':
      return `von außen${q.wortlaut ? `: ${q.wortlaut}` : ''}`;
    case 'managementbewertung':
      return `aus der ${UEMS_MANAGEMENTBEWERTUNG}${q.kennung ? ` ${q.kennung}` : ''}`;
    default:
      return `eigene ${UEMS_FESTSTELLUNG}`;
  }
}

/** „Feststellung F-2029-0001 · aus dem internen Audit AU-2029-0001 · festgestellt von … · Frist 22.04.2029 · offen.“ */
export const feststellungKopf = (f: Feststellung) =>
  satzText('feststellung_kopf', {
    kennzeichen: f.kennzeichen, quelle: quelleWort(f.quelle), person: f.festgestellt_von.name, am: tagText(f.festgestellt_am),
    verantwortlich: f.verantwortlich.name, frist: tagText(f.frist), zustand: FESTSTELLUNG_ZUSTAND_WORT[f.zustand],
  });

/** Die Vorgabe: „D-0001, Fassung 1: ‚…‘“ oder nur der Wortlaut. */
export function vorgabeWort(v: Feststellung['vorgabe']): string {
  const dok = v.dokument ? `${v.dokument}${v.fassung ? `, Fassung ${v.fassung}` : ''}` : '';
  if (dok && v.wortlaut) return `${dok}: ${v.wortlaut}`;
  return dok || v.wortlaut || '';
}

/** Der Bezug: Aufgabe, Dokument und Objekte — ohne Angabe das Unternehmen. */
export function bezugWort(b: Feststellung['bezug'], aufgabeWort: (a: string) => string): string {
  const teile = [b.aufgabe ? `Aufgabe „${aufgabeWort(b.aufgabe)}“` : null, b.dokument, b.objekte.length ? b.objekte.join(', ') : null].filter(Boolean);
  return teile.length ? teile.join(' · ') : 'das Unternehmen';
}

/** Ein Eintrag (FS2) — immer die Aussage einer Person an einem Tag, nie ein Satz des Systems. */
export function eintragSatz(e: FeststellungEintrag): string {
  const werte = { person: e.person.name, am: tagText(e.am), wortlaut: e.wortlaut };
  if (e.art === 'behebung') return satzText('behebung', werte);
  if (e.art === 'ursache_aussage') return satzText('ursache_aussage', werte);
  return `${EINTRAG_WORT[e.art]} — ${werte.person}, ${werte.am}: ${werte.wortlaut}`;
}

/** „Wirksamkeit geprüft am 15.04.2029 von Ines Kaltenbach: wirksam — Stand Nr. 1 mit Prüfsumme.“ (FS4, FS5) */
export function standSatz(s: FeststellungStand): string {
  if (s.ergebnis === 'wirksam' || s.ergebnis === 'nicht_wirksam') {
    return satzText('wirksamkeit', { am: tagText(s.am), person: s.entschieden_von.name, ergebnis: ERGEBNIS_WORT[s.ergebnis], nr: String(s.nr) });
  }
  return `Abgeschlossen am ${tagText(s.am)} von ${s.entschieden_von.name}: ${ERGEBNIS_WORT[s.ergebnis]} — Stand Nr. ${s.nr} mit Prüfsumme.`;
}

/**
 * FS4 als Satz, nicht als Sperre: solange eine Maßnahme geplant ist oder keine umgesetzt oder bewertet wurde, steht
 * „Die Wirksamkeit lässt sich prüfen, sobald …“ — entschieden wird an der Route (409 `wirksamkeit_noch_nicht`).
 */
export function wirksamkeitPruefbar(massnahmen: Pick<FeststellungMassnahme, 'zustand'>[]): boolean {
  return (
    massnahmen.length > 0 &&
    massnahmen.every((m) => m.zustand !== 'geplant') &&
    massnahmen.some((m) => m.zustand === 'umgesetzt' || m.zustand === 'bewertet')
  );
}

/** Die Herkunft einer Maßnahme aus dem Energiemanagement (SP5): „Herkunft: Feststellung F-2029-0001.“ — sonst `null`. */
export function herkunftSatz(art: MassnahmeHerkunft, kennung: string | null): string | null {
  if (!kennung) return null;
  if (art === 'nichtkonformitaet') return satzText('herkunft_feststellung', { kennung });
  if (art === 'audit') return satzText('herkunft_audit', { kennung });
  if (art === 'managementbewertung') {
    const [br, b] = kennung.split('/');
    return satzText('herkunft_managementbewertung', { kennung: br, beschluss: (b ?? '').replace(/^B/, '') });
  }
  return null;
}

// ------------------------------------------------------------------ Entwürfe → Körper

const leer = (t: string | null | undefined) => !t || !t.trim();
const ohne = (t: string) => (leer(t) ? null : t.trim());
const TAG = /^\d{4}-\d{2}-\d{2}$/;

export interface AuditEntwurf {
  titel: string;
  termin: string;
  auditorIds: string[];
  unabhaengigkeit: string;
  was: string;
  woran: string;
  verantwortlich: string;
}
export const LEERES_AUDIT: AuditEntwurf = { titel: '', termin: '', auditorIds: [], unabhaengigkeit: '', was: '', woran: '', verantwortlich: '' };

/** Planen (IA1): Titel, Termin, Auditorin oder Auditor, Unabhängigkeit als Wortlaut, was und woran — alles Pflicht. */
export function auditKoerper(e: AuditEntwurf): { fehler: Feldfehler } | { koerper: InternesAuditStand } {
  const fehler: Feldfehler = {};
  if (leer(e.titel)) fehler.titel = 'Bitte geben Sie dem Audit einen Titel.';
  if (!TAG.test(e.termin)) fehler.termin = 'Bitte wählen Sie den Termin.';
  if (!e.auditorIds.length) fehler.auditorIds = 'Bitte wählen Sie, wer prüft.';
  if (leer(e.unabhaengigkeit)) fehler.unabhaengigkeit = 'Bitte beschreiben Sie, warum die Person unabhängig prüft.';
  if (leer(e.was)) fehler.was = 'Bitte nennen Sie, was geprüft wird.';
  if (leer(e.woran)) fehler.woran = 'Bitte nennen Sie, woran geprüft wird.';
  if (!e.verantwortlich) fehler.verantwortlich = 'Bitte wählen Sie, wer verantwortlich ist.';
  if (Object.keys(fehler).length) return { fehler };
  return {
    koerper: {
      titel: e.titel.trim(), termin: e.termin, auditor_ids: e.auditorIds, unabhaengigkeit: e.unabhaengigkeit.trim(), was: e.was.trim(),
      woran: e.woran.trim(), verantwortlich: e.verantwortlich,
    },
  };
}

/** Ein Hinweis (IA2, IA5): Wortlaut und die Person, die prüft — sie braucht kein Konto. */
export function hinweisKoerper(e: { wortlaut: string; personId: string; am: string }) {
  const fehler: Feldfehler = {};
  if (leer(e.wortlaut)) fehler.wortlaut = 'Bitte halten Sie den Hinweis im Wortlaut fest.';
  if (!e.personId) fehler.personId = 'Bitte wählen Sie, wer den Hinweis festgestellt hat.';
  if (Object.keys(fehler).length) return { fehler };
  return { koerper: { wortlaut: e.wortlaut.trim(), festgestellt_von: e.personId, am: e.am || null } };
}

export interface AuditAbschlussEntwurf {
  entschiedenVon: string;
  am: string;
  zusammenfassung: string;
  bericht: VerweisEntwurf;
  /** Je Hinweis-Nr. das Kennzeichen der Maßnahme, die aus ihm wurde (wahlfrei). */
  massnahmen: Record<number, string>;
}

/** Abschließen (IA3): der Bericht als Verweis ODER eine Zusammenfassung — beides geht, keines nicht. */
export function auditAbschlussKoerper(e: AuditAbschlussEntwurf): { fehler: Feldfehler } | { koerper: InternesAuditAbschliessen } {
  const fehler: Feldfehler = {};
  if (!e.entschiedenVon) fehler.entschiedenVon = 'Bitte wählen Sie, wer den Abschluss entschieden hat.';
  const bericht = verweisKoerper(e.bericht, false);
  if (bericht && 'fehler' in bericht) fehler.bericht = bericht.fehler;
  if (!bericht && leer(e.zusammenfassung)) fehler.zusammenfassung = 'Bitte halten Sie den Bericht als Verweis fest oder fassen Sie das Ergebnis zusammen.';
  const massnahmen = Object.entries(e.massnahmen)
    .filter(([, m]) => !!m)
    .map(([hinweis, massnahme]) => ({ hinweis: Number(hinweis), massnahme }));
  if (Object.keys(fehler).length) return { fehler };
  return {
    koerper: {
      entschieden_von: e.entschiedenVon, am: e.am || null, zusammenfassung: ohne(e.zusammenfassung),
      bericht: bericht ? (bericht as EnergiemanagementBeleg) : null, ...(massnahmen.length ? { massnahmen } : {}),
    },
  };
}

export interface FeststellungEntwurf {
  quelle: Feststellung['quelle']['art'];
  auditId: string;
  extern: string;
  wortlaut: string;
  vorgabeDokument: string;
  vorgabeFassung: string;
  vorgabeWortlaut: string;
  aufgabe: string;
  objekte: string;
  festgestelltVon: string;
  festgestelltAm: string;
  verantwortlich: string;
  frist: string;
}
export const leereFeststellung = (audit: { id: string; auditorId: string | null; am: string | null } | null): FeststellungEntwurf => ({
  quelle: audit ? 'internes_audit' : 'eigene', auditId: audit?.id ?? '', extern: '', wortlaut: '', vorgabeDokument: '', vorgabeFassung: '',
  vorgabeWortlaut: '', aufgabe: '', objekte: '', festgestelltVon: audit?.auditorId ?? '', festgestelltAm: audit?.am ?? '', verantwortlich: '', frist: '',
});

/** Erfassen (FS1): Quelle mit genau ihrem Verweis, Wortlaut, Vorgabe (Dokument-Fassung und/oder Wortlaut), Personen. */
export function feststellungKoerper(e: FeststellungEntwurf): { fehler: Feldfehler } | { koerper: FeststellungErfassen } {
  const fehler: Feldfehler = {};
  if (e.quelle === 'internes_audit' && !e.auditId) fehler.auditId = `Bitte wählen Sie das ${UEMS_INTERNES_AUDIT}.`;
  if (e.quelle === 'extern' && leer(e.extern)) fehler.extern = 'Bitte nennen Sie, von wem die Feststellung kommt.';
  if (leer(e.wortlaut)) fehler.wortlaut = 'Bitte beschreiben Sie, was nicht erfüllt ist.';
  const fassung = e.vorgabeFassung ? Number(e.vorgabeFassung) : null;
  if (e.vorgabeDokument && !fassung) fehler.vorgabeFassung = 'Bitte wählen Sie die Fassung.';
  if (!e.vorgabeDokument && leer(e.vorgabeWortlaut)) fehler.vorgabe = 'Bitte nennen Sie die Vorgabe — ein Dokument mit Fassung oder im Wortlaut.';
  if (!e.festgestelltVon) fehler.festgestelltVon = 'Bitte wählen Sie, wer festgestellt hat.';
  if (!e.verantwortlich) fehler.verantwortlich = 'Bitte wählen Sie, wer verantwortlich ist.';
  if (e.frist && e.festgestelltAm && e.frist < e.festgestelltAm) fehler.frist = 'Die Frist liegt nicht vor dem Tag der Feststellung.';
  if (Object.keys(fehler).length) return { fehler };
  const objekte = e.objekte.split(/[,;\s]+/).map((o) => o.trim()).filter(Boolean);
  const mitBezug = !!e.aufgabe || objekte.length > 0;
  return {
    koerper: {
      quelle: {
        art: e.quelle,
        ...(e.quelle === 'internes_audit' ? { audit_id: e.auditId } : {}),
        ...(e.quelle === 'extern' ? { wortlaut: e.extern.trim() } : {}),
      },
      wortlaut: e.wortlaut.trim(),
      vorgabe: {
        ...(e.vorgabeDokument ? { dokument_id: e.vorgabeDokument, fassung } : {}),
        ...(leer(e.vorgabeWortlaut) ? {} : { wortlaut: e.vorgabeWortlaut.trim() }),
      },
      bezug: mitBezug ? { ...(e.aufgabe ? { aufgabe: e.aufgabe } : {}), ...(objekte.length ? { objekte } : {}) } : null,
      festgestellt_von: e.festgestelltVon,
      festgestellt_am: e.festgestelltAm || null,
      verantwortlich: e.verantwortlich,
      frist: e.frist || null,
    },
  };
}

/** Ein Eintrag (FS2): Art, Wortlaut, die Person, deren Aussage es ist, und der Tag. */
export function eintragKoerper(e: { art: FeststellungEintrag['art'] | ''; wortlaut: string; personId: string; am: string }) {
  const fehler: Feldfehler = {};
  if (!e.art) fehler.art = 'Bitte wählen Sie die Art des Eintrags.';
  if (leer(e.wortlaut)) fehler.wortlaut = 'Bitte halten Sie den Eintrag im Wortlaut fest.';
  else if (e.wortlaut.trim().length > STARTWERTE.eintrag_zeichen_hoechstens) fehler.wortlaut = `Höchstens ${STARTWERTE.eintrag_zeichen_hoechstens.toLocaleString('de-DE')} Zeichen.`;
  if (!e.personId) fehler.personId = 'Bitte wählen Sie, wessen Aussage es ist.';
  if (Object.keys(fehler).length) return { fehler };
  return { koerper: { art: e.art as FeststellungEintrag['art'], wortlaut: e.wortlaut.trim(), person_id: e.personId, am: e.am || null } };
}

/** Ein Stand (FS4, FS5): Ergebnis, Begründung 10–500 Zeichen, die Person, die geprüft hat. */
export function standKoerper(e: { ergebnis: FeststellungErgebnis | ''; begruendung: string; entschiedenVon: string; am: string }) {
  const fehler: Feldfehler = {};
  if (!e.ergebnis) fehler.ergebnis = 'Bitte wählen Sie das Ergebnis.';
  const b = begruendungFehler(e.begruendung);
  if (b) fehler.begruendung = b;
  if (!e.entschiedenVon) fehler.entschiedenVon = 'Bitte wählen Sie, wer geprüft hat.';
  if (Object.keys(fehler).length) return { fehler };
  return {
    koerper: { ergebnis: e.ergebnis as FeststellungErgebnis, begruendung: e.begruendung.trim(), entschieden_von: e.entschiedenVon, am: e.am || null },
  };
}

/** Kennung oder Kennzeichen in der Adresse (`…/feststellungen/F-2029-0001`) — die Maßnahmen-Seite springt mit dem Kennzeichen. */
export const istKennzeichen = (x: string) => /^(?:AU|F)-\d{4}-\d{4,9}$/.test(x);

// ------------------------------------------------------------------ Ablehnungen der Routen (IP-18, IP-19)

export const ABLEHNUNG: Record<string, string> = {
  audit_nicht_durchgefuehrt: 'Das geht erst, wenn das Audit als durchgeführt gemeldet ist.',
  audit_nicht_geplant: 'Das Audit ist nicht mehr geplant.',
  audit_unbekannt: `Dieses ${UEMS_INTERNES_AUDIT} gibt es nicht oder Sie dürfen es nicht sehen.`,
  auditor_fehlt: 'Bitte wählen Sie, wer prüft.',
  unabhaengigkeit_fehlt: 'Bitte beschreiben Sie, warum die Person unabhängig prüft.',
  bericht_oder_zusammenfassung: 'Bitte halten Sie den Bericht als Verweis fest oder fassen Sie das Ergebnis zusammen.',
  bericht_ungueltig: 'Bitte nennen Sie, wo der Bericht bei Ihnen liegt.',
  hinweis_unbekannt: 'Diesen Hinweis gibt es an diesem Audit nicht.',
  massnahme_unbekannt: 'Diese Maßnahme stammt nicht aus diesem Audit.',
  feststellung_abgeschlossen: 'Diese Feststellung ist abgeschlossen. Was jetzt nicht erfüllt ist, halten Sie als neue Feststellung fest.',
  wirksamkeit_beantragt: 'Für diese Feststellung ist schon ein Stand beantragt — zuerst entscheidet die zweite Person.',
  wirksamkeit_noch_nicht: satzText('wirksamkeit_noch_nicht', {}),
  vieraugen_beantragen: 'Bei Ihnen gilt Vier-Augen: der Stand wird beantragt, und eine zweite Person bestätigt ihn.',
  vieraugen_urheber: 'Diesen Stand haben Sie beantragt — bestätigen muss eine zweite Person.',
  vieraugen_verantwortlich: 'Wer für die Feststellung verantwortlich ist, bestätigt nicht die eigene Wirksamkeit.',
  vieraugen_rolle: 'Bestätigen kann nur, wer Kundenadministrator oder Energiemanager ist.',
  kein_antrag: 'Es gibt keinen offenen Antrag.',
  vorgabe_fehlt: 'Bitte nennen Sie die Vorgabe — ein Dokument mit Fassung oder im Wortlaut.',
  vorgabe_unbekannt: 'Diese Dokument-Fassung gibt es nicht.',
  festgestellt_von_fehlt: 'Bitte wählen Sie, wer festgestellt hat.',
  verantwortlich_fehlt: 'Bitte wählen Sie, wer verantwortlich ist.',
  angabe_fehlt: 'Bitte füllen Sie alle Pflichtangaben aus.',
  person_unbekannt: 'Diese Person gibt es im Energiemanagement nicht.',
  tag_in_zukunft: 'Der Tag liegt in der Zukunft.',
  tag_vor_durchfuehrung: 'Der Tag liegt vor der Durchführung des Audits.',
  tag_vor_feststellung: 'Der Tag liegt vor dem Tag der Feststellung.',
  frist_ungueltig: 'Die Frist liegt nicht vor dem Tag der Feststellung.',
  begruendung_fehlt: 'Bitte begründen Sie in 10 bis 500 Zeichen.',
  ergebnis_ungueltig: 'Bitte wählen Sie das Ergebnis.',
  quelle_unbekannt: 'Diese Quelle gibt es noch nicht.',
};
