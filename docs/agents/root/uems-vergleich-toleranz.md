# Toleranz je Vergleichsquelle und Monatsvergleich (AP-16 IP-17)

Verbindlich: [Bewertung §13](../../contracts/v2/bewertung.md#13-toleranz-je-vergleichsquelle-und-monatsvergleich-ip-17-g5-r9-e10--a),
Regel `monatsvergleich` (Vektoren G5 in `bewertung-vectors.json`, drei Zwillinge),
`VergleichToleranzService`, `VergleichToleranzApiTest`, `VergleichToleranzSchnittstelleVertragTest`.

- Die Toleranz hängt an der BINDUNG `messstelle_quelle` (Rolle `vergleich`), nicht am Einbau:
  eigene Tabelle `vergleich_toleranz`, keine Art in `quelle_einstellung` (die wirkt auf Werte
  und steht in der Einstellungs-Liste des Geräts). Fassung 1 = Startwert 2 % des Vertrags,
  nie gespeichert; n + 1 mit Begründung gilt ab dem laufenden Monat, nie rückwirkend.
- Lesemodell, kein Schreibweg auf Werte: führend über `MessstelleWerteService.werte(…, "monat", …)`,
  Vergleich aus `messreihe_periode` des Vergleichskanals (`energie` bei Integration, sonst `menge`).
  Beide Zahlen werden gelesen, nie gebildet oder ersetzt.
- Nur Vergleichsquellen der HAUPTGRÖSSE mit Monatsmenge vergleichen. ⚠ Die Referenzdatei führt
  K-1 an MS-01 an der Nebengröße Wirkleistung (Momentanwert) — dort `ohne_monatsmenge`. Eine
  Integration entsteht nur, wenn eine Bindung des Kanals `integration` sagt (`ViertelstundeVerdichter`).
- Lücke, Ersatzwert, angebrochener Monat oder führend ≤ 0 = `nicht_vergleichbar` mit Grund, nie
  „passt“ und nie ein Befund. Befund nur bei streng größerer, ungerundeter Abweichung.
- Recht `messmittel.angaben` am POST (Zaun über `RechtZiel.MESSSTELLE`); das GET trägt nur den
  Pflicht-Kommentar `messwerte.ansehen`. Offboarding löscht die Fassungen im AP-16-Block von
  `TenantRepository`.
