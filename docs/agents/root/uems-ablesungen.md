# Ablesungen an Messstellen (AP-09 IP-8)

Einstieg: `docs/contracts/v2/messwert-herkunft.md` → Ablesungen; Code `AblesungService`,
`AblesungRepository`, `AblesungPerioden`, `AblesungLueckenLauf`. Migration
`V20260916180000__uems_ablesungen.sql`, echte App-Rolle: `AblesungApiTest`.

- Ablesungen sind gemessene Zählerstände, keine Bezugsgrößen mit Beleg. Identität:
  Mandant + Messstelle + Größe, niemals eine erfundene Box/Komponente. Quellen-Art
  `ablesung` ist additiv; alte Quellen behalten `art = NULL` (= Messkanal) und ihre Pflichtfelder. Der
  Default `messkanal` gilt nur für neue Zeilen, kein Backfill der Bestandszeilen.
- Erst die gemeinsame Vier-Augen-Einstellung mit FOR SHARE sperren, dann die Messstelle.
  Berichtigungen nutzen `MessreiheKorrekturRepository` und die bestehenden Freigabe-/
  Rücknahmerouten. `Reihe.ablesung` ist eine eigene Identitätsform; kanalgebundene
  Aufrufer behalten ihren bisherigen Konstruktor. Die Kaskade darf daraus keine
  Komponentenreihe machen.
- Die Rohwertklasse hat 90 Tage Aufbewahrung: Herkunft und Fassungen werden beim
  INSERT dauerhaft in `messstelle_ablesung_fassung` belegt, ohne zweiten Schreibweg.
  Keine Updates; Entfernung ausschließlich beim Offboarding vor der Quellenbindung.
  Der optionale Offboarding-Hook wird auf älteren Migrationsständen nicht aufgerufen.
- Z6/E5 ordnet den ganzen Ablesezeitraum einem Monat zu; nie interpolieren oder auf
  Tage verteilen. Das AP-08-Lesemodell liest vorhandene Perioden und Versionen.
  B8/F17: 95,9 %, Oktober 1 240 m³, November keine Werte.
- Archivieren beendet auch die komponentenlose Quellenbindung über den bestehenden
  `MessstelleQuelleService` und nennt sie im Archiv-Protokoll. Der Filter verwendet
  Bestandsspalten; alte Migrationsstände bleiben lesbar.
- Z7: strikt später als letzte Ablesung + zwei lokale Kalendermonate. `data_gap/cloud`
  ohne Box; stabile Ereignis-ID aus Quelle und letztem Zeitpunkt. Änderungen des
  Kennzeichens ändern die Ereignisidentität nicht.
- Vertragsleser: Herkunft in API/Writer, Ereignisse auch Ingest und Portal, unveränderte
  `verbrauch-vectors.json` für F17. Migrationen mit TenantRepository gegen alte Stände
  sowie die sechs Bestandsschutz-Nachbarn mitlaufen lassen.
