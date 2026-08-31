/**
 * Der STEUERART-DIALOG — die reine Hälfte (Verbrauchsmanagement v1, Paket P2;
 * Konzept `vp-verbrauchsmgmt-konzept-v1` §3.1/§3.2/§6.2, Mockup-Frames
 * „Steuerart-Dialog Schritt 1+2 / 3+4").
 *
 * Rein: keine Netzaufrufe, kein React, keine Uhr — das
 * `verbraucherZone`/`steuerungJetzt`-Muster. Sie macht aus den SERVER-Optionen
 * Karten, Folgefragen, den Folgen-Satz und den Rumpf des `PUT`; die Fläche
 * rendert nur.
 *
 * **⚠ SIE ERFINDET KEINE WAHL UND KEINE VORGABE.** Welche Quellen und Ziele es
 * gibt, ob eine gesperrt ist und warum, und mit welchem Wert eine Folgefrage
 * startet, sagt der SERVER (`SteuerartSatz` → `optionen`/`vorgaben`); hier
 * entstehen nur die Wörter. Eine Quelle, die dieser Portal-Stand nicht kennt,
 * wird schlicht nicht gerendert statt geraten — und ein Feld ohne belegte
 * Vorgabe startet LEER, nie mit einer erfundenen Zahl.
 *
 * **⚠ Die vier Schritte sind Quelle → Folgefragen → Ziel → Folgen** (§6.2). Ein
 * Typ ohne Ziel (Schaltlast, SG-Ready-Wärmepumpe) hat DREI — der Schritt wird
 * ausgelassen, nicht leer angezeigt.
 */
import { FLEX_FALLBACK_NOTE } from './consumers/policy';
import type {
  Steuerart, SteuerartFenster, VerbraucherEintrag,
} from './verbraucherZone';

/**
 * Der Satz zum lokalen Frist-Notnagel — WÖRTLICH der des Regel-Baukastens
 * (`consumers/policy.ts`). Dieselbe Zusage darf nicht an zwei Orten anders
 * klingen; deshalb wird er importiert und nur weitergereicht.
 */
export { FLEX_FALLBACK_NOTE };

// ---------------------------------------------------------------------------
// Der Vertrag (was der Server je Zeile mitschickt)
// ---------------------------------------------------------------------------

export interface SteuerartWahl {
  id: string;
  gesperrt: boolean;
  grund?: string | null;
}

export interface SteuerartVorgaben {
  schwelleKw?: number | null;
  preisgrenzeCtKwh?: number | null;
  mindestlaufzeitMinuten?: number | null;
  sperrzeitMinuten?: number | null;
  fenster?: SteuerartFenster | null;
  zielUhrzeit?: string | null;
  zielTage?: string | null;
  zielEnergieKwh?: number | null;
  zielLaufzeitMinuten?: number | null;
  zielFensterStunden?: number | null;
}

export interface SteuerartOptionen {
  schreibbar: boolean;
  nichtSchreibbarGrund?: string | null;
  quellen: SteuerartWahl[];
  ziele: SteuerartWahl[];
  vorgaben: SteuerartVorgaben;
}

/** Der Rumpf des `PUT` — die Spiegelform der gelesenen Steuerart. */
export interface SteuerartWunsch {
  quelle: string;
  schwelleKw?: number | null;
  preisgrenzeCtKwh?: number | null;
  mindestlaufzeitMinuten?: number | null;
  sperrzeitMinuten?: number | null;
  /**
   * ⚠ NUR am Ladepunkt (P5): was bei zu wenig Überschuss geschehen soll —
   * `pausieren` (die Vorgabe: „Nur Sonnenstrom") oder `mindestleistung`
   * („Sonne zuerst", mit `mindestleistungKw` als Boden). Sie beschreibt die
   * QUELLEN-BAHN der Box (`charge_points[].source`), nicht ein Policy-Dokument
   * — deshalb konnte P2 sie noch nicht anbieten: die Policy-Sprache kann ein
   * „entweder/oder" nicht ausdrücken, ohne mehrdeutig zu werden.
   */
  ueberschussModus?: string | null;
  mindestleistungKw?: number | null;
  fenster?: SteuerartFenster | null;
  ziel?: string | null;
  zielFenster?: SteuerartFenster | null;
  zielEnergieKwh?: number | null;
  zielLaufzeitMinuten?: number | null;
  zielAmStueck?: boolean | null;
}

