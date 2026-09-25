import type { ReactNode } from 'react';
import { SAETZE } from '../energiemanagement';
import { mitEinsicht } from '../energiemanagementPortal';
import { useRollen } from '../rollen';
import { Recht } from './Recht';

/** Der Leer-Satz für „Einsicht“ (UEMS AP-19 IP-13, §5.8): an der Stelle eines Schreib-Knopfs, nie ein Knopf. */
export function EinsichtSatz() {
  return (
    <span className="vp-muted vp-recht-hinweis" role="note" data-testid="einsicht-satz">
      {SAETZE.einsicht_schreibversuch}
    </span>
  );
}

const darfEine = (rollen: ReturnType<typeof useRollen>, aktion: string | readonly string[], standort: string | null | undefined) => {
  const ziel = standort === undefined ? rollen.standort : standort;
  return (typeof aktion === 'string' ? [aktion] : aktion).some((a) => rollen.darf(a, ziel));
};

/**
 * Ein Schreib-Knopf im Energiemanagement (UEMS AP-19 IP-13, RE3): wer darf, sieht den Knopf; wer die Rolle „Einsicht“
 * hat, liest an seiner Stelle „Mit ‚Einsicht‘ können Sie hier nichts ändern. …“; alle anderen den Satz von `Recht`.
 */
export function EinsichtRecht({ aktion, standort, children }: { aktion: string | readonly string[]; standort?: string | null; children: ReactNode }) {
  const rollen = useRollen();
  if (!darfEine(rollen, aktion, standort) && mitEinsicht(rollen.selbst)) return <EinsichtSatz />;
  return (
    <Recht aktion={aktion} standort={standort}>
      {children}
    </Recht>
  );
}

/**
 * Eine Gruppe von Schreib-Knöpfen (jeder mit eigenem `Recht`): mit „Einsicht“ und keinem der Rechte EIN Satz statt je
 * Knopf einer; sonst bleibt die Gruppe, wie sie ist.
 */
export function EinsichtGruppe({ aktion, standort, children }: { aktion: readonly string[]; standort?: string | null; children: ReactNode }) {
  const rollen = useRollen();
  if (!darfEine(rollen, aktion, standort) && mitEinsicht(rollen.selbst)) return <EinsichtSatz />;
  return <>{children}</>;
}
