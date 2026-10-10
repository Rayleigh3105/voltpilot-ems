import { useMemo } from 'react';
import { useRollen } from './rollen';
import { rechteAus, type BerichtRechte } from './berichtDialoge';

/** Berichte lesen denselben /me-Stand wie alle Kundenflächen. Unbekannt gibt kein Recht. */
export function useBerichtRechte(): BerichtRechte | undefined {
  const { selbst } = useRollen();
  return useMemo(() => selbst ? rechteAus(selbst) : undefined, [selbst]);
}
