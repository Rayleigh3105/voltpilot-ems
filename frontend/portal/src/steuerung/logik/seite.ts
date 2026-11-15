/**
 * Ableitungen der Seite einer Logik (Steuerlogik Stufe 4): Zustandswort, der nächste Schritt, Wörter für Rollen und
 * Protokoll, die Tabelle zum Herunterladen und der Entwurf im Browser. Rein (bis auf den Speicher des Browsers, der
 * immer fehlen darf).
 */
import type { LogikAnsicht, LogikFassungKopf, LogikKopf, LogikZustand, SteuerlogikSchritt } from '../../api';

export interface Pille {
  wort: string;
  klasse: 'on' | 'done' | 'off' | 'wait' | 'hand' | 'lock';
}

/** Das Zustandswort einer Logik: was gerade läuft, sonst ob gespeichert. */
export function pille(zustand: LogikZustand | 'neu', aktiv: number | null, vorgelegt: number | null = null): Pille {
  if (zustand === 'neu') return { wort: 'Neu', klasse: 'wait' };
  if (aktiv != null && zustand === 'scharf') return { wort: `Scharf · Fassung ${aktiv}`, klasse: 'on' };
  if (aktiv != null && zustand === 'mitlaufend') return { wort: `Läuft mit · Fassung ${aktiv}`, klasse: 'done' };
  if (vorgelegt != null) return { wort: 'Zur Freigabe', klasse: 'hand' };
  if (zustand === 'stillgelegt') return { wort: 'Stillgelegt', klasse: 'off' };
  return { wort: 'Gespeichert', klasse: 'off' };
}

export function kopfPille(k: LogikKopf): Pille {
  return pille(k.zustand, k.aktiv, k.vorgelegt);
}

export function ansichtPille(a: LogikAnsicht): Pille {
  const aktiv = a.fassungen.find((f) => f.zustand === 'mitlaufend' || f.zustand === 'scharf') ?? null;
  return pille(aktiv?.zustand ?? a.fassungen[0]?.zustand ?? 'geprueft', aktiv?.fassung ?? null, vorgelegt(a)?.fassung ?? null);
}

/** Die aktive Fassung (mitlaufend oder scharf). */
export function aktiveFassung(a: LogikAnsicht): LogikFassungKopf | null {
  return a.fassungen.find((f) => f.zustand === 'mitlaufend' || f.zustand === 'scharf') ?? null;
}

/** Die vorgelegte Fassung, die noch auf die Freigabe wartet (neuer als jede scharfe). */
export function vorgelegt(a: LogikAnsicht): LogikFassungKopf | null {
  for (const f of a.fassungen) {
    if (f.scharfAm) return null;
    if (f.vorgelegtAm) return f;
  }
  return null;
}

export type Handlung = 'mitlaufen' | 'vorlegen' | 'scharf';

/** Was als Nächstes zu tun ist, in einem Satz, mit den Knöpfen dafür; `null`, wenn nichts offen ist. */
export function naechsterSchritt(a: LogikAnsicht): { satz: string; handlungen: Handlung[] } | null {
  const neueste = a.fassungen[0];
  if (!neueste) return null;
  const aktiv = aktiveFassung(a);
  const v = vorgelegt(a);
  if (v) {
    return a.plattform
      ? { satz: `Fassung ${v.fassung} liegt zur Freigabe vor.`, handlungen: ['scharf'] }
      : { satz: `Fassung ${v.fassung} liegt VoltPilot zur Freigabe vor.`, handlungen: [] };
  }
  if (!a.darfBearbeiten || neueste.zustand !== 'geprueft') return null;
  if (aktiv?.zustand === 'scharf') {
    return {
      satz: `Fassung ${neueste.fassung} ist gespeichert. Scharf schaltet VoltPilot.`,
      handlungen: a.plattform ? ['scharf'] : ['vorlegen'],
    };
  }
  return {
    satz: `Fassung ${neueste.fassung} ist gespeichert und läuft noch nicht.`,
    handlungen: a.plattform ? ['mitlaufen', 'scharf'] : ['mitlaufen', 'vorlegen'],
  };
}

