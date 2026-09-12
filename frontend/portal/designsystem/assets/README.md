# Marken-Assets

| Datei | Verwendung |
|---|---|
| `voltpilot-logo.png` | Bestandslogo mit transparentem Rand, Seitenleiste |
| `voltpilot-wordmark.png` | Kompakte Wortmarke, Anmeldung/Registrierung und Keycloak |
| `fonts/inter-latin.woff2` | Variable Fließtextschrift |
| `fonts/inter-tight-latin.woff2` | Variable Überschriftenschrift |
| `fonts/OFL.txt` | SIL Open Font License 1.1; begleitet die Schriften |

Die Wortmarke ist das freigegebene Raster-Asset, kein SVG-Platzhalter. Wortmarke und Schriften liegen auch im Keycloak-Theme unter `deploy/keycloak/themes/voltpilot/login/resources/`; Änderungen an beiden Auslieferungsorten synchron halten.

Schriften werden lokal geladen. Die Untermenge `latin` enthält deutsche Umlaute und ß, aber nicht alle Zeichen weiterer Sprachen. Einbindung über `tokens/fonts.css`; bei zusätzlichen Sprachen den Zeichensatz prüfen.
