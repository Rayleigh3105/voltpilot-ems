# Die VORSCHAU und die KURVEN-VORLAGEN (P5d, api-Hälfte)

Zwei kleine Routen, die die Portal-Fläche des Batterie-Anschlusses trägt (Konzept
`vp-deye-diybms-luecke-l5` §3.2b, Paket P5d). Die Fläche selbst steht in
`docs/agents/portal/der-batterie-assistent-p5d-anschluss-zuo.md`.

## `GET /api/v1/soc-curve-templates`

Der Kurven-Katalog (`soccurves/catalog.json`, seit P5b) als DTO —
kunden-förmig, authentifiziert, **nicht anlagenbezogen**: eine Kennlinie ist eine
Aussage über eine ZELLCHEMIE, nicht über eine Anlage (dasselbe Muster wie
`GET /api/v1/component-templates`). Sie existiert, damit das Portal die
Stützpunkte nicht nachbaut; ein Zwilling im Frontend dürfte abdriften, und eine
abgedriftete Kennlinie ist ein falscher Ladestand mit Nachkommastellen. Jede
Vorlage trägt `chemistry` und ihr Zellfenster mit, damit die Fläche sie NENNEN
kann.

## `POST /api/v1/sites/{siteId}/components/battery/preview`

Die Zuordnungs-VORSCHAU. `UserDefinedBatteryService.previewConnection` prüft den
Rumpf mit **derselben** `requireValid`-Regel wie das Speichern und schickt die
so entstandene Definition — wörtlich das, was in `connection_json` landen würde,
plus `listen_s` — als `connection` einer `test_connection`-Anfrage über den
BESTEHENDEN Probe-Kanal (`ProbeService.testConnection`, brand
`user-defined-battery`). Eine zweite, nur für die Vorschau gebaute Form wäre ein
Zwilling und damit eine Vorschau auf etwas anderes als das Ergebnis.

**Sie schreibt nichts** — keine Entität, keine Fassung, kein Flow, kein
Verbindungstest-Beleg — und ist ausdrücklich **keine Voraussetzung des
Speicherns**: eine MQTT-Vorschau braucht ein Lauschfenster, das ältere Boxen nicht
haben, und eine Pflicht ohne Tür wäre eine Sackgasse statt eines Schutzes. Jeder
Ausgang ist deshalb ein 200 mit benannter Klasse; `not_supported` ist eine Aussage
über die BOX, nie über die Zuordnung.

## Der `samples`-Block (Vertrag, additiv)

`docs/contracts/mqtt-probe.schema.json` → `op_result.samples`: EINE Zeile je
Zuordnung mit `channel`, `topic`, `raw`, `value`, `count`, `at`. **Ein eigener
Block, nicht `reading`**: `reading` ist die geschlossene Vier-Kanal-Momentaufnahme
eines KATALOG-Geräts, während diese Zeilen die Namen tragen, die der Kunde gerade
eingetippt hat. Fixtures:
`examples/mqtt-probe.valid.test-connection-battery{,-result}.json`.

Die Ehrlichkeitsregeln erzwingt `ProbeResultListener` bei der ANKUNFT, statt sie
der Box zu glauben: eine Zeile ohne Kanal wird verworfen; `count = 0` heißt
„nichts empfangen" und wirft `raw`/`value` weg (eine Zahl ohne Empfang wäre eine
erfundene Messung); ohne BEIDE Zahlen ist es keine Lesung. Eine Ablehnung darf
Zeilen tragen — „im Fenster kam nichts an" ist genau die Auskunft, wegen der die
Vorschau existiert.

**⚠ Die BOX-Hälfte fehlt noch.** Kein heutiger Edge-Stand kann lauschen; er
antwortet `not_supported` und sendet den Block gar nicht. Ein FEHLENDER Block
heißt „diese Box kann es nicht", nie „es kam nichts an" — die Fläche unterscheidet
beides.
