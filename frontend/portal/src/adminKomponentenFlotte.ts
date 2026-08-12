/**
 * Die REINE Ableitung der Betriebs-Sicht auf die Komponenten-Welt der Flotte
 * (Einheitsmodell Stufe 6).
 *
 * <p>Sie beantwortet drei Betriebsfragen je Anlage: wo werden die Geräte
 * gepflegt, woher stammen ihre Anbindungen, und wo steht Soll ≠ Ist.
 *
 * <p><b>⚠ Nichts hier erfindet einen Zustand.</b> Was die Box nicht gemeldet
 * hat, ist „unbekannt" - nie 0, nie „nicht angekommen". Die Wörter für den
 * Soll/Ist-Stand sind WÖRTLICH die des Servers (`in_sync`/`pending`/
 * `unreported`), damit Flotten-Sicht und Anlagen-Fläche nie Verschiedenes
 * behaupten.
 */

export interface FlottenQuellen {
  builtin: number;
  certified: number;
  custom: number;
  composed: number;
  unknown: number;
}

export interface FlottenSchreibzugang {
  controlPoints: number;
  platformActivated: number;
  templateWrites: number;
  certSource?: string | null;
  platformCertVerdict?: string | null;
  platformCertModel?: string | null;
}

export interface FlottenAnlage {
  siteId: string;
  siteName: string;
  tenantId: string;
  tenantName: string;
  componentAuthority: string;
  componentsAdoptedAt?: string | null;
  componentsAdoptedBy?: string | null;
  componentCount: number;
  sources?: FlottenQuellen | null;
  privateTemplates: number;
  syncStatus: string;
  refusedRevision?: string | null;
  refusedReason?: string | null;
  appliedAt?: string | null;
  write?: FlottenSchreibzugang | null;
}

export type Ton = 'ok' | 'warn' | 'off';

export interface Etikett {
  label: string;
  ton: Ton;
}

/** Wo die Geräte dieser Anlage gepflegt werden. */
export function pflegeOrt(authority: string | null | undefined): Etikett {
  return authority === 'portal'
    ? { label: 'Im Portal', ton: 'ok' }
    : { label: 'An der Box', ton: 'off' };
}

/**
 * Soll gegen Ist.
 *
 * <p>⚠ `unreported` ist bewusst NICHT der Warnton: „die Box hat sich noch
 * nicht geäußert" ist keine Störung, und eine Flotte, in der jede stille
 * Anlage rot leuchtet, macht die echte Abweichung unsichtbar.
 */
export const SOLL_IST: Record<string, Etikett> = {
  in_sync: { label: 'Angewandt', ton: 'ok' },
  pending: { label: 'Ausstehend', ton: 'warn' },
  unreported: { label: 'Nicht gemeldet', ton: 'off' },
};

export function sollIst(status: string | null | undefined): Etikett {
  return (status && SOLL_IST[status]) || { label: 'Unbekannt', ton: 'off' };
}

/** Woher die Anbindungen stammen, als ein Satz - nur was da ist. */
export function quellenText(q: FlottenQuellen | null | undefined): string {
  if (!q) return 'Noch keine Komponenten';
  const teile: string[] = [];
  if (q.builtin) teile.push(`${q.builtin}× Katalog`);
  if (q.certified) teile.push(`${q.certified}× geprüfte Vorlage`);
  if (q.custom) teile.push(`${q.custom}× Selbstbau`);
  if (q.composed) teile.push(`${q.composed}× aus den Stammdaten`);
  if (q.unknown) teile.push(`${q.unknown}× ohne Angabe`);
  return teile.length ? teile.join(' · ') : 'Noch keine Komponenten';
}

/**
 * Die drei Freigabe-Stufen des Konzepts (§3.3) in EINER Anzeige.
 *
 * <p>⚠ `certSource` ist DREIWERTIG: fehlt es, heißt das „unbekannt", NIE
 * „nicht freigegeben" - wer die zwei zusammenfallen lässt, schickt einen
 * Kunden zu einem Prüfstand, den er nicht braucht.
 */
