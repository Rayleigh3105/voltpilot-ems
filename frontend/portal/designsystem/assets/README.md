# Marken-Assets

| Datei | Was es ist | Wo es benutzt wird |
|---|---|---|
| `voltpilot-logo.png` | 2040 × 816, das Zeichen mit grosszuegigem transparentem Rand (292 KB) | Seitenleiste der App (`shell/AppShell.tsx`) |
| `voltpilot-wordmark.png` | 640 × 152, auf die Wortmarke BESCHNITTEN (9 KB) | Anmelde-/Registrierungs-Buehne (`components/AuthScreen.tsx`) und - als Kopie - das Keycloak-Login-Theme |

**Warum zwei Dateien.** Die Anmeldeseite ist die erste Seite, die ein Kunde
sieht, und sie laedt sie UNANGEMELDET ueber irgendeine Leitung; dort zaehlt
jedes Kilobyte, und der transparente Rand der grossen Datei ist dort nur
Ballast (das Zeichen fuellt darin ~40 % der Flaeche). Die Seitenleiste laedt
ihr Logo dagegen erst, wenn die App ohnehin steht - sie behaelt die
Bestandsdatei, damit dieser Umbau ihr Layout nicht anfasst.

**⚠ Die Wortmarke ist das FINALE Asset, kein Platzhalter** (Captain-Antwort
23.08.2026: ein SVG des Logos gibt es nicht). Erzeugt aus `voltpilot-logo.png`
durch Zuschnitt auf die Alpha-Bounding-Box (+6 px Luft) und Skalierung auf
640 px Breite, Palette auf 255 Farben (mittlerer Fehler 0,55/255 - unsichtbar).
Sie liegt hier UND unter `deploy/keycloak/themes/voltpilot/login/resources/img/`
(Keycloak kann nicht in den Portal-Baum greifen) - wer die Marke erneuert,
tauscht beide.

## Schriften (`fonts/`)

| Datei | Was es ist | Wo es benutzt wird |
|---|---|---|
| `fonts/inter-latin.woff2` | Inter, variabel (`wght` 100–900), Untermenge `latin` (48 KB) | `designsystem/tokens/fonts.css` (`@font-face`), Fliesstext |
| `fonts/inter-tight-latin.woff2` | Inter Tight, variabel, Untermenge `latin` (45 KB) | dieselbe Datei, Ueberschriften |
| `fonts/OFL.txt` | SIL Open Font License 1.1 | muss die Schriften begleiten (Lizenzauflage) |

**Warum gebuendelt statt von Google geladen** (Perf-Review `vp-cockpit-perf-p7`
§2 U3): der fruehere `@import` auf `fonts.googleapis.com` stand am Anfang des
gebuendelten Stylesheets, war damit render-BLOCKIEREND und zwang das
Boot-Skelett, auf eine fremde Origin (DNS + TLS) zu warten — gemessen
−0,33 s kalter FCP allein im Labor. Die Begruendung und die Folgen fuer CSP,
Cache-Politik und Keycloak-Lockstep stehen ausfuehrlich im Kopf von
`designsystem/tokens/fonts.css`.

**⚠ Byte-identisch mit dem Keycloak-Login-Theme**
(`deploy/keycloak/themes/voltpilot/login/resources/fonts/`, das dieselben zwei
Dateien aus demselben Grund traegt — Keycloak kann nicht in den Portal-Baum
greifen). Wer eine Fassung erneuert, tauscht BEIDE, sonst zeigen Anmeldeseite
und Portal verschiedene Schriften.
