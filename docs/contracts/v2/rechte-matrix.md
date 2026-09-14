<!-- ERZEUGT von docs/contracts/v2/tools/rechte_matrix.py aus rechte-matrix.json — nicht von Hand ändern. -->

# Rechte-Matrix (UEMS AP-03 §4.3 und Nachträge)

Die Quelle ist [`rechte-matrix.json`](./rechte-matrix.json); diese Datei wird aus ihr erzeugt (`python3 docs/contracts/v2/tools/rechte_matrix.py`, `--check` prüft). Wie aus Matrix und Zuweisungen ein Ja oder Nein wird — Geltungsbereich vor Aktion, Unterstützer-Umfang, OCPP-Stufe, Teilansicht, Entzug —, pinnen [`rechte-vectors.json`](./rechte-vectors.json) und die Zwillinge Java `services/api/.../uems/RechteAbleitung` ⟷ TS `frontend/portal/src/rechte.ts`.

Zeilen = konkrete Kundenaktionen, Spalten = Rollen, Zellen = eindeutiger Geltungsbereich. Codes: **U** erlaubt, unternehmensweit · **S** erlaubt je zugewiesenem Standort · **E** nur das eigene Konto · **-** nein · **P** bleibt beim VoltPilot-Betrieb (Plattform) · **A** Unterstützer ab Umfang „Ansehen“ · **Ei** Unterstützer ab Umfang „Einrichten“ · **B** Unterstützer nur mit Umfang „Einrichten und Bedienen“.

## Rollen

| Rolle | Kennung | Kürzel | Geltungsbereich | Achsen |
|---|---|---|---|---|
| Kundenadministrator | `kundenadministrator` | KA | Unternehmen | Daten ✔ · Steuerung ✔ (Betrieb + Rahmen) · Verwaltung ✔ |
| Energiemanager | `energiemanager` | EM | Unternehmen | Daten ✔ (alle Standorte) · Steuerung ✘ · Verwaltung ✘ |
| Bearbeiter | `bearbeiter` | BE | je Standort | Daten ✔ (je Standort) · Steuerung ✘ · Verwaltung ✘ |
| Bedienberechtigt | `bedienberechtigt` | BD | je Standort | Daten: nur sehen · Steuerung ✔ (Betrieb, je Standort) · Verwaltung ✘ |
| Leser | `leser` | LE | je Standort | Daten: sehen (je Standort) · Steuerung ✘ · Verwaltung ✘ |
| Unterstützer | `unterstuetzer` | US | je Standort · befristet | je Umfang: Daten sehen/pflegen · Steuerung Betrieb · nie Rahmen, nie Verwaltung · immer befristet + Banner + Protokoll |
| VoltPilot-Betrieb | `voltpilot_betrieb` | VP | Plattform | Plattform-Betrieb |

## Unterstützer-Umfang (E9)

| Umfang | Kennung | Code |
|---|---|---|
| Ansehen | `ansehen` | A |
| Einrichten | `einrichten` | Ei |
| Einrichten und Bedienen | `einrichten_und_bedienen` | B |

## Matrix

48 Aktionen × 7 Rollen — zeichengleich zur Tabelle im AP-03-Konzept §4.3 (SHA-256 `fa96d75444e46487274d89b23cac88ff4190760cef604db7c07e83fe836cc20a`).

