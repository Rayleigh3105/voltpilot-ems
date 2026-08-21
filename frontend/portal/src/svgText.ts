/**
 * Die EINE Textkappung für handgezeichnete SVG-Bilder des Portals.
 *
 * SVG kennt keinen Umbruch und keine Ellipse: ein Text, der breiter ist als
 * sein Kasten, läuft einfach darüber hinaus - und zwar erst auf dem Rechner
 * des Kunden, mit dessen Schriftmetrik, nie im Test. Deshalb bekommt jede
 * Zeile, die knapp werden KANN, ein `textLength` mit
 * `lengthAdjust="spacingAndGlyphs"`: der Browser staucht sie dann mit seinen
 * ECHTEN Metriken in den Kasten, statt dass wir raten.
 *
 * `undefined` heißt „passt bequem" - eine Zeile ohne `textLength` wird nie
 * gestaucht UND nie gestreckt (ein bedingungsloses `textLength` zöge kurze
 * Zeilen auf die volle Breite auseinander, was schlimmer aussieht als das
 * Problem).
 *
 * Die Schätzung ist absichtlich grob und eher großzügig: sie darf lieber
 * einmal zu oft kappen als eine Zeile über den Rand laufen lassen.
 *
 * Sie stand als private Hilfe in `soVerdient.ts` (dem Erlös-Bild) und wohnt
 * jetzt neutral hier, weil das Struktur-Schaltbild dieselbe Disziplin braucht -
 * zwei Schätzungen derselben Sache laufen irgendwann auseinander, und dann
 * kappen zwei Bilder desselben Portals verschieden.
 */
export function capTextLength(text: string, fontSize: number, max: number): number | undefined {
  const geschaetzt = text.length * fontSize * 0.66;
  return geschaetzt > max ? max : undefined;
}
