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
- AP-19 IP-15: die Einsatz-Seite trägt nach „Messmittel“ den Abschnitt „Nachweise“ (`components/Nachweise.tsx`, nur mit
  `energiemanagement.ansehen`); die Bühne spielt dafür immer die Energiemanagement-Routen — wer `e2e/bewertung.tsx`
  ändert, fährt auch `e2e/nachweise.spec.ts` · [Portal Energiemanagement](uems-energiemanagement-portal.md).

## Ergebnis-Seite (Konzept Auswerten a1 §6.7, Captain-Freigabe 06.10.2026)

`#/portfolio/bewertung` zeigt das Ergebnis statt der Rohdaten; jede Ableitung steht im reinen Modul
`src/bewertungErgebnis.ts` (Antwortsatz, Kacheln, Gruppen, Statuszeile, Kriterien in Worten, Umfang, Datumsblöcke), die
Seite rendert nur. Kopf „Energetische Bewertung“ mit Satz und „Was ist die energetische Bewertung?“
(`components/BegriffAufklapper.tsx`, Begriff `energetische_bewertung`), Statuszeile „Gilt · Stand Nr. 1 vom …“ (fällig:
Hinweiskarte, „Neuen Stand freigeben“ führt per `zumEntscheid` zum Bewertungsstand), Antwortsatz, Kacheln, links die
Bereiche (Wesentlich · Nicht wesentlich · Noch nicht eingestuft · Noch ohne Werte), rechts Bewertungsstand,
„Wie VoltPilot vorschlägt“ (`KriterienKarte`) und Umfang; Grenz-Satz einmal am Fuß („Was VoltPilot leistet“).

- Gruppen folgen der geltenden Einstufung einer Person, nie dem Vorschlag; „Noch ohne Werte“ = `keine_werte` UND keine
  Menge im Zeitraum - außer „wesentlich“: der bleibt unter „Wesentliche Bereiche“, sonst zählte die Antwort ihn und die
  Karte nicht. Strom steht vor Trägern ohne Anteil (m³ ist kein kWh).
- Wächter Q5: `bewertungErgebnis.ts` rechnet keine Menge. Die Menge der wesentlichen Bereiche summiert
  `uemsBewertung.menge` (nie eine Summe gerundeter Anteile), ihren Anteil und den des Rests bildet `uemsBewertung.prozent`;
  „x % zugeordnet“ ist `abdeckung_prozent` der Route (eine Stelle, damit 79,6 % nicht wie 80 % aussehen). Ein negativer
  Rest (Doppelzählung) ist nie „0 % · ausreichend“, sondern „passt nicht“ mit Satz.
- Entscheidet eine dritte Person zuerst, antwortet die Route 409 `bereits_entschieden`; die Kriterien-Karte lädt dann
  neu und sagt das, statt veraltete Knöpfe stehen zu lassen. Ohne Vorschlag ist im Einstufen-Dialog nichts vorgewählt.
- ⚠ Ein Vorschlag zählt nur mit Messwerten: ohne Menge sagt die Route „unter Schwelle“ (alle Kriterien „nicht
  anwendbar“) - das ist kein Vorschlag, „weicht vom Vorschlag ab“ erscheint dann nie (`vorschlagBild`).
- ⚠ Zwei Uhren der Demo: die Datengrundlage der gültigen Bewertung (Bühne, April 2028 bis März 2029) hat keine
  Messwerte; die Seite sagt das als Verlässlichkeits-Satz, Anteile und Balken fehlen, die Einstufungen bleiben.
- Keine Kürzel K1 bis K8 auf der Seite (§10.10): nur der Dialog „Kriterien ändern“ zeigt Wort und Kürzel
  (`KRITERIEN_FELDER`); R16-Hinweise zitieren Kundennamen („Kompressoren K1+K2“) und sind vom Wächter ausgenommen.
- Vier-Augen-Kriterien (Befund 6): `KriterienKarte` liest `…/kriterien` und `…/kriterien/fassungen`; eine beantragte
  Fassung zeigt Änderung, Person und „Freigeben“/„Ablehnen“ (Begründung Pflicht) nur einer zweiten Person mit
  `bewertung.kriterien`; „Kriterien ändern“ fehlt solange (sonst 409 `freigabe_offen`). Die Meldung nach dem Speichern
  folgt `freigabe_status` (`kriterienMeldung`).
