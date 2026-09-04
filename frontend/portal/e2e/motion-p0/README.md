# Browser-Beweis · Bewegungs-Programm P0

jsdom kennt kein `@property`, keine Kaskade über Media-Queries und keine
Sourcemaps — die drei Zusagen von P0 lassen sich deshalb NUR im echten Browser
messen. Diese drei Skripte tun das; sie sind Werkzeug, kein Testlauf (keine
CI-Verdrahtung, kein PNG im Repo).

Voraussetzung: der Dev-Server läuft und der Demo-Stack steht.

```bash
npm run dev -- --host 127.0.0.1 --port 5173   # Login demo/demo
npx playwright install chromium webkit
```

| Skript | Frage | Aufruf |
|---|---|---|
| `proof.mjs` | Löst die Familie auf? Verstummt sie? Läuft etwas über? | `VP_BASE=http://localhost:5173/ node e2e/motion-p0/proof.mjs [--webkit] [--shots DIR]` |
| `diff.mjs` | Sieht die Fläche anders aus als vorher? | `node e2e/motion-p0/diff.mjs VORHER_DIR NACHHER_DIR` |
| `noprop-probe.mjs` | Was macht ein Browser OHNE `@property` (Safari < 16.4)? | `node e2e/motion-p0/noprop-probe.mjs` |

⚠ **`VP_BASE` muss `localhost` sein, nicht `127.0.0.1`** — die Keycloak-Weiche
des Realms lässt nur `http://localhost:5173` als Ursprung zu, sonst landet der
Lauf auf der Anmeldeseite und misst die falsche Fläche (genau so passiert).

⚠ **Ein Bild-Vergleich braucht seinen RAUSCHBODEN.** Das Cockpit zeigt Live-Werte
und eine Uhr; zwei Läufe auf DEMSELBEN Code unterscheiden sich gemessen um
0,03–1,16 % der Pixel. Eine Aussage „unverändert" ist erst belastbar, wenn der
Vorher/Nachher-Abstand darunter liegt — dafür immer zusätzlich zweimal auf
demselben Stand fotografieren und beide Zahlen nennen.

⚠ **Echte 375 nachweisen**, nie `window.innerWidth` (das zählt die Bildlaufleiste
mit): `proof.mjs` berichtet `document.documentElement.clientWidth`.
