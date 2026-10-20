import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import type { AufbauKategorie } from '../aufbauBaum';

/**
 * Das einfarbige Symbol einer Zeile der Aufbau-Tabelle - die Kategorie färbt nur das Zeichen.
 *
 * Eigene, winzige Datei statt eines Exports aus `AufbauTabelle.tsx` (Alerting Scheibe 2,
 * Nachbesserung 3/3 - Bündel-Befund): `GeraeteKatalog.tsx` und `Einrichten.tsx` brauchen NUR dieses
 * Symbol, sind aber selbst von mehreren Stellen aus statisch erreichbar - ein Import aus der
 * großen `AufbauTabelle.tsx` zog deren ganzes Modul (Tabelle, Zeilen) mit in jeden
 * Chunk, der dieses Symbol brauchte, und trieb den Einstieg über sein Gewicht (`test/bundle-smoke.sh`,
 * 256 kB gz, schon ohne Luft).
 */
export function AufbauSymbol({ kategorie, icon }: { kategorie: AufbauKategorie | 'anlage'; icon: IconName }) {
  return (
    <span className={`vp-auf-sym is-${kategorie}`} aria-hidden="true">
      <Icon name={icon} size={15} />
    </span>
  );
}
