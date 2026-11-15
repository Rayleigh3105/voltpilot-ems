/**
 * Wie die Regeln einer Anlage laufen (Steuerlogik Stufe 6, Zusammenführen; Vertrag `steuerlogik.md`): auf dem
 * bisherigen Weg (Node-RED auf der Docker-Box) oder auf dem neuen (die Box rechnet jede Regel selbst, im Kern der
 * Regelsprache). Keine Anlage wechselt still: der Schalter ist ab Werk aus; an rechnet der neue Weg nur zum Vergleich
 * mit, erst „Übernehmen“ lässt ihn schalten, und „Zurück“ wirkt sofort. Auf einer Edge Light gibt es nur den neuen
 * Weg. Rein und getestet (`steuerweg.test.ts`); die Karte rendert nur, was hier entsteht.
 */
import type { SteuerwegAntwort, SteuerwegRegel, SteuerwegStand, SteuerwegVergleich } from '../api';

export type Schritt = 'mitlauf' | 'uebernehmen' | 'zurueck';

export interface Pille {
  klasse: 'on' | 'wait' | 'off' | 'lock' | 'done';
  wort: string;
}

export interface Knopf {
  schritt: Schritt;
  wort: string;
  art: 'primaer' | 'sekundaer';
}

export interface WegAnsicht {
  titel: string;
  pille: Pille;
  satz: string;
  /** Die Schritte, die der Schalter jetzt anbietet (leer auf einer Edge Light oder ohne Box). */
  knoepfe: Knopf[];
  /** Ein Grund, warum es keinen Schritt gibt, obwohl es Regeln gibt (etwa ein Update der Box). */
  hinweis: string | null;
}

/** Ob der Abschnitt etwas zu sagen hat: nur mit Regeln, oder wenn der Schalter schon an ist. */
export function sichtbar(a: SteuerwegAntwort | null): boolean {
  if (!a) return false;
  return a.stand.regeln.length > 0 || (a.stand.boxArt === 'docker' && a.stand.modus !== 'alt');
}

export function wegAnsicht(a: SteuerwegAntwort): WegAnsicht {
  const s = a.stand;
  if (s.boxArt === 'light') {
    return {
      titel: 'Neuer Weg',
      pille: { klasse: 'on', wort: 'neuer Weg' },
      satz: 'Auf dieser Box rechnet die Box jede Regel selbst.',
      knoepfe: [],
      hinweis: s.boxKannScharf ? null : 'Für Regeln braucht diese Box ein Update.',
    };
  }
  if (s.boxArt == null) {
    return { titel: 'Bisheriger Weg', pille: { klasse: 'off', wort: 'bisher' }, satz: 'Die Anlage hat keine eindeutige Box.', knoepfe: [], hinweis: null };
  }
  const darf = a.darf;
  switch (s.modus) {
    case 'mitlauf':
      return {
        titel: 'Vergleich läuft',
        pille: { klasse: 'wait', wort: 'Vergleich' },
        satz: 'Der neue Weg rechnet mit, geschaltet wird wie bisher. Stimmen beide überein, übernehmen Sie.',
        knoepfe: darf ? [
          ...(s.boxKannScharf ? [{ schritt: 'uebernehmen' as const, wort: 'Übernehmen', art: 'primaer' as const }] : []),
          { schritt: 'zurueck', wort: 'Vergleich beenden', art: 'sekundaer' },
        ] : [],
        hinweis: s.boxKannScharf ? null : 'Zum Übernehmen braucht die Box ein Update.',
      };
    case 'kern':
      return {
        titel: 'Neuer Weg',
        pille: { klasse: 'on', wort: 'neuer Weg' },
        satz: 'Die Box rechnet Ihre Regeln selbst und schaltet danach. Zurück geht jederzeit sofort.',
        knoepfe: darf ? [{ schritt: 'zurueck', wort: 'Zurück zum bisherigen Weg', art: 'sekundaer' }] : [],
        hinweis: null,
      };
    default:
      return {
        titel: 'Bisheriger Weg',
        pille: { klasse: 'off', wort: 'bisher' },
        satz: 'Ihre Regeln laufen wie bisher. Der neue Weg rechnet sie in der Box selbst: erst nur zum Vergleich, dann auf Ihren Schritt.',
        knoepfe: darf && s.boxKannMitlauf && s.regeln.length > 0 ? [{ schritt: 'mitlauf', wort: 'Vergleich starten', art: 'primaer' }] : [],
        hinweis: s.boxKannMitlauf ? null : 'Für den neuen Weg braucht die Box ein Update.',
      };
  }
}

