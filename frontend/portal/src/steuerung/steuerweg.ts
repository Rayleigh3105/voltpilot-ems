/**
 * Wie die Regeln und Steuerarten einer Anlage laufen (Steuerlogik Stufe 6, Zusammenführen; Vertrag `steuerlogik.md`):
 * auf dem bisherigen Weg (Node-RED auf der Docker-Box, die Verbraucherregel und der Heizstab-Regler der Box) oder auf
 * dem neuen (die Box rechnet selbst, im Kern der Regelsprache). Keine Anlage wechselt still: der Schalter ist ab Werk
 * aus; an rechnet der neue Weg nur zum Vergleich mit, erst „Übernehmen“ lässt ihn schalten, und „Zurück“ wirkt sofort.
 * Der Schalter hat zwei Gruppen: die Regeln (auf Edge Light und Edge Industrie immer der neue Weg) und die Geräte
 * mit Steuerart oder Heizstab-Regler (auf allen Box-Arten). Ein Schritt bewegt jede Gruppe, die ihn gehen kann.
 * Rein und getestet (`steuerweg.test.ts`); die Karte rendert nur, was hier entsteht.
 */
import type { SteuerwegAntwort, SteuerwegGeraet, SteuerwegRegel, SteuerwegStand, SteuerwegVergleich } from '../api';

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
  /** Die Schritte, die der Schalter jetzt anbietet (leer auf Edge Light, Edge Industrie oder ohne Box). */
  knoepfe: Knopf[];
  /** Ein Grund, warum es keinen Schritt gibt, obwohl es Regeln gibt (etwa ein Update der Box). */
  hinweis: string | null;
}

type Wegstand = 'alt' | 'mitlauf' | 'kern';

/** Die Gruppen des Schalters, die an dieser Anlage etwas tragen, mit ihrem Stand. */
interface Gruppen {
  /** Regeln gibt es (oder ihr Schalter ist an); `null` ohne. */
  regeln: { modus: Wegstand; schaltbar: boolean } | null;
  geraete: { modus: Wegstand; schaltbar: boolean } | null;
}

function gruppen(a: SteuerwegAntwort): Gruppen {
  const s = a.stand;
  // Edge Light und Edge Industrie (Go-Kern): Regeln laufen dort immer im Kern.
  const light = s.boxArt === 'light' || s.boxArt === 'industrie';
  const regeln = s.regeln.length > 0 || (!light && s.modus !== 'alt')
    ? { modus: (light ? 'kern' : s.modus) as Wegstand, schaltbar: !light } : null;
  const geraete = s.geraete.length > 0 || s.geraeteModus !== 'alt'
    ? { modus: s.geraeteModus, schaltbar: true } : null;
  return { regeln, geraete };
}

/** Ob der Abschnitt etwas zu sagen hat: nur mit Regeln oder Steuerarten, oder wenn der Schalter schon an ist. */
export function sichtbar(a: SteuerwegAntwort | null): boolean {
  if (!a) return false;
  const g = gruppen(a);
  return g.regeln != null || g.geraete != null;
}

/** Die Überschrift nennt, was an dieser Anlage läuft. */
export function abschnittTitel(a: SteuerwegAntwort): string {
  const g = gruppen(a);
  if (g.regeln && g.geraete) return 'Wie Ihre Regeln und Steuerarten laufen';
  return g.geraete ? 'Wie Ihre Steuerarten laufen' : 'Wie Ihre Regeln laufen';
}

/** „Ihre Regeln“, „Ihre Steuerarten“, „Ihre Regeln und Steuerarten“ für die Gruppen einer Liste. */
function wasWort(regeln: boolean, geraete: boolean): string {
  if (regeln && geraete) return 'Ihre Regeln und Steuerarten';
  return geraete ? 'Ihre Steuerarten' : 'Ihre Regeln';
}

