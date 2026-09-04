# Browser-Beweis · Bewegungs-Programm P5 (Seitenwechsel)

jsdom kennt die View-Transitions-API nicht — die sechs Zusagen von P5 lassen
sich deshalb NUR im echten Browser messen. `proof.mjs` tut das; es ist Werkzeug,
kein Testlauf (keine CI-Verdrahtung, kein PNG im Repo).

```bash
npm run dev                                   # Login demo/demo, Demo-Stack muss stehen
VP_BASE=http://localhost:5173/ node e2e/motion-p5/proof.mjs
```

⚠ **`VP_BASE` muss `localhost` sein, nicht `127.0.0.1`** — der Realm lässt nur
`http://localhost:<port>` als Ursprung zu. Auf einem anderen Port als 5173
braucht es zusätzlich einen Vite-Proxy `/api → :8090` (oder eine geweitete
`VOLTPILOT_CORS_ALLOWED_ORIGINS`), sonst misst der Lauf eine Fläche ohne Daten.

⚠ **Echte 375 nachweisen**, nie `window.innerWidth` (das zählt die Bildlaufleiste
mit): das Skript berichtet `document.documentElement.clientWidth`.

## Warum über `getAnimations()` und nicht per Bildvergleich

Die Richtung eines Seitenwechsels ist eine Aussage über eine ANIMATION, nicht
über ein Pixelmuster: `document.getAnimations()` nennt zum `ready`-Zeitpunkt der
Transition den Animationsnamen, das Pseudo (`::view-transition-old/new(root)`),
die aufgelöste Dauer und die Keyframes. Damit ist „schiebt von rechts" exakt und
umbenennungsfest belegt (`vp-vt-kommt-von-rechts` gegen `vp-vt-kommt-von-links`),
statt aus einem Standbild geschätzt — dieselbe Begründung, aus der der
Bündel-Wächter die Sourcemap liest statt zu `grep`en.

## Was gemessen wird

| Fall | Frage |
|---|---|
| (a) | Schiebt 375 in der richtigen Richtung, und steht die Schale? |
| (b) | Blendet 1440 nur — auch unter `vp-vt-push`/`-pop`? |
| (c) | Kosten die Übergänge Bilder? (vorher/nachher auf DEMSELBEN Stand, CPU 4×) |
| (d) | Verstummt der Seitenwechsel über den EINEN Schalter? |
| (e) | Ohne die Browser-API: der Schnitt von heute, ohne Fehler? |
| (f) | Zwei schnelle Wechsel: nichts gestapelt, Ziel korrekt? |

⚠ **(c) braucht seinen RAUSCHBODEN.** „Vorher" ist derselbe Build OHNE
`document.startViewTransition` — dann läuft `commit` byte-identisch den Pfad von
main. Zwei Läufe auf demselben Stand schwankten gemessen um ±90 ms auf dem
längsten Long Task; eine Aussage „nicht schlechter" ist erst darunter belastbar.