/** Die Antwort des `PUT`. */
export interface SteuerartErgebnis {
  steuerart: Steuerart;
  aktiv: boolean;
  grund?: string | null;
  nachricht?: string | null;
  verteilt?: boolean;
  policyVersion?: number | null;
}

// ---------------------------------------------------------------------------
// Die Wörter
// ---------------------------------------------------------------------------

export const DIALOG_TITEL = 'Steuerart';
export const SCHRITT_QUELLE = 'Quelle';
export const SCHRITT_DETAILS = 'Einstellungen';
export const SCHRITT_ZIEL = 'Ziel';
export const SCHRITT_FOLGEN = 'Das passiert jetzt';

export const FRAGE_QUELLE_LADEN = 'Womit soll geladen werden?';
export const FRAGE_QUELLE_LAUFEN = 'Womit soll dieses Gerät laufen?';
export const FRAGE_ZIEL_LADEN = 'Soll etwas bis zu einer Uhrzeit fertig sein?';
export const FRAGE_ZIEL_LAUFEN = 'Muss es bis zu einer Uhrzeit gelaufen sein?';

export const SPEICHERN = 'Speichern';
export const WEITER = 'Weiter';
export const ZURUECK = 'Zurück';

/** Die Karte „kein Ziel" — sie steht immer vorn und ist nie gesperrt. */
export const KEIN_ZIEL = {
  id: '',
  titel: 'Kein Ziel',
  zeileLaden: 'Es lädt, wann die Quelle es hergibt.',
  zeileLaufen: 'Es läuft, wann die Quelle es hergibt.',
};

/**
 * Die Quellen-Karten in Kundendeutsch.
 *
 * **⚠ `sofort` heißt an einem LADEPUNKT etwas anderes als an einem Heizstab.**
 * Am Ladepunkt ist es die Wahl „lade, sobald ein Auto steckt"; überall sonst
 * ist es die RÜCKNAHME — „VoltPilot steuert dieses Gerät nicht", der Zustand,
 * in dem jede Komponente beginnt. Dieselbe Id, zwei ehrliche Sätze; ein Wort
 * für beides wäre an einer der zwei Stellen falsch.
 */
/**
 * ⚠ Die zwei Textquellen teilen sich DIESEN Typ, damit `SOFORT_OHNE_LADEPUNKT`
 * und ein Katalog-Eintrag eine HOMOGENE Union bilden. Ohne ihn engt
 * `'zeileLaufen' in t` den zielpunktlosen Zweig auf `{} & Record<…, unknown>`
 * ein und `t.zeileLaufen` ist nicht mehr `string` (TS2322).
 */
type QuelleText = { titel: string; zeile: string; zeileLaufen?: string };

