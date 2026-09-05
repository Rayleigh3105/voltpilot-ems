# Bewegung · P7 — die Gesamtmessung

`proof.mjs` ist die **Schluss-Messung des Bewegungs-Programms**: EIN Aufruf,
EINE Zusammenfassung (18 Zeilen), gegen den fertigen Stand aller Pakete. Er
ersetzt keinen Test — er ist Werkzeug, wie die Rigs von P0/P1/P4/P5, auf denen
er aufbaut (`../motion-lab`, `../motion-p4`, `../motion-p5`).

## Aufruf

```bash
cd frontend/portal
docker compose --profile optimize up -d        # nur für (g), im Repo-Wurzelverzeichnis
npx vite build                                 # (a)–(g) messen gegen dist/
node e2e/motion-p7/proof.mjs                   # alles
node e2e/motion-p7/proof.mjs a d               # einzelne Abschnitte
```

Umgebung: `P7_OUT` (Ziel der Zusammenfassung), `P7_PY` (Python MIT Pillow, für
(f)), `VP_SITE`, `VP_ADMIN`/`VP_ADMIN_PW`, `P7_PORT`.

## Die sieben Abschnitte

| | misst | Zusage |
|---|---|---|
| a | Datei-Inventar aller CSS-Blätter | `transition: all` = 0 · nackte Dauern = 0 · jeder Dauer-Loop benannt |
| b | reduced-motion-Sweep über 8 Flächen bei 375 | keine laufende Animation, nirgends |
| c | Bildrate bei 375 / CPU 4× je Seitenwechsel + Zeitraumwechsel | keine langen Frames außer Nachlade-Long-Tasks |
| d | Cockpit-Start, 9 Läufe, gedrosselt UND als Paar gegen `origin/main` | CLS ≤ 0,05, Median wie Einzelsprung |
| e | 1440: Hover-Lift, Seitenwechsel | 1 px in 120 ms · der Rechner BLENDET |
| f | angehaltene Aufdeck-Frames eines Balken-Charts (Rig aus P1) | 0 Spalten „zu niedrig" |
| g | die zwei Admin-Charts des Optimizers | beide zeichnen, Reveal genau 1× je Chart, Bild unverändert |

## Drei Fallen, die beim Bau dieses Rigs aufgegangen sind

1. **Port 5173 ist Pflicht.** Der Dev-Realm von Keycloak kennt nur
   `http://localhost:5173/*` als Rückleit-Adresse. Antwortet dort schon jemand,
   bricht das Skript ab, statt über fremden Code zu messen.
2. **Die Anlage mit Daten ist `…0002`** („Demo Site Berlin"), nicht die `…0012`
   aus dem P5-Rig — die ist im lokalen Stack leer, und jede Chart-Messung dort
   misst das Nichts.
3. **Erst sichtbar machen, dann messen.** Der Aufdeck-Haken hängt an einem
   `IntersectionObserver` (Schwelle 0,15). Wer nicht scrollt, misst „kein
   Reveal" und meint „kaputt".

## Was der Vergleich gegen `origin/main` braucht

(d) und (g) vergleichen zwei Stände am selben Rechner im selben Moment — die
Zahlen anderer Pakete stammen von anderen Tagen und tragen deren Maschinenlast.
Dafür muss `dist_vor/` daneben liegen; ohne das misst der Beweis nur den
eigenen Stand und sagt das:

```bash
git archive origin/main | tar -x -C /tmp/vp-main
ln -s "$PWD/node_modules" /tmp/vp-main/node_modules
(cd /tmp/vp-main && npx vite build --outDir dist_vor) && cp -R /tmp/vp-main/dist_vor .
```

`dist_vor/` ist Labor und gehört NICHT ins Repo — hinterher löschen.