| Aktion | Herkunft | Kundenadministrator | Energiemanager | Bearbeiter | Bedienberechtigt | Leser | Unterstützer | VoltPilot-Betrieb | Anmerkung |
|---|---|---|---|---|---|---|---|---|---|
| **Unternehmen, Standorte, Struktur (AP-02)** |  |  |  |  |  |  |  |  |  |
| Unternehmen bearbeiten (Name, Kurzname, Zeitzone-Vorgabe, Sitz) | AP-02 §4.1 | U | U | - | - | - | - | - |  |
| Standort anlegen · bearbeiten · archivieren · wiederherstellen | AP-02 §4.6 | U | U | - | - | - | - | - | AP-02 nennt Kundenadministrator und Energiemanager. |
| Gebäude und Bereiche pflegen (anlegen, bearbeiten, verschieben, Fläche, archivieren) | AP-02 §4.6 | U | U | S | - | - | Ei | - | „Standort-Bearbeiter“ aus AP-02 = Bearbeiter. |
| Anlage einem Standort zuordnen / umziehen | AP-02 §4.6, IP-11 | U | - | - | - | - | - | - |  |
| Rückwirkend ändern („gültig ab“ in der Vergangenheit) | AP-02 E2 | U | U | - | - | - | - | - | Bearbeiter nur ab heute (W14). |
| Änderungsprotokoll und „Stand am“ lesen | AP-02 §4.4 | U | U | S | S | S | A | - | „jeder Leser des Standorts“ (AP-02). |
| Anlage anlegen (Assistent) · archivieren · löschen (nur ohne Historie) | Bestand, AP-02 W5 | U | - | - | - | - | - | P | heute jeder Benutzer (SiteController ohne Rollenprüfung). |
| Box anmelden; Gerät / Komponente anlegen, verbinden, bearbeiten; Verbindungstest | Einheitsmodell, AP-01 §5.2 | U | U | S | - | - | Ei | - | Installateur: Schritte 2–3 des Mess-Assistenten (AP-01). |
| Komponente löschen · Gerät entfernen | Bestand | U | U | S | - | - | - | - | Unterstützer nie (zerstörend). |
| Datenaufzeichnungen löschen | Bestand (purge) | U | - | - | - | - | - | - | heute jeder Benutzer. |
| Mess-Selektion je Komponente (zusätzliche Messwerte) | Geräteseite Stufe 3b | U | U | S | - | - | Ei | - |  |
| **Messstellen und Messdaten (AP-04, AP-08, AP-09)** |  |  |  |  |  |  |  |  |  |
| Messstelle anlegen · bearbeiten · Ort, Prozess, Kostenstelle zuordnen | AP-04 | U | U | S | - | - | Ei | - |  |
| Führende Quelle binden · Zählerwechsel · Wandlerfaktoren | AP-04 | U | U | S | - | - | Ei | - |  |
| Korrektur / Ersatzwert erfassen (versioniert, begründet) | AP-08 | U | U | S | - | - | - | - | Messdatenpflege — nie der Unterstützer (Nachweis bleibt beim Kunden). |
| Bezugsgröße eingeben / berichtigen (manuell) | AP-09 | U | U | S | - | - | - | - |  |
| CSV-Import mit Vorschau (Bezugsgrößen) | AP-09 | U | U | S | - | - | - | - |  |
| Messwerte, Zeitreihen, Datenqualität ansehen | AP-07, AP-13 | U | U | S | S | S | A | - |  |
| **Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13)** |  |  |  |  |  |  |  |  |  |
| Kennzahl definieren — Geltungsbereich Standort | AP-11 | U | U | S | - | - | - | - |  |
| Kennzahl definieren — Geltungsbereich Unternehmen | AP-11 | U | U | - | - | - | - | - | Unternehmensweite Kennzahlen nur unternehmensweite Rollen (R-A1). |
| Standort-Bericht abrufen (Entwurf, PDF/CSV auf Abruf) | AP-12 | U | U | S | S | S | - | - |  |
| Standort-Bericht freigeben (Berichtsstand) | AP-12 | U | U | S | - | - | - | - |  |
| Unternehmens-Bericht abrufen / freigeben | AP-12 | U | U | - | - | - | - | - |  |
| Export je Standort (CSV: Messwerte, Kennzahlen) | AP-12, Bestand Geräte-CSV | U | U | S | S | S | - | - | Unterstützer: kein Export (Datenabfluss). |
| Unternehmens-Export (alle Standorte) | AP-12 | U | U | - | - | - | - | - | standortbeschränkte Nutzer bekommen stattdessen den Export ihrer Standorte mit Kopfzeile „Teilansicht“ (R-A4). |
| Cockpit anpassen — Eigen-Schicht der Organisation (Anlage / Unternehmen) | Cockpit anpassen, Stufe 3 | U | U | S | - | - | - | P | Vorgabe-Schicht bleibt VoltPilot; Leser/Bedienberechtigte/Unterstützer schreiben kein Organisations-Layout (W8). |
| Eigene Auswertung anlegen (je Anlage) | Eigene Auswertung, Stufe 5 | U | U | S | - | - | - | - |  |
| **Funktionen und Steuerung (AP-01, Bestand)** |  |  |  |  |  |  |  |  |  |
| Funktion „Messen & Auswerten“ je Standort einrichten | AP-01 §5.2 | U | U | - | - | - | Ei | - | Unterstützer: Schritte 2–3 (Datenquelle, Messstellen); Schritt 1 und Abschluss der Kunde. |
| Funktion „Steuern & Optimieren“ je Standort einrichten (Anlage aufnehmen, Freigeben, Grenze, Betriebsweise) | AP-01 §5.3 | U | - | - | - | - | Ei | - | Unterstützer bereitet vor (Tests, Grenze); die Freigabe und der Start bleiben beim Kundenadministrator. |
| Steuerung starten · beenden je Anlage (nach bestandenen Prüfungen) | AP-01 R1/R2 | U | - | - | - | - | - | - | Plan: „Kundenadministrator … nach technischen Prüfungen starten“. |
| Steuerung anhalten · fortsetzen je Anlage; Standort anhalten · fortsetzen | AP-01 E8, E9, E12 | U | - | - | S | - | B | - |  |
| Handeingriff: Speicher jetzt laden, Ladestand halten, Automatik pausieren, Gerät jetzt an/aus, „Jetzt voll laden“, „Laden pausieren“ | Zone Jetzt (Steuerung Stufe 4, OCPP Stufe 4) | U | - | - | S | - | B | - | Dauer Pflicht, TTL ≤ 24 h — bleibt beim Entzug bis zum Ablauf (E15). |
| Betriebsweise ändern: Betriebsmodell wechseln, Regeln anlegen/aktivieren, Steuerart je Verbraucher, Rangliste | Steuerung Stufe 5, Verbrauchsmanagement | U | - | - | S | - | B | - | E4 = A: Betrieb im Rahmen; Regel gewinnt weiterhin immer. |
| Ladekarten und Fahrzeug-Profile pflegen; OCPP-Betriebsaktionen (Reservieren, Verfügbarkeit, sanft neu starten) | OCPP Stufe 3/4, P7 | U | - | - | S | - | B | P | Plattform-Aktionen (HardReset, Firmware, Diagnose) bleiben VoltPilot. |
| Schalt-Test / Verbindungstest durchführen | Einheitsmodell Stufe 4 | U | - | - | - | - | Ei | - |  |
| Steuern freigeben je Komponente · Freigabe zurücknehmen | Einheitsmodell Stufe 4 (Stufe 3 „selbst“) | U | - | - | - | - | - | P | Stufe 1 (Zertifizierung + Scharfschaltung) bleibt VoltPilot (S1); Widerruf auch durch den Kundenadministrator. |
| Anschlussgrenze, Einspeisegrenze, Netzladen-Schalter eintragen | AP-01 E10, Grenzen & Wächter Stufe 0 | U | - | - | - | - | Ei | P | Ladepark-Rahmen-Auslegung (Hausreserve, Marge …) bleibt VoltPilot (S5). |
| Register schreiben (Kunden-Lane, Vorschau + Schreiben) | Register schreiben Stufe 3 | U | - | - | - | - | Ei | P | Journal trägt künftig den Benutzer als Urheber (W7). |
| Ladepunkt anbinden · Kennung zurücknehmen | OCPP-Anbinde-Assistent | U | - | - | - | - | Ei | - |  |
| Prognose-Modell je Anlage befördern | Prognose-Beförderung | U | U | - | - | - | - | P | Plattform-Vorgabe bleibt VoltPilot; „gehört dem Kunden“ → Datenachse. |
| **Benutzer und Unterstützung (AP-03)** |  |  |  |  |  |  |  |  |  |
| Benutzer anlegen (Startpasswort, Pflichtwechsel bei der ersten Anmeldung) · sperren · entfernen | AP-03 | U | - | - | - | - | - | P | VoltPilot legt nur den ersten Kundenadministrator eines Kundenbereichs an (W4). |
| Rollen und Standorte zuweisen · entziehen | AP-03 | U | - | - | - | - | - | - | der letzte Kundenadministrator ist geschützt (W12). |
| Unterstützung gewähren · verlängern · beenden | AP-03 | U | - | - | - | - | - | P | VoltPilot: nur anfragen; Notfall-Zugriff sichtbar und befristet (E8). |
| Zugriffsprotokoll lesen (wer hat wem wann was gewährt/entzogen; Anmeldungen der Unterstützer) | AP-03 | U | - | - | - | - | - | P | VoltPilot sieht das Plattform-Protokoll seiner Notfall-Zugriffe. |
| Eigenes Konto: Name, Passwort, Abmelden; eigene Standorte und Rollen sehen | AP-03 (`/me`) | E | E | E | E | E | E | E |  |
| **Bleibt beim VoltPilot-Betrieb (Plattform)** |  |  |  |  |  |  |  |  |  |
| Kundenbereich anlegen / löschen; ersten Kundenadministrator anlegen | Admin-Konsole | - | - | - | - | - | - | P |  |
| Modell zertifizieren · Steuer-Scharfschaltung je Wechselrichter (S1) | Steuerungs-Zertifizierung | - | - | - | - | - | - | P |  |
| Ladepark-Rahmen auslegen (Hausreserve, Marge, Rotation, Budget) | Ladepark-Rahmen (Admin-Route) | - | - | - | - | - | - | P | AP-01 W6: Admin-Route bleibt; die Anschlussgrenze gehört dem Kunden. |
| Flotte, OTA, Registry-Push, Optimierer-Konfiguration, What-if, Vorlagen, Plattform-Prognosevorgabe | `/api/v1/admin/**` | - | - | - | - | - | - | P | unverändert. |