const QUELLE_TEXT: Record<string, QuelleText> = {
  sofort: {
    titel: 'Sofort laden',
    zeile: 'Volle Leistung, sobald ein Auto steckt. Netzstrom erlaubt.',
  },
  ueberschuss: {
    titel: 'Solar-Überschuss',
    // ⚠ Ein Heizstab LÄDT nichts. Dieselbe Quelle, zwei Sätze - die
    // Ladepunkt-Sprache der Mockups gilt nur am Ladepunkt.
    zeile: 'Lädt mit dem Strom, den Ihre PV übrig hat.',
    zeileLaufen: 'Läuft mit dem Strom, den Ihre PV übrig hat.',
  },
  guenstig: {
    titel: 'Günstige Stunden',
    zeile: 'Lädt in den billigsten Stunden Ihres Tarifs.',
    zeileLaufen: 'Läuft in den billigsten Stunden Ihres Tarifs.',
  },
  feste_zeiten: {
    titel: 'Feste Zeiten',
    zeile: 'Läuft in einem Zeitfenster, das Sie festlegen. Netzstrom erlaubt.',
  },
  freigabe_ueberschuss: {
    titel: 'Freigabe bei Überschuss',
    zeile: 'VoltPilot gibt die Wärmepumpe frei, wenn die Sonne übrig hat. '
      + 'Anlaufen entscheidet sie selbst.',
  },
  freigabe_guenstig: {
    titel: 'Freigabe bei günstigem Strom',
    zeile: 'VoltPilot gibt die Wärmepumpe in den billigen Stunden frei. '
      + 'Anlaufen entscheidet sie selbst.',
  },
};

/** Was `sofort` an allem sagt, was kein Ladepunkt ist (die Rücknahme). */
const SOFORT_OHNE_LADEPUNKT: QuelleText = {
  titel: 'Ohne Steuerung durch VoltPilot',
  zeile: 'Das Gerät läuft, wie es selbst eingestellt ist. VoltPilot schaltet es nicht.',
};

const ZIEL_TEXT: Record<string, { titel: string; zeileLaden: string; zeileLaufen: string }> = {
  bis_uhrzeit: {
    titel: 'Bis Uhrzeit fertig',
    zeileLaden: 'Reicht die Quelle nicht, lädt VoltPilot rechtzeitig nach — auch aus dem Netz.',
    zeileLaufen: 'Reicht die Quelle nicht, schaltet VoltPilot rechtzeitig ein — auch mit Netzstrom.',
  },
  laufzeit_bis: {
    titel: 'Laufzeit bis Uhrzeit',
    zeileLaden: 'Es muss bis dahin eine Mindestzeit geladen haben.',
    zeileLaufen: 'Es muss bis dahin eine Mindestzeit gelaufen sein.',
  },
};

export interface KartenView {
  id: string;
  titel: string;
  zeile: string;
  gesperrt: boolean;
  /** Der Grund steht IMMER an einer gesperrten Karte (§3.1). */
  grund: string | null;
}

/** Die Quellen-Karten einer Zeile; unbekannte Ids fallen weg statt geraten. */
export function quellenKarten(o: SteuerartOptionen | null | undefined,
  ladepunkt: boolean): KartenView[] {
  const out: KartenView[] = [];
  for (const q of o?.quellen ?? []) {
    const t = q.id === 'sofort' && !ladepunkt ? SOFORT_OHNE_LADEPUNKT : QUELLE_TEXT[q.id];
    if (!t) continue;
    const zeile = !ladepunkt && t.zeileLaufen ? t.zeileLaufen : t.zeile;
    out.push({
      id: q.id, titel: t.titel, zeile,
      gesperrt: q.gesperrt === true,
      grund: (q.grund ?? '').trim() || null,
    });
  }
  return out;
}

/** Die Ziel-Karten; „Kein Ziel" steht immer vorn. */
export function zielKarten(o: SteuerartOptionen | null | undefined,
  ladepunkt: boolean): KartenView[] {
  const echte: KartenView[] = [];
  for (const z of o?.ziele ?? []) {
    const t = ZIEL_TEXT[z.id];
    if (!t) continue;
    echte.push({
      id: z.id, titel: t.titel, zeile: ladepunkt ? t.zeileLaden : t.zeileLaufen,
      gesperrt: z.gesperrt === true,
      grund: (z.grund ?? '').trim() || null,
    });
  }
  if (echte.length === 0) return [];
  return [{
    id: KEIN_ZIEL.id, titel: KEIN_ZIEL.titel,
    zeile: ladepunkt ? KEIN_ZIEL.zeileLaden : KEIN_ZIEL.zeileLaufen,
    gesperrt: false, grund: null,
  }, ...echte];
}

