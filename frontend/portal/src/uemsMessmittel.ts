import { ApiError, type MessmittelAngaben, type MessmittelEintrag, type MessmittelPruefungsart } from './api';
import { UEMS_NICHT_ERHOBEN, UEMS_PRUEFUNGSARTEN } from './glossar';
import { monatWort } from './uemsVergleichToleranz';
import { zahlText } from './zahl';

/**
 * UEMS AP-16 IP-18 (G1–G5, R8, R9): reine Ableitungen für Messmittel-Blatt, Messmittel-Dialog, Toleranz-Dialog und
 * die Prüfaufgaben-Zeile. Gerechnet wird in der Cloud; hier stehen nur Wörter, die lokale Prüfsumme und der Entwurf.
 *
 * ⚠ G2: ein Beleg ist ein VERWEIS. {@link pruefsummeLokal} liest die gewählte Datei im Browser und liefert nur ihre
 * SHA-256; {@link eintragAus} kennt die Datei gar nicht — in den PUT gelangen Bezeichnung, Ablage und Prüfsumme.
 * ⚠ G3: was fehlt, heißt wörtlich „nicht erhoben“; nie ein Vorgabewert, nie eine gerechnete Genauigkeit der Messkette.
 */

/** SHA-256 der gewählten Datei, im Browser gebildet (Web Crypto). Die Datei selbst verlässt das Gerät nie. */
export async function pruefsummeLokal(datei: Blob): Promise<string> {
  const puffer = typeof datei.arrayBuffer === 'function' ? await datei.arrayBuffer() : await lesen(datei);
  const summe = await crypto.subtle.digest('SHA-256', puffer);
  return [...new Uint8Array(summe)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ältere Laufzeiten ohne `Blob.arrayBuffer` lesen über FileReader — ebenfalls nur lokal. */
function lesen(datei: Blob): Promise<ArrayBuffer> {
  return new Promise((ok, fehler) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as ArrayBuffer);
    r.onerror = () => fehler(r.error);
    r.readAsArrayBuffer(datei);
  });
}

/** „3b1f4d…9a2e“ → „3b1f…9a2e“ (§5.7). */
export const pruefsummeKurz = (sha: string) => `${sha.slice(0, 4)}…${sha.slice(-4)}`;

/** „2031-12-31“ → „31.12.2031“. */
export function tagText(iso: string): string {
  const [j, m, t] = iso.slice(0, 10).split('-');
  return `${t}.${m}.${j}`;
}