## Nachträge der später konzipierten Pakete

AP-03 wurde vor AP-04 … AP-07 konzipiert; deren Rechte-Abschnitte hat der Captain mit dem jeweiligen Paket abgenommen: AP-04 §6.7 (UEMS AP-04 Messstellen — report.md §6.7, abgenommen mit E1–E12 am 10.09.2026) · AP-05 §6 (UEMS AP-05 WAGO — report.md §6, abgenommen mit E1–E9 am 10.09.2026) · AP-06 §4.8 (UEMS AP-06 Edges — report.md §4.8, abgenommen mit E1–E12 am 10.09.2026) · AP-07 §4.10 (UEMS AP-07 Messdaten — report.md §4.10, abgenommen mit E1–E13 am 10.09.2026) · AP-10 §4.10 (UEMS AP-10 Bilanzen — report.md §4.10, abgenommen mit E15 = A am 12.09.2026) · AP-09 §4.11 (UEMS AP-09 Bezugsgrößen — report.md §4.11 und W8, abgenommen mit E1–E17 = A am 12.09.2026) · AP-08 §4.8 (UEMS AP-08 Verbrauch — report.md §4.8, abgenommen mit E1–E15 = A am 11.09.2026) · AP-08 §5 (UEMS AP-08 Verbrauch — report.md §5, Bedienablauf „Eine Korrektur oder einen Ersatzwert widerrufen“, abgenommen mit E1–E15 = A am 11.09.2026). Die 15 Zeilen darunter entstehen dort; ihre Zellen sind die des Abschnitts („wie Zeile X“ = die Zellen von X). Widersprüche zu einer Konzept-Zeile stehen benannt in [`rechte-vectors.json`](./rechte-vectors.json) (`widersprueche`), samt Fällen.