// ---------------------------------------------------------------------------
// Der Entwurf (was der Kunde gerade gewählt hat)
// ---------------------------------------------------------------------------

export interface SteuerartEntwurf {
  quelle: string;
  schwelleKw: number | null;
  preisgrenzeCtKwh: number | null;
  mindestlaufzeitMinuten: number | null;
  sperrzeitMinuten: number | null;
  /** §3.2 am Ladepunkt: `pausieren` | `mindestleistung`. */
  ueberschussModus: string;
  mindestleistungKw: number | null;
  fensterTage: string;
  fensterVon: string;
  fensterBis: string;
  ziel: string;
  zielUhrzeit: string;
  zielTage: string;
  zielEnergieKwh: number | null;
  zielLaufzeitMinuten: number | null;
  zielAmStueck: boolean;
}

/**
 * Der Entwurf, mit dem der Dialog aufmacht: die HEUTE geltende Steuerart, wo
 * es eine gibt, sonst die Vorgaben des Servers.
 *
 * **⚠ Eine Zeile mit „Eigene Regel" startet OHNE Quelle** — ihre Policy lässt
 * sich nicht auf eine der Steuerarten abbilden, und eine zu behaupten hieße,
 * beim Speichern etwas zu überschreiben, was der Kunde nie gewählt hat.
 */
export function entwurfAus(e: VerbraucherEintrag | null | undefined): SteuerartEntwurf {
  const s = e?.steuerart;
  const v = e?.optionen?.vorgaben ?? {};
  const eigene = !s || s.quelle === 'eigene_regel';
  return {
    quelle: eigene ? '' : s.quelle,
    schwelleKw: zahl(s?.schwelleKw) ?? zahl(v.schwelleKw),
    preisgrenzeCtKwh: zahl(s?.preisgrenzeCtKwh) ?? zahl(v.preisgrenzeCtKwh),
    mindestlaufzeitMinuten: zahl(v.mindestlaufzeitMinuten),
    sperrzeitMinuten: zahl(v.sperrzeitMinuten),
    // ⚠ Ohne gespeicherte Angabe ist die Vorgabe `pausieren` — das ist die
    // ehrliche Lesart von „Nur Sonnenstrom"; `mindestleistung` wäre eine
    // Netzstrom-Freigabe, die niemand erteilt hat.
    ueberschussModus: (s?.ueberschussModus as string) || 'pausieren',
    mindestleistungKw: zahl(s?.mindestleistungKw),
    fensterTage: s?.fenster?.tage || v.fenster?.tage || 'daily',
    fensterVon: s?.fenster?.von || v.fenster?.von || '',
    fensterBis: s?.fenster?.bis || v.fenster?.bis || '',
    ziel: eigene ? '' : (s?.ziel ?? ''),
    zielUhrzeit: s?.zielFenster?.bis || v.zielUhrzeit || '',
    zielTage: s?.zielFenster?.tage || v.zielTage || 'daily',
    zielEnergieKwh: zahl(s?.zielEnergieKwh) ?? zahl(v.zielEnergieKwh),
    zielLaufzeitMinuten: zahl(s?.zielLaufzeitMinuten) ?? zahl(v.zielLaufzeitMinuten),
    zielAmStueck: s?.zielAmStueck === true,
  };
}

/**
 * Den Entwurf mit dem Wunsch eines VORSCHLAGS belegen (§6.1).
 *
 * **⚠ Nur die Felder, die der Wunsch WIRKLICH trägt.** Ein Vorschlag nennt
 * seine Quelle und ihre eine Zahl; alles Übrige bleibt beim Bestand bzw. bei
 * der Server-Vorgabe. Ein pauschales Überschreiben löschte die Antworten, die
 * der Kunde schon einmal gegeben hat.
 */
