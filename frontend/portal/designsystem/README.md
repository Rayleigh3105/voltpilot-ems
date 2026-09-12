# Designsystem

Tokens, gemeinsame Komponenten und kompakte visuelle Referenzen des Portals. Komponentenregeln stehen direkt daneben in `*.prompt.md`.

Mit dem Vite-Entwicklungsserver des Portals öffnen:

- `/designsystem/components/core/buttons.card.html`
- `/designsystem/components/core/cards.card.html`
- `/designsystem/components/forms/forms.card.html`

`preview.jsx` rendert die aktuellen React-Komponenten mit fiktiven Beispielen. Die Vorschauen benötigen keinen separat erzeugten Bundle und laden keine React-/Babel-Laufzeit von einem CDN. Sie sind Entwicklungsseiten und werden nicht in das Portal-Produktionsbundle importiert.

`guidelines/*.card.html` zeigt Farben, Typografie und Abstände. Werte aus `tokens/` beziehen; sichtbare Zahlenbeispiele bei Tokenänderungen mitpflegen. Marken- und Font-Dateien: [Assets](assets/README.md).