| Aktion | Herkunft | Kundenadministrator | Energiemanager | Bearbeiter | Bedienberechtigt | Leser | Unterstützer | VoltPilot-Betrieb | Anmerkung |
|---|---|---|---|---|---|---|---|---|---|
| **Messstellen und Messdaten (AP-04, AP-08, AP-09)** |  |  |  |  |  |  |  |  |  |
| Messstellen-Register lesen (Messstelle, Ort, Quelle, Zustand, letzter Wert) | AP-04 §6.7 | U | U | S | S | S | A | - | AP-04: „Register lesbar für Leser und Bedienberechtigte“; wer Messstellen pflegt, liest sie; Unterstützer „Ansehen“ liest wie ein Leser (AP-03 §4.2). |
| Ereignisse einsehen | AP-07 §4.10 | U | U | S | S | S | A | - | AP-07: „wie Verlauf“ — Zellen der Zeile „Messwerte, Zeitreihen, Datenqualität ansehen“. |
| **Datenquellen und Boxen (AP-06)** |  |  |  |  |  |  |  |  |  |
| Datenquelle anlegen · bearbeiten · Netzlage · Erreichbarkeitsprüfung | AP-06 §4.8 | U | U | S | - | - | Ei | - | Auch Erhebungsbogen und Assistent „WAGO-Steuerung anbinden“ (AP-05 §6, W-R10). |
| Zuständige Box wechseln · Box tauschen | AP-06 §4.8 | U | - | S | - | - | Ei | - | Steuerquelle: nur Kundenadministrator — in AP-06 gesperrt. Den Energiemanager nennt AP-06 hier nicht (W-R9). |
| Box-Übersicht, Rückmeldung, Ausfall-Anzeige lesen | AP-06 §4.8 | U | U | S | S | S | A | - | AP-06: „alle Rollen des Standorts inkl. Leser; Unterstützer ab „Ansehen““. |
| **Messstellen und Messdaten (AP-04, AP-08, AP-09)** |  |  |  |  |  |  |  |  |  |
| Berechnete Messstelle anlegen · Formel ab einem Tag ändern (Fassung) | AP-10 §4.10 (E15) | U | U | S | - | - | Ei | - | AP-10 E15: „Zellen wie `messstelle.bearbeiten`: KA U · EM U · BE S · sonst −“ — die Zeile folgt dem „wie“ (Unterstützer „Einrichten“ wie jede Pflege-Zeile der Messstellen). Bis AP-10 IP-3 trugen das Anlegen der berechneten Messstelle `messstelle.bearbeiten`. |
| Messstelle auf Kostenstellen verteilen · Verteilung ab einem Tag ändern oder berichtigen | AP-10 §4.10 (E15) | U | U | S | - | - | Ei | - | AP-10 E15: „`messstelle.verteilung` (Zellen wie `messstelle.bearbeiten`)“ — die Zeile folgt dem „wie“ (Unterstützer „Einrichten“ wie jede Pflege-Zeile der Messstellen). Seit AP-10 IP-8 nennt `PUT /api/v1/messstellen/{id}/verteilung` die Kennung; gelesen wird über `messstelle.ansehen`. Die Durchsetzung bringt AP-03. |
| **Unternehmen, Standorte, Struktur (AP-02)** |  |  |  |  |  |  |  |  |  |
| Kostenstelle anlegen · umbenennen · beenden | AP-10 §4.10 (E15) | U | U | - | - | - | - | - | AP-10 E15: „Zellen wie `unternehmen.bearbeiten`: KA U · EM U“. Beendet, nie gelöscht (§5.7); seit AP-10 IP-7 nennen `POST /api/v1/unternehmen/kostenstellen`, `PUT …/{id}` und `PUT …/{id}/beenden` die Kennung. |
| Prozess anlegen · umbenennen · beenden | AP-10 §4.10 (E15) | U | U | - | - | - | - | - | AP-10 E15: „Zellen wie `unternehmen.bearbeiten`: KA U · EM U“. Beendet, nie gelöscht (§5.7); seit AP-10 IP-7 nennen `POST /api/v1/unternehmen/prozesse`, `PUT …/{id}` und `PUT …/{id}/beenden` die Kennung. Eine Messstelle einem Prozess zuordnen bleibt `messstelle.bearbeiten` („Ort, Prozess, Kostenstelle zuordnen“). |
| Netzanschluss anlegen · bearbeiten · beenden · Anlage binden | AP-10 §4.10 (E15) | U | U | - | - | - | - | - | AP-10 E15: „`netzanschluss.verwalten` (Zellen wie `standort.verwalten`)“. Beendet, nie gelöscht (§5.1); seit AP-10 IP-6 nennen `POST /api/v1/standorte/{id}/netzanschluesse`, `PUT …/netzanschluesse/{id}` und `POST …/netzanschluesse/{id}/anlagen` die Kennung. Lesen bleibt ohne eigene Kennung (wie das Standort-Lesemodell). |
| **Messstellen und Messdaten (AP-04, AP-08, AP-09)** |  |  |  |  |  |  |  |  |  |
| Bezugsgröße anlegen · bearbeiten · archivieren · Messkanal binden/lösen | AP-09 §4.11 (W8) | U | U | S | - | - | - | - | AP-09 W8: „U U S - - - -“ — Bearbeiter nur für Geltungsbereiche seines Standorts, nie Unterstützer. Seit AP-09 IP-5 nennen `POST /api/v1/bezugsgroessen`, `PUT`/`DELETE …/{id}` und `POST …/{id}/archivieren` die Kennung; auch das Löschen einer Bezugsgröße ohne Wert (M6). |
| Ersatzwert erfassen / zurücknehmen | AP-08 §4.8 (AP-03 Z. 202, IP-15) | U | U | S | - | - | - | - | AP-08 §4.8 nennt als Recht die Konzept-Zeile `korrektur.erfassen` (AP-03 Z. 202); AP-08 IP-15 gibt dem Ersatzwert eine eigene Kennung mit denselben Zellen — nie der Unterstützer. Auch der Widerruf eines Ersatzwerts gehört hierher (§4.8 wörtlich, W-R12). Die Route kommt mit AP-08 IP-16. |
| Korrektur prüfen und freigeben | AP-08 §4.8 (E8, IP-15) | U | U | S | - | - | - | - | E8: bei Vier-Augen an gibt eine zweite Person frei (Ersteller ≠ Freigeber), und nur Energiemanager oder Kundenadministrator; der Bearbeiter nur bei Vier-Augen aus. Die Zelle sagt, wer überhaupt freigeben kann — Einstellung und Ersteller prüft `korrekturEntscheiden` (rechte-vectors.json, Familie `vieraugen`). Nie der Unterstützer. Seit AP-08 IP-15 nennt `POST /api/v1/korrekturen/{kennung}/freigeben` die Kennung und setzt sie durch. |
| Korrektur zurücknehmen (widerrufen) | AP-08 §5 (Bedienablauf „Eine Korrektur oder einen Ersatzwert widerrufen“, IP-15) | U | U | S | - | - | - | - | Bearbeiter nur für eigene Korrekturen und nur bei Vier-Augen aus — die Bedingung prüft `korrekturEntscheiden` (Familie `vieraugen`). Die Zeile regelt die Korrektur; den Ersatzwert widerruft `ersatzwert.erfassen` (§4.8 wörtlich, W-R12). Nie der Unterstützer. Seit AP-08 IP-15 nennt `POST /api/v1/korrekturen/{kennung}/zuruecknehmen` die Kennung und setzt sie durch. |
| Vier-Augen-Einstellung ändern | AP-08 §4.8 (E8, IP-15) | U | - | - | - | - | - | - | E8: „Konfigurierbar je Unternehmen durch den Kundenadministrator: ‚Freigabe durch eine zweite Person‘ aus (Vorgabe) oder an“. Seit AP-08 IP-15 nennt `PUT /api/v1/unternehmen/vieraugen` die Kennung und setzt sie durch; gelesen wird ohne eigene Kennung (`GET /api/v1/unternehmen/vieraugen`, wie das Unternehmen-Lesemodell). |

### Jede Handlung der Rechte-Abschnitte

Welche Kennung jede Handlung trägt: eine **neue Zeile** (oben) oder eine **bestehende Zeile**, die sie schon regelt.

