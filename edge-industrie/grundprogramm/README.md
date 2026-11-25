# Grundprogramm: die Boot-Applikation des Basisprojekts

Hier liegt, wenn vorhanden, genau eine Datei: die von CODESYS erzeugte Boot-Applikation des
Basisprojekts (Online › Bootapplikation erzeugen), wie der Captain sie nach
[`voltpilot-sps/basisprojekt/EINSPIELEN.md`](../../../voltpilot-sps/basisprojekt/EINSPIELEN.md)
(Schritt 9, "An den Werkstattdienst übergeben") an diesen Ordner übergibt - nicht das `.project`,
nicht die Lizenz-Angabe, nur die Boot-Applikation.

Diese Datei entsteht nicht in diesem Repository und nicht automatisch: Niemand hier kompiliert ein
CODESYS-Projekt. `edge-industrie/scripts/release.sh` packt nur, was in diesem Ordner liegt, zu
`edge-industrie-grundprogramm.tar.gz` und hängt sie an eine Edge-Industrie-Fassung an, wenn (und nur
wenn) dieser Ordner eine Datei enthält.

## Ohne Datei: kein Grundprogramm in dieser Fassung

Solange hier keine Datei liegt (Stand 25.11.2026: noch keine - der Captain liefert sie erst), baut
`release.sh` die Fassung trotzdem, nur ohne diesen Anhang. Der Werkstatt-Dienst stellt das beim
Einrichten eines PFC200 fest (Schritt `grundprogramm`, Fall `pfc_kein_grundprogramm`) und hält mit
einem Handgriff an - er nimmt nie an, dass "kein Anhang" "egal" heißt.

## Herkunft (Audit-Spur)

Die Datei selbst trägt keine Herkunft; `HERKUNFT.md` daneben hält von Hand fest, aus welchem Commit des
Repositorys `voltpilot-sps` (Ordner `basisprojekt/`) sie stammt - für die Nachvollziehbarkeit, nicht als
automatischer Abgleich. Wer eine neue Boot-Applikation einspielt, aktualisiert beide Dateien zusammen.

## Was hier NICHT passiert

- Keine Prüfung, ob die Datei tatsächlich eine gültige CODESYS-Boot-Applikation ist: Das kann nur
  CODESYS selbst beim Erzeugen und die Laufzeit beim Laden beweisen (siehe PS-P14,
  `services/werkstatt-dienst/internal/pfc200/schritte_grundprogramm.go`).
- Kein automatischer Abruf aus `voltpilot-sps`: Das Basisprojekt ändert sich selten (nur wenn der
  Captain ein neues CODESYS-Projekt übergibt), nicht mit jeder Edge-Industrie-Fassung - ein Live-Fetch
  aus einem zweiten Repository bei jedem Release-Lauf wäre Komplexität ohne Nutzen dafür.
