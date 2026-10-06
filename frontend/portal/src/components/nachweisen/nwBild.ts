/**
 * Nachweisen, Konzept n1 Runde 2 (§0.3, §12): die reinen Teile der Zeilen-Bausteine. Hier wird nichts entschieden;
 * Zustand, Frist und Folge kommen aus der Route, hier stehen nur Datumsblock, Kürzel und die Legende des Folgen-Balkens.
 */
import type { FristBild } from '../../wiedervorlage';

/** Zustands-Zeichen einer Folge oder eines Schritts: erledigt, läuft, überfällig, ohne Folge. */
export type ZustandArt = 'done' | 'laeuft' | 'ueber' | 'ohne';
/** Ton des Datumsblocks (wie die Wiedervorlage): überfällig, demnächst, erledigt, im Plan. */
export type DatumTon = 'ueber' | 'bald' | 'erledigt' | 'plan';

export const ZUSTAND_WORT: Record<ZustandArt, string> = {
  done: 'erledigt',
  laeuft: 'läuft',
  ueber: 'überfällig',
  ohne: 'ohne Folge',
};

/**
 * Der Datumsblock eines Tags: kleines Wort („bis“, „seit“, „frei“, leer), darüber Tag und Monat, darunter das Jahr.
 * Vorleser hören den ganzen Satz („bis 22.01.2030“). Ohne Tag gibt es keinen Block: Unbekannt ist kein Datum.
 */
export function datumsblock(wort: string, iso: string | null | undefined): Pick<FristBild, 'wort' | 'tag' | 'jahr' | 'satz'> | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const tag = `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
  const jahr = iso.slice(0, 4);
  return { wort, tag, jahr, satz: `${wort ? `${wort} ` : ''}${tag}${jahr}` };
}

/** „Ines Kaltenbach“ → „IK“; ein Name aus einem Wort ergibt zwei Buchstaben. Ohne Namen kein Kürzel. */
export function kuerzelAus(name: string | null | undefined): string {
  const teile = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!teile.length) return '';
  if (teile.length === 1) return teile[0].slice(0, 2).toUpperCase();
  return `${teile[0][0]}${teile[teile.length - 1][0]}`.toUpperCase();
}

/** Eine Zeile der Legende unter dem Folgen-Balken: Art, Zahl, Wort (Einzahl und Mehrzahl, „1 läuft“, „2 laufen“). */
export type LegendenTeil = { art: ZustandArt; zahl: number; wort: string };

const LEGENDE_WORT: Record<ZustandArt, [string, string]> = {
  done: ['erledigt', 'erledigt'],
  laeuft: ['läuft', 'laufen'],
  ueber: ['überfällig', 'überfällig'],
  ohne: ['ohne Folge', 'ohne Folge'],
};
const LEGENDE_REIHE: ZustandArt[] = ['done', 'laeuft', 'ueber', 'ohne'];

/** Die Legende des Folgen-Balkens: nur Arten, die vorkommen, in fester Reihe. */
export function folgenLegende(zustaende: ZustandArt[]): LegendenTeil[] {
  return LEGENDE_REIHE.map((art) => {
    const zahl = zustaende.filter((z) => z === art).length;
    return { art, zahl, wort: LEGENDE_WORT[art][zahl === 1 ? 0 : 1] };
  }).filter((t) => t.zahl > 0);
}

/** Der Satz für Vorleser zum Folgen-Balken: „3 erledigt, 2 laufen, 1 ohne Folge“. */
export const folgenSatz = (zustaende: ZustandArt[]) =>
  folgenLegende(zustaende)
    .map((t) => `${t.zahl} ${t.wort}`)
    .join(', ');
