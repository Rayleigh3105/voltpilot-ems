/**
 * UEMS AP-15 IP-24 — die reine Schicht des Betreiber-Blatts „Gemeinsame Steuerung“ (Konzept §5.3/§5.4, I1, I4, T5,
 * R12, R19). NUR für die Plattform-Rolle: sie spricht Betreiber-Vokabular (Messpunkt, `plan_id`, Revision, Epoche,
 * Stufe) und steht deshalb in `copy.test.ts` unter den Admin-Schichten — gerendert nur hinter `showTechnicalLayer()`.
 *
 * Grundsatz: unbekannt ist nie eine Null und nie grün. Was die Box nicht meldet (alte Box ohne Herzschlag-Block),
 * heißt „nicht gemeldet“; der Zielstand wird erst behauptet, wenn die api ihn meldet.
 */
import type {
  UemsBetreiberblatt,
  UemsBoxStand,
  UemsFaehigkeitHerkunft,
  UemsGemeinsameSteuerungBefund,
  UemsGemeinsameSteuerungEinrichten,
  UemsGemeinsameSteuerungZustand,
  UemsRevision,
  UemsSprungMessung,
  UemsSprungprobe,
  UemsVerlustTag,
} from './api';
import { pufferSatz } from './gemeinsameSteuerungFlaeche';
import { flaechenSatz } from './uemsGemeinsameSteuerung';
import { zahl as deutscheZahl } from './zahl';

export const NICHT_GEMELDET = 'nicht gemeldet';

export type BoxNamen = ReadonlyMap<string, string>;
const name = (namen: BoxNamen, id: string | null | undefined) => (id && namen.get(id)) || 'ohne Namen';