export function wegAnsicht(a: SteuerwegAntwort): WegAnsicht {
  const s = a.stand;
  if (s.boxArt == null) {
    return { titel: 'Bisheriger Weg', pille: { klasse: 'off', wort: 'bisher' }, satz: 'Die Anlage hat keine eindeutige Box.', knoepfe: [], hinweis: null };
  }
  const g = gruppen(a);
  const light = s.boxArt === 'light' || s.boxArt === 'industrie';
  const alle = [g.regeln, g.geraete].filter((x): x is { modus: Wegstand; schaltbar: boolean } => x != null);
  const schaltbar = alle.filter((x) => x.schaltbar);
  const imVergleich = schaltbar.some((x) => x.modus === 'mitlauf');
  const imKern = schaltbar.some((x) => x.modus === 'kern');
  const kannMitlauf = (g.regeln?.schaltbar === true && g.regeln.modus === 'alt' && s.boxKannMitlauf && s.regeln.length > 0)
    || (g.geraete != null && g.geraete.modus === 'alt' && s.boxKannSteuerarten && s.geraete.length > 0);
  const darf = a.darf;
  const knoepfe: Knopf[] = [];
  if (darf && kannMitlauf) knoepfe.push({ schritt: 'mitlauf', wort: 'Vergleich starten', art: 'primaer' });
  if (darf && imVergleich && s.boxKannScharf) knoepfe.push({ schritt: 'uebernehmen', wort: 'Übernehmen', art: 'primaer' });
  if (darf && imKern) knoepfe.push({ schritt: 'zurueck', wort: 'Zurück zum bisherigen Weg', art: 'sekundaer' });
  else if (darf && imVergleich) knoepfe.push({ schritt: 'zurueck', wort: 'Vergleich beenden', art: 'sekundaer' });

  // Ein Update, das ein Schritt braucht, steht da, statt dass der Knopf still fehlt.
  let hinweis: string | null = null;
  if (g.geraete?.modus === 'alt' && s.geraete.length > 0 && !s.boxKannSteuerarten) {
    hinweis = 'Für den neuen Weg der Steuerarten braucht die Box ein Update.';
  }
  if (g.regeln?.schaltbar && g.regeln.modus === 'alt' && s.regeln.length > 0 && !s.boxKannMitlauf) {
    hinweis = 'Für den neuen Weg braucht die Box ein Update.';
  }
  if (imVergleich && !s.boxKannScharf) hinweis = 'Zum Übernehmen braucht die Box ein Update.';
  if (light && g.regeln && !s.boxKannScharf) hinweis = 'Für Regeln braucht diese Box ein Update.';

  if (imVergleich) {
    return {
      titel: 'Vergleich läuft',
      pille: { klasse: 'wait', wort: 'Vergleich' },
      satz: 'Der neue Weg rechnet mit, geschaltet wird wie bisher. Stimmen beide überein, übernehmen Sie.',
      knoepfe,
      hinweis,
    };
  }
  const neu = alle.filter((x) => x.modus === 'kern');
  if (neu.length === alle.length && alle.length > 0) {
    const nurRegelnLight = light && g.geraete == null;
    return {
      titel: 'Neuer Weg',
      pille: { klasse: 'on', wort: 'neuer Weg' },
      satz: nurRegelnLight ? 'Diese Box rechnet jede Regel selbst und schaltet danach.'
        : `Die Box rechnet ${wasWort(g.regeln != null, g.geraete != null)} selbst und schaltet danach.${imKern ? ' Zurück geht jederzeit sofort.' : ''}`,
      knoepfe,
      hinweis,
    };
  }
  if (neu.length > 0) {
    // Teils: was schon im Kern läuft, und was noch den bisherigen Weg geht.
    const regelnNeu = g.regeln?.modus === 'kern';
    return {
      titel: 'Teils neuer Weg',
      pille: { klasse: 'wait', wort: 'teils neu' },
      satz: `Die Box rechnet ${wasWort(regelnNeu, !regelnNeu)} schon selbst. ${wasWort(!regelnNeu, regelnNeu)} laufen wie bisher; auch sie rechnet der neue Weg, erst nur zum Vergleich.`,
      knoepfe,
      hinweis,
    };
  }
  return {
    titel: 'Bisheriger Weg',
    pille: { klasse: 'off', wort: 'bisher' },
    satz: `${wasWort(g.regeln != null, g.geraete != null)} laufen wie bisher. Der neue Weg rechnet sie in der Box selbst: erst nur zum Vergleich, dann auf Ihren Schritt.`,
    knoepfe,
    hinweis,
  };
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

/** Eine Zeile je Weg: die Pille und der Satz einer Regel oder eines Geräts. */
function zeile(weg: SteuerwegRegel['weg'], v: SteuerwegVergleich | null, gruende: string[]): { pille: Pille; satz: string | null } {
  switch (weg) {
    case 'mitlauf': {
      const jetzt = v ? `Neuer Weg: ${standText(v.wunsch)}, geschaltet: ${standText(v.ist)}.` : 'Die Box meldet den Vergleich gleich.';
      const tag = vergleichSatz(v);
      // Auf einen Blick: weicht der neue Weg heute ab, oder rechnet er bisher gleich?
      const pille: Pille = (v?.abweichend_s ?? 0) > 0 ? { klasse: 'wait', wort: 'weicht ab' }
        : (v?.verglichen_s ?? 0) > 0 ? { klasse: 'done', wort: 'gleich' } : { klasse: 'wait', wort: 'Vergleich' };
      return { pille, satz: tag ? `${jetzt} ${tag}` : jetzt };
    }
    case 'kern': {
      const halt = v?.halt?.text ?? v?.konflikt?.text ?? null;
      const satz = halt ?? (v ? `Die Box will: ${standText(v.wunsch)}.` : 'Die Box meldet sich gleich.');
      return { pille: { klasse: halt ? 'lock' : 'on', wort: 'neuer Weg' }, satz };
    }
    case 'aus':
      return { pille: { klasse: 'lock', wort: 'läuft nicht' }, satz: gruende.join(' ') || null };
    default:
      return { pille: { klasse: 'off', wort: 'bisher' }, satz: gruende.join(' ') || null };
  }
}

export function regelZeile(r: SteuerwegRegel): RegelZeile {
  return { flowId: r.flowId, name: r.name, ...zeile(r.weg, r.vergleich, r.gruende) };
}

export interface GeraetZeile {
  entityId: string;
  name: string;
  /** Was das Gerät führt: „Steuerart“ oder „Heizstab-Regler“. */
  art: string;
  pille: Pille;
  satz: string | null;
}

export function geraetZeile(g: SteuerwegGeraet): GeraetZeile {
  return { entityId: g.entityId, name: g.name, art: g.art === 'heizstab' ? 'Heizstab-Regler' : 'Steuerart',
    ...zeile(g.weg, g.vergleich, g.gruende) };
}

function anzahl(n: number, eins: string, viele: string): string {
  return n === 1 ? `1 ${eins}` : `${n} ${viele}`;
}

/** Was der Dialog vor „Übernehmen“ nennt: was sich ändert und was gleich bleibt. */
export function uebernehmenFolgen(a: SteuerwegAntwort): string[] {
  const regeln = [...a.stand.regeln, ...a.stand.geraete];
  const neu = regeln.filter((r) => r.weg === 'mitlauf');
  const bleiben = regeln.filter((r) => r.weg === 'alt');
  const abweichend = neu.filter((r) => (r.vergleich?.abweichend_s ?? 0) > 0);
  const neueRegeln = a.stand.regeln.filter((r) => r.weg === 'mitlauf').length;
  const neueGeraete = a.stand.geraete.filter((r) => r.weg === 'mitlauf').length;
  const was = [neueRegeln ? anzahl(neueRegeln, 'Regel', 'Regeln') : null,
    neueGeraete ? anzahl(neueGeraete, 'Steuerart', 'Steuerarten') : null].filter(Boolean).join(' und ');
  const out = [`Die Box schaltet ${was || anzahl(0, 'Regel', 'Regeln')} selbst; der bisherige Weg gibt sie ab.`];
  if (abweichend.length) {
    out.push(`Heute wichen die Wege ab bei: ${abweichend.map((r) => `„${r.name}“`).join(', ')}.`);
  }
  if (bleiben.length) {
    out.push(`Auf dem bisherigen Weg bleiben: ${bleiben.map((r) => `„${r.name}“`).join(', ')}.`);
  }
  out.push(`${wasWort(a.stand.regeln.length > 0, a.stand.geraete.length > 0)}, Schutzgrenzen und Eingriffe bleiben, wie sie sind. Zurück geht jederzeit sofort.`);
  return out;
}