| Abschnitt | Handlung | Wer (Wortlaut des Abschnitts) | Recht (Abschnitt) | Kennung | Zuordnung | Anmerkung |
|---|---|---|---|---|---|---|
| AP-04 §6.7 | Messstelle anlegen · bearbeiten · Ort, Prozess, Kostenstelle zuordnen | Kundenadministrator und Energiemanager unternehmensweit, Bearbeiter je Standort, Unterstützer mit Umfang „Einrichten“ | `@Recht("messstelle.bearbeiten")` | `messstelle.bearbeiten` | bestehende Zeile | AP-04 zitiert die Matrix-Zeile wörtlich; die Zellen stimmen überein. |
| AP-04 §6.7 | Führende Quelle binden · Zählerwechsel · Wandlerfaktoren | Kundenadministrator und Energiemanager unternehmensweit, Bearbeiter je Standort, Unterstützer mit Umfang „Einrichten“ | `@Recht("messstelle.quelle")` | `messstelle.quelle` | bestehende Zeile | AP-04 zitiert die Matrix-Zeile wörtlich; die Zellen stimmen überein. Die Kennung hieß bis hierher `messstelle.quelle_binden` (W-R8). |
| AP-04 §6.7 | Register lesen | Leser und Bedienberechtigte | — | `messstelle.ansehen` | neue Zeile |  |
| AP-05 §6 | Bogen und Assistent (Erhebungsbogen, Assistent „WAGO-Steuerung anbinden“) | Kundenadministrator (unternehmensweit), Bearbeiter je Standort, Unterstützer „Einrichten“ (Installateur, befristet) | — | `datenquelle.bearbeiten` · `geraet.einrichten` | bestehende Zeile | Der Bogen ist der erste Schritt der Datenquelle „WAGO-Steuerung“, der Assistent legt je Karte eine Komponente an. Den Energiemanager nennt AP-05 nicht (W-R10). |
| AP-05 §6 | Vorlagen-Freigabe | nur VoltPilot-Admin | — | `plattform.betrieb` | bestehende Zeile | „Vorlagen“ steht in der Plattform-Zeile. |
| AP-06 §4.8 | Datenquelle anlegen · bearbeiten · Netzlage · Erreichbarkeitsprüfung | Kundenadministrator (U), Energiemanager (U), Bearbeiter je Standort (S), Unterstützer ab Umfang „Einrichten“ (Ei) | `datenquelle.bearbeiten` | `datenquelle.bearbeiten` | neue Zeile |  |
| AP-06 §4.8 | Zuständige Box wechseln · Box tauschen | Kundenadministrator (U), Bearbeiter je Standort (S), Unterstützer „Einrichten“ (Ei) — Steuerquelle: nur Kundenadministrator (und dort in diesem Paket gesperrt) | `datenquelle.zustaendigkeit` | `datenquelle.zustaendigkeit` | neue Zeile | Die Steuerquelle ist eine Regel des Objekts, keine Zelle — der Schreibweg lehnt sie ab (Grund `steuerquelle`). Kein Energiemanager (W-R9). |
| AP-06 §4.8 | Box-Übersicht, Rückmeldung, Ausfall-Anzeige lesen | alle Rollen des Standorts inkl. Leser; Unterstützer ab „Ansehen“ | lesend | `datenquelle.ansehen` | neue Zeile |  |
| AP-06 §4.8 | Steuern freigeben (Komponente) | unverändert Kundenadministrator (AP-03) — AP-06 fasst Freigaben nicht an | unverändert | `freigabe.erteilen` | bestehende Zeile |  |
| AP-07 §4.10 | Herkunft eines Werts sehen | jeder mit Leserecht auf den Standort der Messstelle (AP-03) | Standortleser | `messwerte.ansehen` | bestehende Zeile | Die Herkunft gehört zum Messwert; die Zeile „Messwerte, Zeitreihen, Datenqualität ansehen“ trägt AP-07 schon als Herkunft und gibt jedem Standortleser das Recht. |
| AP-07 §4.10 | Export mit Herkunfts-Spalten | Standortleser für Messstellen des Standorts; unternehmensweite Messstellen nur Energiemanager/Kundenadministrator (AP-00 §7.6 „Standortrecht schneidet auch Summen“) | AP-03 | `export.standort` · `export.unternehmen` | bestehende Zeile | Die Herkunfts-Spalten ändern das Recht nicht; unternehmensweite Messstellen schneidet der Geltungsbereich. Der Unterstützer exportiert nicht (W-R11). |
| AP-07 §4.10 | Ereignisse einsehen | wie Verlauf | Standortleser | `ereignisse.ansehen` | neue Zeile |  |
| AP-07 §4.10 | Korrektur nach `late_arrival` anstoßen | Messdatenpflege (AP-03 Achse Messdaten), Ablauf AP-08 | Bearbeiter | `korrektur.erfassen` | bestehende Zeile | Der Anstoß öffnet den Korrektur-Ablauf von AP-08; das Recht ist die Messdatenpflege dieser Zeile — nie der Unterstützer. |
| AP-07 §4.10 | Datenaufzeichnungen löschen (Purge) | Kundenadministrator; für Messstellen-gebundene Reihen gesperrt (E8) | Kundenadministrator | `aufzeichnungen.loeschen` | bestehende Zeile | Die Sperre für Messstellen-gebundene Reihen (AP-07 E8) ist eine Regel des Objekts, keine Zelle — sie gilt auch für den Kundenadministrator und wird im Löschweg geprüft, nicht in `darf`. |
| AP-10 §4.10 | berechnete Messstelle anlegen, Fassung ändern | Zellen wie `messstelle.bearbeiten`: KA U · EM U · BE S · sonst − | `messstelle.formel` | `messstelle.formel` | neue Zeile | Seit AP-10 IP-3 nennen `POST /api/v1/messstellen/berechnet` und `POST …/messstellen/{id}/formel/fassungen` die Kennung (davor `messstelle.bearbeiten`); seit AP-10 IP-9 auch `POST /api/v1/sites/{siteId}/bilanz/rest` (Vorschlag „Rest anlegen“ bestätigen). |
| AP-10 §4.10 | Lesen der Bilanz, Verteilung und Herkunft | über `messstelle.ansehen` | `messstelle.ansehen` | `messstelle.ansehen` | bestehende Zeile | Auch die Formel zu einem Tag (`GET …/formel?am=`) seit AP-10 IP-9 die Bilanz je Anlage (`GET /api/v1/sites/{siteId}/bilanz`, mit ihrer Live-Zeile) und seit AP-10 IP-11 die Kostenstellen-Sicht (`GET /api/v1/unternehmen/kostenstellen/{id}/energie`: gemessen · verteilt · berechnet · nicht verteilt, mit Herkunft); Live-Wert und Verlauf der berechneten Messstelle bleiben `messwerte.ansehen`. |
| AP-10 §4.10 | Kostenstellen und Prozesse verwalten | Zellen wie `unternehmen.bearbeiten`: KA U · EM U | `kostenstelle.verwalten` · `prozess.verwalten` | `kostenstelle.verwalten` · `prozess.verwalten` | neue Zeile | Seit AP-10 IP-7 (Tabellen `kostenstelle`, `prozess`, `messstelle_prozess`); die Durchsetzung bringt AP-03. |
| AP-10 §4.10 | Messstelle auf Kostenstellen verteilen (Satz ab einem Tag) | Zellen wie `messstelle.bearbeiten`: KA U · EM U · BE S · sonst − | `messstelle.verteilung` | `messstelle.verteilung` | neue Zeile | Seit AP-10 IP-8 (Tabelle `messstelle_verteilung`, `PUT /api/v1/messstellen/{id}/verteilung`); gelesen wird über `messstelle.ansehen` (`GET …/verteilung?am=`). Die Durchsetzung bringt AP-03. |
| AP-10 §4.10 | Netzanschlüsse verwalten und Anlagen binden | Zellen wie `standort.verwalten`: KA U · EM U | `netzanschluss.verwalten` | `netzanschluss.verwalten` | neue Zeile | Seit AP-10 IP-6 (Tabellen `netzanschluss`, `anlage_netzanschluss`); die Durchsetzung bringt AP-03. |
| AP-09 §4.11 | Bezugsgrößen und Werte, Herkunft, Fassungen, Importe ansehen | Leser · Bearbeiter · Energiemanager · Kundenadministrator · Bedienberechtigt (Standort) · Unterstützer ab „Ansehen“ | `messwerte.ansehen` (Zuordnung wie AP-07 „Herkunft eines Werts sehen“) | `messwerte.ansehen` | bestehende Zeile | Seit AP-09 IP-5 nennen `GET /api/v1/bezugsgroessen`, `GET …/{id}` und `GET …/{id}/werte` die Kennung. |
| AP-09 §4.11 | Bezugsgröße anlegen · bearbeiten · archivieren · Messkanal binden/lösen | Kundenadministrator · Energiemanager (U) · Bearbeiter (S, nur Geltungsbereiche seines Standorts) | `bezugsgroesse.verwalten` (Nachtrag, W8) | `bezugsgroesse.verwalten` | neue Zeile | W8: neue Zeile „U U S - - - -“. Das Binden eines Messkanals kommt mit AP-09 IP-17 an dieselbe Kennung. |
| AP-09 §4.11 | Wert eingeben · berichtigen · Zuordnung ändern | KA · EM (U) · Bearbeiter (S) — nie Unterstützer | `bezugsgroesse.eingeben` (vorhanden) | `bezugsgroesse.eingeben` | bestehende Zeile | Die Route kommt mit AP-09 IP-7. |
| AP-09 §4.11 | CSV hochladen · Vorschau · übernehmen · zurücknehmen · Vorlagen pflegen | wie oben | `bezugsgroesse.importieren` (vorhanden; Rücknahme und Vorlagen zugeordnet) | `bezugsgroesse.importieren` | bestehende Zeile | W8: Rücknahme und Vorlagen gehören zur bestehenden Zeile; die Routen kommen mit AP-09 IP-12 ff. |
| AP-08 §4.8 | Werte, Zustände, Kennzeichen, Versionen ansehen | Leser · Bearbeiter · Energiemanager · Kundenadministrator · Bedienberechtigt (Standort) · Unterstützer (Ansehen) | AP-03 Matrix „Messwerte ansehen“ | `messwerte.ansehen` | bestehende Zeile | Seit AP-08 IP-9 nennt `GET /api/v1/messstellen/{kennzeichen}/werte` die Kennung; die Durchsetzung bringt AP-03. |
| AP-08 §4.8 | Ersatzwert erfassen / zurücknehmen | Bearbeiter (je Standort) · Energiemanager · Kundenadministrator — nie Unterstützer | AP-03 Z. 202 | `ersatzwert.erfassen` | neue Zeile | AP-08 IP-15 gibt dem Ersatzwert eine eigene Kennung mit den Zellen der genannten Zeile AP-03 Z. 202 (`korrektur.erfassen`). Die Route kommt mit AP-08 IP-16. |
| AP-08 §4.8 | Korrektur vorschlagen (Ablesestände, Umklassifizierung, Wert berichtigen) | Bearbeiter · Energiemanager · Kundenadministrator | AP-03 Z. 202 | `korrektur.erfassen` | bestehende Zeile | Die Routen kommen mit AP-08 IP-12 ff. |
| AP-08 §4.8 | Korrektur prüfen und freigeben | Energiemanager · Kundenadministrator; Bearbeiter nur, wenn Vier-Augen aus (E8); Ersteller ≠ Freigeber bei Vier-Augen an | E8 | `korrektur.freigeben` | neue Zeile | Die Zelle nennt, wer freigeben kann; „nur, wenn Vier-Augen aus“ und „Ersteller ≠ Freigeber“ stehen in rechte-vectors.json, Familie `vieraugen`. Bis AP-08 IP-15 stand die Handlung unter den Regeln ohne Zeile. |
| AP-08 §4.8 | Vier-Augen-Einstellung ändern | Kundenadministrator | E8 | `vieraugen.einstellen` | neue Zeile | Die Einstellung je Unternehmen, Vorgabe aus (E8). Bis AP-08 IP-15 stand die Handlung unter den Regeln ohne Zeile. |
| AP-08 §5 | Eine Korrektur oder einen Ersatzwert widerrufen | Energiemanager · Kundenadministrator (Bearbeiter nur für eigene, wenn Vier-Augen aus) | — | `korrektur.zuruecknehmen` | neue Zeile | Für den Ersatzwert gilt die Zeile aus §4.8 wörtlich (`ersatzwert.erfassen`, W-R12). |

