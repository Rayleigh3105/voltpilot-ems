# Die SPEISER-BINDUNG (P6): die eigene Batterie speist den Speicher-Knoten

Der Schluss-Stein des Zwei-Ebenen-Anschlusses (Konzept `vp-deye-diybms-luecke-l5`
§3.2b, Paket P6, Captain-Entscheid **E6 (a)** vom 09.09.2026). P5 hat die
Batterie ANGEBUNDEN, P5b ihren Ladestand GERECHNET, P5d die Fläche gebaut — und
bis hierher landete beides nirgends: die Speicher-Kachel der Anlage zeigte
weiter das Schweigen des Wechselrichters, der im Spannungsmodus gar keinen
Ladestand misst.

## Die Frage, die nur der Kunde beantworten kann

**Der Kanalname `soc_pct` sagt nicht, WESSEN Ladestand er ist.** Ein DIYBMS an
einem Hybrid-Wechselrichter, ein zweiter Speicher im Keller und ein Prüfaufbau
auf dem Tisch schicken denselben Kanal. Deshalb ist die Bindung eine
AUSDRÜCKLICHE Frage im Assistenten und niemals eine Heuristik — E6 (a) wörtlich:
„ausdrückliche Bindung im Assistenten … Bilanz-Ehrlichkeit bleibt, Kundenwille
wird explizit; Leistung bleibt beim Wechselrichter".

Drei Antworten, gespeichert als `binding` in der `connection_json` der Batterie
(`{mode, inverter_entity_id?}`):

| `mode` | Bedeutung | Was in den Speicher-Knoten fliesst |
|---|---|---|
| `unbound` (**Vorgabe**) | sie steht für sich | nichts — ein Topologie-Knoten mit eigenen Messwerten, ausserhalb der Energiebilanz (die Stufe-3-Zusage) |
| `feeds_inverter` | sie hängt an Hybrid-Wechselrichter X (`inverter_entity_id`, PFLICHT) | `soc_pct` + `charge_limit_a`/`discharge_limit_a`/`charge_allowed`/`discharge_allowed`. **Nie `power_kw`** — der Wechselrichter MISST die Batterieleistung, und dieselben Kilowatt zweimal zu zählen wäre schlicht falsch |
| `standalone` | es gibt keinen Hybriden; sie IST der Speicher-Knoten | dasselbe PLUS `power_kw` |

Eingespeist werden nur Kanäle, die die Batterie WIRKLICH liefert (ein aus P5b
gerechneter `soc_pct` zählt mit — er ist der Grund für dieses Paket). Eine
Bindung, die nichts einspeisen könnte, wird ABGELEHNT statt eine Wirkung zu
versprechen, die ausbleibt.

## Die Bindung IST eine Rollen-Zuordnung

`UserDefinedBatteryService.applyBinding` schreibt je eingespeistem Kanal EINE
Zeile in `entity_role_assignment` (Rolle `storage`, `is_primary = true`) und
LÖSCHT die Zeilen jedes nicht mehr eingespeisten Kanals. Es entsteht kein
zweiter Mechanismus: das Lesemodell löst die Überschreibung vor der Vorgabe auf,
und der Registry-Push trägt sie als `descriptor.role_assignment` zur Box (Befund
L4), damit `:8484` denselben Energiefluss zeichnet wie das Portal.

`is_primary` ist die halbe Aussage: der Kunde sagt, DIESE Batterie liefert den
Ladestand des Speichers — ein Hybrid-Wechselrichter, der im Spannungsmodus
seinen eigenen (erfundenen) meldet, darf ihn nicht überstimmen. Schweigt die
gebundene Batterie, fällt die Ableitung weiter auf einen anderen SoC zurück —
aber `soc_source` NENNT dann jenes Gerät, die Fläche sagt also, wessen Zahl sie
zeigt, statt still zu ersetzen.

**Ohne Bindung passiert NICHTS von selbst:** `user-defined-battery` steht seit
P6 in `TopologyDeriver.isSelfBuiltType` (und den Go-/TS-Zwillingen), bekommt
also keine Vorgabe-Rolle — obwohl der Typ Kategorie `storage` ist und `soc_pct`
und `power_kw` sonst von allein in den Speicher-Knoten liefen.

## Was der Speicher-Knoten dazugewinnt (Vertrag additiv)

`docs/contracts/v2/topology-read-model.md` + `topology-vectors.json`, alle drei
Zwillinge zusammen geändert:

- `soc_source: {entity_id, label}` — WELCHE Entität `soc_pct` geliefert hat.
  Immer da, wenn `soc_pct` da ist. Sie trägt die Anzeige „Ladestand von:
  &lt;Batterie&gt;" und repariert nebenbei die P5d-Herkunft: die wurde bisher
  unter den FLUSS-Mitgliedern gesucht, und eine gebundene Batterie ist keines.
- `limits: {source, charge_limit_a?, discharge_limit_a?, charge_allowed?,
  discharge_allowed?}` — was das BMS zulässt, aus GENAU EINER Entität (eine
  Ladegrenze des einen BMS neben der Entladegrenze eines anderen wäre ein Block
  mit zwei Bedeutungen). Ein abwesendes Feld fehlt, statt als „erlaubt" gelesen
  zu werden.
- Die vier Grenz-Kanäle sind — wie `soc_pct` — Speicher-EIGENSCHAFTEN, nie
  Fluss-Mitglieder: ein Ampere und ein Ja/Nein sind keine Kilowatt.
- Eine Freigabe reist als ZAHL durch die Telemetrie: alles ausser 0 heisst „ja".

## Wo es sichtbar wird

- **Speicher-Kachel** (`adaptiveLive.storageTile` → `livePuls` → `LivePuls.tsx`):
  „Ladestand von: &lt;Batterie&gt;" — aber NUR, wenn der Ladestand von einem
  anderen Gerät kommt als die Kilowatt der Kachel; sonst wäre es eine
  Wiederholung des Kachel-Namens. Daneben die BMS-Hülle („max. 22 A laden ·
  Entladen gesperrt").
- **Geräteseite** (`geraetGesicht.speicherKacheln`, gespeist aus
  `GesichtInput.speicherKnoten`): der gebundene Ladestand gewinnt über das
  Schweigen des Wechselrichters und sagt, von wem er kommt; „Laden (BMS)" /
  „Entladen (BMS)" stehen daneben.

## Prüfungen, die nur der Server machen kann

`UserDefinedBatteryService.requireBindingTarget`: der gebundene Wechselrichter
muss zu DIESER Anlage gehören (**404**, nie 403 — RLS verbirgt eine fremde
Anlage), Kategorie `storage` haben (**422**) und darf nicht die Batterie selbst
sein (**422** — das ist der eigenständige Fall, und die beiden
auseinanderzuhalten ist der Punkt der ausdrücklichen Bindung).

## Tests

`UserDefinedBatteryDefinitionTest` (die Regeln), `UserDefinedBatteryBindingTest`
(welche Rollen-Zeilen entstehen und wieder verschwinden, Mockito, ohne Docker),
`TopologyDeriverTest` + die geteilten Vektoren (Go/TS/Java),
`batterieAnschluss.test.ts`, `BatterieAssistent.test.tsx`,
`adaptiveLive.test.ts`, `geraetGesicht.test.ts`.