/** „2 Std 10 Min“, „45 s“, „0 s“ aus Sekunden; Zahl und Einheit bleiben zusammen (geschütztes Leerzeichen). */
export function dauerText(s: number): string {
  const sek = Math.max(0, Math.round(s));
  if (sek < 60) return `${sek}\u00a0s`;
  const min = Math.floor(sek / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${min}\u00a0Min`;
  return `${h}\u00a0Std${m ? ` ${m}\u00a0Min` : ''}`;
}

/** Ein Stand in Worten: „an“, „aus“, „Stufe 2“, „21 °C“; unbekannt bleibt unbekannt. */
export function standText(st: SteuerwegStand | undefined): string {
  if (!st) return 'unbekannt';
  if (st.stufe != null) return st.stufe === 0 ? 'aus' : `Stufe ${st.stufe}`;
  if (st.ein != null) return st.ein ? 'an' : 'aus';
  if (st.sollwert != null) return `${st.sollwert.toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C`;
  if (st.betriebsart) return st.betriebsart;
  return 'kein Wunsch';
}

/** Der Vergleich des Tages als ein Satz; `null` ohne Meldung der Box. */
export function vergleichSatz(v: SteuerwegVergleich | null): string | null {
  if (!v || v.verglichen_s == null) return null;
  if (v.verglichen_s <= 0) return 'Heute noch kein Vergleich.';
  const ab = v.abweichend_s ?? 0;
  const basis = `Heute ${dauerText(v.verglichen_s)} verglichen`;
  if (ab <= 0) return `${basis}, immer gleich.`;
  const laengst = v.laengste_abweichung_s != null && v.laengste_abweichung_s > 0
    ? ` (längstens ${dauerText(v.laengste_abweichung_s)})` : '';
  return `${basis}, ${dauerText(ab)} verschieden${laengst}.`;
}

export interface RegelZeile {
  flowId: string;
  name: string;
  pille: Pille;
  /** Was die Box jetzt tut oder warum die Regel nicht auf dem neuen Weg läuft. */
  satz: string | null;
}

export function regelZeile(r: SteuerwegRegel): RegelZeile {
  const v = r.vergleich;
  switch (r.weg) {
    case 'mitlauf': {
      const jetzt = v ? `Neuer Weg: ${standText(v.wunsch)}, geschaltet: ${standText(v.ist)}.` : 'Die Box meldet den Vergleich gleich.';
      const tag = vergleichSatz(v);
      // Auf einen Blick: weicht der neue Weg heute ab, oder rechnet er bisher gleich?
      const pille: Pille = (v?.abweichend_s ?? 0) > 0 ? { klasse: 'wait', wort: 'weicht ab' }
        : (v?.verglichen_s ?? 0) > 0 ? { klasse: 'done', wort: 'gleich' } : { klasse: 'wait', wort: 'Vergleich' };
      return { flowId: r.flowId, name: r.name, pille, satz: tag ? `${jetzt} ${tag}` : jetzt };
    }
    case 'kern': {
      const halt = v?.halt?.text ?? v?.konflikt?.text ?? null;
      const satz = halt ?? (v ? `Die Box will: ${standText(v.wunsch)}.` : 'Die Box meldet sich gleich.');
      return { flowId: r.flowId, name: r.name, pille: { klasse: halt ? 'lock' : 'on', wort: 'neuer Weg' }, satz };
    }
    case 'aus':
      return { flowId: r.flowId, name: r.name, pille: { klasse: 'lock', wort: 'läuft nicht' }, satz: r.gruende.join(' ') || null };
    default:
      return { flowId: r.flowId, name: r.name, pille: { klasse: 'off', wort: 'bisher' }, satz: r.gruende.join(' ') || null };
  }
}

/** Was der Dialog vor „Übernehmen“ nennt: was sich ändert und was gleich bleibt. */
export function uebernehmenFolgen(a: SteuerwegAntwort): string[] {
  const regeln = a.stand.regeln;
  const neu = regeln.filter((r) => r.weg === 'mitlauf');
  const bleiben = regeln.filter((r) => r.weg === 'alt');
  const abweichend = neu.filter((r) => (r.vergleich?.abweichend_s ?? 0) > 0);
  const out = [
    neu.length === 1 ? 'Die Box schaltet 1 Regel selbst; der bisherige Weg gibt sie ab.'
      : `Die Box schaltet ${neu.length} Regeln selbst; der bisherige Weg gibt sie ab.`,
  ];
  if (abweichend.length) {
    out.push(`Heute wichen die Wege ab bei: ${abweichend.map((r) => `„${r.name}“`).join(', ')}.`);
  }
  if (bleiben.length) {
    out.push(`Auf dem bisherigen Weg bleiben: ${bleiben.map((r) => `„${r.name}“`).join(', ')}.`);
  }
  out.push('Ihre Regeln, Schutzgrenzen und Eingriffe bleiben, wie sie sind. Zurück geht jederzeit sofort.');
  return out;
}