export function mitVorbelegung(e: SteuerartEntwurf,
  w: SteuerartWunsch | null | undefined): SteuerartEntwurf {
  if (!w?.quelle) return e;
  const out: SteuerartEntwurf = { ...e, quelle: w.quelle };
  if (w.schwelleKw != null) out.schwelleKw = w.schwelleKw;
  if (w.preisgrenzeCtKwh != null) out.preisgrenzeCtKwh = w.preisgrenzeCtKwh;
  if (w.mindestlaufzeitMinuten != null) out.mindestlaufzeitMinuten = w.mindestlaufzeitMinuten;
  if (w.fenster) {
    out.fensterTage = w.fenster.tage || out.fensterTage;
    out.fensterVon = w.fenster.von || out.fensterVon;
    out.fensterBis = w.fenster.bis || out.fensterBis;
  }
  // Ein Vorschlag schlägt heute nie ein Ziel vor - träfe er eines, gälte
  // dieselbe Regel: nur nennen, was er wirklich sagt.
  if (w.ziel != null) out.ziel = w.ziel;
  return out;
}

/**
 * Welche Folgefragen diese Quelle stellt (§3.2). Der Dialog überspringt den
 * zweiten Schritt, wenn hier nichts steht — eine leere Seite ist keine Frage.
 */
export type FrageId =
  | 'schwelle' | 'preisgrenze' | 'mindestlaufzeit' | 'sperrzeit' | 'fenster'
  | 'ueberschussModus';

/**
 * ⚠ `ladepunkt` ist OPTIONAL und per Vorgabe `false`: jeder bestehende Aufrufer
 * bekommt Zeichen für Zeichen dieselbe Liste wie vor P5. Die Modus-Frage gibt
 * es NUR am Ladepunkt, weil nur dort eine Quellen-BAHN existiert, die zwischen
 * „pausieren" und „Mindestleistung halten" unterscheiden kann.
 */
export function fragen(quelle: string, ladepunkt = false): FrageId[] {
  switch (quelle) {
    case 'ueberschuss':
      return ladepunkt
        ? ['schwelle', 'ueberschussModus', 'mindestlaufzeit']
        : ['schwelle', 'mindestlaufzeit'];
    case 'freigabe_ueberschuss': return ['schwelle', 'mindestlaufzeit', 'sperrzeit'];
    case 'guenstig': return ['preisgrenze'];
    case 'freigabe_guenstig': return ['preisgrenze', 'mindestlaufzeit', 'sperrzeit'];
    case 'feste_zeiten': return ['fenster'];
    default: return [];
  }
}

/** Die Beschriftungen der Folgefragen (§3.2), je mit ihrer Einheit. */
export const FRAGE_TEXT: Record<FrageId, { label: string; einheit?: string; hinweis?: string }> = {
  schwelle: {
    label: 'Ab wie viel Überschuss einschalten?',
    einheit: 'kW',
    hinweis: 'Darunter bleibt das Gerät aus.',
  },
  ueberschussModus: {
    label: 'Was, wenn zu wenig Überschuss da ist?',
    hinweis: 'Pausieren heißt: es wird kein Netzstrom gekauft.',
  },
  preisgrenze: {
    label: 'Bis zu welchem Preis?',
    einheit: 'ct/kWh',
    hinweis: 'VoltPilot schaltet ein, solange Ihr Bezugspreis darunter liegt.',
  },
  mindestlaufzeit: {
    label: 'Mindestlaufzeit',
    einheit: 'Min.',
    hinweis: 'Einmal eingeschaltet, läuft es mindestens so lange — das schont das Gerät.',
  },
  sperrzeit: {
    label: 'Sperrzeit danach',
    einheit: 'Min.',
    hinweis: 'So lange bleibt die Freigabe danach aus.',
  },
  fenster: { label: 'Zu welchen Zeiten?' },
};

