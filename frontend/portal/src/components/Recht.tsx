import type { ReactNode } from 'react';
import { useRollen } from '../rollen';

/** Ein verbotener Hebel wird zum Satz. Fremde Ziele bleiben unsichtbar. */
export function Recht({ aktion, standort, rueckwirkend = false, children }: {
  aktion: string | readonly string[];
  standort?: string | null;
  /** Eine vergangene Gültigkeit braucht zusätzlich die eigene Matrix-Zeile. */
  rueckwirkend?: boolean;
  children: ReactNode;
}) {
  const rollen = useRollen();
  const ziel = standort === undefined ? rollen.standort : standort;
  if ((typeof aktion === 'string' ? [aktion] : aktion).some(a => rollen.darf(a, ziel))
    && (!rueckwirkend || rollen.darf('aenderung.rueckwirkend', ziel))) return <>{children}</>;
  if (!rollen.selbst || (ziel !== null && !rollen.selbst.standorte.some((s) => s.id === ziel))) return null;
  return <span className="vp-muted vp-recht-hinweis" role="note">{rollen.grund}</span>;
}
