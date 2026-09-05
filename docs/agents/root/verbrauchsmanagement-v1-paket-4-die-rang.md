# Verbrauchsmanagement v1 — Paket 4: die RANGLISTE wird bedienbar

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 166).


Konzept `data/vp-verbrauchsmgmt-konzept-v1` §5 + §7.3, **Captain-Entscheid E3**
(frei sortierbar · Speicher oben · `service_rank` = Position). P1 hat die
Rangliste LESEND projiziert; P4 baut den Schreibweg — **ohne eine einzige neue
Tabelle**. Kein Edge-Release, keine Migration.

- **⚠ DIE RANGLISTE IST EINE PROJEKTION, IN BEIDE RICHTUNGEN.** Gespeichert
  werden genau die vier Felder, die die Maschine schon kennt (§5 „eine Wahrheit,
  kein zweites Format"): `consumer_profile.default_service_rank` (die Position —
  **der Schreibpfad fehlte bis hierher komplett**, die Spalte trug seit ihrer
  Migration den Kommentar „set only after a detected conflict"),
  `consumer_profile.storage_relation` (über dem Speicher = `consumer_first`,
  darunter = `storage_first`), `site_charging_config.storage_priority` und die
  Vorrang-Menge `site_charge_point_priority`. Gelesen wird daraus wieder über
  `RanglisteProjektion.liste`; die Inverse ist `RanglisteAbleitung` — beide rein
  und Docker-frei geprüft (das `Tagesprotokoll`/`FleetPflege`-Muster), und der
  RUNDLAUF ist ein Test.
- **⚠ RANKBAR heisst: es gibt ein `consumer_profile`** — dort und nur dort
  existieren die zwei Spalten. `Kandidat.storageRelation == null` IST der
  Marker (die Spalte ist NOT NULL). Folge, die P1 noch anders sah: eine
  **go-e/Modbus-Wallbox wird wie ein Verbraucher platziert** (sie hat ein Profil,
  ihr `storage_relation` ist der Epsilon des Co-Optimierers, und sie kennt die
  Quellen-Bahn des Ladeparks nicht — das ist P6); nur eine komponierte
  **OCPP-Säule** ohne Profil folgt der Ladepunkt-Regel.
- **⚠ GLEICHRANGIGE LADEPUNKTE SIND EINE ZEILE** (Mockup 1440, Anmerkung 22) —
  eine Ehrlichkeits-Aussage, keine Platzersparnis: für Säulen ohne Profil kann
  die Cloud heute nur „Vorrang" und „Rest" ausdrücken (der Ganzzahl-Rang je
  Säule ist P6), und die Box wechselt zwischen Gleichrangigen ohnehin ab
  (`lastmgmt.go` Rotation). Sie einzeln ziehbar zu zeigen verspräche eine
  Reihenfolge, die kein Speicher hält. `RanglisteEintrag` trägt dafür
  `mitglieder`; `entityId`/`name` sind bei einer Gruppe `null`.
- **⚠ Die Positionen zählen GERÄTE, nicht Zeilen** — eine Gruppe aus drei Säulen
  auf Platz 6 belegt 6, 7 und 8, die nächste Zeile steht auf 9. Nur so ist die
  Position einer Zeile dieselbe Zahl, die `default_service_rank` trägt. Beim
  SORTIEREN zählt die Fläche selbst (`entwurfPositionen`), weil die gespeicherten
  Zahlen dann eine Reihenfolge meinen, die es gerade nicht mehr gibt.
- **Die NORMALFORM ist bindend, und die ANTWORT zeigt sie sofort**
  (`PUT` liefert die Zone, wie sie danach GELESEN wird):
  `[rankbare oben, nach Rang] [Säulen-Gruppe oben?] SPEICHER
  [Säulen-Gruppe unten?] [rankbare unten, nach Rang]`. Eine Anordnung, die die
  Maschine nicht halten kann, springt damit im selben Atemzug sichtbar an ihren
  Platz statt beim nächsten Laden.
- **⚠ Steht KEINE Säule über dem Speicher, bleibt die VORRANG-MENGE
  unangetastet.** Die Projektion liest sie dann gar nicht (alle Säulen stehen
  unten), die Liste sagt also nichts über sie — und ein Löschen nähme dem Kunden
  nur seine Vorrang-Wahl aus der Ladepark-Kapsel. Steht eine oben, ist die Menge
  genau die oben stehenden und `storage_priority` wird `auto_vor_speicher`.
- **⚠ `default_service_rank`/`storage_relation` werden geschrieben, OHNE die
  `version` hochzuzählen** (`ConsumerRepository.setServiceRank`): sie ist das
  Optimistic-Concurrency-Token des VERBRAUCHER-Editors, und eine Rangliste, die
  sie bewegt, liesse einen gleichzeitig offenen Dialog in einen 409 laufen.
- **PFLICHTEN GEHEN IMMER VOR DER RANGLISTE — als Eigenschaft dessen, was NICHT
  geschrieben wird.** Die Ableitung fasst ausschliesslich die vier Felder an;
  der Optimierer deckt in D2-Stufe 1 zuerst jede Pflicht und benutzt den Rang
  nur, um die Pflichten UNTEREINANDER zu ordnen (`co_solver._requirement_order`).
  Ein Struktur-Wächter pinnt die Feldliste von `Ableitung`.
- **Route `PUT /api/v1/sites/{siteId}/rangliste`** (`SiteVerbraucherController`,
  RLS-gefenced wie jede `/sites/**`-Route — kein `@PreAuthorize`, fremde Anlage
  **404**; in `openapi.yaml`). Rumpf FLACH, ein Gerät je Eintrag; eine Gruppe
  schickt der Client als ihre Mitglieder hintereinander. **Erst prüfen, dann
  schreiben** — jede Ablehnung ist ein deutscher Satz und schreibt NICHTS
  (leere Liste · fremdes Gerät · Doppel · unbekannte Art · fehlender
  Speicher-Platz). **Nicht genannte Geräte landen UNTEN** statt in einer
  Ablehnung: zwischen Lesen und Speichern kann eine Säule dazugekommen sein,
  und ein Rennen darf keine Bedienung kosten (E3 „neue Verbraucher unten").
- **⚠ Die D6-PFLICHTFRAGE „Was hat bei knapper Leistung Vorrang?" ist im Portal
  ERSATZLOS entfallen** (`consumers/questions.ts`): der Vorrang IST die
  Position, und zwei Editoren für dieselbe Tatsache wären zwei Wahrheiten. Sie
  schrieb ohnehin nichts (`buildPolicyDocument` liest `draft.storageRelation`
  nicht). An ihrer Stelle steht der WEG (`RANGLISTE_NOTIZ`).
- **Beweise:** rein `RanglisteAbleitungTest` (17: die drei Ableitungen, die
  go-e-Regel, „nicht genannt landet unten", der RUNDLAUF, Idempotenz auf der
  Normalform, sechs Ablehnungen, der Struktur-Wächter) + `RanglisteProjektionTest`
  (10) · Testcontainers
  `VerbraucherApiTest.dieReihenfolgeWirdGespeichertUndKommtGenauSoZurueck`
  (echte DB + Keycloak: gezogen → gespeichert → die Spalten, die Optimierer und
  Box wirklich lesen; zweites Speichern ändert nichts; der Weg zurück lässt die
  Vorrang-Menge stehen; jede Ablehnung ohne Schreibvorgang; RLS 404 + anonym
  401) · Portal `rangliste.test.ts` (19) + `RanglisteKarte.test.tsx` (9). Beide
  tragenden Regeln mutationsgeprüft (immer-Vorrang-schreiben und
  Profil-Marker-ignorieren fallen einzeln um). Im echten Chrome bei 375 und 1440
  durchgespielt: Reihenfolge geändert, gespeichert, die Zeile bestätigt es
  („Stellplatz 2 · Carport zuerst · 6 Einträge"); 0 px horizontaler Überlauf,
  0 überstehende Elemente, keine Konsolenmeldungen.
- **NICHT in diesem Paket:** der Ganzzahl-Rang je Säule auf der Box
  (`Session.Rank`, `charge_points[].rank`) und der Speicher-Split — das ist P6
  und braucht ein Edge-Release. Bis dahin ordnet die Rangliste die Säulen nur
  relativ zum Speicher; **wer zwischen ihnen zuerst darf, bleibt die
  Vorrang-Wahl** (die Fläche sagt genau das). ⚠ Sie wohnt seit P5 in der
  Rangliste selbst — die Ladepark-Kapsel, die sie vorher trug, ist entfallen.

