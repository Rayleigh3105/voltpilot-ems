import { useEffect, useState } from 'react';
import { api } from './api';
import { rechteAus, type BerichtRechte } from './berichtDialoge';

/**
 * Was die Person an Berichten darf (UEMS AP-12 IP-14) — gelesen aus der Selbstauskunft `GET /api/v1/me`.
 *
 * - `undefined`: die Antwort fehlt noch — schreibende Hebel stehen noch nicht da (kein Aufblitzen für einen Leser).
 * - `null`: die Selbstauskunft ist nicht zu haben — die Hebel stehen da, und die Route entscheidet mit ihrem Satz.
 */
export function useBerichtRechte(): BerichtRechte | null | undefined {
  const [rechte, setRechte] = useState<BerichtRechte | null | undefined>(undefined);
  useEffect(() => {
    let aktiv = true;
    api.selbstauskunft().then(
      (s) => aktiv && setRechte(rechteAus(s)),
      () => aktiv && setRechte(null),
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return rechte;
}
