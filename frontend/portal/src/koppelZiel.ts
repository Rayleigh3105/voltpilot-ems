/**
 * Wohin die Box aus dem QR-Code nach der Anmeldung führt (Konzept vp-qr-einstieg, QE-2 A).
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`): `App.tsx` lädt es erst nach, wenn wirklich
 * eine Referenz gemerkt ist - das erste Bild trägt die Weiche nicht. Die Referenz selbst und ihr Speicher
 * wohnen in `koppelLink.ts`. Reines Modul.
 */

export type KoppelZiel =
  /** Der Einrichtungs-Assistent bietet die Referenz im Schritt „Box“ an; die Adresse bleibt. */
  | { art: 'assistent' }
  /** Diese Adresse öffnen (Aufbau mit „Box hinzufügen“ oder die Werkstatt). */
  | { art: 'adresse'; hash: string }
  /** Mehrere Anlagen: der Kunde wählt, an welcher die Box steht (dann Aufbau dieser Anlage). */
  | { art: 'wahl' }
  /** Die Box steht schon in der eigenen Geräteliste (F-2, M10). */
  | { art: 'schonDeins'; deviceId: string; siteId: string }
  /** Das Konto darf keine Box verbinden (F-9, M12) - nie still verwerfen. */
  | { art: 'ohneRecht' };

/**
 * Wo die gemerkte Referenz hingehört, sobald feststeht, wer angemeldet ist, welche Anlagen und Boxen
 * es gibt und was das Konto darf. `aufbau` baut die Adresse des Aufbaus (`nav.aufbauHash`),
 * `werkstatt` die der Werkstatt. Die Vorprüfung „gehört schon zu Ihnen“ liest nur die eigene
 * Geräteliste (keine neue Route); ob die Box frei ist, sagt erst das Verbinden selbst.
 */
export function koppelZiel(
  ref: string,
  lage: {
    admin: boolean;
    siteIds: readonly string[];
    /** Die eigenen Boxen (`GET /devices`), Referenz und Anlage. */
    boxen: readonly { id: string; externalRef: string; siteId: string }[];
    /** Recht „Anlage anlegen“ (nur ohne Anlage nötig). */
    darfAnlegen: boolean;
    /** Recht „Geräte einrichten“ (`geraet.einrichten`) - irgendwo im Konto. */
    darfVerbinden: boolean;
    aufbau: (siteId: string, ref: string) => string;
    werkstatt: (ref: string) => string;
  },
): KoppelZiel {
  if (lage.admin) return { art: 'adresse', hash: lage.werkstatt(ref) };
  const eigene = lage.boxen.find((b) => b.externalRef.toLowerCase() === ref);
  if (eigene) return { art: 'schonDeins', deviceId: eigene.id, siteId: eigene.siteId };
  if (!lage.darfVerbinden) return { art: 'ohneRecht' };
  if (lage.siteIds.length === 0) return lage.darfAnlegen ? { art: 'assistent' } : { art: 'ohneRecht' };
  if (lage.siteIds.length === 1) return { art: 'adresse', hash: lage.aufbau(lage.siteIds[0], ref) };
  return { art: 'wahl' };
}