export function zahl(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

// ───────────────────────────────────────────────────────────── Kopf

export const STUFEN: Record<UemsGemeinsameSteuerungZustand['zustand'], string> = {
  nicht_eingerichtet: 'nicht eingerichtet',
  erklaert: 'S0 · erklärt',
  beobachtet: 'S1 · beobachtet',
  geprueft: 'S2 · geprüft',
  anteile_aktiv: 'S3 · Anteile aktiv',
  angehalten: 'angehalten',
  aufgeloest: 'aufgelöst',
  wird_aufgeloest: 'wird aufgelöst',
};

export function kopfZeile(z: UemsGemeinsameSteuerungZustand | null): string {
  if (!z) return 'Zustand nicht lesbar';
  if (z.aufloesen) return flaechenSatz('wird_aufgeloest', {
    bestaetigt: String(z.aufloesen.bestaetigt), gesamt: String(z.aufloesen.gesamt),
  });
  const epoche = z.epoche == null ? 'Epoche —' : `Epoche ${z.epoche}`;
  const wer = z.zustand === 'angehalten'
    ? z.naechster_schritt === 'vom_betreiber_angehalten' ? ' · vom Betreiber angehalten' : ' · vom Kunden angehalten'
    : '';
  return `${STUFEN[z.zustand]}${wer} · ${epoche}`;
}

/**
 * Jedes Wort aus `fehlt` und jede Ablehnung der Handgriffe (409) als Betreiber-Satz. `nachweis_fehlt` steht hier —
 * der Kunde sieht es nicht (seine Fläche lässt es aus, IP-23).
 */
export const WOERTER: Record<string, string> = {
  box_nicht_in_anlage: 'Box {box} ist nicht in dieser Anlage angemeldet.',
  kein_netzanschluss: 'Kein Netzanschluss an die Anlage gebunden.',
  grenze_fehlt: 'Grenze am Netzanschluss fehlt ({richtung}).',
  faehigkeit_fehlt: 'Box {box} meldet die Fähigkeit steuerungsverbund_anteil nicht (Edge-Update nötig).',
  nachweis_fehlt: 'Sprungprobe fehlt an Box {box} (T5) — ohne bestandene Probe kein Scharfschalten.',
  auslegung_passt_nicht: 'Auslegung passt nicht ({richtung}).',
  fuehrende_box_misst_nicht: 'Die führende Box {box} liest den Netzzähler nicht.',
  mitsteuernde_box_misst_nicht: 'Box {box} hat keinen eigenen Messpunkt am Abgang.',
  vorgabe_signal_nicht_an_jeder_box: 'Signal des Netzbetreibers liegt an Box {box} nicht an (G6).',
  // Übergänge und Sprungprobe (409)
  nicht_eingerichtet: 'Die Anlage hat keine Gemeinsame Steuerung.',
  bereits_aktiv: 'Die Anteile sind schon aktiv.',
  nicht_aktiv: 'Die Anteile sind nicht aktiv.',
  nicht_angehalten: 'Die Gemeinsame Steuerung ist nicht angehalten.',
  erst_anhalten: 'Erst anhalten.',
  vom_betreiber_angehalten: 'Vom Betreiber angehalten — nur die Plattform setzt fort.',
  kein_mitglied: 'Die Box ist kein Mitglied.',
  bereits_bestaetigt: 'Das Mitglied ist schon bestätigt.',
  nicht_beobachtet: 'Die Sprungprobe läuft nur in S1 (beobachtet).',
  sprungprobe_nicht_gemeldet: 'Box {box} meldet die Fähigkeit sprungprobe nicht.',
  sprungprobe_laeuft: 'Eine Sprungprobe läuft schon (eine zur Zeit je Anlage).',
  netzpunkt_nicht_frisch: 'Der Netzzähler der führenden Box hat keinen Wert der letzten 60 s.',
  nicht_zugestellt: 'Die Box war nicht erreichbar — nichts gespeichert.',
};

const RICHTUNG: Record<string, string> = { einspeisung: 'Einspeisung', bezug: 'Bezug' };

export function wortSatz(
  wort: string,
  namen: BoxNamen,
  e: { box_id?: string | null; richtung?: string | null } = {},
): string {
  const vorlage = WOERTER[wort];
  if (!vorlage) return wort;
  return vorlage
    .replace('{box}', name(namen, e.box_id))
    .replace('{richtung}', e.richtung ? RICHTUNG[e.richtung] ?? e.richtung : 'beide Richtungen');
}

/** Was zum nächsten Schritt fehlt — alle Wörter aus `fehlt`, mit Box und Richtung. */
export function fehltSaetze(z: UemsGemeinsameSteuerungZustand | null, namen: BoxNamen): string[] {
  const out: string[] = [];
  for (const f of z?.fehlt ?? []) {
    const t = wortSatz(f.wort, namen, f);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// ───────────────────────────────────────────────────────────── I1: was Scharfschalten verlangt

export type Erfuellt = 'erfuellt' | 'offen';

export interface I1Punkt {
  schluessel: string;
  text: string;
  stand: Erfuellt;
  /** Die Wörter aus `fehlt`, die diesen Punkt offen halten — die 409-Wörter an ihrer Stelle. */
  woerter: string[];
}

/**
 * Die I1-Liste VOR dem Klick: je Bedingung erfüllt/offen, entschieden allein aus `fehlt` der api (keine eigene
 * Prüfung, die abweichen könnte), dazu die Wörter einer 409-Antwort. Fähigkeit und Sprungprobe je Box. In S0 nennt die api nur die Struktur — die
 * übrigen Punkte sind dann nicht beurteilt und stehen offen.
 */
export function i1Liste(
  z: UemsGemeinsameSteuerungZustand | null,
  namen: BoxNamen,
  abgelehnt: readonly UemsGemeinsameSteuerungBefund[] = [],
): I1Punkt[] {
  // Eine 409-Antwort (`fehlt` der Ablehnung) zählt mit — ihre Wörter stehen an ihrem Punkt.
  const fehlt = [...(z?.fehlt ?? []), ...abgelehnt.filter((a) => !(z?.fehlt ?? []).some((f) => f.wort === a.wort && f.box_id === a.box_id && f.richtung === a.richtung))];
  const mitglieder = z?.mitglieder ?? [];
  const nurStruktur = z?.zustand === 'erklaert';
  const punkt = (schluessel: string, text: string, pruefe: (f: UemsGemeinsameSteuerungBefund) => boolean, strukturell = false): I1Punkt => {
    const offen = fehlt.filter(pruefe);
    const unbeurteilt = nurStruktur && !strukturell;
    return {
      schluessel,
      text,
      stand: offen.length === 0 && !unbeurteilt ? 'erfuellt' : 'offen',
      woerter: offen.map((f) => wortSatz(f.wort, namen, f)),
    };
  };
  const liste: I1Punkt[] = [
    punkt('netzanschluss', 'Netzanschluss gebunden, beide Grenzen gesetzt',
      (f) => f.wort === 'kein_netzanschluss' || f.wort === 'grenze_fehlt', true),
    punkt('mitglieder', 'Jede Box in dieser Anlage, jede mitsteuernde mit eigenem Messpunkt',
      (f) => f.wort === 'box_nicht_in_anlage' || f.wort === 'mitsteuernde_box_misst_nicht', true),
    punkt('netzzaehler', 'Führende Box liest den Netzzähler', (f) => f.wort === 'fuehrende_box_misst_nicht', true),
  ];
  for (const m of mitglieder) {
    liste.push(punkt(`faehigkeit:${m.box_id}`, `Fähigkeit steuerungsverbund_anteil an Box ${name(namen, m.box_id)}`,
      (f) => f.wort === 'faehigkeit_fehlt' && f.box_id === m.box_id));
  }
  liste.push(punkt('auslegung', 'Auslegung passt', (f) => f.wort === 'auslegung_passt_nicht'));
  for (const m of mitglieder) {
    liste.push(punkt(`sprungprobe:${m.box_id}`, `Sprungprobe bestanden an Box ${name(namen, m.box_id)} (T5)`,
      (f) => f.wort === 'nachweis_fehlt' && f.box_id === m.box_id));
  }
  liste.push(punkt('signal', 'Signal des Netzbetreibers an jeder Box mit § 14a-Verbrauchern (G6)',
    (f) => f.wort === 'vorgabe_signal_nicht_an_jeder_box'));
  // Ein Wort, das keinem Punkt gehört, darf nicht verschwinden.
  const bekannt = new Set(['kein_netzanschluss', 'grenze_fehlt', 'box_nicht_in_anlage', 'mitsteuernde_box_misst_nicht',
    'fuehrende_box_misst_nicht', 'faehigkeit_fehlt', 'auslegung_passt_nicht', 'nachweis_fehlt', 'vorgabe_signal_nicht_an_jeder_box']);
  const rest = fehlt.filter((f) => !bekannt.has(f.wort));
  if (rest.length > 0) liste.push(punkt('weitere', 'Weitere Bedingungen', (f) => !bekannt.has(f.wort)));
  return liste;
}

export function scharfschaltenMoeglich(z: UemsGemeinsameSteuerungZustand | null): boolean {
  return (z?.zustand === 'beobachtet' || z?.zustand === 'geprueft') && (z.fehlt ?? []).length === 0;
}

// ───────────────────────────────────────────────────────────── Zweischritt (R12)

export interface ZweischrittLage {
  art: 'kein_dokument' | 'uebergang' | 'ziel_gesendet' | 'ziel';
  text: string;
  /** Die Box(en), auf deren Quittung gewartet wird. */
  wartetAuf: string[];
}

/**
 * „1 von 2 Boxen hat bestätigt“ mit der Box, auf deren Quittung gewartet wird. Der Zielstand steht erst, wenn die
 * api `schritt = ziel` meldet UND jede Box ihn quittiert hat — vorher nie.
 */
export function zweischrittLage(blatt: UemsBetreiberblatt | null, namen: BoxNamen): ZweischrittLage {
  const d = blatt?.zweischritt;
  if (!d) return { art: 'kein_dokument', text: 'Noch kein Anteils-Dokument gesendet.', wartetAuf: [] };
  const von = d.bestaetigt.length + d.wartet_auf.length;
  const wartet = d.wartet_auf.map((id) => name(namen, id));
  const stand = `Epoche ${d.epoche} · Revision ${d.revision}`;
  const warteText = wartet.length > 0 ? ` · wartet auf ${wartet.map((b) => `Box ${b}`).join(', ')}` : '';
  if (d.schritt === 'uebergang') {
    return {
      art: 'uebergang',
      text: `Änderung wird übernommen — ${d.bestaetigt.length} von ${von} ${von === 1 ? 'Box hat' : 'Boxen hat'} bestätigt${warteText} (Übergangsstand, ${stand}). Der Zielstand folgt erst nach jeder Quittung.`,
      wartetAuf: wartet,
    };
  }
  if (wartet.length > 0) {
    return {
      art: 'ziel_gesendet',
      text: `Zielstand gesendet — ${d.bestaetigt.length} von ${von} Boxen haben ihn quittiert${warteText} (${stand}).`,
      wartetAuf: wartet,
    };
  }
  return { art: 'ziel', text: `Zielstand steht — alle ${von} Boxen haben quittiert (${stand}).`, wartetAuf: [] };
}

// ───────────────────────────────────────────────────────────── Spalten je Box

export function alter(iso: string | null | undefined, jetzt: Date): string {
  if (!iso) return NICHT_GEMELDET;
  const s = Math.max(0, Math.round((jetzt.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `vor ${s} s`;
  if (s < 90 * 60) return `vor ${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86400)} Tagen`;
}

export function faehigkeitText(h: UemsFaehigkeitHerkunft | null | undefined): string {
  if (h === 'gemeldet') return 'gemeldet';
  if (h === 'versions_tabelle') return 'laut Versions-Tabelle';
  return 'fehlt';
}

export function revisionText(r: UemsRevision | null | undefined): string {
  return r ? `E${r.epoche} · R${r.revision}` : NICHT_GEMELDET;
}

/** Die kurze Plan-Kennung (die ersten acht Zeichen); ohne Plan „keiner“. */
export function planText(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : 'keiner';
}

export interface Zelle {
  text: string;
  /** Sichtbar markiert: ungleich, fehlt, veraltet. */
  warnung?: boolean;
  /** Unbekannt — nie grün, nie eine Null. */
  unbekannt?: boolean;
}

export interface BoxSpalte {
  boxId: string;
  name: string;
  rolle: string;
  erreichbar: Zelle;
  faehigkeit: Zelle;
  faehigkeitSprungprobe: Zelle;
  geraete: { text: string; unbekannt: boolean }[];
  messpunkt: Zelle;
  waechter: { einspeisung: Zelle; bezug: Zelle };
  plan: { veroeffentlicht: Zelle; angenommen: Zelle; ungleich: boolean };
  revision: { gesendet: Zelle; quittiert: Zelle; ungleich: boolean };
  /** `reserve`: um so viel senkt die Box das Ladebudget ihres Bezugs-Anteils (andere steuerbare Verbraucher). */
  wirksam: { einspeisung: Zelle; bezug: Zelle; reserve: Zelle };
  /**
   * Erklärtes Ungeregeltes hinter dem Abgang (AP-15 Folge von IP-19): `null` = keins erklärt — die Zeile erscheint
   * nur, wenn eine Box einen Wert über 0 hat.
   */
  ungeregelt: Zelle | null;
  verlustGestern: Zelle;
}

const RUECKFALL: Record<string, string> = { am_geraet: 'am Gerät hinterlegt', katalog: 'laut Katalog', ohne_angabe: 'ohne Angabe' };

function geraeteZeilen(box: string, einrichten: UemsGemeinsameSteuerungEinrichten | null): BoxSpalte['geraete'] {
  const b = einrichten?.boxen.find((x) => x.box_id === box);
  const komponenten = new Map((b?.komponenten ?? []).map((k) => [k.komponente_id, k.name ?? k.typ]));
  return (b?.geraete ?? []).map((g) => {
    const rueckfall = g.rueckfall_kw != null
      ? `Rückfall ${zahl(g.rueckfall_kw)} kW`
      : g.rueckfall === 'faellt_auf_wert' ? 'Rückfall ohne Zahl' : `Rückfall ${g.rueckfall ?? 'unbekannt'} → zählt mit Nennleistung`;
    const herkunft = g.rueckfall_herkunft ? RUECKFALL[g.rueckfall_herkunft] ?? g.rueckfall_herkunft : 'ohne Angabe';
    const freigabe = g.schreibfreigabe === false ? ' · ohne Schreibfreigabe (ungeregelt)' : '';
    return {
      text: `${komponenten.get(g.komponente_id) ?? 'Gerät'} · ${RICHTUNG[g.richtung]} ${zahl(g.nenn_kw)} kW · ${rueckfall} (${herkunft})${freigabe}`,
      unbekannt: g.rueckfall_kw == null,
    };
  });
}

function kwZelle(n: number | null | undefined): Zelle {
  return n == null ? { text: NICHT_GEMELDET, unbekannt: true } : { text: `${zahl(n)} kW` };
}

const GRUNDLAGE: Record<string, string> = { prognose: 'Prognose', nowcast: 'Nowcast' };

/**
 * Folgepaket zu IP-22: der Anteils-Verlust von gestern — die Untergrenze der Box (gemessen) und die Schätzung der
 * Cloud (aus der PV-Prognose) nebeneinander, nie verrechnet. Ohne Meldung der Box: nicht gemeldet, keine Null.
 */
export function verlustGesternZelle(v: UemsVerlustTag | null | undefined): Zelle {
  if (!v) return { text: NICHT_GEMELDET, unbekannt: true };
  const gemessen = `mindestens ${zahl(v.verlust_kwh)} kWh (gemessen)`;
  const g = v.schaetzung_grundlage ?? null;
  if (g == null) return { text: `${gemessen} · Schätzung noch nicht gerechnet`, unbekannt: true };
  if (g === 'keine' || v.schaetzung_kwh == null) return { text: `${gemessen} · keine Schätzung (keine Prognose)`, unbekannt: true };
  return { text: `${gemessen} · geschätzt ${zahl(v.schaetzung_kwh)} kWh (${GRUNDLAGE[g] ?? g})` };
}

/** Die Stufen aus dem Herzschlag-Block (`GemeinsameSteuerungHerzschlag.WAECHTER_STUFEN`). */
export const WAECHTER: Record<string, string> = {
  aus: 'aus',
  ueberwacht: 'überwacht',
  regelt: 'regelt',
  haelt: 'hält',
  zieht_zusammen: 'zieht zusammen',
  sicherheitskappe: 'Sicherheitskappe',
};

function waechterZelle(s: string | null | undefined, gemeldet: boolean): Zelle {
  if (!gemeldet || !s) return { text: NICHT_GEMELDET, unbekannt: true };
  // Ein Wächter, der eingreift oder aus ist, ist sichtbar markiert; nur „überwacht“ ist Ruhe.
  return { text: WAECHTER[s] ?? s, warnung: s !== 'ueberwacht' };
}

/** Die Spalten nebeneinander: die führende Box zuerst, dann die mitsteuernden. */
export function boxSpalten(
  blatt: UemsBetreiberblatt | null,
  einrichten: UemsGemeinsameSteuerungEinrichten | null,
  namen: BoxNamen,
  jetzt: Date,
): BoxSpalte[] {
  const boxen = [...(blatt?.boxen ?? [])].sort((a, b) => (a.rolle === b.rolle ? 0 : a.rolle === 'fuehrt' ? -1 : 1));
  return boxen.map((b: UemsBoxStand) => {
    const v = b.plan.veroeffentlicht?.plan_id ?? null;
    const a = b.plan.angenommen?.plan_id ?? null;
    const planUngleich = v != null && v !== a;
    const g = b.anteile.gesendet;
    const q = b.anteile.quittiert;
    const revUngleich = g != null && (q == null || q.epoche !== g.epoche || q.revision !== g.revision);
    const gesehen = b.zuletzt_gesehen ?? null;
    const stumm = gesehen == null || jetzt.getTime() - new Date(gesehen).getTime() > 90_000;
    const mp = b.messpunkt;
    return {
      boxId: b.box_id,
      name: name(namen, b.box_id),
      rolle: b.rolle === 'fuehrt' ? 'führt' : 'steuert mit',
      erreichbar: gesehen == null
        ? { text: NICHT_GEMELDET, unbekannt: true }
        : { text: `Herzschlag ${alter(gesehen, jetzt)}`, warnung: stumm },
      faehigkeit: { text: faehigkeitText(b.faehigkeit.steuerungsverbund_anteil), warnung: b.faehigkeit.steuerungsverbund_anteil === 'fehlt' },
      faehigkeitSprungprobe: { text: faehigkeitText(b.faehigkeit.sprungprobe), warnung: b.faehigkeit.sprungprobe === 'fehlt' },
      geraete: geraeteZeilen(b.box_id, einrichten),
      messpunkt: !mp
        ? { text: 'kein Messpunkt', warnung: true }
        : mp.zustand === 'nicht_gemeldet'
          ? { text: NICHT_GEMELDET, unbekannt: true }
          : { text: `${mp.zustand} · ${alter(mp.gelesen_am, jetzt)}`, warnung: mp.zustand !== 'ok' },
      waechter: {
        einspeisung: waechterZelle(b.waechter?.einspeisung, b.waechter != null),
        bezug: waechterZelle(b.waechter?.bezug, b.waechter != null),
      },
      plan: {
        veroeffentlicht: { text: planText(v), unbekannt: v == null },
        angenommen: a == null ? { text: v == null ? 'keiner' : NICHT_GEMELDET, unbekannt: true, warnung: planUngleich } : { text: planText(a), warnung: planUngleich },
        ungleich: planUngleich,
      },
      revision: {
        gesendet: { text: g ? revisionText(g) : 'nichts gesendet', unbekannt: g == null },
        quittiert: { text: q ? revisionText(q) : NICHT_GEMELDET, unbekannt: q == null, warnung: revUngleich },
        ungleich: revUngleich,
      },
      wirksam: {
        einspeisung: kwZelle(b.anteile.wirksam_kw?.einspeisung),
        bezug: kwZelle(b.anteile.wirksam_kw?.bezug),
        // nicht gemeldet = die Box hält keine Reserve (altes Dokument, alte Box)
        reserve: b.anteile.reserve_verbraucher_kw == null ? { text: 'keine', unbekannt: true } : kwZelle(b.anteile.reserve_verbraucher_kw),
      },
      ungeregelt: b.anteile.ungeregelt_hinter_abgang_kw != null && b.anteile.ungeregelt_hinter_abgang_kw > 0
        ? kwZelle(b.anteile.ungeregelt_hinter_abgang_kw) : null,
      verlustGestern: verlustGesternZelle(b.verlust_gestern),
    };
  });
}

// ───────────────────────────────────────────────────────────── Darunter: Auslegung, Bilanz, Protokolle

export function auslegungSaetze(einrichten: UemsGemeinsameSteuerungEinrichten | null): string[] {
  const e = einrichten?.ergebnis;
  const out: string[] = [];
  for (const r of ['einspeisung', 'bezug'] as const) {
    const a = e?.[r];
    if (!a) { out.push(`${RICHTUNG[r]}: nicht rechenbar — unbekannt ist nicht „passt“.`); continue; }
    const kopf = `${RICHTUNG[r]}: Grenze ${zahl(a.grenze_kw)} kW − Vorbehalt ${zahl(a.vorbehalt_kw)} kW = ${zahl(a.verteilbar_kw)} kW verteilbar, Rückfälle ${zahl(a.summe_rueckfall_kw)} kW`;
    if (a.urteil === 'passt') out.push(`${kopf} — passt.`);
    else if (a.urteil === 'vorbehalt_ueber_grenze') out.push(`${kopf} — passt nicht: der Vorbehalt liegt über der Grenze.`);
    else out.push(`${kopf} — passt nicht: die Rückfälle übersteigen das Verteilbare.`);
    const puffer = pufferSatz(einrichten, r);
    if (puffer) out.push(`${RICHTUNG[r]}: ${puffer}`);
  }
  return out;
}

export function bilanzSatz(z: UemsGemeinsameSteuerungZustand | null): string {
  const b = z?.bilanz;
  if (!b) return 'Verbund-Bilanz: noch kein Tag gerechnet.';
  const seit = b.seit ? ` seit ${datum(b.seit)}` : '';
  const grund = b.zustand === 'unbekannt' && b.grund ? ` (${b.grund})` : '';
  return `Verbund-Bilanz ${b.zustand}${seit}${grund} · zuletzt ${datum(b.tag)}.`;
}

export function vorbehaltSatz(z: UemsGemeinsameSteuerungZustand | null): string {
  const v = z?.vorbehalt;
  if (!v) return 'Vorbehalt: nicht bekannt.';
  const r = (x: typeof v.einspeisung, n: string) => `${n} ${x.kw == null ? 'unbekannt' : `${zahl(x.kw)} kW`} (${x.herkunft === 'gemessen' ? 'aus Messwerten' : 'erklärt'})`;
  const vorschlag = v.vorschlag ? ` · Vorschlag: ${RICHTUNG[v.vorschlag.richtung]} ${zahl(v.vorschlag.alt_kw)} → ${zahl(v.vorschlag.neu_kw)} kW nach ${v.vorschlag.messtage} Messtagen` : '';
  return `Vorbehalt: ${r(v.einspeisung, 'Einspeisung')} · ${r(v.bezug, 'Bezug')}${vorschlag}.`;
}

export function datum(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
}

export function zeit(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
  });
}

const URTEIL: Record<UemsSprungprobe['urteil'], string> = {
  ausgeloest: 'ausgelöst — Bericht steht aus',
  bestanden: 'bestanden',
  nicht_bestanden: 'nicht bestanden',
  abgebrochen: 'abgebrochen',
  nicht_auswertbar: 'nicht auswertbar (kein Bestanden)',
};

export interface ProtokollZeile {
  probeId: string;
  box: string;
  wann: string;
  art: string;
  sprung: string;
  urteil: string;
  gilt: boolean;
  bestanden: boolean;
  abweichung: string;
}

function abweichungText(s: UemsSprungMessung[]): string {
  if (s.length === 0) return '—';
  return s.map((m, i) => `${i + 1}: ${m.abweichung_kw == null ? 'nichts gesehen' : `${m.abweichung_kw > 0 ? '+' : ''}${zahl(m.abweichung_kw)} kW`}${m.toleranz_kw != null ? ` (±${zahl(m.toleranz_kw)})` : ''}`).join(' · ');
}

export function protokollZeilen(blatt: UemsBetreiberblatt | null, namen: BoxNamen): ProtokollZeile[] {
  return (blatt?.sprungproben ?? []).map(({ probe: p, spruenge }) => ({
    probeId: p.probe_id,
    box: name(namen, p.box_id),
    wann: zeit(p.ausgeloest_am),
    art: p.art === 'erzeugung_senken' ? 'Erzeugung senken' : 'Verbrauch senken',
    sprung: `${zahl(p.sprung_kw)} kW · ${p.wiederholungen} × ${p.dauer_s} s`,
    urteil: `${URTEIL[p.urteil]}${p.grund ? ` (${p.grund})` : ''}${p.entwertet_am ? ' · entwertet' : ''}`,
    gilt: p.gilt,
    bestanden: p.urteil === 'bestanden',
    abweichung: abweichungText(spruenge),
  }));
}

// ───────────────────────────────────────────────────────────── Handgriffe (I4)

export const SPRUNG_MAX_KW = 50;

/** Warum an dieser Box KEINE Sprungprobe ausgelöst werden kann — oder null. Grund statt Knopf. */
export function sprungprobeGrund(z: UemsGemeinsameSteuerungZustand | null, box: UemsBoxStand, namen: BoxNamen): string | null {
  if (z?.zustand !== 'beobachtet') return 'Nur in S1 (beobachtet).';
  if (box.faehigkeit.sprungprobe === 'fehlt') return wortSatz('sprungprobe_nicht_gemeldet', namen, { box_id: box.box_id });
  return null;
}

/** Die Eingabe „Sprung in kW“: größer 0, höchstens 50 — sonst der Grund. */
export function sprungEingabe(text: string): { kw: number | null; fehler: string | null } {
  const n = deutscheZahl(text);
  if (n == null) return { kw: null, fehler: 'Bitte eine Zahl in kW eingeben.' };
  if (n <= 0) return { kw: null, fehler: 'Der Sprung liegt über 0 kW.' };
  if (n > SPRUNG_MAX_KW) return { kw: null, fehler: `Höchstens ${SPRUNG_MAX_KW} kW.` };
  return { kw: n, fehler: null };
}

/** Was nach dem Handgriff gilt — steht im Bestätigungsdialog. */
export const DANACH = {
  sprungprobe: [
    'Die Box senkt zweimal für 60 s die gewählte Stellgröße — immer in die sichere Richtung — und bricht selbst ab, wenn ihr Wächter eingreifen müsste.',
    'Die Cloud vergleicht mit dem Netzzähler der führenden Box: Richtung und Größe ± max(10 %, 2 kW). Das Protokoll erscheint unten.',
    'Hat danach jede Box eine bestandene Probe, steht die Anlage auf S2 (geprüft).',
  ],
  scharfschalten: [
    'Neue Epoche. Zweischritt: zuerst verengt die führende Box auf ihren Anteil; erst nach ihrer Quittung bekommen die mitsteuernden ihr Dokument.',
    'Erst wenn alle quittiert haben, gilt der Zielstand und der Planer veröffentlicht je Box.',
    'Die Mitglieder gelten danach als bestätigt.',
  ],
  anhalten: [
    'Die mitsteuernden Boxen bekommen keinen Plan mehr; die führende steuert allein wie ohne Gemeinsame Steuerung.',
    'Die Anteile bleiben in Kraft — kein Wächter fällt weg.',
    'Vom Betreiber angehalten: der Kunde kann nicht selbst fortsetzen.',
  ],
  fortsetzen: [
    'Alle Bedingungen aus I1 werden erneut geprüft; dieselbe Epoche, keine neue Probe.',
    'Danach bekommen wieder alle Boxen ihren Plan.',
  ],
  bestaetigen: [
    'Das Mitglied gilt als bestätigt (nach dem Box-Tausch, R17). Rolle, Messpunkt und Probe übernimmt die Nachfolgerin nur bei unveränderten Datenquellen.',
  ],
  vomNetz: [
    'Sie bestätigen: die Geräte dieser Box sind vom Netz. Ihr Rückfall wird nicht mehr reserviert (§5.5, I4).',
    'Die anderen Boxen bekommen den Rest ohne die Quittung dieser Box; danach endet ihre Mitgliedschaft.',
    'Stimmt das nicht, kann die Grenze am Netzanschluss überschritten werden — im Zweifel die Quittung der Box abwarten.',
  ],
} as const;

/** Die Ablehnung einer Admin-Route als Satz an ihrer Stelle: `{code, message, fehlt}`. */
export function ablehnungSaetze(body: unknown, namen: BoxNamen): string[] {
  const b = (body ?? {}) as { code?: string; message?: string; fehlt?: UemsGemeinsameSteuerungBefund[] };
  const out: string[] = [];
  if (b.code) out.push(WOERTER[b.code] ? wortSatz(b.code, namen) : b.message ?? b.code);
  for (const f of b.fehlt ?? []) {
    const t = wortSatz(f.wort, namen, f);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length === 0) out.push(b.message ?? 'Das hat nicht geklappt.');
  return out;
}
