<!-- ERZEUGT von docs/contracts/v2/tools/rechte_matrix.py aus rechte-matrix.json — nicht von Hand ändern. -->

# Rechte-Matrix (UEMS AP-03 §4.3)

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

48 Aktionen × 7 Rollen — zeichengleich zur Tabelle im AP-03-Konzept §4.3.

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

## Kennungen

Jede Zeile hat eine stabile Kennung; eine Route, eine Fläche und ein Vektor verweisen über sie (`@Recht("messstelle.bearbeiten")`), nie über den Wortlaut.

| Kennung | Gruppe | Aktion |
|---|---|---|
| `unternehmen.bearbeiten` | Unternehmen, Standorte, Struktur (AP-02) | Unternehmen bearbeiten (Name, Kurzname, Zeitzone-Vorgabe, Sitz) |
| `standort.verwalten` | Unternehmen, Standorte, Struktur (AP-02) | Standort anlegen · bearbeiten · archivieren · wiederherstellen |
| `gebaeude.pflegen` | Unternehmen, Standorte, Struktur (AP-02) | Gebäude und Bereiche pflegen (anlegen, bearbeiten, verschieben, Fläche, archivieren) |
| `anlage.zuordnen` | Unternehmen, Standorte, Struktur (AP-02) | Anlage einem Standort zuordnen / umziehen |
| `aenderung.rueckwirkend` | Unternehmen, Standorte, Struktur (AP-02) | Rückwirkend ändern („gültig ab“ in der Vergangenheit) |
| `aenderungsprotokoll.lesen` | Unternehmen, Standorte, Struktur (AP-02) | Änderungsprotokoll und „Stand am“ lesen |
| `anlage.verwalten` | Unternehmen, Standorte, Struktur (AP-02) | Anlage anlegen (Assistent) · archivieren · löschen (nur ohne Historie) |
| `geraet.einrichten` | Unternehmen, Standorte, Struktur (AP-02) | Box anmelden; Gerät / Komponente anlegen, verbinden, bearbeiten; Verbindungstest |
| `komponente.loeschen` | Unternehmen, Standorte, Struktur (AP-02) | Komponente löschen · Gerät entfernen |
| `aufzeichnungen.loeschen` | Unternehmen, Standorte, Struktur (AP-02) | Datenaufzeichnungen löschen |
| `mess_selektion.bearbeiten` | Unternehmen, Standorte, Struktur (AP-02) | Mess-Selektion je Komponente (zusätzliche Messwerte) |
| `messstelle.bearbeiten` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Messstelle anlegen · bearbeiten · Ort, Prozess, Kostenstelle zuordnen |
| `messstelle.quelle_binden` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Führende Quelle binden · Zählerwechsel · Wandlerfaktoren |
| `korrektur.erfassen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Korrektur / Ersatzwert erfassen (versioniert, begründet) |
| `bezugsgroesse.eingeben` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Bezugsgröße eingeben / berichtigen (manuell) |
| `bezugsgroesse.importieren` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | CSV-Import mit Vorschau (Bezugsgrößen) |
| `messwerte.ansehen` | Messstellen und Messdaten (AP-04, AP-08, AP-09) | Messwerte, Zeitreihen, Datenqualität ansehen |
| `kennzahl.standort_definieren` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Kennzahl definieren — Geltungsbereich Standort |
| `kennzahl.unternehmen_definieren` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Kennzahl definieren — Geltungsbereich Unternehmen |
| `bericht.standort_abrufen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Standort-Bericht abrufen (Entwurf, PDF/CSV auf Abruf) |
| `bericht.standort_freigeben` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Standort-Bericht freigeben (Berichtsstand) |
| `bericht.unternehmen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Unternehmens-Bericht abrufen / freigeben |
| `export.standort` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Export je Standort (CSV: Messwerte, Kennzahlen) |
| `export.unternehmen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Unternehmens-Export (alle Standorte) |
| `cockpit.anpassen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Cockpit anpassen — Eigen-Schicht der Organisation (Anlage / Unternehmen) |
| `auswertung.anlegen` | Kennzahlen, Berichte, Exporte (AP-11, AP-12, AP-13) | Eigene Auswertung anlegen (je Anlage) |
| `funktion.messen_einrichten` | Funktionen und Steuerung (AP-01, Bestand) | Funktion „Messen & Auswerten“ je Standort einrichten |
| `funktion.steuern_einrichten` | Funktionen und Steuerung (AP-01, Bestand) | Funktion „Steuern & Optimieren“ je Standort einrichten (Anlage aufnehmen, Freigeben, Grenze, Betriebsweise) |
| `steuerung.starten_beenden` | Funktionen und Steuerung (AP-01, Bestand) | Steuerung starten · beenden je Anlage (nach bestandenen Prüfungen) |
| `steuerung.anhalten_fortsetzen` | Funktionen und Steuerung (AP-01, Bestand) | Steuerung anhalten · fortsetzen je Anlage; Standort anhalten · fortsetzen |
| `handeingriff.setzen` | Funktionen und Steuerung (AP-01, Bestand) | Handeingriff: Speicher jetzt laden, Ladestand halten, Automatik pausieren, Gerät jetzt an/aus, „Jetzt voll laden“, „Laden pausieren“ |
| `betriebsweise.aendern` | Funktionen und Steuerung (AP-01, Bestand) | Betriebsweise ändern: Betriebsmodell wechseln, Regeln anlegen/aktivieren, Steuerart je Verbraucher, Rangliste |
| `ladepunkt.betrieb` | Funktionen und Steuerung (AP-01, Bestand) | Ladekarten und Fahrzeug-Profile pflegen; OCPP-Betriebsaktionen (Reservieren, Verfügbarkeit, sanft neu starten) |
| `schalttest.durchfuehren` | Funktionen und Steuerung (AP-01, Bestand) | Schalt-Test / Verbindungstest durchführen |
| `freigabe.erteilen` | Funktionen und Steuerung (AP-01, Bestand) | Steuern freigeben je Komponente · Freigabe zurücknehmen |
| `grenze.eintragen` | Funktionen und Steuerung (AP-01, Bestand) | Anschlussgrenze, Einspeisegrenze, Netzladen-Schalter eintragen |
| `register.schreiben` | Funktionen und Steuerung (AP-01, Bestand) | Register schreiben (Kunden-Lane, Vorschau + Schreiben) |
| `ladepunkt.anbinden` | Funktionen und Steuerung (AP-01, Bestand) | Ladepunkt anbinden · Kennung zurücknehmen |
| `prognose.befoerdern` | Funktionen und Steuerung (AP-01, Bestand) | Prognose-Modell je Anlage befördern |
| `benutzer.verwalten` | Benutzer und Unterstützung (AP-03) | Benutzer anlegen (Startpasswort, Pflichtwechsel bei der ersten Anmeldung) · sperren · entfernen |
| `zuweisung.verwalten` | Benutzer und Unterstützung (AP-03) | Rollen und Standorte zuweisen · entziehen |
| `unterstuetzung.verwalten` | Benutzer und Unterstützung (AP-03) | Unterstützung gewähren · verlängern · beenden |
| `zugriffsprotokoll.lesen` | Benutzer und Unterstützung (AP-03) | Zugriffsprotokoll lesen (wer hat wem wann was gewährt/entzogen; Anmeldungen der Unterstützer) |
| `konto.eigenes` | Benutzer und Unterstützung (AP-03) | Eigenes Konto: Name, Passwort, Abmelden; eigene Standorte und Rollen sehen |
| `plattform.kundenbereich` | Bleibt beim VoltPilot-Betrieb (Plattform) | Kundenbereich anlegen / löschen; ersten Kundenadministrator anlegen |
| `plattform.zertifizierung` | Bleibt beim VoltPilot-Betrieb (Plattform) | Modell zertifizieren · Steuer-Scharfschaltung je Wechselrichter (S1) |
| `plattform.ladepark_rahmen` | Bleibt beim VoltPilot-Betrieb (Plattform) | Ladepark-Rahmen auslegen (Hausreserve, Marge, Rotation, Budget) |
| `plattform.betrieb` | Bleibt beim VoltPilot-Betrieb (Plattform) | Flotte, OTA, Registry-Push, Optimierer-Konfiguration, What-if, Vorlagen, Plattform-Prognosevorgabe |