/** Die Ziel-Fragen (§3.2). */
export const ZIEL_FRAGE = {
  uhrzeit: 'Fertig bis',
  tage: 'An welchen Tagen',
  energie: 'Mindestens',
  laufzeit: 'Laufzeit',
  amStueck: 'Am Stück',
};

/** Die Tages-Wörter des Vertrags in Kundendeutsch. */
export const TAGE_WORT: Record<string, string> = {
  daily: 'täglich',
  weekdays: 'werktags',
  weekend: 'am Wochenende',
};

// ---------------------------------------------------------------------------
// Der Rumpf des PUT
// ---------------------------------------------------------------------------

/**
 * Der Wunsch aus dem Entwurf — nur die Felder, die diese Quelle wirklich hat.
 *
 * **⚠ Was die Quelle nicht fragt, wird auch nicht geschickt.** Eine
 * mitgeschickte Preisgrenze an einer Überschuss-Quelle wäre ein verborgener
 * Wert, den der Kunde nie zu sehen bekommt; der Server würde ihn ignorieren,
 * aber die Antwort läse sich, als hätte er ihn gespeichert.
 */
export function wunschAus(e: SteuerartEntwurf, ladepunkt = false): SteuerartWunsch {
  const w: SteuerartWunsch = { quelle: e.quelle };
  const f = fragen(e.quelle, ladepunkt);
  if (f.includes('ueberschussModus')) {
    w.ueberschussModus = e.ueberschussModus || 'pausieren';
    // ⚠ Der Boden reist NUR mit, wenn er auch gemeint ist - bei `pausieren`
    // wäre er eine Zahl ohne Wirkung, die der Server als Bahn `sonne_zuerst`
    // missverstehen könnte.
    if (e.ueberschussModus === 'mindestleistung' && e.mindestleistungKw != null) {
      w.mindestleistungKw = e.mindestleistungKw;
    }
  }
  if (f.includes('schwelle') && e.schwelleKw != null) w.schwelleKw = e.schwelleKw;
  if (f.includes('preisgrenze') && e.preisgrenzeCtKwh != null) {
    w.preisgrenzeCtKwh = e.preisgrenzeCtKwh;
  }
  if (f.includes('mindestlaufzeit') && e.mindestlaufzeitMinuten != null) {
    w.mindestlaufzeitMinuten = e.mindestlaufzeitMinuten;
  }
  if (f.includes('sperrzeit') && e.sperrzeitMinuten != null) {
    w.sperrzeitMinuten = e.sperrzeitMinuten;
  }
  if (f.includes('fenster')) {
    w.fenster = { tage: e.fensterTage, von: e.fensterVon, bis: e.fensterBis };
  }
  if (e.ziel) {
    w.ziel = e.ziel;
    w.zielFenster = { tage: e.zielTage, von: '', bis: e.zielUhrzeit };
    if (e.ziel === 'bis_uhrzeit' && e.zielEnergieKwh != null) {
      w.zielEnergieKwh = e.zielEnergieKwh;
    }
    if (e.ziel === 'laufzeit_bis') {
      if (e.zielLaufzeitMinuten != null) w.zielLaufzeitMinuten = e.zielLaufzeitMinuten;
      w.zielAmStueck = e.zielAmStueck;
    }
  }
  return w;
}

/**
 * Was den „Weiter"/„Speichern"-Knopf sperrt — der SPIEGEL der Server-Regeln,
 * damit der Kunde den Klick spart. Der Server prüft dasselbe ein zweites Mal;
 * fällt hier eine Regel weg, lehnt er trotzdem ab.
 */
