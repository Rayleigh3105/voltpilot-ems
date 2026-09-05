# ⚠ Ein ANGENOMMENER Register-Auftrag endet IMMER mit genau EINEM Ergebnis

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 59).


Derselbe Vorfall, zweiter Befund: fuer einen angenommenen Auftrag
(491de871…, 20:08:55Z) stand im Protokoll eine „Auftrag angenommen"-Zeile und
danach NICHTS. Aus der Cloud ist das ununterscheidbar von „die Box hat den
Auftrag nie bekommen". `agent.runRegisterWrite` ist seither eine HUELLE
(`answer`-Closure + `defer` mit `recover`), die drei Faelle abdeckt, die ein
neuer Zweig sonst still wieder aufreissen koennte: ein `return` ohne Antwort,
ein doppeltes Antworten (der Kontrakt kennt GENAU EIN Ergebnis je `request_id`)
und ein PANIC. Die Ausfuehrung selbst wohnt in `executeRegisterWrite`, die
Test-Naht ist die Paket-Variable `registerExecute` (das
`installerWriteTimeout`/`registerWriteWindow`-Muster).

**⚠ Der PANIC wird bewusst aufgefangen** - eine Abwaegung, keine Bequemlichkeit:
ohne `recover` risse ein Panic in dieser Goroutine den GANZEN Edge-Kern einer
Kundenanlage mit sich (Telemetrie, Fahrplan-Ausfuehrung, Schutzgrenzen), wegen
eines Register-Vorschau-Klicks. Er wird deshalb LAUT protokolliert (ERROR mit
dem Panic-Wert) und ehrlich quittiert (`MsgCrashed`), statt verschluckt zu
werden. Beweis: `agent.TestAnAcceptedOrderAlwaysEndsWithExactlyOneReceipt`
(mutationsgeprueft).

