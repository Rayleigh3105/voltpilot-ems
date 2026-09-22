# Welt „Bewertung“ im Portal (AP-16 IP-6, Meilenstein M1)

Adressen `#/portfolio/bewertung` (Umfang und Einsätze) und `#/portfolio/bewertung/{id}` (ein Einsatz). Ableitungen im
reinen Modul `frontend/portal/src/bewertung.ts`; Flächen `BewertungPage`, `EnergieeinsatzSeite`, `UmfangDialog`,
`EnergieeinsatzDialoge`. Routen: [Bewertung §8](../../contracts/v2/bewertung.md#8-routen-ip-4-b1b4b5-r5r14) und
[Umfang](uems-bewertung-umfang.md).

- Erscheinen: Bereich `bewertung` in `ebenenNav.ebenenBereiche` nach der Berichte-Regel UND `EbenenLesemodell.bewertung`
  (`energieeinsatz.ansehen` aus `/me`, am Unternehmen oder an einem Standort). Ohne das Feld gibt es keinen Bereich —
  deshalb bleibt die geteilte Bühne `e2e/startansicht.tsx` bei sechs Unternehmens-Kacheln; die Welt hat ihre eigene
  Bühne `e2e/bewertung.html` (`?person=IK|PH|JW&stand=leer|voll&ee=EE-n`).
- M1 rechnet nichts: der Umfang zeigt nur die Anlagenzahl der Route („am … im Umfang: 3 Anlagen“, nur y), keinen
  Nenner in kWh (IP-9). `keine_werte` ist ein Abzeichen, nie eine Null.
- Anlegen/Ändern/Beenden und Umfang nur mit `energieeinsatz.verwalten` (Unternehmen); lesende Rollen sehen einen Satz
  statt der Knöpfe (R14). Prozess und Träger ändern sich nie — Bearbeiten schickt nur geänderte Teile an ihre Route.
- Prozess-Picker: Prozesse ohne laufenden Einsatz stehen als „Vorschlag“ oben; ein Prozess mit laufendem Einsatz des
  gewählten Trägers bleibt sichtbar, gesperrt, mit „läuft bereits: EE-…“. 409 `einsatz_laeuft_bereits` wird zum Satz
  mit dem laufenden Einsatz (`bewertung.ablehnung`).
- ⚠ Grenz-Satz: `copy.test.ts` (Block „Bewertung“, `BEWERTUNG_FLAECHEN`) verlangt ihn je Datei — wörtlich oder als
  JSX-Kind `>{UEMS_NORMGRENZE}<`; ein reiner Import zählt nicht. Neue Bewertungs-Flächen dort eintragen.
- ⚠ Offene Lücken der Routen (nicht nachgebaut): das Protokoll liefert `zeit`, `openapi.yaml` nennt es nicht; eine
  Einflussgröße trägt nur `bezugsgroesse_id` — die Einsatz-Seite liest dafür den Bezugsgrößen-Katalog nach.
- Nachweis: `src/bewertung.test.ts`, `e2e/bewertung.spec.ts` (375/1440; `BEWERTUNG_BILDER=<Ordner>` legt die Bilder ab).
