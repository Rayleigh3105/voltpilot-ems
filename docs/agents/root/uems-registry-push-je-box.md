# UEMS-Registry-Push je Box: jede Box genau ihre Quellen, Anlagen-Rollen nur an die führende

Neu am 15.09.2026 (AP-06 IP-6, W7). Regel `services/api/.../uems/PushJeBox.java` (rein), Dienst
`entities/EntityRegistryService.pushRegistryBestEffort` → `pushJeBox`, Lesewege
`EntityRegistryRepository.datenquelleJeEntitaet` · `zustaendigkeitenDerQuellen` · `boxenMitSoll` ·
`upsertRegistryStates`, Migration `V20260915040000`. Prosa `docs/contracts/v2/data-source-assignment.md`
§8 „Der Push je Box (IP-6)“. Beweis: `uems/PushJeBoxTest` (Referenz A1/A3/A9, erschöpfend über alle
kleinen Welten), `entities/RegistryPushJeBoxBestandTest` (feste Uhr, Byte-Gleichheit gegen den wörtlich
kopierten Weg vor IP-6, Abbruch beim Bauen, Teilzustellung), `uems/RegistryPushJeBoxApiTest`
(Testcontainers + EMQX: drei Boxen, drei Pushes, am Broker gezählt; Rollen; Wechsel zum Zeitpunkt; A12;
Übernahme mit Teilzustellung).

## ⚠ Die Fallen

- **Welchen Weg der Push nimmt, entscheidet EINE Frage:** trägt irgendeine v2-Entität der Anlage
  `data_source_id`? Nein → der Weg von vorher, Zeile für Zeile (ein Push an die führende Box,
  `upsertRegistryState`). Ja → je Box. Ein Mock ohne `datenquelleJeEntitaet` liefert eine leere Map
  und fährt damit den Bestandsweg — die Bestandstests bleiben so, wie sie sind.
- **Ohne führende Box kein Push — auch keiner je Box** (`keine_fuehrende_box`). Sonst verlöre die Box,
  die heute die Anlagen-Summe bildet, ihren Bestand, sobald eine zweite Box ohne Speicher-Link dazukommt.
- **Anlagen-Rollen = `grid-meter`, `house-load`, `battery-hybrid`.** Liest ihre Quelle eine andere Box
  als die führende, steht die Rolle in KEINEM Push (Log `anlagen_rolle_an_anderer_box`) — nie bei der
  falschen Box. `producer` und `user-defined-battery` folgen ihrer Quelle wie jede Komponente.
- **Anlagen-übergreifend ist gesperrt:** liest eine Box außerhalb der Anlage die Quelle (A3: DQ-3 an
  Box Halle 2 (neu) ab 10.04.2027 07:30), steht die Komponente in keinem Push
  (`box_ausserhalb_der_anlage`), bis IP-7 den Fall freischaltet.
- **Soll je (Anlage, Box).** Schlüssel `(tenant_id, site_id, device_id)`; `registryState`,
  `registryRevision` und die Admin-Flotte lesen die JÜNGSTE Zeile (`composed_at`, bei Gleichstand die
  Box-Kennung) — ein Lauf schreibt alle Boxen mit derselben Revision, in EINER Anweisung. Abmelden setzt
  `device_id` weiter auf NULL; eine noch angemeldete Box mit Soll-Zeile bekommt ihre (auch leere)
  Vollmenge und vergisst so eine Quelle sicher.
- **Zugestellt heißt: JEDE Box.** `PushOutcome.published` ist nur wahr, wenn jede Box ihren Push bekam;
  `boxen` nennt jede, `teilweiseZugestellt()` den W7-Fall. Die Bestands-Übernahme wirft dann
  `PushNotDeliveredException(siteId, teilweiseZugestellt)`, und NACH dem Rollback stellt
  `ComponentAdoptionService.nachAbbruchZurueckstellen` beide Boxen zurück — gerufen vom Takt und von der
  Admin-Route. Wer einen weiteren Aufrufer von `adoptIfComplete` baut, ruft es mit.
- **Alles oder nichts je Box:** ERST alle Nutzlasten bauen, DANN das Soll aller Boxen, zuletzt zustellen.
  Wer an `pushJeBox` etwas zwischen Bauen und Schreiben einfügt, das werfen kann, bricht den
  Abbruch-Test in `RegistryPushJeBoxBestandTest`.
- **Noch NICHT:** wer eine Zuständigkeit schreibt (Datenquellen-API, Vorschlagsliste), löst keinen Push
  aus — die neue Verteilung erreicht die Boxen mit dem nächsten Registry-Push der Anlage; die Übergabe mit
  Reihenfolge (alt ohne → neu mit) ist IP-7. Mess-Plan (`measurement-config`), Flow-Aktivierung und
  Fahrplan bleiben an der führenden Box und unverändert.