const ROLLEN: Record<string, string> = {
  kundenadministrator: 'Kundenadministrator',
  unterstuetzer: 'Fachbetrieb',
  voltpilot_betrieb: 'VoltPilot',
  bedienberechtigt: 'Bedienberechtigt',
  energiemanager: 'Energiemanager',
};

export function rolleWort(rolle: string | null | undefined): string | null {
  return rolle ? ROLLEN[rolle] ?? rolle : null;
}

/** Ein Wert der Textform für Menschen (`"72 °C"` bleibt, `on`/`off` werden an/aus). */
export function wertWort(w: unknown): string {
  if (w === undefined || w === null) return '–';
  if (w === 'on' || w === true) return 'an';
  if (w === 'off' || w === false) return 'aus';
  if (typeof w === 'object') return JSON.stringify(w);
  return String(w);
}

/** Ein Schritt des Protokolls in einem Satz. */
export function schrittSatz(s: SteuerlogikSchritt): string {
  const d = (s.daten ?? {}) as Record<string, unknown>;
  switch (s.was) {
    case 'gespeichert':
      return `Fassung ${s.fassung} gespeichert${d.notiz ? `: ${String(d.notiz)}` : ''}`;
    case 'angenommen':
      return `Fassung ${s.fassung} von VoltPilot angenommen`;
    case 'mitlaufen':
      return `Fassung ${s.fassung} läuft mit`;
    case 'vorgelegt':
      return `Fassung ${s.fassung} zur Freigabe vorgelegt`;
    case 'scharf':
      return `Fassung ${s.fassung} scharf geschaltet`;
    case 'zurueck':
      return `Zurück von Fassung ${String(d.von ?? '?')} auf Fassung ${String(d.auf ?? s.fassung)}`;
    case 'stillgelegt':
      return `Fassung ${s.fassung} stillgelegt`;
    case 'stellwert':
      if (d.verworfen) return `„${String(d.kennung)}“ passt nicht zur neuen Fassung, gilt wieder die Vorgabe`;
      return `„${String(d.name ?? d.kennung)}“: ${wertWort(d.alt)} → ${wertWort(d.neu)}`;
    case 'anfrage':
      return `Bitte um Änderung${d.kennung ? ` zu „${String(d.kennung)}“` : ''}: ${String(d.text ?? '')}`;
    case 'erledigt':
      return 'Bitte um Änderung erledigt';
  }
  return s.was;
}

/** Das Protokoll als Tabelle (CSV, Semikolon, ISO-Zeit, ungerundet). */
export function protokollCsv(schritte: SteuerlogikSchritt[]): string {
  const feld = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const zeilen = [['Zeit', 'Wer', 'Rolle', 'Fassung', 'Schritt', 'Was'].join(';')];
  for (const s of schritte) {
    zeilen.push([s.am, s.von ?? '', rolleWort(s.rolle) ?? '', String(s.fassung), s.was, schrittSatz(s)].map(feld).join(';'));
  }
  return zeilen.join('\n') + '\n';
}

// --- Entwurf im Browser ------------------------------------------------------------------------------------------

/** Ein ungespeicherter Text: die Fassung, von der er ausging (0 = neue Logik), und der Text. */
export interface Entwurf {
  basis: number;
  text: string;
}

function schluessel(siteId: string, logikId: string): string {
  return `vp-logik-entwurf:${siteId}:${logikId}`;
}

export function ladeEntwurf(siteId: string, logikId: string): Entwurf | null {
  try {
    const roh = window.localStorage.getItem(schluessel(siteId, logikId));
    if (!roh) return null;
    const e = JSON.parse(roh) as Entwurf;
    return typeof e.text === 'string' && typeof e.basis === 'number' ? e : null;
  } catch {
    return null;
  }
}

export function merkeEntwurf(siteId: string, logikId: string, e: Entwurf): void {
  try {
    window.localStorage.setItem(schluessel(siteId, logikId), JSON.stringify(e));
  } catch {
    // Ohne Speicher bleibt der Entwurf nur auf der Seite.
  }
}

export function vergissEntwurf(siteId: string, logikId: string): void {
  try {
    window.localStorage.removeItem(schluessel(siteId, logikId));
  } catch {
    // nichts zu tun
  }
}
