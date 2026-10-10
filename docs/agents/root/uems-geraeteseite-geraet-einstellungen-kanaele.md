# UEMS-Geräteseite ergänzt: Gerät, Einstellungen „Ändern ab …“, Messkanäle mit „speist …“

Neu am 14.09.2026 (AP-04 IP-12, nur Portal, keine Route, keine Migration). Die bestehende
Geräteseite (`pages/GeraetSeiteSection.tsx`, Geräteseiten-Programm PRs 533–540) trägt in der
Sektion „Komponenten — Was misst und steuert es?“ unter den Komponenten-Zeilen und über dem
Änderungsprotokoll drei Blöcke aus `components/GeraetHerkunft.tsx`: Karte „Gerät“, Karte
„Einstellungen“ (Dialog `components/EinstellungAendernDialog.tsx`) und „Messkanäle“. Ableitung
NUR im reinen Modul `src/geraetEinstellungen.ts`.

Beweise: `geraetEinstellungen.test.ts` (A5-Folgen gegen `quelle-einstellung-vectors.json`, Fakten
geändert → Sätze geändert, Kanal-Zeile „speist MS-06 (führend)“, Vorgänger „ausgebaut am …“),
`components/GeraetHerkunft.test.tsx` (Fläche + Dialog + POST-Körper), ein Fall in
`GeraetSeiteSection.test.tsx` (Blöcke sitzen in `sektion-komponenten`), E2E-Bühne
`e2e/geraet-herkunft.{html,tsx,spec.ts}` (echte Seite, Uhr per `page.clock.setFixedTime`, 0 px
Querlauf bei 375/1440, `GERAET_BILDER=<Ordner>` legt Bilder ab). Fixtures am Referenzunternehmen:
`src/test/geraetHerkunftFixtures.ts` (GR-4 Z-5a → Z-5b, C-1 mit EK-2 und A5).

## ⚠ Die Fallen

- **Die Sätze einer Fassung bildet der Vertrags-Zwilling.** Folgen-Karte, Wert-Text und
  Wirkung kommen aus `uemsEinstellung.ts` (`folgen`, `neueFassung`, `gueltigZu`, `wertText`), die
  Fläche formuliert keinen eigenen Satz. Wer den Wortlaut ändert, ändert die Vektor-Datei — und
  läuft ALLE ihre Leser (Java + Portal, `rg -l quelle-einstellung-vectors services frontend`).
- **Der Weg Komponente → Gerät ist `geraetZuKomponenten`** (derselbe wie das Protokoll): nur ein
  EINGEBAUTER Einbau mit laufender Speisung. Ohne Treffer rendert `GeraetHerkunft` nichts. Die
  gleichzeitigen `uemsGeraete`-Abrufe beider Blöcke teilt `request` (Coalescing), kein Hook nötig.
- **Einstellungen gehören zur SEITE, nicht nur zum Gerät.** Fassungen an einer anderen Komponente
  desselben Einbaus (die Energiekarte nebenan am Controller) stehen nicht da; Fassungen am
  Einbau (`entity_id` null) gelten für alle und stehen immer da. Der Filter sind die Schlüssel von
  `EinstellungNamen.komponenten`.
- **„In VoltPilot seit“ statt „Eingebaut am“ bei `aus_bestand`.** Dann ist `eingebaut_am` der
  Beginn des Verlaufs, nicht der Einbautag — nie als Einbautag ausgeben.
- **Die Prüfung im Dialog ist höchstens so streng wie der Server.** `beginn` ist der Einbau des
  Geräts; für eine Quelle an Komponente/Messwert prüft der Server genauer. Zeitumstellung: eine
  fehlende oder doppelte Uhrzeit wird nie geraten (`zeitpunktAus` über `bezugsPeriode.zeitpunkteVon`).
- **„Anwendung“ ist ein verbotenes Kundenwort** (`copy.test.ts`): die Wahl heißt „Wer rechnet
  damit?“. Die Anwendungs-TEXTE des Vertrags (`anwendung_text`) enthalten das Wort nicht.
- **Die Kanal-Liste liest `…/komponenten/{id}/messkanaele`, nicht „Beobachtete Messwerte“.** Die
  Beobachtungsliste im Register fällt bei einer Familie ohne Katalog (etwa `modbus-generic`) ganz
  weg und überspringt abgewählte Auswahlen — „speist …“ muss aber an genau diesen Kanälen
  sichtbar bleiben (Variantenvergleich in der Freigabe, Empfehlung A).

## Nicht dieses Paket

Gerät austauschen / Zählerwechsel-Dialog (IP-18), Controllerwechsel (IP-19), Verlaufs-Marke
„Zähler gewechselt“, Rechte-Tor im Portal (die Route antwortet 403 mit Satz, der Dialog zeigt ihn).
