# Tagesvektoren der Steuerlogik

Drei nachgebaute Tage aus dem Referenzlabor des Steuerlogik-Konzepts (14.11.2026), Vertrag [docs/contracts/v2/steuerlogik.md](../../../../../../docs/contracts/v2/steuerlogik.md).
Die Vorlage (Home-Assistant-Nachbau) steuert eine nachgebaute Anlage; dieselbe Aufzeichnung geht in den Kern (Logik `heizung-treu`, Minutenraster 60 s).
Alle Namen sind erfunden.

Je Tag zwei Dateien:

- `<tag>.eingaben.csv.gz`: je Sekunde Sonnenstand, Netz (W), Batterie (W, + = laden), Ladestand, drei Temperaturen und der Relaisstand davor; leere Spalte = unverändert, `x` = kein Wert.
- `<tag>.erwartet.json.gz`: was der Referenz-Kern des Labors daraus entschieden hat — Stufenwechsel (44, 87, 46; zusammen 177) mit Schritt und Grund, je Sekunde Heizstufe, Netzheizen, Sperre, Vorrang, Lage und die drei Ausgänge (lauflängenkodiert), dazu jeder Lagewechsel mit gerendertem Satz.

`tage_test.go` spielt die Eingaben durch den Go-Kern und verlangt Deckungsgleichheit in jeder Sekunde.
Die Werte sind auf 3 bis 4 Nachkommastellen gerundet abgelegt; das Labor hat belegt, dass der Referenz-Kern auf den gerundeten Eingaben dieselben Entscheidungen trifft wie auf den vollen.
Die Dateien sind Vertragsvektoren: nicht neu erzeugen oder ändern, ohne dass der Vertrag es sagt.
