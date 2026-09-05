# Der Kommando-Verlauf JE GERÄT: `?device=` auf `/command-history`

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 148).


Anlagen-Zentrale Stufe 1 PR 1b (Konzept `data/vp-anlagen-zentrale-konzept-h6`
§7.4, Captain-Entscheid **D3: die Befehle-Seite bleibt, die Geräteseite zeigt
die gefilterte Sicht**). Rein ADDITIV: ohne den Parameter antwortet die Route
byte-gleich wie vorher.

- **⚠ DIE GRENZE IST EINE AUSSAGE, keine Bequemlichkeit** (`CommandLogRepository.entriesForDevice`):
  die **BOX** bekommt JEDE Zeile ihres Geräts — auch die gerätebezogenen ohne
  Komponente —, weil sie DER Schreibweg der Anlage IST; ein **Gerät DAHINTER**
  bekommt nur die Zeilen SEINER Komponenten. Grund ist die belegte Datenlage:
  der `abregelung`-Strom wird mit `entity_id = null` geschrieben
  (`CommandLogWriter`), weil die Box EIN Rücklesen über ALLE Einheiten
  zurückliest — eine anlagenweite Abregelung einem von drei Wechselrichtern
  zuzuschreiben wäre eine **erfundene Zuordnung**. **Das weicht bewusst vom
  Konzept-Wortlaut ab** („die Abregelung steht damit bei den Fronius"): der
  Scout nahm ein gesetztes `entity_id` an, das es nicht gibt. Die Fläche ZIEHT
  die Grenze nicht nur, sie ERKLÄRT sie (`befehle.ANLAGENWEITE_BEFEHLE`).
- **`command/DeviceScopes` ist die EINZIGE Stelle, die eine Geräte-Adresse
  auflöst** — Box-Referenz/UUID · gemeldete Quellen-Kennung (`inverter`,
  `src-…`) · `cp-<ChargePointId>` —, und sie tut es ausschließlich über
  BESTEHENDE Lesepfade (`DeviceRepository`, `DeviceSourceStatusRepository`,
  `DeviceChargerStatusRepository`, `EntityRegistryRepository`), ohne eine neue
  Abfrage-Form. Jeder davon ist RLS-gefenced, eine fremde Anlage kann also gar
  nicht auflösen → **404, nie 403**. `CHARGER_PREFIX` ist der Zwilling der
  Portal-Funktion `geraetSeite.chargerGeraetId` — **beide zusammen ändern**.
- **Ein Gerät gilt als BELEGT, sobald EINES von beidem vorliegt:** eine
  Komponente ist darauf gepinnt ODER die Box meldet es. Nur eines zu verlangen
  hieße, ein real vorhandenes Gerät je nach Tagesform nicht zu finden. Ein
  gemeldetes Gerät OHNE Komponente ist eine gültige, **ehrlich leere** Antwort —
  nie zu „alle Zeilen der Anlage" aufgeweitet.
- **`entity` und `device` schließen sich aus (400).** Zwei verschiedene Fragen;
  eine still zu bevorzugen hieße, eine der beiden Antworten unter dem falschen
  Etikett auszugeben.
- **Zwei additive DTO-Felder, beide gegen das Raten:** `deviceRef` (Echo des
  Filters) und **`deviceIsBox`** (Server-Fakt: Box oder Gerät dahinter — die
  Fläche kann es aus dem Ref nicht ableiten, ohne die `cp-`/`src-`-Konventionen
  zu erraten). Die Antwort trägt bewusst **KEINEN Geräte-NAMEN** — den bildet
  das Portal aus seiner einen Ableitung (`entityLabel.deviceName`), ein zweiter
  hier wäre ein Zwilling, der abdriftet.
- **`writes` beschreibt bei einem Geräte-Filter das GERÄT** (schreibt VoltPilot
  an irgendeine seiner Komponenten?) — die EINE Regel dafür ist
  `CommandLogReader.writesTo`, geteilt mit `DeviceScopes`, damit eine Komponente
  und ihr Gerät darüber nie Verschiedenes behaupten.
- **Register-Zeilen** (der vierte Strom) folgen derselben Grenze:
  `RegisterWriteEventRepository.betweenForEntities` ordnet über `entity_id` zu,
  also über die Lane „komponente". Ein Vorgang auf der primären Lane oder einer
  frei getippten Adresse gehört dem Schreibweg der BOX und erscheint dort.
- **Dieselbe Grenze gilt dem REGISTER-Journal** (Anlagen-Zentrale Stufe 1 PR 1c):
  `RegisterWriteEventDto` trägt seit dieser Stufe additiv `entityId` — die Lane
  „komponente" ist die einzige Zuordnung, mit der sich ein Vorgang einem Gerät
  HINTER der Box zuschreiben lässt; primäre Lane und frei getippte Adresse
  gehören dem Schreibweg der BOX. Gepinnt in `RegisterWriteApiTest` (Entity-Lane
  trägt die Komponente, primäre Lane trägt `null`).
- **Beweis:** `CommandHistoryApiTest.derGeraeteFilterTrenntDieBoxVonDenGeraetenDahinter`
  (echte DB: Box sieht beide Ströme, das Gerät dahinter nur seine Komponente,
  gemeldet-ohne-Komponente ehrlich leer, unbekannte Adresse 404, Komponente +
  Gerät 400, fremde Anlage 404). Portal-Seite in `frontend/portal/AGENTS.md`.

