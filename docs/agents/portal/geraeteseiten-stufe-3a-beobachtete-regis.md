# Geräteseiten Stufe 3a: „Beobachtete Register" — die Messbibliothek, richtig herum

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 10).


Konzept `data/vp-geraeteseite-rahmen-r2` §7.2/§7.4 (Captain-Entscheide **D3a** die Liste gibt
es auch für HTTP/OCPP-Geräte · **D5a**). Sie führt die Stufe-0-Auskunft („welchen Katalog zeigt
diese Seite?") zu Ende: die Sektion beginnt jetzt mit dem, was DIESES Gerät WIRKLICH aufzeichnet.
Die ursprüngliche Stufe war reine Portal-Arbeit ohne neuen Endpunkt oder Migration; sie baut auf
der Komponenten-Selektion des Servers auf (PR 536, Root-`AGENTS.md` „Mess-Selektion JE
KOMPONENTE"). Der spätere Statusabruf `selectedOnly` ist unten als Produktions-Härtung benannt.

- **⚠ `MeasurementLibrary` ist darin AUFGELÖST, nicht dupliziert** (Datei + Test gelöscht, das
  Stylesheet heißt seither `components/Messwerte.css` und wird von `SiteMeasurementComparison`
  mitbenutzt). Die Drawer-Bauteile (`PointRow`, `HistoryChart`, das Formular für ein eigenes
  Register) sind WÖRTLICH mitgewandert — eine zweite Kopie hieße, jede Ehrlichkeitsregel und
  jeden Ablehnungs-Satz zweimal zu pflegen. Neu sind die reine `src/beobachteteRegister.ts` und
  die Fläche `components/BeobachteteRegister.tsx`.
- **Die Sektion hat DREI Teile in dieser Reihenfolge** (§7.2): **1** die beobachteten Punkte als
  Zeilen (Name · Adresse mono · Wert + Einheit + Frische · 24-h-`MiniLineSpark` · „Verlauf" /
  „Nicht mehr beobachten" · Zustands-Chip), **2** „＋ Register beobachten" (der Katalog-Einschub
  DIESES Geräts, sein Titel NENNT es) und **3** die unveränderte `RegisterSektion` (lesen +
  schreiben). Für ein HTTP-/OCPP-Gerät (`registerFaehig === false`) gibt es nur 1+2, und alles
  heißt „Messwert" statt „Register" (`wortwahl`/`TITEL`/`HINZU`/`LEER` — D3: die Fähigkeit ist
  dieselbe, „Register" wäre dort das falsche Wort).
- **⚠ Die ruhige Liste ist KEINE erste Katalogseite** (Produktionsbefund
  28.08.2026): `hybrid_3p` trägt mehr als 600 lesbare Punkte, der Server deckelt
  eine Seite auf 250 und „PV2 Spannung“ liegt hinter Position 500. Deshalb
  fragt `loadQuiet` ausschließlich `selectedOnly=true` (plus `entityId`) und
  nie `family`/`availableOnly`; der paginierte Familien-Schnitt gehört nur in
  den geöffneten Bibliotheks-Drawer. Ein 15-s-Takt lädt Auswahl + letzte Werte
  nach — der einmalige Sofortabruf direkt nach dem Einschalten lief dem ersten
  Edge-Sample davon und ließ sonst bis zum Neuladen dauerhaft einen Strich
  stehen. Gepinnt in `MeasurementCatalogTest` und
  `BeobachteteRegister.test.tsx`.
- **⚠ DIE BRÜCKE ist der Grund, warum Teil 3 in derselben Sektion bleibt:** jede über „Jetzt
  lesen" abgerufene Zeile bekommt „Beobachten" (`brueckeAusLesung` → `BrueckeVorschlag` →
  `bruecke`-Prop → das Formular öffnet VORBEFÜLLT). Der Vorschlag entsteht **zur LESEZEIT**
  (`jetztLesen`), weil Adresse, Registerart und das Roh/Skaliert-PAAR nur dort vorliegen — aus
  einer fertigen `RegisterZeile` ließe sich die Skala nur RATEN. Eine SPULE und eine unlesbare
  Adresse bekommen deshalb keinen Knopf, sondern `BRUECKE_NICHT_MOEGLICH` (die
  `registerZugang`-Regel: ein Knopf, der nichts bewirken kann, wird nicht angeboten).
- **Vier Ehrlichkeitsregeln, jede einzeln gepinnt:** ein Wert wird GELESEN, nie gerechnet · die
  Einheit kommt aus dem Katalog, nie geraten · ein Punkt, den die Box heute nicht lesen kann,
  behauptet KEINE Beobachtung (`wartet` + `WARTET_AUF_BOX`) — **ein angekommener WERT gewinnt
  aber**, er ist der Beweis · und nur eine EINGESCHALTETE Auswahl ist eine Beobachtung (eine
  abgewählte ist Historie, keine Zeile).
- **⚠ Die Adresse steht in BEIDEN Lesehöhen gleich** — Zeile und Katalog-Einschub gehen durch
  dieselbe `adresse()`; wer im Einschub wieder den rohen `selector` rendert, lässt dieselbe
  Adresse an zwei Orten verschieden aussehen.
- **`entityId` reist in JEDEN Aufruf** (Auswahl · Katalog · Vorschau · Umschalten · eigenes
  Register · Verlauf/Export): es ist die Komponente DIESER Seite (`editRow?.id`, die schon für
  den Verlauf benutzt wurde). **Ohne sie ist alles byte-gleich die Box-Semantik** — die
  Box-Seite und ein Gerät ohne gepflegte Komponente verhalten sich zeichengleich wie vorher.
- **Die Kurzfassung der geschlossenen Sektion kommt von der FLÄCHE nach oben**
  (`kurzfassung` → `onKurzfassung` → `beobKurz`, ein stabiler `useState`-Setter, React bricht bei
  gleichem String ab): „3 beobachtet · Ladestand 87 % vor 12 s". Der Rahmen leitet sie NICHT
  selbst ab — zwei Zähler über dieselben Zeilen wären zwei Wahrheiten.
- **Die Ausblende-Regel der Stufe 0 gilt unverändert:** ohne Katalog-Familie entsteht die Fläche
  gar nicht und fragt auch nichts ab; der Fehlerfall spricht über das GERÄT.
- **⚠ Die Stufe-3c-Grenze hat ein ENDE mit Ansage.** `BEOBACHTEN_HINWEIS`/`beobachtenMoeglich`
  (`registerFamilie.ts`, Stufe 0) sagen „für dieses Gerät wird Beobachten mit einem der nächsten
  Box-Stände möglich" — die Edge-Hälfte (#538, „ein Messpunkt wird über SEINE Komponente gelesen")
  ist gebaut und reist mit dem nächsten Edge-Release. **Eine laufende Box behält ihr Image**, der
  Satz bleibt also je Box wahr, bis sie aktualisiert ist; er verschwindet dadurch nicht von selbst
  (es gibt keinen Rückkanal „ich kann das jetzt"). Wer ihn entfernt, entfernt ihn für ALLE Boxen —
  das ist eine bewusste Entscheidung nach der Flotten-Aktualisierung, kein Aufräumen.
- **⚠ Für Tests: ein gerendertes ECharts stürzt in jsdom ab** (zrender ohne Canvas, „Cannot set
  properties of null (setting 'dpr')") — die Verlaufs-Attrappe liefert deshalb `data: []` (die
  Darstellungs-Umschalter stehen VOR dem Datenzweig, sie bleiben also prüfbar); und die
  Wallbox-Fixture braucht `communication: 'goe_http_api'`, denn über die Register-Sektion
  entscheidet der WEG (`geraetGesicht`), über den Katalog die FAMILIE.
- **Beweise:** `beobachteteRegister.test.ts` (22, rein) · `components/BeobachteteRegister.test.tsx`
  (20: die Liste führt, der leere Zustand nennt den Weg, das HTTP-Wort, die Kurzfassung nach oben,
  „Nicht mehr beobachten" fragt VORHER, der Katalog-Einschub samt Verlauf-Tausch/Escape, die
  Komponente in jedem Aufruf, die Box-Semantik ohne sie, die Stufe-3c-Grenze, die Brücke) ·
  `pages/GeraetSeiteSection.test.tsx` (die drei Teile, die Wallbox ohne Lesen/Schreiben, die
  Brücke bis ins vorbefüllte Formular, `entityId` in den Auswahl-Aufrufen).