- Weg von der Seite: Ranglisten-Tabelle, Messabdeckung je Einsatz/Ort (Kachel „Keinem Bereich zugeordnet“ statt dessen),
  Prüfaufgaben (stehen am Einsatz), zweite Liste der Einsätze und die Messplanung (zieht nach Messen, §10.9).
- Bühne: `e2e/bewertung.html?…&kriterienvieraugen=1|kriterienantrag=IK` (mit `person=JW`); Nachweis
  `src/bewertungErgebnis.test.ts`, `src/pages/BewertungPage.test.tsx`, `e2e/bewertung.spec.ts`, `e2e/bewertungsstand.spec.ts`.

## Rangliste und Einstufung (AP-16 IP-12, Meilenstein M2)

Die Seite liest `…/bewertung/rangliste` über die Datengrundlage der gültigen Bewertung (sonst zwölf volle Monate,
`useBewertungZeitraum`) und zeigt seit a1 nur noch das Ergebnis (siehe oben); Einstufen geschieht an der Einsatzseite. Die Einsatzseite liest
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

Die Abdeckungs-Tabelle (`components/MessabdeckungTabelle.tsx`, reines Modul `src/uemsMessabdeckung.ts`, seit a1 nicht
mehr auf der Bewertung) liest `…/bewertung/messabdeckung`: je Einsatz und je Ort gemessen · geplant · Ersatz ·
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
`src/bewertungStand.ts`; seit a1 Datumsblöcke aus `bewertungErgebnis.standBild/entwurfBild`, „Unterschiede ansehen“ =
`BerichtVergleichDialog` in einer `Fehlergrenze`) und über der Antwort die Statuszeile. Sie liest NUR die
Bericht-Routen (`GET /api/v1/berichte`, `…/{kennung}`, `…/entwurf`, `…/staende/{nr}/pdf|csv`) — keine zweite Maschine:
Anlegen ist `BerichtAnlegenDialog` mit `nurVorlage`, Freigeben `BerichtFreigebenDialog`, der Vermerk `revisionBanner`.

- Recht: jede Handlung an `energetische_bewertung` hängt an `bewertung.abrufen` (`berichtDialoge.darf(…, vorlage)`, wie
  `BerichtRechte.kennung` mit Vorlage); nur Abrufen und PDF liest die API seit AP-19 IP-11 über `bewertung.ansehen` (gleiche
  Zellen). Die Fläche fragt weiter `bewertung.abrufen` — die Trennung der Oberfläche für „Einsicht“ ist AP-19 IP-13. Ohne das Recht fehlen Karte, Frist-Zeile und die Vorlage im Anlegen-Dialog; die
  Karte erscheint erst mit einem Einsatz oder einer Bewertung (R11). Vier-Augen gibt es an der Bericht-Freigabe nicht.
- ⚠ Der Bewertungs-Abzug hat keine `werte`/`kennzahlen`: `freigabeAntrag` liest sie optional, `freigabeVorschau` lässt den
  Punkt „Alle n Werte endgültig“ bei null Werten weg. `zeitraumWahlen/zeitraumVorgabe('datengrundlage')` = zwölf volle
  Monate (`2025-11/2026-10`), keiner „läuft“. Eine in „Berichte“ angelegte Bewertung öffnet die Seite „Bewertung“
  (`BerichtePage.onBewertung`); die Berichtsseite kennt die acht Bewertungs-Abschnitte nicht.
- PDF/CSV hängen nur hier ein (`api.berichtDatei` → Blob → Download); `AUSGABE_EINGEHAENGT` der Berichtsseite bleibt aus.
  ⚠ Darum klappen ersetzte Stände unter „Frühere Stände“ auf der Karte auf (mit PDF/CSV) - ein Verweis auf die
  Berichtsseite verlöre ihre Dateien.
- ⚠ Kein Feld „Name“ am Anlegen (§5.5 Schritt 1): `BerichtAnlegen` kennt nur Vorlage, Geltung, Zeitraum — Befund, nicht
  nachgebaut; der Stand-Satz nennt „Bewertung <Jahr>“ aus dem letzten Monat der Datengrundlage.
- Bühne: `e2e/bewertung.html?stand=voll&bewertungsstand=keine|entwurf|nr1|revision|nr2|faellig` (Routen in
  `src/test/bewertungStandBuehne.ts`, R7/R10-Zeitachse; `window.__bewertungAbrufe` zählt Dateien). Nachweis
  `src/bewertungStand.test.ts`, `e2e/bewertungsstand.spec.ts` (375/1440; `BEWERTUNGSSTAND_BILDER=<Ordner>` legt Bilder ab).
