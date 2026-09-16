# UEMS-Stichtag der Bestandsregel E12: `zugriff_bestand` (AP-03, Befund aus IP-5)

Neu angelegt am 16.09.2026. Spezifikation: Befund `vp-uems-r03-e12-stichtag` aus dem Bau von AP-03 IP-5 (PR 825).
Code: `V20260916060000__uems_zugriff_stichtag.sql`, `ZugriffRepository.bestandskonto`/`stichtag`/`stichtagSetzen`,
`ZugriffBestand.bestandAbschliessen`, `ZugriffBestandLaeufer`, `KundenbenutzerAngelegt.neuerKundenbereich`.
Beweis: `ZugriffStichtagTest` (die vier Nachweise), `ZugriffBestandTest`, `ZugriffBestandWiringTest`.

## Warum

Die Bestandsregel E12 steht seit IP-4 **in der Anfrage**: ein Kundenkonto, das in seinem Kundenbereich NIE eine
Zuweisung hatte, ist unternehmensweit. Das ist bewusst so — sonst sperrte jede Störung des Start-Laufs (Not-Aus,
Keycloak nicht erreichbar, Lauf abgeschaltet) den ganzen Kunden aus, ein Betriebsproblem würde zum Ausfall.

Der Regel fehlte ein **Stichtag**. Ein im Portal frisch angelegtes Konto hat naturgemäß nie eine Zuweisung — und
wäre damit unternehmensweit. Genauso ein Konto, das jemand direkt in der Keycloak-Admin-Konsole mit dem passenden
`tenant_id`-Attribut anlegt: es erreichte den ganzen Kundenbereich, ohne dass irgendwo eine Zeile steht.

## Was gilt

- **Der Stichtag ist die Übernahme selbst.** `zugriff_bestand` hält je Kundenbereich EINE Zeile: `stichtag`,
  `herkunft` (`bestandslauf` | `neuer_kundenbereich`), `konten`. **Keine Zeile = die Regel gilt.**
- **Ohne Stichtag** bleibt alles wie in IP-2/IP-4: nie zugewiesen = unternehmensweit. Kein Bestandskonto wird
  ausgesperrt, egal ob der Lauf aus ist, scheiterte oder noch nicht dran war.
- **Mit Stichtag** gilt E12 in diesem Kundenbereich nicht mehr. Der Lauf hat dort für JEDES Konto eine echte Zeile
  in `zugriff` geschrieben — „nie zugewiesen" kann danach nur noch „nach dem Stichtag entstanden" heißen. Ein
  solches Konto bekommt `standorte` + `{}`, sieht auf keiner gezäunten Tabelle eine Zeile, bekommt aus
  `RechtPruefung.benutzer` keine Zuweisung und schreibt Protokolleinträge ohne Rolle.
- **Wer ihn setzt:** nur wer die VOLLSTÄNDIGE Kontenliste sieht.
  - `ZugriffBestandLaeufer` → `ZugriffBestand.bestandAbschliessen(liste, HERKUNFT_LAUF)`.
  - `KundenbenutzerAngelegt` mit `neuerKundenbereich = true` (nur `RegistrationController`) → `HERKUNFT_NEU`: ein
    Kundenbereich, der mit seinem ersten Konto entsteht, hat keinen Bestand und beginnt sofort ohne die Regel.
  - Ein einzeln nachgezogenes Konto (`AdminController.createUser`) setzt ihn NIE.
- **Einmal und nie verschoben:** `INSERT … ON CONFLICT DO NOTHING`, die App-Rolle hat kein `UPDATE`-Recht. Der
  Stichtag entsteht in DERSELBEN Transaktion wie die Zuweisungen — es gibt ihn nie ohne sie.
- **Eine möglicherweise abgeschnittene Liste setzt keinen Stichtag.** Meldet Keycloak
  `KeycloakAdminClient.MAX_KONTEN_JE_KUNDENBEREICH` Konten, übernimmt der Lauf, lässt den Bestand aber offen —
  lieber die Regel einen Start länger als ein ausgesperrtes Bestandskonto.
- **Unverändert:** ein Konto mit nur beendeten oder nur künftigen Zuweisungen bleibt beim engsten Zaun. „Nie
  gehabt" ist nicht „hat gerade keine", und ein Entzug wirkt weiter sofort.
- Die neue Fläche heißt im Code `Zugriff.bestandskonto()` (früher `nieZugewiesen`) — sie trägt jetzt beide
  Hälften. Ihre drei Leser (`modus()`, `RechtPruefung.benutzer`, `ProtokollAkteur.hoechsteRolle`) sind unberührt.

## ⚠ Fallen

- ⚠ **Der Stichtag ist keine Zeitgrenze, gegen die gerechnet wird.** Er ist die Aussage „der Bestand dieses
  Kundenbereichs ist übernommen". Wer gegen `stichtag` vergleichen will, braucht erst einen Zeitpunkt am Konto —
  den gibt es nicht (`benutzer.created_at` ist die Zeit des Laufs, nicht die Anlage in Keycloak).
- ⚠ **Für IP-13/IP-14:** eine Kundenroute, die ein Konto anlegt, schreibt seine Zuweisung in DERSELBEN Handlung
  und veröffentlicht `KundenbenutzerAngelegt` NICHT (sonst wird das Konto Kundenadministrator). Mit dem Stichtag
  ist ein solches Konto ohne Zuweisung rechtlos statt unternehmensweit — das ist die gewollte Richtung.
- ⚠ **In Produktion ist der Stichtag beim ersten Start nach dem Deploy da**, danach greift die neue Regel. Im
  Testlauf ist der Start-Lauf aus (surefire), also hat keine Tabelle einen Stichtag und jeder Bestandstest misst
  weiter die alte Regel. Wer die neue Regel prüfen will, setzt die Zeile selbst.
- ⚠ Die Tabelle gehört zum Offboarding: `TenantRepository.deleteById` räumt sie mit `zugriff_protokoll`,
  `zugriff` und `benutzer` ab (Fremdschlüssel `ON DELETE RESTRICT`).
- ⚠ `ZugriffKontextLader.bestandskonto` fragt nur, wenn KEINE Zuweisung wirksam ist — eine Anweisung für beide
  Hälften. Ein Lesefehler heißt „kein Bestandskonto", also der enge Zaun.
