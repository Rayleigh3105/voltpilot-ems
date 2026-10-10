# Energetische Bewertung: Kaskade und Anstoß (AP-16 IP-23)

Die energetische Bewertung nutzt beide Wege der bestehenden Bericht-Maschine. `BerichtKaskade` trifft über die
`messstelle`-Quellen auch Bewertungsstände, wenn eine zitierte Monatsversion korrigiert wird. Der Stand bleibt
byte-gleich; nur `bericht_revision_anstoss` und die bestehende Meldung kommen hinzu.

`StrukturAenderungLaeufer` liest zusätzlich `energieeinsatz_aenderung`, `bewertung_aenderung`,
`messbedarf_aenderung`, `geraet_aenderung` und rückwirkende `prozesse_zugeordnet`-Einträge aus
`messstelle_aenderung`. Das vorhandene Wasserzeichen `bericht_struktur_gelesen` bleibt zeilenweise und wird in derselben
Transaktion wie die Naht geschrieben. Die sechs Anlass-Arten und ihre Kennungen stehen in `docs/contracts/v2/bericht.md`
§7 B4.

## Grenzen und Schalter

- `voltpilot.uems.bewertung.enabled` ist standardmäßig an. Aus blendet nur Bewertungsstände aus der Kaskade aus und liest
  die Bewertungs-Protokolle nicht; Routen, andere Berichte und deren Strukturpfad bleiben unverändert.
- Bewertungs-Protokolle werden erst Kandidaten, wenn im Mandanten ein Bericht der Vorlage `energetische_bewertung`
  besteht. Ohne Bewertung entsteht darum auch kein Wasserzeichen.
- Kriterien-Fassungen lösen über alle Umfang-Quellen des Mandanten auf; Umfangsänderungen über alte und neue Fassung;
  Einstufung, Messbedarf und Messmittel über ihre jeweilige Quellen-ID; Prozess-Zuordnungen über die Energieeinsätze der
  vorher und nachher genannten Prozesse.
- Ein beantragter Vier-Augen-Stand löst noch nicht aus: `einstufung_gesetzt` zählt nur, wenn er schon freigegeben ist,
  andernfalls erst `einstufung_bestaetigt`.

Prüfnachweis: `UemsStrukturAenderungTest` (R7, R11, R15 sowie Einstufung, Messbedarf, Messmittel, Prozess-Zuordnung und
Flag aus), `UemsBerichtKaskadeTest`, `StrukturAenderungWiringTest` und die Vertrags-/Migrationswächter.