### Regeln ohne eigene Zeile

Sätze der Abschnitte, die keine Handlung sind — und wo sie gelten.

| Abschnitt | Wortlaut | Wo es gilt |
|---|---|---|
| AP-04 §6.7 | Geltungsbereich = Standort des Orts | rechte-vectors.json, Familie darf: das Ziel ist der Standort, an dem der Ort der Messstelle hängt |
| AP-04 §6.7 | fremde Messstellen 404 | rechte-vectors.json, Familie darf: Geltungsbereich vor Aktion (404 `ausserhalb_geltungsbereich`) |
| AP-04 §6.7 | Urheber `actor_*` in jedem Protokolleintrag | keine Handlung — Urheber-Regel (services/api uems/ProtokollAkteur) |
| AP-04 §6.7 | Aggregate („x von y Messstellen liefern Daten“) serverseitig über die sichtbare Menge mit `teilansicht` | rechte-vectors.json, Familie teilansicht (Ableitungen `teilansicht` und `summe`) |
| AP-05 §6 | Pilot-Protokolle als Verlauf-Einträge mit Urheber | keine Handlung — Urheber-Regel (services/api uems/ProtokollAkteur) |
| AP-05 §6 | „AP-05 sagt nur, wer den Bogen ausfüllt, wer die Karte einstellt und wer die Vorlage freigibt“ (§6.1) | Bogen → `datenquelle.bearbeiten`; die Karte stellt der Installateur AM GERÄT ein (WAGO-I/O-CHECK, §4.7) — keine Portal-Handlung, die Einstellungs-Fassung trägt `messstelle.quelle` (Wandlerfaktoren, AP-04); Vorlage → `plattform.betrieb` |
| AP-10 §4.10 | `messstelle.verteilung` (Zellen wie `messstelle.bearbeiten`), `kostenstelle.verwalten` und `prozess.verwalten` (Zellen wie `unternehmen.bearbeiten`: KA U · EM U), `netzanschluss.verwalten` (Zellen wie `standort.verwalten`) | `kostenstelle.verwalten` und `prozess.verwalten` stehen seit AP-10 IP-7 als Zeilen, `messstelle.verteilung` seit AP-10 IP-8, `netzanschluss.verwalten` seit AP-10 IP-6 |
| AP-10 §4.10 | Unterstützer nach Umfang („Ansehen“ sieht, „Pflegen“ verteilt nie Rahmen) | keine eigene Zeile — der Unterstützer-Umfang der Matrix (`umfaenge`); in `messstelle.formel` die Zelle Ei |
| AP-09 §4.11 | Ablesung an einer Messstelle erfassen · berichtigen — `ablesung.erfassen` (Nachtrag, W8: „U U S - - - -“) | noch keine Zeile — sie entsteht mit dem Bau-Paket, das ihre Route baut: AP-09 IP-8 |
| AP-09 §4.11 | Berichtigung / Rücknahme freigeben (Vier-Augen an) — `korrektur.freigeben` (AP-08 IP-15), Ersteller ≠ Freigeber; Vier-Augen-Einstellung — `vieraugen.einstellen` (AP-08) | `korrektur.freigeben` und `vieraugen.einstellen` stehen seit AP-08 IP-15 (Nachtrag AP-08 §4.8); die Freigabe an Bezugsgrößen kommt mit AP-09 IP-7 |
| AP-09 §4.11 | Werte, Fassungen, Importe löschen — niemand (Offboarding ausgenommen) | keine Zeile — die Tabellen lassen es nicht zu (V20260913104500: Werte append-only); V20260913120000 öffnet nur das Löschen einer Bezugsgröße OHNE Wert (M6) |
| AP-08 §4.8 | Rohwerte, Ereignisse, Korrekturen löschen — niemand (AP-07 E8/E11; Offboarding ausgenommen) | keine Zeile — die Tabellen lassen es nicht zu (`messreihe_ereignis` append-only; der Purge lehnt Messstellen-gebundene Reihen ab, AP-07 IP-11) |
| AP-08 §5 | Bei Vier-Augen an ist der Knopf für den Ersteller gesperrt: „Freigabe durch eine zweite Person (Jonas Wendlinger, …)“ (§5, Bedienablauf „Einen Korrektur-Vorschlag prüfen und freigeben“) | rechte-vectors.json, Familie `vieraugen`: 403 `zweite_person_noetig` mit dem Satz „Freigabe durch eine zweite Person.“ und dem Weg zu den übrigen Kundenadministratoren; der Knopf ist AP-08 IP-16 |