export function fehlt(e: SteuerartEntwurf, o: SteuerartOptionen | null | undefined): string | null {
  if (!e.quelle) return 'Bitte wählen Sie, womit dieses Gerät laufen soll.';
  const wahl = (o?.quellen ?? []).find((q) => q.id === e.quelle);
  if (wahl?.gesperrt) return (wahl.grund ?? '').trim() || 'Diese Wahl ist hier nicht möglich.';
  const f = fragen(e.quelle);
  if (f.includes('schwelle') && !(e.schwelleKw != null && e.schwelleKw > 0)) {
    return 'Bitte geben Sie die Überschuss-Schwelle an.';
  }
  if (f.includes('preisgrenze') && e.preisgrenzeCtKwh == null) {
    return 'Bitte geben Sie Ihre Preisgrenze an.';
  }
  if (f.includes('fenster')) {
    if (!istUhrzeit(e.fensterVon) || !istUhrzeit(e.fensterBis)) {
      return 'Bitte geben Sie Anfang und Ende des Zeitfensters an.';
    }
    if (e.fensterVon === e.fensterBis) return 'Anfang und Ende dürfen nicht gleich sein.';
  }
  if (e.ziel) {
    if (!istUhrzeit(e.zielUhrzeit)) return 'Bitte geben Sie die Uhrzeit der Frist an.';
    if (e.ziel === 'bis_uhrzeit' && !(e.zielEnergieKwh != null && e.zielEnergieKwh > 0)) {
      return 'Bitte geben Sie an, wie viel bis dahin geflossen sein muss.';
    }
    if (e.ziel === 'laufzeit_bis'
      && !(e.zielLaufzeitMinuten != null && e.zielLaufzeitMinuten > 0)) {
      return 'Bitte geben Sie die Laufzeit an.';
    }
  }
  return null;
}

function istUhrzeit(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) || t === '24:00';
}

