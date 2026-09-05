# Versionierter Messpunktkatalog (`catalog/measurement-points`)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 154).


- **Eine Wahrheit für Portal, Cloud und Edge.** Der kanonische, deterministisch
  erzeugte Bestand liegt versioniert unter `catalog/measurement-points/dist/`;
  künftige Consumer lesen dieses Artefakt bzw. ein bytegleich daraus erzeugtes
  Paket und pflegen keine zweite Point-Key-/Label-/Einheitenliste. Slice 0
  ändert bewusst keinen bestehenden Telemetrie- oder MQTT-Vertrag und aktiviert
  keinen Laufzeit-Poller.
- **Quellen bleiben vendort und gepinnt.** `sources/manifest.json` nennt für
  Deye, 19 SunSpec-Modelle (inkl. dynamischem Model 160), 316 go-e-Keys,
  Shelly-Generationen/-Komponenten, OCPP-1.6-MeterValues sowie die exakt von den
  In-Repo-Decodern gelesenen Fronius-Solar-API-, KACO-HTTP- und
  KOSTAL-PLENTICORE-Punkte immer URL,
  Commit/Revision und SHA-256. Der normale Generator/Validator ist
  Standardbibliothek-only und greift weder auf Netz noch Geräte zu.
- **Deye-Keys werden NIE neu aus Labels berechnet.** Der append-only
  `sources/deye/point-key-lock.json` hält kanonische Keys, Quell-Locator-/
  Fingerprint-Historie und manuelle Aliase; nach einem Deye-Quellenupdate läuft
  `update_deye_key_lock.py`, dessen Diff bewusst geprüft wird. Regressionen
  nageln Umbenennung und eine später hinzukommende Namensdubletten fest.
- **Shelly hat eine echte Rohdatenkette.** Die offiziellen HTML-Seiten liegen
  bytegenau mit URL/Abrufdatum/SHA in `sources/shelly/raw/` und
  `raw-manifest.json`. `extract_shelly.py` belegt Selektor, Feld, Typ und Einheit
  daraus und verbindet erst dann die getrennten VoltPilot-Annotationen; der
  normale Gate prüft diese Ableitung offline. `verify_remote_sources.py` ist
  dagegen nur ein ausdrücklicher, netzabhängiger Update-Schritt.
- **Das Katalog-CI bleibt wirklich offline.** Es installiert nichts und prüft
  Lock, Shelly-Extraktion, Generator, die tatsächlich ausgewerteten JSON-Schemata
  (inkl. `additionalProperties`) sowie Semantik mit der Python-Standardbibliothek.
  PyYAML wird nur für ein bewusstes Deye-Quellenupdate gebraucht.
- **Unknown-Ehrlichkeit und dynamische Adressen sind Vertragsregeln.** Keine
  Einheit oder Semantik aus Kürzeln/Adressen raten; stattdessen
  `semantic_status=unknown|vendor_label_only` und `null`. SunSpec-Basen sind
  immer live `discovered`; Model 160 behält pro `module[i]` einen eigenen
  Point-Key. `edge_min_version=unreleased` ist für diese reine
  Katalogscheibe absichtlich ehrlich. OCPP führt exakt die 16 Standard-Einheiten;
  `Celcius` aus `ocpp-go` ist nur ein Bibliotheks-Kompatibilitätstippfehler.
- **Jede inhaltliche Änderung ist eine neue Katalogversion.** `VERSION`
  erhöhen, altes Artefakt nicht umschreiben, dann `generate.py --check`,
  `validate.py` und die Unittests aus der Katalog-README ausführen. Bestände,
  Quellstände, Dubletten/Adressen und deterministische Bytes sind
  regressionsgesichert; das optionale Deye-YAML-Update nutzt ausschließlich die
  in `requirements-update.txt` gepinnte PyYAML-Version. Der Release-Test hält
  `VERSION`, die Maven-Ressourcenauswahl der API und den paketierten Edge-Katalog
  auf exakt derselben Version; der gemeinsame API-Publisher-Fixture muss durch
  den echten Edge-Planer und die Runtime laufen.