## Kennungen

Jede Zeile hat eine stabile Kennung; eine Route, eine Fläche und ein Vektor verweisen über sie (`@Recht("messstelle.bearbeiten")`), nie über den Wortlaut. Jede Kennung, die ein Routen-Kommentar in `services/api` nennt, steht hier (`RechteKennungenDerRoutenTest`).

| Kennung | Gruppe | Aktion | Quelle |
|---|---|---|---|
| `unternehmen.bearbeiten` | Unternehmen, Standorte, Struktur (AP-02) | Unternehmen bearbeiten (Name, Kurzname, Zeitzone-Vorgabe, Sitz) | AP-03 §4.3 |
| `standort.verwalten` | Unternehmen, Standorte, Struktur (AP-02) | Standort anlegen · bearbeiten · archivieren · wiederherstellen | AP-03 §4.3 |
| `gebaeude.pflegen` | Unternehmen, Standorte, Struktur (AP-02) | Gebäude und Bereiche pflegen (anlegen, bearbeiten, verschieben, Fläche, archivieren) | AP-03 §4.3 |
| `anlage.zuordnen` | Unternehmen, Standorte, Struktur (AP-02) | Anlage einem Standort zuordnen / umziehen | AP-03 §4.3 |
| `aenderung.rueckwirkend` | Unternehmen, Standorte, Struktur (AP-02) | Rückwirkend ändern („gültig ab“ in der Vergangenheit) | AP-03 §4.3 |
| `aenderungsprotokoll.lesen` | Unternehmen, Standorte, Struktur (AP-02) | Änderungsprotokoll und „Stand am“ lesen | AP-03 §4.3 |
| `anlage.verwalten` | Unternehmen, Standorte, Struktur (AP-02) | Anlage anlegen (Assistent) · archivieren · löschen (nur ohne Historie) | AP-03 §4.3 |
| `geraet.einrichten` | Unternehmen, Standorte, Struktur (AP-02) | Box anmelden; Gerät / Komponente anlegen, verbinden, bearbeiten; Verbindungstest | AP-03 §4.3 |
| `komponente.loeschen` | Unternehmen, Standorte, Struktur (AP-02) | Komponente löschen · Gerät entfernen | AP-03 §4.3 |
| `aufzeichnungen.loeschen` | Unternehmen, Standorte, Struktur (AP-02) | Datenaufzeichnungen löschen | AP-03 §4.3 |
| `mess_selektion.bearbeiten` | Unternehmen, Standorte, Struktur (AP-02) | Mess-Selektion je Komponente (zusätzliche Messwerte) | AP-03 §4.3 |
| `messstelle.bearbeiten` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Messstelle anlegen · bearbeiten · Ort, Prozess, Kostenstelle zuordnen | AP-03 §4.3 |
| `messstelle.quelle` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Führende Quelle binden · Zählerwechsel · Wandlerfaktoren | AP-03 §4.3 |
| `korrektur.erfassen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Korrektur / Ersatzwert erfassen (versioniert, begründet) | AP-03 §4.3 |
| `bezugsgroesse.eingeben` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Bezugsgröße eingeben / berichtigen (manuell) | AP-03 §4.3 |
| `bezugsgroesse.importieren` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | CSV-Import mit Vorschau (Bezugsgrößen) | AP-03 §4.3 |
| `messwerte.ansehen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Messwerte, Zeitreihen, Datenqualität ansehen | AP-03 §4.3 |
| `kennzahl.standort_definieren` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Kennzahl definieren — Geltungsbereich Standort | AP-03 §4.3 |
| `kennzahl.unternehmen_definieren` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Kennzahl definieren — Geltungsbereich Unternehmen | AP-03 §4.3 |
| `bericht.standort_abrufen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Standort-Bericht abrufen (Entwurf, PDF/CSV auf Abruf) | AP-03 §4.3 |
| `bericht.standort_freigeben` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Standort-Bericht freigeben (Berichtsstand) | AP-03 §4.3 |
| `bericht.unternehmen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Unternehmens-Bericht abrufen / freigeben | AP-03 §4.3 |
| `export.standort` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Export je Standort (CSV: Messwerte, Kennzahlen) | AP-03 §4.3 |
| `export.unternehmen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Unternehmens-Export (alle Standorte) | AP-03 §4.3 |
| `cockpit.anpassen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Cockpit anpassen — Eigen-Schicht der Organisation (Anlage / Unternehmen) | AP-03 §4.3 |
| `auswertung.anlegen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Eigene Auswertung anlegen (je Anlage) | AP-03 §4.3 |
| `funktion.messen_einrichten` | Funktionen und Steuerung (AP-01, Bestand) | Funktion „Messen & Auswerten“ je Standort einrichten | AP-03 §4.3 |
| `funktion.steuern_einrichten` | Funktionen und Steuerung (AP-01, Bestand) | Funktion „Steuern & Optimieren“ je Standort einrichten (Anlage aufnehmen, Freigeben, Grenze, Betriebsweise) | AP-03 §4.3 |
| `steuerung.starten_beenden` | Funktionen und Steuerung (AP-01, Bestand) | Steuerung starten · beenden je Anlage (nach bestandenen Prüfungen) | AP-03 §4.3 |
| `steuerung.anhalten_fortsetzen` | Funktionen und Steuerung (AP-01, Bestand) | Steuerung anhalten · fortsetzen je Anlage; Standort anhalten · fortsetzen | AP-03 §4.3 |
| `handeingriff.setzen` | Funktionen und Steuerung (AP-01, Bestand) | Handeingriff: Speicher jetzt laden, Ladestand halten, Automatik pausieren, Gerät jetzt an/aus, „Jetzt voll laden“, „Laden pausieren“ | AP-03 §4.3 |
| `betriebsweise.aendern` | Funktionen und Steuerung (AP-01, Bestand) | Betriebsweise ändern: Betriebsmodell wechseln, Regeln anlegen/aktivieren, Steuerart je Verbraucher, Rangliste | AP-03 §4.3 |
| `ladepunkt.betrieb` | Funktionen und Steuerung (AP-01, Bestand) | Ladekarten und Fahrzeug-Profile pflegen; OCPP-Betriebsaktionen (Reservieren, Verfügbarkeit, sanft neu starten) | AP-03 §4.3 |
| `schalttest.durchfuehren` | Funktionen und Steuerung (AP-01, Bestand) | Schalt-Test / Verbindungstest durchführen | AP-03 §4.3 |
| `freigabe.erteilen` | Funktionen und Steuerung (AP-01, Bestand) | Steuern freigeben je Komponente · Freigabe zurücknehmen | AP-03 §4.3 |
| `grenze.eintragen` | Funktionen und Steuerung (AP-01, Bestand) | Anschlussgrenze, Einspeisegrenze, Netzladen-Schalter eintragen | AP-03 §4.3 |
| `register.schreiben` | Funktionen und Steuerung (AP-01, Bestand) | Register schreiben (Kunden-Lane, Vorschau + Schreiben) | AP-03 §4.3 |
| `ladepunkt.anbinden` | Funktionen und Steuerung (AP-01, Bestand) | Ladepunkt anbinden · Kennung zurücknehmen | AP-03 §4.3 |
| `prognose.befoerdern` | Funktionen und Steuerung (AP-01, Bestand) | Prognose-Modell je Anlage befördern | AP-03 §4.3 |
| `benutzer.verwalten` | Benutzer und Unterstützung (AP-03) | Benutzer anlegen (Startpasswort, Pflichtwechsel bei der ersten Anmeldung) · sperren · entfernen | AP-03 §4.3 |
| `zuweisung.verwalten` | Benutzer und Unterstützung (AP-03) | Rollen und Standorte zuweisen · entziehen | AP-03 §4.3 |
| `unterstuetzung.verwalten` | Benutzer und Unterstützung (AP-03) | Unterstützung gewähren · verlängern · beenden | AP-03 §4.3 |
| `zugriffsprotokoll.lesen` | Benutzer und Unterstützung (AP-03) | Zugriffsprotokoll lesen (wer hat wem wann was gewährt/entzogen; Anmeldungen der Unterstützer) | AP-03 §4.3 |
| `konto.eigenes` | Benutzer und Unterstützung (AP-03) | Eigenes Konto: Name, Passwort, Abmelden; eigene Standorte und Rollen sehen | AP-03 §4.3 |
| `plattform.kundenbereich` | Bleibt beim VoltPilot-Betrieb (Plattform) | Kundenbereich anlegen / löschen; ersten Kundenadministrator anlegen | AP-03 §4.3 |
| `plattform.zertifizierung` | Bleibt beim VoltPilot-Betrieb (Plattform) | Modell zertifizieren · Steuer-Scharfschaltung je Wechselrichter (S1) | AP-03 §4.3 |
| `plattform.ladepark_rahmen` | Bleibt beim VoltPilot-Betrieb (Plattform) | Ladepark-Rahmen auslegen (Hausreserve, Marge, Rotation, Budget) | AP-03 §4.3 |
| `plattform.betrieb` | Bleibt beim VoltPilot-Betrieb (Plattform) | Flotte, OTA, Registry-Push, Optimierer-Konfiguration, What-if, Vorlagen, Plattform-Prognosevorgabe | AP-03 §4.3 |
| `messstelle.ansehen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Messstellen-Register lesen (Messstelle, Ort, Quelle, Zustand, letzter Wert) | AP-04 §6.7 |
| `ereignisse.ansehen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Ereignisse einsehen | AP-07 §4.10 |
| `datenquelle.bearbeiten` | Datenquellen und Boxen (AP-06) | Datenquelle anlegen · bearbeiten · Netzlage · Erreichbarkeitsprüfung | AP-06 §4.8 |
| `datenquelle.zustaendigkeit` | Datenquellen und Boxen (AP-06) | Zuständige Box wechseln · Box tauschen | AP-06 §4.8 |
| `datenquelle.ansehen` | Datenquellen und Boxen (AP-06) | Box-Übersicht, Rückmeldung, Ausfall-Anzeige lesen | AP-06 §4.8 |
| `messstelle.formel` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Berechnete Messstelle anlegen · Formel ab einem Tag ändern (Fassung) | AP-10 §4.10 |
| `messstelle.verteilung` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Messstelle auf Kostenstellen verteilen · Verteilung ab einem Tag ändern oder berichtigen | AP-10 §4.10 |
| `kostenstelle.verwalten` | Unternehmen, Standorte, Struktur (AP-02) | Kostenstelle anlegen · umbenennen · beenden | AP-10 §4.10 |
| `prozess.verwalten` | Unternehmen, Standorte, Struktur (AP-02) | Prozess anlegen · umbenennen · beenden | AP-10 §4.10 |
| `netzanschluss.verwalten` | Unternehmen, Standorte, Struktur (AP-02) | Netzanschluss anlegen · bearbeiten · beenden · Anlage binden | AP-10 §4.10 |
| `bezugsgroesse.verwalten` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Bezugsgröße anlegen · bearbeiten · archivieren · Messkanal binden/lösen | AP-09 §4.11 |
| `ersatzwert.erfassen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Ersatzwert erfassen / zurücknehmen | AP-08 §4.8 |
| `korrektur.freigeben` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Korrektur prüfen und freigeben | AP-08 §4.8 |
| `korrektur.zuruecknehmen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Korrektur zurücknehmen (widerrufen) | AP-08 §5 |
| `vieraugen.einstellen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Vier-Augen-Einstellung ändern | AP-08 §4.8 |
