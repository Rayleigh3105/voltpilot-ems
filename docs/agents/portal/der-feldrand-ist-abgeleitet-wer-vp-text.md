# ⚠ Der FELDRAND ist ABGELEITET — wer `--vp-text-gray` anfasst, verschiebt ihn mit

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 30).


`--vp-field-border` ist kein eigener Farbwert, sondern
`color-mix(in srgb, var(--vp-text-gray) 80%, var(--vp-surface))` — es existiert, weil der Rand
eines Eingabefeldes die EINZIGE Angabe ist, wo das Feld anfängt, und deshalb die 3:1-Grenze für
Nicht-Text-Kontrast halten muss (WCAG 1.4.11; `--vp-border` liegt bei 1,19:1, `--vp-gray` bei
1,49:1). Wächter ist `src/fieldBorder.test.ts`, das den Mix NACHRECHNET statt ihn nachzuschlagen.

- **Die Ableitung ist die Falle.** PR 479 stimmte den Mix auf das damalige `--vp-text-gray`
  (`#6C757D`) ab: Ruhe-Rand 3,21:1, Fokus-Rand `--vp-primary-deep` 3,276:1 — ein Abstand von
  **0,07**. Als der Mobile-UX-Commit `c2ceb32e` das Neutral für AA auf `--vp-surface-alt` auf
  `#66717C` nachdunkelte, wanderte der Ruhe-Rand auf 3,35:1 **mit** und überholte den Fokus-Rand;
  Fokussieren las sich damit als Rücknahme. Beide Commits waren für sich richtig — die KOPPLUNG
  hat niemand gesehen. **Wer ein Neutral retuned, führt `src/fieldBorder.test.ts` aus.**
- **⚠ Der FOKUS-Rand eines Feldes ist `--vp-action`, nie eine Marken-Nuance.** `--vp-action` ist
  das Interaktions-Blau des Hauses (7,97:1 auf Weiss, trägt auch `--vp-focus-ring-color`);
  `--vp-primary-deep` ist laut `colors.css` dekorativ („gradient end, active nav") und wurde aus
  demselben Grund schon einmal von `--vp-link` abgezogen („3.1:1 - failed AA"). Der Abstand ist
  jetzt ~4,6 statt 0,07 und überlebt eine Neutral-Korrektur.
- **⚠ `Input` (`designsystem/components/forms/Input.jsx`) und der `VpPicker`-Auslöser
  (`src/components/VpPicker.css`) tragen DASSELBE Fokus-Token** — der Auslöser sitzt neben echten
  Feldern und fällt sonst auf. Die Zusage stand bis 08/2026 nur im Kommentar und galt nicht (der
  Picker nahm `--vp-action`, `Input` `--vp-primary-deep`); der Test liest das Token seither aus
  BEIDEN Dateien und vergleicht sie, statt es festzuschreiben.
- Das Portal hat **kein Dunkel-Thema** (kein `prefers-color-scheme`/`data-theme` in
  `designsystem/` oder `src/`) — es gibt genau einen Token-Satz zu prüfen.

