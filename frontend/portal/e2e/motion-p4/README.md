# Bewegungs-Beweis P4 — App-Start und Login-Bühne

Misst am **Produktions-Build**, nicht am Dev-Server: der Dev-Server liefert
unminifiziertes JS über eine Modul-Kette und macht jede Start-Zahl unbrauchbar.

## Voraussetzungen

* Die Cloud-API läuft (`docker compose up -d`, api auf `:8090`, Keycloak auf `:8081`).
* **Port 5173** ist frei. ⚠ Er ist nicht beliebig: der Dev-Realm kennt genau
  `http://localhost:5173` als Rückleit-URL, jede andere Portnummer lehnt Keycloak
  beim Anmelden ab. Über `P4_PORT` überschreibbar, wenn der Realm es hergibt.
* Zwei Builds nebeneinander, damit „vorher gegen nachher" paarweise messbar ist:

```bash
cd frontend/portal
npm run build && mv dist dist_nach          # dieser Zweig
git stash -u && npm run build && mv dist dist_vor && git stash pop   # oder aus origin/main
```

## Lauf

```bash
node e2e/motion-p4/proof.mjs            # alle Abschnitte
node e2e/motion-p4/proof.mjs b f        # nur einzelne
```

Die Zusammenfassung landet in `P4_OUT` (Vorgabe:
`~/IdeaProjects/firstmate/data/vp-motion-p4-start-login/proof.txt`).

## Abschnitte

| | Frage |
|---|---|
| a | Start bei 375 px, CPU 4× + Fast 3G: kein Frame ohne Skelett UND ohne Inhalt; Staffel samt Deckel |
| b | FCP/LCP/CLS **paarweise** vorher gegen nachher, 9 Paare in EINER Sitzung |
| f | Diagnose: derselbe Build ohne Staffel bzw. mit Staffel ohne `opacity` |
| c | reduzierte Bewegung: Skelett sofort weg, keine Staffel |
| d | Login bei 1440: Karte 260 ms, Laufpunkte 1,8 s, reduziert still |
| e | zweiter Besuch derselben Sitzung: keine Staffel |

## ⚠ Zwei Fallen, die schon falsche Zahlen erzeugt haben

1. **`page.goto` auf dieselbe Adresse ist eine Selbe-Dokument-Navigation** (nur der
   Hash wechselt). Kein neues Dokument heißt: kein `addInitScript`, kein Boot-Skelett,
   leere Messreihe. Nur `page.reload()` startet den App-Start wirklich neu — außer in
   Abschnitt (e), wo die Hash-Navigation genau der Gegenstand ist.
2. **Blockmessung taugt hier nicht.** LCP fällt auf Cockpit-Inhalt, der erst nach der
   Antwort der Cloud-API erscheint; deren Streuung (100…870 ms) ist ein Vielfaches
   des gesuchten Effekts. „Erst 9× nachher, dann 9× vorher" lieferte für denselben
   Code einmal −116 ms und einmal +368 ms. Gemessen wird deshalb abwechselnd im
   selben Tab.
