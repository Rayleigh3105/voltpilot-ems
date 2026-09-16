# UEMS-Rechte an der Steuerung und das Akteur-Vokabular (AP-03 IP-7)

Neu angelegt am 16.09.2026. Spezifikation: AP-03 §4.3 Gruppe 4, §4.4 Invarianten 3 und 11, W7, E4, E13, §8 IP-7.
Code: dieselbe Mechanik wie IP-6 (`docs/agents/root/uems-rechte-schreibrouten.md`) — `zugriff/Recht`,
`zugriff/RechtPruefung`; dazu `uems/ProtokollAkteur`, `ocpp/OcppActionPolicy`, Migration `V20260916010000`.
Beweis: `RechtMatrixApiTest` (Gruppe 4, OCPP-Stufen, A3/A11, Urheber je Art), `UemsAkteurVokabularMigrationTest`,
`OcppActionPolicyTest`, `KeycloakPartnerRolleApiTest`.

## Was gilt

- **Die 50 Schreibwege der Gruppe 4 tragen `@Recht`** — Handeingriffe und Betriebsweise sind Betrieb im Rahmen
  (Bedienberechtigt je Standort, Unterstützer „Einrichten und Bedienen“, E4), Freigabe · Grenze · OCPP-Regelung ·
  Preisblatt sind Rahmen (Kundenadministrator), Anbinden · Schalt-Test · Register sind Einrichten (Unterstützer ab
  „Einrichten“). `RechtRoutenArchitekturTest` zählt 163 Routen mit `@Recht`; in `OHNE_RECHT` stehen nur noch die
  zwei öffentlichen.
- **Zwei Rechte in einem Aufruf** lösen `RechtZiel.DIENST` + genaue Prüfung im Handler:
  - `PUT …/funktionen/steuern` (Anlage und Standort): `starten`/`beenden` = `steuerung.starten_beenden`,
    `anhalten`/`fortsetzen` = `steuerung.anhalten_fortsetzen` — die Aktion steht im Körper.
  - `PUT …/charging-config`: `gridLimitKw` = `grenze.eintragen`, Reihenfolge und Quellen-Wahl =
    `betriebsweise.aendern` — je Feldgruppe, die der Rumpf wirklich trägt.
- **Was nichts an der Anlage ändert, hängt am Lese-Recht:** `POST …/steuerung-vorschau` und `POST …/simulation`
  tragen `messwerte.ansehen` (das Portal ruft die Vorschau beim Öffnen einer Regel-Karte selbst auf — ein
  Schreibrecht hätte dort jeden Leser ausgesperrt).
- **OCPP-Stufe aus der Zuweisung (E13):** `RechtPruefung.ocppStufe(siteId)` am Standort der Anlage —
  `SITE_ADMIN` für Kundenadministrator und Bedienberechtigt, `CUSTOMER` für den Unterstützer mit „Einrichten und
  Bedienen“, `PLATFORM` für VoltPilot, sonst `KEINE`. Die Realm-Rollen `operator`/`admin`/`site-admin` gelten nur
  noch, wo es KEINEN Zugriff-Kontext gibt (OIDC aus, Token ohne Kontoart) und am Umschalter `X-Tenant-Id`.
  Der grobe `@PreAuthorize`-Riegel der drei OCPP-Controller lässt zusätzlich das Partner-Konto durch.
- **EIN Akteur-Vokabular** (`actor_sub`, `actor_name`, `actor_rolle`, `actor_art` mit
  `kunde | unterstuetzung | voltpilot | notfall`) in allen vier Protokollen — geschrieben an EINER Stelle:
  `uems/ProtokollAkteur` liest den `ZugriffContext` der Anfrage. Die Rolle ist die, unter der die Anfrage ihr Recht
  bekam (`ZugriffContext.handelndeRolle()`, gesetzt von `RechtPruefung`), sonst die höchste wirksame Zuweisung.

## Die vier Protokolle und ihre Spalten

| Protokoll | Tabelle | vorher | seit IP-7 |
|---|---|---|---|
| Änderungsprotokoll | `ort_aenderung` | `akteur_sub`, `akteur_name` | **umbenannt** in `actor_sub`/`actor_name` + `actor_rolle`, `actor_art` |
| Register-Journal | `register_write_event` | `actor_sub/name/role`, `origin` | zusätzlich `actor_rolle`, `actor_art` (`origin`/`actor_role` unverändert) |
| Handeingriff | `device_override`, `consumer_override`, `consumer_audit_event` | `created_by` bzw. `actor` (nur das Subject) | zusätzlich `actor_sub … actor_art` |
| Befehls-Verlauf | `device_command_log` | gar kein Urheber | `actor_*` an Ereignissen, die ein Mensch auslöst („Jetzt voll laden“) |

Gelesen wird es als `ProtokollUrheber {name, rolle, art}`: `urheber` an `CommandEntry` und an den Handeingriffen der
Zone Jetzt, `actorRolle`/`actorArt` am Register-Vorgang, `urheber` im Änderungsprotokoll (AP-02 IP-14).

## ⚠ Fallen für die Folgepakete

- ⚠ **Der Bestand des Ortsprotokolls trägt KEINE Rolle.** Die Migration trägt nur die Art nach (`actor_sub IS NULL`
  oder Name `VoltPilot (…` → `voltpilot`, sonst `kunde`); `actor_rolle` bleibt leer — „nicht festgehalten“ wird nie
  geraten. Wer Rollen auswertet, muss `null` vertragen.
- ⚠ **Ein neues Journal schreibt den Urheber über `ProtokollAkteur`**, nie aus einem Anfragekörper. Reicht der
  Schreibweg nur das Subject weiter (Handeingriffe, Register, Befehls-Verlauf), holt ihn
  `ProtokollAkteur.angemeldetAls(sub)` — sie gibt NUR etwas zurück, wenn das Subject der Aufrufer der Anfrage ist
  (Jobs und Listener schreiben keinen Urheber).
- ⚠ **`device_command_log.actor_*` gilt nur für Ereignisse** (`kind = 'ereignis'`, CHECK): eine abgeleitete Periode
  hat keinen Urheber. Wer eine Periode mit Urheber braucht, ändert erst den Vertrag.
- ⚠ **Bestandsregel E12 wirkt auch hier:** ein Kundenkonto, das nie eine Zuweisung hatte, ist Kundenadministrator —
  seine OCPP-Stufe steigt dadurch von `CUSTOMER` auf `SITE_ADMIN`. Das ist E13, kein Versehen;
  `KeycloakPartnerRolleApiTest` hält es fest.
- ⚠ **Nicht gebunden, weil sie nichts verschärfen:** `POST /api/v1/registration`, `POST …/enrollment/csr` bleiben
  öffentlich. `netzladenErlaubt` und `maxFeedInKw` liegen im Rumpf von `PUT /api/v1/sites/{id}`
  (`anlage.verwalten`, strenger als `grenze.eintragen`) — ein Unterstützer mit „Einrichten“ kommt dort NICHT
  durch, obwohl die Matrix-Zeile ihn nennt. Wer die Grenze aus der Anlage löst, nimmt sie mit.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='RechtRoutenArchitekturTest,RechtAufruferTest,OcppActionPolicyTest')
(cd services/api && ./mvnw test -Dtest='RechtMatrixApiTest')
(cd services/api && ./mvnw test -Dtest='UemsAkteurVokabularMigrationTest')
```
