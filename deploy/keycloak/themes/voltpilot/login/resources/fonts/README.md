# Schriften des Login-Themes

Inter (Fliesstext) und Inter Tight (Ueberschriften) — dieselben zwei Familien,
die das Portal benutzt (`frontend/portal/designsystem/tokens/typography.css`).

**Warum gebuendelt und nicht von Google Fonts geladen:** die Anmeldeseite ist
die eine Seite, die JEDER Kunde sieht, bevor er dem Portal irgendetwas
anvertraut hat. Ein Aufruf an einen Dritt-Host waere dort eine
Datenschutz-Aussage, die wir nicht treffen wollen, und in einem Netz ohne
Internet-Ausgang (Betriebshof, Insellage) wuerde die Seite ihre Schrift gar
nicht bekommen.

**Zwei Dateien fuer sechs Schnitte:** beides sind VARIABLE Schriften
(`wght` 100–900), Googles CSS liefert fuer 400/500/600/700 dieselbe Datei aus.
`@font-face` in `../css/voltpilot.css` gibt deshalb `font-weight: 100 900` an —
wer einen Schnitt ergaenzen will, aendert dort nichts.

**Untermenge:** nur `latin` (U+0000–00FF u. a.). Deutsche Umlaute und ß liegen
darin; `latin-ext` (Polnisch, Tschechisch, …) ist nicht enthalten, weil der
Realm `de` und `en` fuehrt. Kommt eine Sprache dazu, kommt die passende
Untermenge dazu — der Fallback-Stack des Portals traegt sie bis dahin.

| Datei | Quelle | Stand |
|---|---|---|
| `inter-latin.woff2` | Google Fonts `Inter` v20, Untermenge `latin` | 23.08.2026 |
| `inter-tight-latin.woff2` | Google Fonts `Inter Tight` v9, Untermenge `latin` | 23.08.2026 |

Lizenz: SIL Open Font License 1.1 — der volle Text liegt als `OFL.txt` daneben
(die OFL verlangt, dass er die Schriften begleitet).
