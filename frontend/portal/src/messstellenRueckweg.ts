/**
 * Der Rückweg aus einer Messstelle in DIESELBE Trefferliste (Konzept Messen m1, §6.3: „‹ Alle Messstellen“ führt in
 * dieselbe Trefferliste zurück). Die Liste merkt sich ihre Adresse samt Suche und Filter (`?suche=druck&ort=G-1`);
 * die Seite einer Messstelle liest sie, wenn sie zu derselben Liste gehört - sonst gilt die Liste der Ebene ohne
 * Parameter. Gemerkt wird nur im Speicher dieser Sitzung: ein Neuladen beginnt mit der ganzen Liste.
 */
let gemerkt: string | null = null;

/**
 * Die Adresse der Liste, so wie sie gerade steht - ohne den Sprung der Wiedervorlage (`entscheid=`): er gilt beim
 * Ankommen einmal, der Rückweg von einer Messstelle löst den Blick nicht noch einmal aus.
 */
export function merkeListe(hash: string): void {
  const [pfad, ...rest] = hash.split('?');
  const p = new URLSearchParams(rest.join('?'));
  p.delete('entscheid');
  const q = p.toString();
  gemerkt = `${pfad}${q ? `?${q}` : ''}`;
}

/** Die gemerkte Adresse, wenn sie zur Liste `pfad` gehört (`#/portfolio/messstellen`, `#/standort/{id}/messstellen`). */
export function listeZurueck(pfad: string): string | null {
  if (!gemerkt) return null;
  return gemerkt.split('?')[0] === pfad ? gemerkt : null;
}
