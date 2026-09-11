# UEMS-Einstellungs-Fassungen je Quelle: Wandler, Skalierung, Vorzeichen … zeitgültig, Wirkung nur ab Gültigkeitsbeginn

Neu am 11.09.2026 (AP-04 IP-11, Backend). Tabelle `quelle_einstellung` + Weitung von
`messstelle_aenderung_art_chk` um `einstellung_geaendert` (Migration `V20260911280000`), Routen
`GET /api/v1/geraete/{id}/einstellungen?stichtag=` und `POST …/einstellungen` (in
`web/GeraetEinstellungController`), Arbeit in `uems/QuelleEinstellungService`, Lesen/Schreiben in
`uems/QuelleEinstellungRepository`. Regeln NUR aus `uems/QuelleEinstellungRegeln` ⟷ TS
`src/uemsEinstellung.ts`, Fälle in `docs/contracts/v2/quelle-einstellung-vectors.json`, Prosa in
`docs/contracts/v2/quelle-einstellung.md`. Beweis: `uems/QuelleEinstellungApiTest` (A4/A5 mit
Rollup-Hash, Codes, Zaun, OpenAPI, Hebel), `uems/UemsQuelleEinstellungMigrationTest` (Fassung 1,
SQL-Seite der Vektoren, Zaun, „nur verkürzt", Offboarding), `QuelleEinstellungRegelnVectorsTest`,
`QuelleEinstellungSchnittstelleVertragTest`, `uemsEinstellung.test.ts`.

## ⚠ Die Fallen

- **Kein gespeicherter Wert ändert sich (E5).** Die Tabelle steht NEBEN der Box-Wahrheit: die
  heutigen Felder (`scale`/`offset` je Selbstbau-Kanal, `invert_*_sign`/`power_scale` je Verbindung)
  bleiben, was die Box anwendet, bis AP-06 Fassungen zustellt. Eine eingetragene angewendete
  Fassung heißt deshalb „angewendet — Zustellung ausstehend" — sie ändert nichts an der Box.
- **Die Quelle ist der EINBAU, nicht das Gerät** (`geraet.id`): ein Zählerwechsel (IP-17) bringt
  einen neuen Einbau ohne Fassungen — „Einstellungen übernommen" muss IP-17 selbst schreiben. Eine
  Fassung am Einbau gilt für alle seine Messstellen (MS-01/MS-02 an GR-2); an Komponente/Kanal nur
  dort.
- **Neue Fassung = dazwischenlegen, nie überschreiben.** Sie beendet die zu ihrem Beginn gültige
  derselben (Quelle, Art) genau dort und gilt bis zur nächsten späteren; 409 nur, wenn am selben
  Zeitpunkt schon eine beginnt. Der Trigger `quelle_einstellung_nur_verkuerzen` lässt `gueltig_bis`
  nur früher werden und schreibt keiner Rolle einen Wert um; die App-Rolle hat kein DELETE.
- **Fassung 1 = die heutige Verbindung, „gilt seit Beginn" der Speisung** (`herkunft = bestand`,
  `uems_einstellungen_ableiten_fuer`, wiederholbar: nur je (Quelle, Art) ohne jede Fassung). Die
  zwei Verbindungs-Vorzeichen stehen an den Kanälen `power_kw` bzw. `battery_power_kw` (zwei
  Fassungen derselben Art brauchen zwei Quellen), `power_scale` an der Komponente; `signed` wird nie
  eine Fassung (Datentyp, kein umgekehrtes Vorzeichen). Neue Komponenten bekommen ihre Fassung 1
  erst mit ihrer ersten Einstellungs-Änderung.
- **Der Hebel (W5) läuft im PUT der Komponente** (`ComponentService.update` →
  `QuelleEinstellungService.verbindungGeaendert`), VOR dem Schreiben der Verbindung und nach der
  Testpflicht: erst Fassung 1 aus der alten Verbindung, dann „angewendet, gültig ab jetzt"
  (`herkunft = verbindung`). Er lehnt nie ab. Selbstbau-, Rollback- und Batterie-Routen schreiben
  (noch) keine Fassung — ihre Änderungen stehen bis AP-06 nur in den heutigen Feldern.
- **Das Protokoll an der Messstelle** ist `messstelle_aenderung` Art `einstellung_geaendert` — an
  jeder Messstelle, deren `messstelle_quelle` (führend ODER Vergleich) zum `gueltig_ab` aus dem
  Einbau (bzw. der Komponente, dem Kanal) liest. Wer den CHECK weitet, schreibt DIESEN Stand ab.
- **„rückwirkend" rechnet der Schreibweg gegen seine Uhr** (`uhrStellen` in Tests) und schreibt
  `eingetragen_am` bzw. `created_at` des Protokolls mit derselben Zeit — sonst widerspricht der
  CHECK `gueltig_ab < eingetragen_am` einer festen Test-Uhr.
