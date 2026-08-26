# Messpunktkatalog

Dieser Ordner ist die gemeinsame, versionierte Wahrheit für Messpunkte in Portal,
Cloud und Edge. Slice 0 stellt ausschließlich Katalog und Tooling bereit: Er ändert
keinen bestehenden Telemetrie-/MQTT-Vertrag, aktiviert keinen Poller und schreibt
keine Register.

Das aktuelle, kanonische Artefakt ist
[`dist/measurement-point-catalog-2026.08.26.3.json`](dist/measurement-point-catalog-2026.08.26.3.json).
Es wird ohne Netz- oder Gerätezugriff ausschließlich aus den unter `sources/`
eingecheckten Snapshots erzeugt. `sources/manifest.json` pinnt Commit bzw.
Dokumentationsstand und SHA-256. Das Artefakt enthält keinen Erzeugungszeitstempel;
gleicher Checkout und gleiche Python-Standardbibliothek ergeben dieselben Bytes.

## Modell

Jeder Eintrag besitzt mindestens:

- Identität: `family`, stabiler `point_key`, dessen `point_key_aliases`,
  `catalog_version`, `edge_min_version`;
- Zugriff: `source_kind`, `address` und/oder `selector`, `width_bits`,
  `value_type`, `signed`, `endian`, `scale`;
- Bedeutung: `unit`, `group`, deutsches `label_de`, originales
  `label_source`, `semantic_status`, `aggregation_kind`;
- Last/Aufbewahrung: `default_cadence_s`, `min_cadence_s`,
  `long_term_cadence_s`, `poll_group`;
- Provenienz: `source_url`, `source_commit` oder `source_revision` und
  `source_sha256`.

Unbekanntes bleibt `null` und wird mit `semantic_status: unknown` oder
`vendor_label_only` sichtbar gemacht. Namen und Einheiten werden nicht aus
Registeradressen, API-Key-Kürzeln oder Beschreibungstext geraten. So bleibt etwa
die Einheit der 316 go-e-Keys bewusst leer. Für SunSpec ist `address.base` immer
`discovered`; insbesondere modelliert Model 160 jedes live entdeckte `module[i]`
über einen eigenen dynamischen Point-Key und relativen Offset.

`edge_min_version` ist in dieser ersten Version `unreleased`, weil Slice 0 keinen
Edge-Consumer veröffentlicht. Ein späterer Edge-Release setzt hier seine echte
Mindestversion in einer neuen Katalogversion.

Die JSON-Schemata liegen unter `schema/`. Der Standardbibliothek-Validator wertet
alle in ihnen verwendeten Draft-2020-12-Schlüssel tatsächlich aus und bricht bei
einem noch nicht unterstützten Schema-Schlüssel ab. `tools/validate.py` ergänzt
sie um projektbezogene Invarianten: eindeutige Point-Keys samt Alias-Namensraum,
Deye-Lock/Adress-/Decoder-Kollisionen, relative SunSpec-Adressen, Breiten,
Kadenzen, Quellen-Hashes, Shelly-Rohbelege und die dynamische Struktur von Model
160.

## Offline erzeugen und prüfen

Voraussetzung ist Python 3.10 oder neuer. Die reguläre Pipeline nutzt nur die
Standardbibliothek:

```bash
python3 catalog/measurement-points/tools/update_deye_key_lock.py --check
python3 catalog/measurement-points/tools/extract_shelly.py --check
python3 catalog/measurement-points/tools/generate.py
python3 catalog/measurement-points/tools/generate.py --check
python3 catalog/measurement-points/tools/validate.py
python3 -m unittest discover -s catalog/measurement-points/tests -p 'test_*.py'
```

Diese Befehle sind das CI-Gate. Sie installieren nichts und führen weder
Netzwerk- noch Gerätezugriffe aus. Insbesondere gehören der Deye-YAML-Normalizer
und die Remote-Quellenprüfung nicht in den normalen Build.

`normalize_deye.py` wird nur beim Austausch der vendorten YAML-Quellen benötigt.
Seine einzige Update-Abhängigkeit ist bewusst auf `PyYAML==6.0.2` festgelegt; ein
normaler Build oder Test parst kein YAML:

```bash
python3 -m pip install -r catalog/measurement-points/requirements-update.txt
python3 catalog/measurement-points/tools/normalize_deye.py
python3 catalog/measurement-points/tools/normalize_deye.py --check
```