function zahl(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Die Folgen-Karte (Mockup „Schritt 4 · Das passiert jetzt")
// ---------------------------------------------------------------------------

export interface FolgenKontext {
  /** Der Anzeigename der Komponente. */
  name: string;
  ladepunkt: boolean;
  /** Wie viele AKTIVE Wenn/Dann-Regeln diese Komponente beanspruchen. */
  regeln: number;
  /** Der Anlagen-Standard der Ladepunkte, wenn es einen gibt. */
  standard?: Steuerart | null;
  /** Die Länge des Ziel-Fensters, die der Server setzt (§3.2). */
  zielFensterStunden?: number | null;
}

/**
 * Die Folgen-Karte: was diese Kombination TUT, in Sätzen, die jeder für sich
 * belegt sind.
 *
 * **⚠ Jeder Satz hängt an einer Tatsache dieses Entwurfs.** Es steht nichts
 * da, was der Entwurf nicht sagt — kein „Netzstrom erlaubt" an einer reinen
 * Überschuss-Quelle (dort läuft das Gerät nur mit gemessener Sonne), kein
 * Box-Notnagel ohne Frist, und kein „weicht vom Standard ab", wo es gar keinen
 * Standard gibt. Die Warnung über eine Regel („eine Regel geht vor") steht
 * dagegen IMMER, sobald es eine gibt: sie ist der Grund, warum die Steuerart
 * manchmal nicht sichtbar wirkt.
 */
export function folgen(e: SteuerartEntwurf, k: FolgenKontext): string[] {
  const out: string[] = [];
  const tut = k.ladepunkt ? 'lädt' : 'läuft';
  const name = `„${k.name}"`;
  switch (e.quelle) {
    case 'sofort':
      out.push(k.ladepunkt
        ? `${name} lädt mit voller Leistung, sobald ein Auto steckt — Netzstrom erlaubt.`
        : `${name} läuft, wie es selbst eingestellt ist. VoltPilot schaltet es nicht.`);
      break;
    case 'ueberschuss':
      out.push(`${name} ${tut}, sobald Ihre PV mehr als ${kw(e.schwelleKw)} übrig hat.`);
      break;
    case 'guenstig':
      out.push(`${name} ${tut}, solange Ihr Bezugspreis unter ${ct(e.preisgrenzeCtKwh)} liegt.`);
      break;
    case 'feste_zeiten':
      out.push(`${name} ${tut} ${TAGE_WORT[e.fensterTage] ?? ''} von ${e.fensterVon} bis `
        + `${e.fensterBis} Uhr — Netzstrom erlaubt.`);
      break;
    case 'freigabe_ueberschuss':
      out.push(`VoltPilot gibt ${name} frei, sobald Ihre PV mehr als ${kw(e.schwelleKw)} übrig `
        + 'hat. Ob die Wärmepumpe dann anläuft, entscheidet sie selbst.');
      break;
    case 'freigabe_guenstig':
      out.push(`VoltPilot gibt ${name} frei, solange Ihr Bezugspreis unter `
        + `${ct(e.preisgrenzeCtKwh)} liegt. Ob die Wärmepumpe dann anläuft, entscheidet sie `
        + 'selbst.');
      break;
    default:
      break;
  }
  if (e.quelle === 'ueberschuss' && e.mindestlaufzeitMinuten != null
    && e.mindestlaufzeitMinuten > 0) {
    out.push(`Einmal eingeschaltet, läuft es mindestens ${e.mindestlaufzeitMinuten} Minuten.`);
  }
  if (e.ziel === 'bis_uhrzeit') {
    out.push(`Fehlt bis ${e.zielUhrzeit} Uhr noch etwas an ${kwh(e.zielEnergieKwh)}, plant `
      + 'VoltPilot die günstigsten Stunden davor — Netzstrom erlaubt.');
  }
  if (e.ziel === 'laufzeit_bis') {
    out.push(`Ist es bis ${e.zielUhrzeit} Uhr noch nicht `
      + `${e.zielLaufzeitMinuten ?? 0} Minuten gelaufen, schaltet VoltPilot rechtzeitig ein — `
      + 'Netzstrom erlaubt.');
  }
  if (e.ziel && k.zielFensterStunden) {
    out.push(`VoltPilot arbeitet dafür zwischen ${minusStunden(e.zielUhrzeit,
      k.zielFensterStunden)} und ${e.zielUhrzeit} Uhr.`);
  }
  if (e.ziel) out.push(FLEX_FALLBACK_NOTE);
  if (k.regeln > 0) {
    out.push(k.regeln === 1
      ? 'Ihre Regel geht weiterhin vor, solange sie greift.'
      : `Ihre ${k.regeln} Regeln gehen weiterhin vor, solange sie greifen.`);
  }
  const abweichung = standardAbweichung(e, k);
  if (abweichung) out.push(abweichung);
  return out;
}

/**
 * Weicht diese Wahl vom Anlagen-Standard ab? Nur an einem Ladepunkt, nur mit
 * bekanntem Standard — und der Satz sagt, was das für die anderen bedeutet.
 */
export function standardAbweichung(e: SteuerartEntwurf, k: FolgenKontext): string | null {
  if (!k.ladepunkt || !k.standard) return null;
  const gleich = k.standard.quelle === e.quelle
    && (k.standard.ziel ?? '') === (e.ziel ?? '');
  return gleich ? null
    : `Dieser Ladepunkt weicht damit vom Anlagen-Standard ab — die anderen bleiben, wie sie sind.`;
}

/** „18:00" aus „06:00" minus 12 h — der Zwilling der Server-Regel. */
export function minusStunden(hhmm: string, stunden: number): string {
  if (!istUhrzeit(hhmm)) return hhmm;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3));
  let total = (h * 60 + m - stunden * 60) % (24 * 60);
  if (total < 0) total += 24 * 60;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function kw(v: number | null): string {
  return v == null ? 'dem eingestellten Wert' : `${fmt(v)} kW`;
}

function ct(v: number | null): string {
  return v == null ? 'Ihrer Preisgrenze' : `${fmt(v)} ct/kWh`;
}

function kwh(v: number | null): string {
  return v == null ? 'Ihrer Zielmenge' : `${fmt(v)} kWh`;
}

function fmt(v: number): string {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(v);
}