export const FREIGABE_QUELLE: Record<string, string> = {
  platform: 'Von der Plattform freigegeben',
  device: 'Am Gerät selbst freigegeben',
  env: 'Flottenweit freigegeben',
};

export interface FreigabeSicht {
  /** Der Satz - `null`, wenn diese Anlage gar nichts Schreibbares hat. */
  text: string | null;
  ton: Ton;
  /** Die Belege, jeder für sich - sie kommen aus verschiedenen Quellen. */
  belege: string[];
}

export function freigabe(w: FlottenSchreibzugang | null | undefined): FreigabeSicht {
  if (!w || (!w.controlPoints && !w.platformActivated && !w.templateWrites)) {
    return { text: null, ton: 'off', belege: [] };
  }
  const belege: string[] = [];
  if (w.platformActivated) {
    belege.push(
      `${w.platformActivated} ${w.platformActivated === 1 ? 'Gerät' : 'Geräte'} scharfgeschaltet`,
    );
  }
  if (w.templateWrites) {
    belege.push(`${w.templateWrites}× über eine geprüfte Vorlage`);
  }
  if (w.certSource && FREIGABE_QUELLE[w.certSource]) {
    belege.push(FREIGABE_QUELLE[w.certSource]);
  }
  if (!w.certSource) {
    belege.push('Herkunft der Freigabe nicht gemeldet');
  }
  return {
    text: `${w.controlPoints} ${w.controlPoints === 1 ? 'Komponente' : 'Komponenten'} darf schreiben`,
    ton: w.platformActivated || w.templateWrites ? 'ok' : 'off',
    belege,
  };
}

/**
 * Der Grund, warum die Box eine Fassung ABGELEHNT hat - der einzige echte
 * Alarm dieser Fläche.
 *
 * <p>Er reist NEBEN der angewandten Fassung, nie an ihrer Stelle: was läuft,
 * ist weiterhin die zuletzt wirklich angewandte.
 */
export function ablehnung(a: FlottenAnlage): string | null {
  if (!a.refusedReason) return null;
  const fassung = a.refusedRevision ? ` (Fassung ${a.refusedRevision})` : '';
  return `Die Box hat eine Fassung abgelehnt${fassung}: ${a.refusedReason}`;
}

/** Die Zeilen, die AUFMERKSAMKEIT brauchen - Ablehnung zuerst, dann ausstehend. */
export function braucheAufmerksamkeit(sites: FlottenAnlage[]): FlottenAnlage[] {
  return sites
    .filter((s) => s.refusedReason || s.syncStatus === 'pending')
    .sort((a, b) => (a.refusedReason ? 0 : 1) - (b.refusedReason ? 0 : 1));
}

/**
 * Der Kopf-Satz. Er zählt nur BELEGTES und nennt Stilles getrennt - aus einer
 * stillen Anlage folgt keine Aufgabe.
 */
export function kopfSatz(sites: FlottenAnlage[]): string {
  if (!sites.length) return 'Noch keine Anlage angelegt.';
  const portal = sites.filter((s) => s.componentAuthority === 'portal').length;
  const box = sites.length - portal;
  const teile = [`${portal} im Portal gepflegt`];
  if (box) teile.push(`${box} noch an der Box`);
  const still = sites.filter((s) => s.syncStatus === 'unreported').length;
  if (still) teile.push(`${still} ohne Rückmeldung`);
  return teile.join(' · ');
}

/** Der Selbstbau-Anteil - der Long Tail, den der Support kennen muss. */
export function selbstbauZeilen(sites: FlottenAnlage[]): FlottenAnlage[] {
  return sites.filter((s) => (s.sources?.custom ?? 0) > 0 || s.privateTemplates > 0);
}
