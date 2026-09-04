/**
 * **Die EINE Liste der fokussierbaren Elemente einer Dialogfläche.**
 *
 * Sie wohnt im Design-System, weil hier die Fläche entsteht, die den Fokus
 * halten muss (`Modal`); `src/components/VpPanel.tsx` reicht sie unter dem
 * eingeführten Namen `fokussierbare` weiter, damit Bottom-Sheet, Picker und
 * die zentrierten Rückfragen dieselbe Liste lesen. Ein zweiter Selektor wäre
 * genau der Zwilling, der lautlos abdriftet - dieselbe Begründung, mit der der
 * BottomSheet auf den EINEN Fokusfallen-Mechanismus zeigt.
 */
export function fokussierbareElemente(el) {
  if (!el) return [];
  return Array.from(
    el.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}
