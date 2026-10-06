/**
 * Der Rückweg aus einer Messstelle in DIESELBE Trefferliste (Konzept Messen m1, §6.3: „‹ Alle Messstellen“ führt in
 * dieselbe Trefferliste zurück). Die Liste merkt sich ihre Adresse samt Suche und Filter (`?suche=druck&ort=G-1`);
 * die Seite einer Messstelle liest sie, wenn sie zu derselben Liste gehört - sonst gilt die Liste der Ebene ohne
 * Parameter. Gemerkt wird nur im Speicher dieser Sitzung: ein Neuladen beginnt mit der ganzen Liste.
 */
let gemerkt: string | null = null;

/** Die Adresse der Liste, so wie sie gerade steht. */
export function merkeListe(hash: string): void {
  gemerkt = hash;
}

/** Die gemerkte Adresse, wenn sie zur Liste `pfad` gehört (`#/portfolio/messstellen`, `#/standort/{id}/messstellen`). */
export function listeZurueck(pfad: string): string | null {
  if (!gemerkt) return null;
  return gemerkt.split('?')[0] === pfad ? gemerkt : null;
}
