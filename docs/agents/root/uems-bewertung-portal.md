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

## Rangliste und Einstufung (AP-16 IP-12, Meilenstein M2)

Die bestehende Seite `#/portfolio/bewertung` liest für den letzten vollen Monat `…/bewertung/rangliste` und zeigt
Rang, Menge, Anteil, Balken, K1–K3, K5/K6, Vorschlag, Anlagenrest und weitere Träger. Die Einsatzseite liest
`…/{id}/einstufungen`; frühere Fassungen bleiben auch nach einer Rückstufung sichtbar. Einstufen sendet den
vollständigen Herkunftsentwurf der Rangliste unverändert. `energieeinsatz.einstufen` und `bewertung.kriterien` kommen
ausschließlich aus `/me`; ohne sie bleiben alle Angaben lesbar, aber ohne Schreibknöpfe.

- Kriterien ändern schreibt acht Vertragswerte plus Pflichtbegründung. Der ehrliche Sofort-Hinweis nennt nur die neue
  Wirkung auf Rangliste und Vorschlag: Bewertungsstände entstehen erst mit IP-21, ihr Anstoß mit IP-23/IP-25.
- ⚠ `BewertungPage` lädt die Einstufungshistorien zusätzlich zur Rangliste, weil die Ranglistenroute keine aktuelle
  Einstufung trägt. Der Vorschlag heißt immer Vorschlag und ändert nie selbst eine Einstufung.
- Nachweis: `src/bewertung.test.ts`; `e2e/bewertung.spec.ts` prüft Pflichtbegründung, Abweichung, Vier-Augen,
  Kriterien und Rückstufungshistorie bei 375/1440.

## Messabdeckung, Messmittel und Toleranz (AP-16 IP-18, Meilenstein M3)

`#/portfolio/bewertung` zeigt unter der Rangliste die Abdeckungs-Tabelle (`components/MessabdeckungTabelle.tsx`, reines
Modul `src/uemsMessabdeckung.ts`) aus `…/bewertung/messabdeckung`: je Einsatz und je Ort gemessen · geplant · Ersatz ·
ungemessen, Rest-Zeilen je Anlage, Summe mit K8. Darüber die Prüfaufgaben-Zeile, auf der Einsatzseite die Karte
„Messmittel“ (`components/EinsatzMessmittel.tsx`: Messstelle → führende Quelle der Hauptgröße → `…/geraete/{id}/messmittel`).
Die Geräteseite trägt das Messmittel-Blatt mit Dialog (`components/MessmittelBlatt.tsx`, reines Modul `src/uemsMessmittel.ts`);
die Befund-Zeile der Messstelle (`components/VergleichBefund.tsx`) je Zeile „Toleranz ändern“.

- „geplant“ trägt nie eine Menge (auch keine 0); Ersatz ist Teil von „gemessen“; ungemessen ist nur der Anlagenrest.
- Beleg = Verweis (G2): `pruefsummeLokal` bildet die SHA-256 im Browser; `eintragAus` kennt die Datei nicht. Beweis:
  `src/uemsMessmittel.test.ts` („Prüfsumme lokal“) und `e2e/abdeckung-messmittel.spec.ts` (kein Datei-Inhalt im Netz).
- „laut Hersteller“ (G4) liest `laut_hersteller` der Route (IP-16) und steht als eigener Abschnitt unter „am Einbau
  erhoben“, mit Fundstelle und Quellen-Prüfsumme; `nicht_belegt` ohne Zahl. Er füllt nie eine Einbau-Zeile.
- Die Prüfaufgabe ist eine Ableitung im Portal (wesentlich = jüngste freigegebene, offene Einstufung; Klasse UND Prüfung
  `nicht_erhoben`); die Prüfaufgabe im Bewertungsstand bleibt IP-21.
- ⚠ Der Satz der Quelle-Karte (`UEMS_VERGLEICH_NEBENEINANDER`, auch im Folgen-Satz beim Binden einer Vergleichsquelle)
  nennt seit IP-18 die Befund-Zeile. Die E3-Wächter (`copy.test.ts`, `QuelleBinden.test.tsx`) nehmen nur diesen einen
  Satz aus; er trägt keine Zahl und sagt „ohne Ursache“.
- Hebel: `messmittel.angaben` über `RechteStandort` der Seite (Recht ohne `standort`-Prop), Sichtbarkeit aus den Routen.
- Bühnen: `e2e/bewertung.html?stand=voll` (Abdeckung, Prüfaufgabe; `&ee=EE-3`), `e2e/geraet-herkunft.html?…&messmittel=1`
  (opt-in, die übrigen Leser dieser Bühne sehen die Seite unverändert), Toleranz über `cloud(page, { vergleich: true })` in
  `e2e/messstelle-seite.spec.ts`. `IP18_BILDER=<Ordner>` legt die Bilder der Ansicht ab.
