import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StellungZeile } from '../uemsBilanz';

type Json = any;

/**
 * Die zeitgültigen elektrischen Stellungen ALLER Messstellen des Referenzunternehmens
 * (`docs/contracts/v2/uems-referenzunternehmen.json`, `messstellen[].elektrische_stellung`) in der
 * Form von `restAusStellung` (AP-10 IP-4). Die Bilanz-Tests lesen sie von dort und nicht aus einer
 * Kopie in der Vektor-Datei. vitest läuft mit cwd = frontend/portal.
 */
export const stellungenDesReferenzunternehmens = (): StellungZeile[] => {
  const referenz: Json = JSON.parse(
    readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/uems-referenzunternehmen.json'), 'utf8'),
  );
  return (referenz.messstellen as Json[]).flatMap((m: Json) =>
    (m.elektrische_stellung as Json[]).map((st: Json) => ({
      messstelle: m.kennzeichen,
      anlage: st.anlage,
      stellung: st.stellung,
      richtung: m.hauptgroesse.richtung,
      art: m.art,
      medium: m.medium,
      unterzaehler_von: st.unterzaehler_von,
      ab: st.gueltig_ab,
      bis: st.gueltig_bis,
    })),
  );
};
