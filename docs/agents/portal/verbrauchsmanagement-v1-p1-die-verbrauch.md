# Verbrauchsmanagement v1 · P1: die Verbraucher-ZONE, und die Jetzt-Zone zeigt jeden Ladepunkt

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 29).


Die Steuerung hat seit P1 VIER Zonen in dieser Reihenfolge: **Jetzt · Verbraucher ·
Regeln · Betriebsmodelle** (§6.1 des Programms), die Ladepark-Kapsel steht ganz
unten. Alle Regeln und jeder Satz liegen rein in `src/verbraucherZone.ts`
(`verbraucherZone.test.ts`), `components/VerbraucherZone.tsx` +
`VerbraucherZone.css` rendern NUR. Server-Seite, Projektion und die Migration
stehen in der Root-`AGENTS.md` („Verbrauchsmanagement v1 — Paket 1").

- **⚠ Die Zone RECHNET NICHTS.** Steuerart, Anlagen-Standard, Ladepark-Rahmen,
  Regelzahl und Rangliste kommen fertig aus `api.siteVerbraucher` — dem EINEN
  Lese-Aggregat. Eine zweite Ableitung im Portal wäre genau die zweite Wahrheit,
  gegen die die Projektion gebaut ist; die Fläche übersetzt das geschlossene
  Vokabular (`quelleChip`/`zielChip`) und ordnet an.
- **Aufbau (§6.2):** Abschnitt *Ladepunkte* (Ladepark-Rahmen als Kopf →
  Anlagen-Standard-Zeile → eine Zeile je Ladepunkt) · *Weitere Verbraucher* ·
  die *Rangliste* als aufklappbare Karte. Die Zeilen-Grammatik ist
  `[Zustandspunkt] Name · Quelle · Ziel · N Regeln →`.
- **⚠ Die ZEILE ist weiterhin LESEND — der Klick öffnet KEINEN Dialog.**
  Statt eines toten Klickziels steht am Abschnittsende der ruhige Satz, WO die
  Steuerart heute gestellt wird (`WEG_LADEPUNKT`/`WEG_VERBRAUCHER`). Der Dialog
  ist P2; ein Knopf, der nichts bewirkt, wäre eine Zusage, die die Fläche nicht
  hält (die `registerZugang`-Regel). Die RANGLISTE ist seit P4 bedienbar — siehe
  den eigenen Abschnitt darunter.
- **„N Regeln" springt gefiltert in die Regeln-Kapsel** (`?komponente=`) —
  derselbe Deep-Link, den die Kapsel seit Stufe 5a konsumiert.
- **⚠ Ein leeres `standardFolger` ist eine ZAHL, kein Etikett:** „Gilt für 2 von
  4 Ladepunkten" wird aus dem gezählt, was der Server geschickt hat; ohne
  gepflegten Standard (`standard: null`) entfällt die Zeile ganz, statt
  „Standard: —" zu behaupten.
- **Skalierung (§6.4):** ab `SUCHE_AB` (12) Verbrauchern eine Suchzeile, ab
  `KLAPPEN_AB` (25) klappt die Liste ein. Beides ist reine Anzeige — die
  Reihenfolge des Servers bleibt.
- **⚠ Die Zahlen gehen NICHT durch `fmtNum`, sondern durch `ladepunkte.kwText`**
  (max 1 Nachkommastelle, gewöhnliches Leerzeichen): `fmtNum` erzwingt feste
  Nachkommastellen und macht aus „32 kW" ein „32,0 kW" — die Mockups zeigen die
  kurze Form, und die Ladepunkt-Flächen daneben schreiben sie schon so.
  `kwText` ist dafür aus `ladepunkte.ts` EXPORTIERT (vorher privat), damit es
  bei einer Zahl-Formatierung bleibt statt zweier.

### Die Rangliste ist seit P4 bedienbar (`components/RanglisteKarte.tsx`)

Ziehen am Rechner, ▲ ▼ überall (das Cockpit-Anpassen-Muster) — am Telefon gibt
es kein HTML5-Drag, die zwei Tasten sind dort also die BEDIENUNG, keine Zugabe.
Alle Regeln liegen rein in `src/verbraucherZone.ts` (`rangliste.test.ts`).
Server-Seite: Root-`AGENTS.md` „Verbrauchsmanagement v1 — Paket 4".

- **⚠ Der SERVER ist die Autorität.** `api.saveRangliste` schickt die Liste FLACH
  (`ranglisteRumpf` löst eine Gruppe in ihre Mitglieder auf) und die ANTWORT —
  die Normalform — ERSETZT den Zustand. Eine Anordnung, die die Maschine nicht
  halten kann, springt damit sofort sichtbar an ihren Platz statt beim nächsten
  Laden. Es gibt bewusst KEINEN Portal-Zwilling der Normalform.
- **⚠ Gleichrangige Ladepunkte sind EINE Zeile** („Stellplatz 2 · Carport",
  Zusatz „2 Ladepunkte") und die Karte SAGT warum (`RANGLISTE_GRUPPE_HINWEIS`):
  für Säulen ohne eigenes Profil kann die Plattform heute nur „vor" oder „nach
  dem Speicher" speichern, wer zwischen ihnen zuerst darf, bleibt die
  Vorrang-Wahl der Ladepark-Kapsel (P6).
- **⚠ Beim Sortieren zählt die Fläche selbst** (`entwurfPositionen`): die
  gespeicherten Positionen meinen dann eine Reihenfolge, die es gerade nicht
  mehr gibt, und eine „5" ganz oben wäre eine Zahl, die niemand meint. Gezählt
  werden GERÄTE — eine Gruppe aus drei Säulen belegt drei Plätze, genau wie
  `default_service_rank` sie zählt.
- **⚠ Die Folgen-Karte spricht über die POSITION, nie über einzelne Geräte**
  (`ranglisteFolgen`): eine Liste kann Ladepunkte auf BEIDEN Seiten des
  Speichers haben (eine go-e über, die Säulen unter ihm), „Ihre Ladepunkte
  stehen über dem Speicher" wäre dann falsch. Der Satz des Mockups ist deshalb
  seiten-agnostisch: „Alles über dem Speicher zieht aus dem ganzen
  Solar-Überschuss, alles darunter aus dem, was der Speicher übrig lässt."
- **Ohne `onRangliste` ist die Karte reine ANZEIGE** — kein „Ändern", keine
  ▲ ▼. Dieselbe Haus-Regel, mit der seit P2 eine nicht schreibbare Zeile kein
  Knopf ist: was strukturell nichts bewirken kann, wird nicht angeboten.
- **⚠ Die D6-Pflichtfrage „Was hat bei knapper Leistung Vorrang?" ist ERSATZLOS
  entfallen** (`consumers/questions.ts`, Kind `storage-rank-note` statt
  `storage-relation`): der Vorrang IST die Position, und die Frage schrieb
  ohnehin nichts (`buildPolicyDocument` liest `draft.storageRelation` nicht).
  An ihrer Stelle steht der WEG (`RANGLISTE_NOTIZ`).

### Die Jetzt-Zone: eine Zeile je LADEPUNKT statt einer Sammel-Zeile

`steuerungJetzt.ladepunktZeilen` ersetzt die frühere `ladeparkZeile`: „Wallbox
Garage · lädt 7,4 kW · Überschuss (Sonne zuerst)" samt „Eingreifen ▸" (P3a),
ohne Auto der Grund „kein Auto eingesteckt".

- **⚠ Es entsteht KEINE zweite Zustands-Wahrheit:** Wort und Ton kommen aus
  `ladepunkte.ladevorgangRows`/`aktuelleLeistung`, der Name aus
  `ladepunktName` — dieselben Ableitungen, die die Ladevorgänge-Seite rendert.
  **Ein VERALTETER Messwert liest deshalb auch hier nie als aktuell:** die Zahl
  kommt aus `aktuelleLeistung`, nie aus dem ROHEN `row.powerKw`. Eine GETRENNTE
  Säule bekommt gar keine Zeile (`ladevorgangRows` überspringt sie) und zählt
  auch nicht als „ohne Auto" — was sie tut, wissen wir gerade nicht.
- **Die QUELLE wird ÜBERGEBEN, nie geraten:** ein laufender Boost IST der
  Urheber („Jetzt voll laden"), sonst die Steuerart aus dem Lese-Aggregat der
  Verbraucher-Zone. **Ohne Auto wird KEINE genannt**: eine Steuerart über einen
  Ladevorgang zu behaupten, den es nicht gibt, wäre eine Aussage über nichts.
- **Ab `LADEPUNKTE_ALLE_BIS` (8) VERBUNDENEN Säulen** stehen nur die mit Auto voll da, der
  Rest wird EIN Satz („9 weitere ohne Auto") — die `LadenKachel`-Regel, hier
  wiederverwendet. `JetztView.weitereLadepunkte` zählt dabei als INHALT: eine
  Zone, die nur diesen Satz trägt, ist nicht leer.
- **⚠ Die HANDLUNG kommt aus P3a und wird hier nur weitergereicht**
  (`ladepunktAktionen`/`ladepunktKeinEingriff`, `JetztZeile.ladepunkt` trägt die
  Stecker-Adresse) — ein Ladevorgang hängt an einem STECKER, nicht an einer
  Komponente, deshalb kann `entityId` ihn nicht adressieren. Es entsteht also
  auch für den Eingriff keine zweite Regel.
- **⚠ Ein Ladepunkt steht GENAU EINMAL.** Trägt dieselbe Entität zusätzlich ein
  Verbraucher-Profil, gewinnt die LADEPUNKT-Zeile und die `geraet`-Zeile
  entfällt (`jetztZone`) — zwei Zeilen wären zwei Wahrheiten über dieselbe
  Säule, einmal aus dem gemeldeten Verbraucher-Zustand, einmal aus dem
  Ladevorgang. Heute kann das strukturell nicht passieren (ein komponierter
  `ev-charger` bekommt nie ein Profil), aber die Regel ist billiger als der
  Befund.
- **⚠ Die Speicher-Zeile nennt „Speicher", nie eine UUID** (drive-by-Fix eines
  Stufe-1-Defekts): `flowApi.entities()` fällt für ein LABEL-loses Messobjekt
  auf seine Id zurück (der Flow-Editor braucht dort einen adressierbaren
  Schlüssel), und eine KOMPONIERTE Batterie trägt seit der Label-Hygiene genau
  kein Label — ungefiltert stand deshalb auf JEDER nicht umbenannten Anlage
  eine nackte UUID oben in der Zone. `speicherName` liest ein Label, das gleich
  der Id ist, seither als „kein Kundenname".

### Betriebsmodelle ohne die Ladepark-Karte

Die Karte „Ladepark-Lastmanagement" ist aus der Zone verschwunden — es ist
SCHUTZ, kein Betriebsmodell (Root-`AGENTS.md`). **Der Server filtert sie aus
dem Regal, und `betriebsmodelle.ts` filtert ein ZWEITES Mal** durch den
byte-gleichen Portal-Katalog: ein ÄLTERER Server, der sie noch schickt, bringt
sie damit nicht zurück (in `SteuerungSection.test.tsx` festgenagelt). Der
Ladepark bleibt über die Ladepark-Kapsel und den Rahmen-Kopf der
Verbraucher-Zone erreichbar — es geht nichts verloren, es zieht um.

**Beweise:** `verbraucherZone.test.ts` (24) · `rangliste.test.ts` (19) ·
`components/VerbraucherZone.test.tsx`
(10) · `components/RanglisteKarte.test.tsx` (9) ·
`steuerungJetzt.test.ts` (42, davon die Ladepunkt-Zeilen samt Einklappen
und die Dedupe) · `pages/SteuerungSection.test.tsx` (41: Zonen-Reihenfolge, das
Lese-Aggregat, die nicht zurückkehrende Ladepark-Karte, der Speicher-Name). Im
echten Chrome gegen den Demo-Stack (go-e-Wallbox + Heizstab + 3 OCPP-Säulen)
bei **1440 / 768 / 375** gemessen: 0 px horizontaler Überlauf, 0 überstehende
Elemente, keine Konsolenmeldungen.