`tools/verify_remote_sources.py` ist ebenfalls ausschließlich ein bewusster
Update-Schritt. Er vergleicht heruntergeladene Bytes mit den Pins; zum Beispiel
prüft `--source goe.api_v2` beide go-e-Dateien und damit auch den deutschen Pfad
unter `API_KEYS_FIRMWARE/`.

## Quellenbestand

- Deye: vier ha-solarman-Karten am Commit
  `ac1d88b83268beeb0511b8a1b7fc8e17deddc044`;
- SunSpec: 19 vollständige Modelle am Commit
  `90b4a331dcca1d6eac69c1bead952fddcc5852e0`;
- go-e: 316 API-v2-Keys der Firmwaretabelle 60.4 am Commit
  `b4d7f85325f5fd7243d007f7fd639ac2db16c5da`;
- Shelly: 210 direkt belegte Statusfelder der relevanten Gen1- sowie
  Gen2/Gen3/Gen4-Komponenten. 21 offizielle HTML-Seiten sind mit Abrufdatum und
  SHA-256 eingefroren; `extract_shelly.py` erzeugt daraus deterministisch die
  Normalform und bindet jeden Punkt an seine konkreten Rohseiten;
- OCPP: 22 MeterValues-Measurands und ihre Dimensionen aus dem im Projekt
  verwendeten `ocpp-go` v0.19.0 (`a1eec917af884db0585752f909a61893aa667480`).
  Die 16 Einheiten sind die OCPP-1.6-Werte; der zusätzlich in `ocpp-go`
  vorhandene Tippfehler `Celcius` bleibt ausdrücklich nur Bibliotheks-
  Kompatibilität und wird nicht als Standarddimension ausgegeben.

Die mitkopierten Lizenzdateien gelten für Deye, SunSpec und OCPP. go-e- und
Shelly-Dateien werden als unveränderte bzw. quellennahe Fakten-Snapshots mit URL,
Revision und Prüfsumme geführt; bei einer Weitergabe ist die jeweilige
Herstellerlizenz erneut zu prüfen.

## Erweitern oder aktualisieren

1. Neue Quelle in `sources/` ablegen, Commit/Revision, URL und SHA-256 im Manifest
   aktualisieren. Nie einen beweglichen Branch als Provenienz eintragen. Optional
   danach die betroffene Quelle mit `verify_remote_sources.py --source <id>`
   gegen den Ursprung prüfen.
2. Deye-Updates zuerst normalisieren und dann
   `tools/update_deye_key_lock.py` ausführen. Der Lock ist append-only: bestehende
   kanonische Keys werden auch bei Quellgruppen-/Label-Umbenennung oder späteren
   Dubletten nicht neu berechnet. Den Lock-Diff fachlich prüfen; einen bewusst
   weiter akzeptierten alten Key nur als Alias am bestehenden Eintrag ergänzen.
3. Bei Shelly die unveränderten Herstellerseiten unter `sources/shelly/raw/`
   ablegen und `raw-manifest.json` aktualisieren. Vendorfelder stehen in
   `extraction-spec.json`, VoltPilot-Kadenz/Übersetzung getrennt in
   `annotations.json`; danach `extract_shelly.py` ausführen. Ein nicht in den
   Rohseiten belegbares Feld, Typ- oder Einheitenwissen darf nicht passieren.
4. Für eine neue Struktur einen kleinen Adapter in `tools/generate.py` ergänzen.
   Quelldaten bleiben vendort; Generatoren dürfen kein Netzwerk voraussetzen.
5. Unsichere Bezeichnung, Einheit oder Semantik als `null`/`unknown` erhalten.
   Deutsche Texte brauchen eine benannte Quelle oder eine überprüfbare,
   fachlich eindeutige Übersetzung.
6. `VERSION` erhöhen und ein neues `dist/measurement-point-catalog-<version>.json`
   erzeugen. Ein bereits ausgeliefertes Artefakt wird nicht nachträglich geändert.
7. Sollbestände und Quellenstände in `tests/expected_inventory.json` bewusst
   anpassen, danach Generator-Drift, Validator und Unit-Tests ausführen.

Künftige Portal-, Cloud- und Edge-Implementierungen lesen dieses Artefakt oder ein
bytegleich daraus ausgeliefertes Paket. Sie pflegen keine zweite Liste von
Point-Keys, Labels oder Einheiten.
