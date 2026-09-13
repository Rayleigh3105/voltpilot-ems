# UEMS-Messstellen-Register: eine Abfrage je Liste, Ort · Stellung · Quelle · „Stand am“

Neu angelegt am 11.09.2026 (AP-04 IP-4, Bericht `data/vp-uems-ap04-messstellen/report.md` §5.16 und
Abnahme A17). `GET /api/v1/messstellen` ist ab jetzt das REGISTER: additiv zur Liste aus IP-3
(`messstellen` bleibt die Vertrags-Form jeder Messstelle) trägt die Antwort `register` (eine Zeile
je Messstelle zum Stichtag), `stichtag`, `zeitpunkt` und `teilansicht`. Arbeit:
`services/api/.../uems/MessstelleRegisterService` (Zeilen + Filter),
`MessstelleRegisterRepository` (die EINE Abfrage), Formen in `web/dto/MessstelleDto`
(`RegisterZeile`, `RegisterOrt`, `RegisterStellung`, `RegisterQuelle`, `RegisterBindung`,
`RegisterGeraet`), Route in `web/MessstelleController`. Beweise: `MessstelleRegisterApiTest`
(15 Fälle, Keycloak + Timescale: §5.16 Zeile für Zeile, A17, jeder Filter, Mandantenzaun, Laufzeit, IP-15)
und `MessstelleSchnittstelleVertragTest` (Java-Formen ⟷ OpenAPI, ohne Docker).

## Die Zeile und was sie NICHT sagt

- `ort`: immer da, mit `grund` des Ortsbaum-Vertrags (`verortet` · `am_unternehmen` ·
  `nicht_verortet` · `ort_nicht_im_baum`), Kurzzeichen, Art, Name, dem Intervall, das am Stichtag
  gilt, `pfad` und dem ABGELEITETEN Standort — über `OrtsbaumAbleitung.verortung`, dieselbe
  Ableitung wie `GET …/{id}/standort?am=`, nie eine zweite (SQL-)Fassung.
- `elektrische_stellung`: die Stellung, die AN DEM TAG gilt (mit Anlagen-Name und
  „Unterzähler von MS-xx“), sonst `null`.
- `quelle`: `stand` = `gebunden` · `berechnet` (AP-10 bringt die Formel) · `keine_datenquelle`
  (E8 — nie eine 0); `fuehrend` die führende Bindung der HAUPTGRÖSSE zum Zeitpunkt (Komponente,
  Kanal + Anzeigename aus `MesskanalService.anzeigename`, Gerät GR-n mit Einbau, `gueltig_ab` =
  das „seit“), `davor` die zuletzt davor beendete führende Bindung („davor Z-5a“),
  `vergleichsquellen` ihre Zahl.
- `lebenszyklus`/`fehlt`: die der Messstellen-Antwort — der HEUTIGE Zustand. Gespeichert ist nur
  der heutige Eingang (`angehalten_ab`/`archiviert_am`); ein Stichtag verschiebt Ort, Stellung und
  Quelle, NICHT den Zustand.
- `beobachtung`, `letzter_wert`, `nebengroessen` und `aggregat`: **seit IP-15 gefüllt** (die
  Platzhalter-Zusage „IMMER `null`“ ist damit eingelöst, nicht mehr gültig) — Einzelheiten und
  Fallen in [`uems-messstellen-beobachtung-letzter-wert.md`](uems-messstellen-beobachtung-letzter-wert.md).
  `null` bleibt die Beobachtung nur bei einer BERECHNETEN Messstelle — ihre Vollständigkeit steht seit AP-10 IP-9 in `berechnung`. `teilansicht` bleibt
  `false`, bis AP-03 Rechte je Standort durchsetzt; Prozess- und Kostenstellen-Filter fehlen,
  solange ihre Objekte fehlen.

## ⚠ Die Fallen

- **Ein Tag ist kein Zeitpunkt.** `stichtag=2026-11-20` heißt: Ort und Stellung an DIESEM Tag, die
  Quelle zu SEINEM BEGINN (00:00 Europe/Berlin) — dieselbe Lesart wie `…/quellen?stichtag=`. Ohne
  Stichtag gilt JETZT (Tag = heute). Wer den Stand von heute Mittag will, schickt einen Zeitpunkt
  mit Versatz, nicht den heutigen Tag.
- **Ein Filterwert, den es hier nicht gibt, findet NICHTS.** Eine unbekannte (oder fremde) ID
  darf nicht wie „kein Filter“ wirken — sonst zeigt `?standort=<fremde-id>` genau die Messstellen
  OHNE Standort. `Auswahl.nichts` schaltet die Liste leer; 403 gibt es nie (RLS-Muster).
- **`ohneQuelle=true` ist nicht „ohne führende Bindung“ schlechthin**, sondern GEMESSEN ohne
  führende Quelle zum Zeitpunkt: eine berechnete Messstelle hat keine Quelle, weil sie gerechnet
  wird, und ist deshalb NIE „ohne Quelle“.
- **Eine Abfrage — und der Ortsbaum.** Alles über die Messstellen (Zeile, Nebengrößen, alle Ort-,
  Stellungs- und Quellen-Intervalle) kommt aus GENAU EINER Abfrage
  (`MessstelleRegisterRepository.ABFRAGE`, JSON je Zeile, Schlüssel = Komponenten der Lese-Records,
  Jackson baut daraus DIESELBEN Records wie die Einzel-Routen — ein unbekannter Schlüssel ist ein
  Fehler, kein stilles Feld). Dazu kommt der feste Lesezug des Standort-Lesemodells für den
  Ortsbaum (`StandortService.baum`) — eine Zahl, die NICHT mit der Zahl der Messstellen wächst.
  `MessstelleRegisterApiTest` zählt am DataSource-Umhang nach: 100 Messstellen = 1 Abfrage auf den
  Messstellen-Tabellen und insgesamt so viele wie 1 Messstelle (< 300 ms). Seit IP-15 kommt EIN
  weiterer Zug für die Werte dazu (`MessstelleRegisterRepository.WERTE`) — er bekommt alle
  Messwerte als Feld und rührt KEINE Messstellen-Tabelle an, die Zusage „eine Abfrage mit
  ‚messstelle‘ im Text“ hält also weiter.
- **Zwei Lesewege, EINE Wahrheit.** Die Liste baut ihre Vertrags-Objekte über dieselbe
  `MessstelleService.darstellung(…)` wie `GET …/{id}`; `dieListeUndDieEinzelneMessstelleSagenDasselbe`
  hält beide zusammen. Wer `messstelle_quelle` & Co. um eine Spalte erweitert, muss sie in der
  Abfrage MIT aufnehmen, sonst schlägt genau dieser Test zu.
