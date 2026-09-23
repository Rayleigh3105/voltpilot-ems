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

- Kriterien ändern schreibt acht Vertragswerte plus Pflichtbegründung. Der Sofort-Hinweis nennt die neue Wirkung auf
  Rangliste und Vorschlag und seit IP-25, wenn ein Stand freigegeben ist, „Bewertungsstand Nr. n bekommt einen Anstoß“ (R15).
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

## Messplanung (AP-16 IP-20, §5.3 Schritte 1–3, R5)

`components/Messplanung.tsx` (reines Modul `src/uemsMessplanung.ts`) liest und schreibt nur die IP-19-Routen
`…/energieeinsaetze/{id}/messbedarf`: die Karte „Messplanung“ auf der Einsatzseite (erfassen, „Messstelle einrichten“,
verwerfen), an jeder Rest-Zeile der Abdeckung „Messbedarf erfassen“ (Einsatz wählbar, Wortlaut mit dem Rest, Ort = Standort
der Anlage) und unter der Abdeckung die Liste je Standort. Die Messstellen-Seite nennt `geplant_fuer_einsaetze` als
„geplant für EE-…“ unter der Beobachtung; ohne Quelle bleibt es „Keine Datenquelle“, nie 0.

- Einlösen = der ECHTE `MessstelleDialog` mit `vorbelegung` (Ort-Kurzzeichen, Hauptgröße); die erste gemeldete Messstelle
  ohne `fehlt` (nach „Weiter: Quelle“) löst genau einmal ein — Ref statt State, weil `merke` Ort und Stellung im selben
  Lauf meldet. Schließt jemand vorher, bleibt der Bedarf offen und die Messstelle ein Entwurf.
- ⚠ Ort und Größe sind am Bedarf Wortlaut: das Portal schreibt das Kurzzeichen („G-1“) und „Wirkenergie · Bezug“;
  `groesseVorbelegung` liest auch „Wirkenergie Bezug (kWh)“ aus R5, Unbekanntes wird nicht vorbelegt.
- ⚠ Es gibt keine Standort-Route: die Liste je Standort liest je Einsatz und ordnet das Kurzzeichen über die Ortsbäume zu
  (unbekannt → „ohne Ort“). Der Register-Filter `geplantFuerEinsatz` ist im Portal noch nicht verdrahtet.
- Bühne: `e2e/bewertung.html?stand=voll&messplanung=1|mb1` (EE-8 und die Routen aus `src/test/messplanungBuehne.ts`;
  Daten ohne `../api`-Wert-Import in `messplanungFixtures.ts`, auch für Playwright). Nachweis `src/uemsMessplanung.test.ts`,
  `components/Messplanung.test.tsx`, `e2e/messplanung.spec.ts` (375/1440; `IP20_BILDER=<Ordner>` legt die Bilder ab).

## Bewertungsstand (AP-16 IP-25, §5.5, R7/R10, Meilenstein M4)

`#/portfolio/bewertung` trägt die Karte „Bewertungsstand“ (`components/BewertungStand.tsx`, reines Modul
`src/bewertungStand.ts`) und im Kopf die Frist-Zeile (derselbe Satz wie `BewertungBaustein`). Sie liest NUR die
Bericht-Routen (`GET /api/v1/berichte`, `…/{kennung}`, `…/entwurf`, `…/staende/{nr}/pdf|csv`) — keine zweite Maschine:
Anlegen ist `BerichtAnlegenDialog` mit `nurVorlage`, Freigeben `BerichtFreigebenDialog`, der Vermerk `revisionBanner`.

- Recht: jede Handlung an `energetische_bewertung` hängt an `bewertung.abrufen` (`berichtDialoge.darf(…, vorlage)`, wie
  `BerichtRechte.kennung` mit Vorlage). Ohne das Recht fehlen Karte, Frist-Zeile und die Vorlage im Anlegen-Dialog; die
  Karte erscheint erst mit einem Einsatz oder einer Bewertung (R11). Vier-Augen gibt es an der Bericht-Freigabe nicht.
- ⚠ Der Bewertungs-Abzug hat keine `werte`/`kennzahlen`: `freigabeAntrag` liest sie optional, `freigabeVorschau` lässt den
  Punkt „Alle n Werte endgültig“ bei null Werten weg. `zeitraumWahlen/zeitraumVorgabe('datengrundlage')` = zwölf volle
  Monate (`2025-11/2026-10`), keiner „läuft“. Eine in „Berichte“ angelegte Bewertung öffnet die Seite „Bewertung“
  (`BerichtePage.onBewertung`); die Berichtsseite kennt die acht Bewertungs-Abschnitte nicht.
- PDF/CSV hängen nur hier ein (`api.berichtDatei` → Blob → Download); `AUSGABE_EINGEHAENGT` der Berichtsseite bleibt aus.
- ⚠ Kein Feld „Name“ am Anlegen (§5.5 Schritt 1): `BerichtAnlegen` kennt nur Vorlage, Geltung, Zeitraum — Befund, nicht
  nachgebaut; der Stand-Satz nennt „Bewertung <Jahr>“ aus dem letzten Monat der Datengrundlage.
- Bühne: `e2e/bewertung.html?stand=voll&bewertungsstand=keine|entwurf|nr1|revision|nr2|faellig` (Routen in
  `src/test/bewertungStandBuehne.ts`, R7/R10-Zeitachse; `window.__bewertungAbrufe` zählt Dateien). Nachweis
  `src/bewertungStand.test.ts`, `e2e/bewertungsstand.spec.ts` (375/1440; `BEWERTUNGSSTAND_BILDER=<Ordner>` legt Bilder ab).
