# Preise ab einem Tag: Tarif, Preisblatt und Einspeisevergütung (vp-tarif-ab-tag)

Stand 26.11.2026, Migration `V20261126223000__anlage_preisfassung.sql`.
Bau-Voraussetzung von Standort-Konzept E1 = B (ein Umzug bleibt dieselbe Anlage mit neuen Sätzen ab dem Umzugstag).

## Modell

- `anlage_preisfassung` hält je Anlage Fassungen aller drei Preisteile: Tarif (`tarif_art`, `tarif_param_ct_kwh`), Preisblatt (`preisblatt` = es gab eine `site_supply_price`-Zeile, dazu ihre Spalten) und angegebene Einspeisevergütung (`einspeiseverguetung_ct_kwh`, `inbetriebnahme_ab_solarspitzengesetz`).
- Zeitform wie das Grenzblatt: `gueltig_ab` ist ein Tag in Europe/Berlin, eine Fassung endet am Vortag der nächsten, `gueltig_ab` NULL ist die Gründungsfassung „von Anfang an“, ersetzt wird über `aufgehoben_am`, nie durch Überschreiben.
- Die Sicht `anlage_preiszeitraum` (security_invoker) liefert die wirksamen Fassungen als halboffene Zeiträume `[von, bis)` in timestamptz.
- `site` und `site_supply_price` bleiben die HEUTIGE Fassung; Optimierer, Box-Preis (`PreisZuleitung`), Einstellungen und Diagnose lesen weiter dort.

## Schreiben

- Die Fassungen schreibt nur die Datenbank: `anlage_preisfassung_gruenden` (neue Anlage), `anlage_preisfassung_site_aufzeichnen` (geänderte Preisspalten an `site`) und `anlage_preisfassung_preisblatt_aufzeichnen` (`site_supply_price`).
- Ein unveränderter Wert zeichnet nichts auf; der Voll-PUT der Anlage mit gleichem Tarif erzeugt also keine Fassung.
- Der Tag kommt transaktionslokal aus `set_config('app.preis_gueltig_ab', '<JJJJ-MM-TT>' | 'beginn', true)`; ohne Angabe gilt heute, ein künftiger Tag ist 22023.
- Eine Änderung ab Tag T ersetzt den geänderten Teil in der Fassung, die an T gilt, und in jeder späteren; die anderen Teile bleiben je Tag, wie sie waren.
- API: `tarifGueltigAb` am `PUT /api/v1/sites/{id}`, `gueltigAb` an `PUT …/supply-price` und `PUT …/einspeiseverguetung` (`web/PreisGueltigAb`: Tag bis heute, `beginn`, fehlt = heute); die Routen sind `@Transactional`, damit Tag und Änderung dieselbe Transaktion teilen.
- Lesen: `GET /api/v1/sites/{id}/preisfassungen`.

## Lesen

- Wer vergangene Energie bewertet, liest die Fassung der Viertelstunde: alle SQL-Kompositionen in `SlotEconomics` lesen den Alias `pf` (`preisFassungJoinSql(site, slot)`), nie mehr `s.tarif_*` oder `ssp.*`.
- Die Erlös-Abfragen über die Zeile je Anlage (`EarningsRepository.ANLAGE_CTE`) tragen eine Zeile je Anlage UND Fassung mit der Fassung als eine Spalte `vorab_pf`; die Viertelstunde wählt ihre Zeile über `[von, bis)`.
- Beschriftungen (`tarifPriced`, `exportVerguetungQuelle`, `HistoryRepository.tariffContext`) und die Preisgrenzen-Vorgabe der Steuerart lesen die heutige Fassung (`heutigePreisFassungJoinSql`).
- Portfolio-Kosten (`PortfolioKpiService`) bepreisen jeden Monat mit dem Arbeitspreis, der in ihm galt (nach Tagen gewichtet; ein Tag ohne Preis macht den Monat unbekannt).

## Fallen

- Eine neue Abfrage, die Energie bewertet, braucht den `pf`-Join; ohne ihn scheitert sie laut an der fehlenden Relation `pf`.
- Tests, die einen Preis direkt per SQL ändern, schreiben ohne `app.preis_gueltig_ab` eine Fassung ab heute: wer die Vergangenheit meint, setzt den Tag (Muster `abTag` in `EarningsStammdatenJeAnlageGleichheitTest`).
- Der Bestandsschutz-Beweis (Vorher/Nachher auf dem Dev-Seed, byte-gleich) und das Netzanschluss-Urteil stehen im PR vp-tarif-ab-tag.
