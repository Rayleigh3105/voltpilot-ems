/**
 * Die Kundensätze der Rechte (Vorlagen aus dem Block `texte` der Vektor-Datei), die Teilansicht-Regel (E10) und
 * Datum mit Uhrzeit in der Zeitzone des Kundenbereichs (UEMS AP-03).
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): die Schale (`rollen.ts`) braucht beim ersten
 * Bild nur die Sätze und die Kopfzeile der Teilansicht, der Unterstützungs-Banner nur `datumZeit`; `rechte.ts` zog
 * dafür den ganzen Rechte-Zwilling samt `uemsOrtsbaum.ts` ins Einstiegs-Bündel. `rechte.ts` reicht alles hier
 * unverändert weiter, und sein Test hält die Sätze weiter gegen die Vektor-Datei.
 */
import { VORGABE_ZEITZONE } from './uemsZustand';

/**
 * Die Kundensätze als Vorlagen (`{…}` wird eingesetzt) — dieselben stehen im
 * Block `texte` der Vektor-Datei; beide Zwillinge prüfen sie dagegen.
 */
export const TEXTE = {
  recht_fehlt: 'Dafür fehlt Ihnen das Recht.',
  weg_ein_kundenadministrator: 'Ihr Kundenadministrator: {namen}.',
  weg_kundenadministratoren: 'Ihre Kundenadministratoren: {namen}.',
  weg_voltpilot: 'Das übernimmt VoltPilot.',
  ausserhalb_geltungsbereich: 'Diese Seite gibt es für Sie nicht.',
  zugriff_beendet: 'Ihr Zugriff auf {standort} wurde beendet.',
  unterstuetzung_beendet: 'Ihre Unterstützung für {kundenbereich} ist beendet.',
  kein_standort: 'Ihnen ist derzeit kein Standort zugewiesen.',
  kein_standort_ein_weg: 'Ihr Kundenadministrator {namen} kann das ändern.',
  kein_standort_wege: 'Ihre Kundenadministratoren {namen} können das ändern.',
  wirkt_ab: 'Wirkt ab {datum}',
  teilansicht: 'Teilansicht: {n} von {m} Standorten',
  teilansicht_export: 'Teilansicht: {namen} ({n} von {m} Standorten)',
  standortuebergreifend: 'umfasst Standorte außerhalb Ihres Zugriffs',
  banner_installateur: '{anzeigename} (Installateur) hat Zugriff auf {standorte} bis {ende} — {umfang}',
  banner_voltpilot: 'VoltPilot-Support hat Zugriff auf {standorte} bis {ende} — {umfang}',
  banner_notfall: 'VoltPilot-Support hat Notfall-Zugriff auf {standorte} bis {ende} — Grund: {grund}',
  banner_unterstuetzer: 'Sie arbeiten im Kundenbereich {kundenbereich} · {standorte} · bis {ende}',
  urheber_installateur: '{anzeigename} (Unterstützung)',
  urheber_voltpilot: 'VoltPilot-Support (Unterstützung)',
  urheber_notfall: 'VoltPilot (Notfall-Zugriff)',
  endete_zeitablauf: 'Endete am {datum} durch Zeitablauf',
  beendet: 'Beendet am {datum}',
  beendet_von: 'Beendet am {datum} durch {name}',
  gesetzt_von: 'gesetzt von {urheber}',
  bedienrecht_beendet: 'gesetzt von {urheber} (Bedienrecht beendet am {zeitpunkt})',
  hoechstens_12_monate:
    'Eine Unterstützung ist höchstens 12 Monate gültig. Sie können sie jederzeit verlängern.',
  standort_fehlt: 'Wählen Sie mindestens einen Standort.',
  grund_fehlt: 'Für einen Notfall-Zugriff ist ein Grund Pflicht.',
  letzter_kundenadministrator:
    '{kundenbereich} braucht mindestens einen Kundenadministrator. Ernennen Sie zuerst eine weitere Person.',
  zweite_person: 'Freigabe durch eine zweite Person.',
  /** Messen-Bau m2 (Konzept Messen m1, §8.2 Punkt 9): eine vergangene Gültigkeit ohne die Zeile `aenderung.rueckwirkend`. */
  recht_rueckwirkend: 'Rückwirkend eintragen dürfen Kundenadministratoren und Energiemanager. Ab heute können Sie es selbst eintragen.',
} as const;

/** Setzt die Werte in die Vorlage ein — auch für die Regeln in `rechte.ts`. */
export function text(schluessel: keyof typeof TEXTE, werte: Record<string, string> = {}): string {
  let s: string = TEXTE[schluessel];
  for (const [k, v] of Object.entries(werte)) s = s.replace(`{${k}}`, v);
  return s;
}

// ─────────────────────────────────────────────────────────────── Teilansicht

/**
 * Die Teilansicht-Regel (E10): die Unternehmensebene gibt es ab zwei
 * zugänglichen Standorten; mit weniger als allen ist sie eine Teilansicht.
 * Unternehmensweite Objekte sehen nur unternehmensweite Rollen (R-A1).
 */
export interface TeilansichtErgebnis {
  sichtbar: number;
  gesamt: number;
  unternehmensebene: boolean;
  teilansicht: boolean;
  kopfzeile: string | null;
  exportKopfzeile: string | null;
  unternehmensweiteObjekte: boolean;
}

/** teilansicht(n, m) — `namen` sind die n sichtbaren Standorte in Anzeige-Reihenfolge. */
export function teilansicht(namen: string[], gesamt: number, uw: boolean): TeilansichtErgebnis {
  const n = namen.length;
  const ebene = n >= 2;
  const teil = ebene && n < gesamt;
  const zahlen = { n: String(n), m: String(gesamt) };
  return {
    sichtbar: n,
    gesamt,
    unternehmensebene: ebene,
    teilansicht: teil,
    kopfzeile: teil ? text('teilansicht', zahlen) : null,
    exportKopfzeile: teil ? text('teilansicht_export', { namen: namen.join(', '), ...zahlen }) : null,
    unternehmensweiteObjekte: uw,
  };
}

// ───────────────────────────────────────────────────────────────────── Text

/** [Jahr, Monat, Tag, Stunde, Minute, Sekunde] in der Zeitzone des Kundenbereichs. */
export function ortszeit(iso: string, zone: string): number[] {
  // 'sv-SE' liefert die ISO-Schreibweise "2026-12-15 00:00:00" — dieselbe Art, eine
  // Zeitzone anzuwenden, wie `uemsZustand.ts`.
  const s = new Date(iso).toLocaleString('sv-SE', { timeZone: zone });
  const m = /(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m === null) throw new Error(`unlesbarer Zeitpunkt: ${iso}`);
  return m.slice(1).map(Number);
}

export const zwei = (n: number): string => String(n).padStart(2, '0');

/** „14.11.2026 09:02" — Datum und Uhrzeit in der Zeitzone des Kundenbereichs. */
export function datumZeit(iso: string, zeitzone: string = VORGABE_ZEITZONE): string {
  const [j, mo, t, h, mi] = ortszeit(iso, zeitzone);
  return `${zwei(t)}.${zwei(mo)}.${j} ${zwei(h)}:${zwei(mi)}`;
}