function naechsterTag(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export const PRUEFUNGSART_OPTIONEN = (Object.keys(UEMS_PRUEFUNGSARTEN) as MessmittelPruefungsart[]).map((wert) => ({
  value: wert,
  label: UEMS_PRUEFUNGSARTEN[wert],
}));

export interface BlattZeile {
  schluessel: string;
  label: string;
  wert: string;
  offen: boolean;
  hinweis?: string;
}

const WANDLER_WORT = { wandler_strom: 'Stromwandler', wandler_spannung: 'Spannungswandler' } as const;

function verhaeltnis(wert: Record<string, unknown>): string | null {
  const p = wert.primaer_a ?? wert.primaer_v;
  const s = wert.sekundaer_a ?? wert.sekundaer_v;
  if (p === undefined || s === undefined) return null;
  return `${String(p).replace('.', ',')}/${String(s).replace('.', ',')} ${wert.primaer_a !== undefined ? 'A' : 'V'}`;
}

/**
 * Das Messmittel-Blatt „am Einbau erhoben“ (G1, G3): Klasse, Prüfung, gültig bis (mit „abgelaufen seit“), Beleg und
 * je Wandler-Fassung die Klasse. `heute` ist JJJJ-MM-TT. Die Katalog-Angabe „laut Hersteller“ (G4) ist KEIN Teil
 * dieser Zeilen — sie steht getrennt in {@link herstellerZeilen}.
 */
export function blattZeilen(a: MessmittelAngaben, heute: string): BlattZeile[] {
  const zeilen: BlattZeile[] = [
    { schluessel: 'klasse', label: 'Genauigkeitsklasse', wert: a.genauigkeitsklasse ?? UEMS_NICHT_ERHOBEN, offen: a.genauigkeitsklasse === null },
    {
      schluessel: 'pruefung',
      label: 'Prüfung',
      wert: `${UEMS_PRUEFUNGSARTEN[a.pruefungsart]}${a.pruefung_am ? ` am ${tagText(a.pruefung_am)}` : ''}`,
      offen: a.pruefungsart === 'nicht_erhoben',
    },
  ];
  if (a.pruefungsart !== 'keine') {
    const bis = a.pruefung_gueltig_bis;
    const abgelaufen = bis !== null && bis < heute;
    zeilen.push({
      schluessel: 'gueltig',
      label: 'Gültig bis',
      wert: bis ? tagText(bis) : UEMS_NICHT_ERHOBEN,
      offen: bis === null,
      ...(abgelaufen ? { hinweis: `abgelaufen seit ${tagText(naechsterTag(bis))}` } : {}),
    });
  }
  const b = a.beleg;
  zeilen.push(
    b
      ? {
          schluessel: 'beleg',
          label: 'Beleg',
          wert: `${b.bezeichnung}${b.ablage ? ` · Ablage: ${b.ablage}` : ''}`,
          offen: false,
          hinweis: `Prüfsumme ${pruefsummeKurz(b.sha256)}${b.person ? ` · eingetragen von ${b.person.name}` : ''} am ${tagText(b.zeitpunkt)}`,
        }
      : { schluessel: 'beleg', label: 'Beleg', wert: UEMS_NICHT_ERHOBEN, offen: true },
  );
  for (const w of a.wandler) {
    const v = verhaeltnis(w.wert);
    zeilen.push({
      schluessel: `wandler-${w.fassung}`,
      label: `${WANDLER_WORT[w.art]}${v ? ` ${v}` : ''}`,
      wert: `Klasse ${w.klasse ?? UEMS_NICHT_ERHOBEN}`,
      offen: w.klasse === null,
      hinweis: `ab ${tagText(w.gueltig_ab)}${w.gueltig_bis ? ` bis ${tagText(w.gueltig_bis)}` : ''}`,
    });
  }
  return zeilen;
}

/**
 * „Laut Hersteller“ (G4, IP-16): je Katalog-Angabe eine Zeile mit Fundstelle und gekürzter Quellen-Prüfsumme —
 * GETRENNT von den Einbau-Zeilen, nie mit ihnen verrechnet. `nicht_belegt` steht so, ohne Zahl.
 */
export function herstellerZeilen(a: MessmittelAngaben): BlattZeile[] {
  return (a.laut_hersteller ?? []).map((h) => ({
    schluessel: `hersteller-${h.ziel}`,
    label: `${h.bezeichnung} (${h.hersteller} ${h.modell})`,
    wert: h.zustand === 'belegt'
      ? [h.klasse, h.wert].filter(Boolean).join(' ') + (h.bezug ? ` v. ${h.bezug}` : '')
      : 'laut Hersteller nicht belegt',
    offen: h.zustand !== 'belegt',
    ...(h.zustand === 'belegt' && h.fundstelle
      ? { hinweis: `${h.fundstelle}${h.source_sha256 ? ` · Quelle ${pruefsummeKurz(h.source_sha256)}` : ''}` }
      : {}),
  }));
}

/** Klasse UND Prüfung fehlen — die Zeile der Prüfaufgabe (§5.7 „Messmittel offen“). */
export const ohneAngabe = (a: MessmittelAngaben) => a.genauigkeitsklasse === null && a.pruefungsart === 'nicht_erhoben';

/**
 * Die Messmittel-Zeile eines Geräts (§5.7): „Unterzähler Druckluft: Klasse und Prüfung nicht erhoben.“ oder
 * „Netzzähler …: Klasse B (MID) · Eichung am 14.06.2023, gültig bis 31.12.2031 · Beleg: … (Prüfsumme 3b1f…9a2e).“
 */
export function messmittelSatz(name: string, a: MessmittelAngaben): string {
  if (ohneAngabe(a)) return `${name}: Klasse und Prüfung ${UEMS_NICHT_ERHOBEN}.`;
  const teile = [`Klasse ${a.genauigkeitsklasse ?? UEMS_NICHT_ERHOBEN}`];
  const pruefung = `${UEMS_PRUEFUNGSARTEN[a.pruefungsart]}${a.pruefung_am ? ` am ${tagText(a.pruefung_am)}` : ''}`;
  teile.push(a.pruefung_gueltig_bis ? `${pruefung}, gültig bis ${tagText(a.pruefung_gueltig_bis)}` : pruefung);
  teile.push(a.beleg ? `Beleg: ${a.beleg.bezeichnung} (Prüfsumme ${pruefsummeKurz(a.beleg.sha256)})` : `Beleg ${UEMS_NICHT_ERHOBEN}`);
  return `${name}: ${teile.join(' · ')}.`;
}

/** Der Entwurf des Dialogs; `datei` steht hier NIE — nur die im Browser gebildete Prüfsumme. */
export interface MessmittelEntwurf {
  klasse: string;
  pruefungsart: MessmittelPruefungsart;
  pruefungAm: string;
  gueltigBis: string;
  belegBezeichnung: string;
  belegAblage: string;
  belegSha256: string | null;
  wandler: Record<string, string>;
}

export function entwurfAus(a: MessmittelAngaben): MessmittelEntwurf {
  return {
    klasse: a.genauigkeitsklasse ?? '',
    pruefungsart: a.pruefungsart,
    pruefungAm: a.pruefung_am ?? '',
    gueltigBis: a.pruefung_gueltig_bis ?? '',
    belegBezeichnung: a.beleg?.bezeichnung ?? '',
    belegAblage: a.beleg?.ablage ?? '',
    belegSha256: a.beleg?.sha256 ?? null,
    wandler: Object.fromEntries(a.wandler.map((w) => [w.fassung, w.klasse ?? ''])),
  };
}

const leerNull = (s: string) => (s.trim() === '' ? null : s.trim());

/**
 * Der PUT aus dem Entwurf — die ganze Angabe (leer = nicht erhoben). Ein Beleg braucht Bezeichnung UND Prüfsumme;
 * `wandler` nennt nur die Fassungen, deren Klasse sich ändert. Liefert einen Fehler-Satz je Feld statt eines Eintrags.
 */
export function eintragAus(
  e: MessmittelEntwurf,
  vorher: MessmittelAngaben,
): { eintrag: MessmittelEintrag } | { fehler: { feld: 'beleg_bezeichnung' | 'beleg_datei' | 'gueltig_bis'; satz: string } } {
  const bezeichnung = leerNull(e.belegBezeichnung);
  if (bezeichnung && !e.belegSha256)
    return { fehler: { feld: 'beleg_datei', satz: 'Bitte wählen Sie die Datei des Belegs — das Portal bildet daraus nur die Prüfsumme.' } };
  if (!bezeichnung && e.belegSha256)
    return { fehler: { feld: 'beleg_bezeichnung', satz: 'Bitte geben Sie dem Beleg eine Bezeichnung.' } };
  if (e.pruefungAm && e.gueltigBis && e.gueltigBis < e.pruefungAm)
    return { fehler: { feld: 'gueltig_bis', satz: '„Gültig bis“ liegt vor dem Prüfdatum.' } };
  const wandler = vorher.wandler
    .filter((w) => leerNull(e.wandler[w.fassung] ?? '') !== w.klasse)
    .map((w) => ({ fassung: w.fassung, klasse: leerNull(e.wandler[w.fassung] ?? '') }));
  return {
    eintrag: {
      genauigkeitsklasse: leerNull(e.klasse),
      pruefungsart: e.pruefungsart,
      pruefung_am: e.pruefungAm || null,
      pruefung_gueltig_bis: e.gueltigBis || null,
      beleg: bezeichnung && e.belegSha256 ? { bezeichnung, ablage: leerNull(e.belegAblage), sha256: e.belegSha256 } : null,
      ...(wandler.length > 0 ? { wandler } : {}),
    },
  };
}

const MESSMITTEL_ABLEHNUNG: Record<string, string> = {
  pruefsumme_ungueltig: 'Die Prüfsumme des Belegs ist ungültig. Bitte wählen Sie die Datei erneut.',
  beleg_unvollstaendig: 'Ein Beleg braucht eine Bezeichnung und die gewählte Datei.',
  pruefungsart_unbekannt: 'Diese Prüfungsart kennt VoltPilot nicht.',
  zeitraum_ungueltig: '„Gültig bis“ liegt vor dem Prüfdatum.',
  text_zu_lang: 'Ein Text ist zu lang (höchstens 200 Zeichen, die Klasse höchstens 60).',
  fassung_unbekannt: 'Diese Wandler-Fassung gehört nicht zu diesem Einbau.',
  klasse_nur_am_wandler: 'Eine Wandler-Klasse steht nur an einem Strom- oder Spannungswandler.',
};

const TOLERANZ_ABLEHNUNG: Record<string, string> = {
  toleranz_ungueltig: 'Die Toleranz muss über 0 und höchstens 100 % liegen, mit höchstens zwei Nachkommastellen.',
  begruendung_fehlt: 'Bitte begründen Sie die neue Toleranz.',
  text_zu_lang: 'Die Begründung ist zu lang (höchstens 500 Zeichen).',
  keine_vergleichsquelle: 'Eine Toleranz gilt nur für eine Vergleichsquelle, nicht für die führende Quelle.',
};

function ablehnungAus(e: unknown, saetze: Record<string, string>): string {
  if (e instanceof ApiError) {
    const code = (e.body as { code?: string } | undefined)?.code;
    if (code && saetze[code]) return saetze[code];
    if (e.status === 403) return 'Dafür fehlt Ihnen das Recht „Messmittel-Angaben und Belege eintragen“.';
    if (e.status === 404) return 'Diese Angabe ist nicht mehr erreichbar.';
  }
  return 'Das hat gerade nicht geklappt. Bitte versuchen Sie es erneut.';
}

export const messmittelAblehnung = (e: unknown) => ablehnungAus(e, MESSMITTEL_ABLEHNUNG);
export const toleranzAblehnung = (e: unknown) => ablehnungAus(e, TOLERANZ_ABLEHNUNG);

/**
 * Die Toleranz aus der Eingabe („2,5“ → „2.5“) — über 0, höchstens 100, höchstens zwei Nachkommastellen; sonst null.
 * Die Route prüft dasselbe (`toleranz_ungueltig`); hier nur, damit der Satz vor dem Senden steht.
 */
export function toleranzWert(eingabe: string): string | null {
  const deutsch = zahlText(eingabe.trim().replace(/\s*%$/, ''));
  if (deutsch === null) return null;
  const t = deutsch.replace(/\./g, '').replace(',', '.');
  if (!/^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 100 ? t : null;
}

/** Der laufende Monat als Wort („Dezember 2026“) — ab dann gilt eine neue Fassung, nie rückwirkend. */
export function laufenderMonat(jetzt: Date = new Date()): string {
  return monatWort(`${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, '0')}`);
}
