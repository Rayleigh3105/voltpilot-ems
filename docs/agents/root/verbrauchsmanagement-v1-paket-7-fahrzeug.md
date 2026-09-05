# Verbrauchsmanagement v1 — Paket 7: FAHRZEUG-PROFILE (je Ladekarte eine Steuerart)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 168).


Konzept `data/vp-verbrauchsmgmt-konzept-v1` §4.5 / §8 P7, **Captain-Entscheid E4:
Pseudonym-Profile über `tag_ref`, KEIN Klartext-IdTag in der Cloud**. Am selben Ladepunkt
lädt der Dienstwagen sofort, während der Privatwagen auf die Sonne wartet. **Alles ist
ADDITIV: eine Anlage ohne ein einziges Profil verhält sich zeichengleich wie vorher**, und
das ist beidseitig festgenagelt (Go: ein Dokument ohne `vehicle_profiles` ändert nichts;
Portal: ohne Auflöser/Karte trägt keine Zeile ein Fahrzeug).

- **⚠ DER SCHLÜSSEL IST DER PSEUDONYM DER BOX — UND ER IST NICHT DER DES OCPP-JOURNALS.**
  `csms.Session.TagRef` entsteht EINMAL bei `StartTransaction` (`tagref_` + HMAC-SHA256 mit
  dem geräteeigenen 32-Byte-Schlüssel `ocpp-privacy.key`, 24 Hexzeichen) und reist im
  Herzschlag. Die Cloud pfeffert dagegen JEDEN aus dem OCPP-JOURNAL eingehenden Bezug ein
  ZWEITES Mal (`OcppPrivacy`, `ocpp_transaction.start_id_tag_ref`) — **wer dort einen Wert
  entnimmt und als Profil-Schlüssel einsetzt, baut ein Profil, das kein Fahrzeug je trifft.**
  Die zwei Pseudonym-Räume werden bewusst NICHT verbunden: die BOX muss ihr Profil selbst
  zuordnen können (der Ladevorgang startet dort, eine Cloud-Runde wäre eine WAN-Abhängigkeit
  auf einer physischen Ladeentscheidung — genau das, was E1 verbietet), und sie kann den
  Pfeffer nicht kennen. Bewusst in Kauf genommen und in der Migration benannt: dieser Tabelle
  steht damit der ungepfefferte Bezug gegenüber — nicht umkehrbar, und der Klartext-IdTag
  kommt in KEINER Cloud-Tabelle vor.
- **Verteilweg: das BESTEHENDE retained `charging-config`-Dokument** (`vehicle_profiles[]`
  additiv, `schema_version` bleibt 1.0; Fixtures `…valid.fahrzeug-profile.json`,
  `…valid.fahrzeug-profile-zurueckgenommen.json` + die ungültige
  `…invalid.fahrzeug-profil-journal-bezug.json`, vom Go-Parser PER PFAD gelesen) — kein
  zweites Topic, keine Broker-Änderung. **⚠ Anders als `charge_points` ist die MENGE die
  AUSSAGE:** das Portal besitzt die Profile allein (es gibt dafür keine `:8484`-Oberfläche),
  eine gesendete Liste ERSETZT also vollständig und eine LEERE nimmt alle zurück — es braucht
  keine Grabstein-Liste. ABWESEND heißt wie überall „das Portal äußert sich nicht".
- **⚠ EIN PROFIL TRÄGT EINE QUELLE UND NIE EIN ZIEL.** Ein Ziel („bis 06:00 fertig") wird
  Stunden im Voraus für einen LADEPUNKT geplant, und welches Auto dann dort steckt, weiß zum
  Planungszeitpunkt niemand. Der Dialog bietet deshalb genau die zwei Quellen an, die die
  Quellen-Bahn einer SITZUNG ausdrücken kann; „Günstige Stunden" wird BEIM NAMEN abgelehnt
  (400 mit Grund), statt eine Wahl anzubieten, die der Server danach ablehnen müsste.
- **⚠ Die Box braucht dafür KEINE neue Regel im Verteiler.** `lastmgmt.Session.Source`/`MinKw`
  waren schon je SITZUNG, und jede Regel dahinter fragt die SITZUNG, nicht die Station
  (`sessionPolicy`, `splitExempt`, `allowsMinimum`, `effectiveMin`). `ocppApplyVehicleProfiles`
  (rein, `agent/ocpp_vehicle.go`) tauscht nur die Vorgabe, die `ocppSessions` von der Station
  kopiert hat — Budget, Rotation, Mindestleistungs-Zugeständnis, Totmann und die K3-Brücke
  binden eine Zeile weiter unten unverändert. **Vorrang: Handeingriff › Profil › Säule**, und
  das ist die BAUFORM (Boost und Halter greifen nach dem Profil), keine Zusage.
- **⚠ Eine Sitzung OHNE Karte behält die Bahn der Säule.** Es gibt kein Vorgabe-Profil und
  kein „Standard-Fahrzeug": eine unbekannte Karte ist ein Kunde, der nicht entschieden hat,
  und für ihn zu entscheiden ist genau das, was dieses Feature nicht tun darf. `min_kw` = 0
  heißt „das Profil äußert sich nicht" und nimmt einer Säule ihre gepflegte Mindestleistung
  NIE weg.
- **Speicher `site_vehicle_tag`** (Migration `V20260866000000`, mandantengebunden mit RLS +
  FORCE — das sind Kundendaten): EINE Zeile ist eine SICHTUNG und, sobald der Kunde sie
  benannt hat, ihr Profil. Beides in einer Tabelle, weil es dieselbe Sache ist. **KEIN
  DELETE-Recht:** „Profil entfernen" nullt Name und Steuerart und LÄSST die Sichtung stehen
  (die Grabstein-Regel des Hauses) — die Karte erscheint danach wieder als unbenannte
  Sichtung, statt beim nächsten Herzschlag als „neu" aufzutauchen.
- **⚠ Eine Karte, die diese Anlage nie gesehen hat, lässt sich nicht benennen** (404): ein
  Profil darauf träfe nie ein Auto. Und was gar kein Pseudonym DIESER Box sein kann
  (`FahrzeugSteuerart.TAG_REF`), ist ein 400 mit Grund — ein Klartext-IdTag darf hier nicht
  einmal ankommen.
- **Routen** (`SiteFahrzeugController`, mandantenbezogen wie jede `/sites/**`-Route — kein
  `@PreAuthorize`, RLS ist der Zaun, fremde Anlage **404**; in `openapi.yaml`):
  `GET /api/v1/sites/{siteId}/fahrzeuge`, `PUT|DELETE …/fahrzeuge/{tagRef}`. Der `PUT` ist
  PATCH je Feld: ein Feld, das der Wunsch nicht nennt, wird nicht angefasst.
- **⚠ Die QUELLE hat DREI Zustände, und der dritte ist der WEG ZURÜCK**
  (`FahrzeugSteuerart.setztBahn`): der Schlüssel FEHLT = „nichts ändern", ein Wort SETZT,
  die **LEERE Zeichenkette NIMMT DAS PROFIL ZURÜCK** (die Karte lädt wieder wie ihr
  Ladepunkt) — die Haus-Regel jeder PATCH-Route, hier auf die Steuerart angewandt. Ohne den
  dritten Zustand müsste der Kunde das ganze Profil entfernen und verlöre dabei den NAMEN,
  den er vergeben hat; der Dialog bietet „Lädt wie der Ladepunkt" ausdrücklich als Wahl an
  und verspricht in seiner Folgen-Karte genau das (**im Review gefunden, nicht im Test** —
  der Wunsch ließ die Quelle weg und das Versprechen war gebrochen).
- **Der Rückkanal** ist additiv am BESTEHENDEN `chargers`-Block: je Stecker `tag_ref`. Der
  Ingest verwirft, was nicht `^tagref_[0-9a-f]{8,64}$` ist (ein Klartext-Tag wird also nie
  gespeichert), und berührt für JEDE gemeldete Karte ihre Sichtung.
- **Portal:** die reine `src/fahrzeugProfile.ts` ist die EINE Textschicht; `FahrzeugeKarte`
  (in der Verbraucher-Zone) und `FahrzeugDialog` rendern. Benannt wird an ZWEI Orten mit
  EINEM Dialog — in der Fahrzeuge-Karte und aus dem Ladevorgangs-Verlauf heraus
  (`verlaufFahrzeug`, Konzept §4.5 „dieser Ladevorgang war … → Name vergeben"); zwei Dialoge
  über dieselbe Sache wären zwei Wahrheiten. Die Jetzt-Zeile nennt das Fahrzeug VOR der
  Quelle („Lädt 11 kW · Dienstwagen · Sofort laden") — und **nur ein BENANNTES**: „Karte
  1f2e…" beantwortete dort keine Frage.
- **Beweise:** rein Go `agent/ocpp_vehicle_test.go` (8) + `internal/chargingcfg` (die drei
  Fixturen PER PFAD) + `agent/ocpp_heartbeat_test.go`
  (`TestTheHeartbeatCarriesThePseudonymAndNeverThePlaintextCard` — auf den SERIALISIERTEN
  Bytes, nicht auf einem Feld) + `internal/csms` (der Pseudonym entsteht genau einmal) ·
  Java rein `FahrzeugSteuerartTest` + `ChargingConfigPublisherTest` (Draht-Form, leere Liste
  nimmt zurück, die Fixture bytegenau) + `ChargerStatusListenerTest` (Ingest, verworfener
  Klartext, Sichtung) · Testcontainers
  `ChargerApiTest.twoCardsAtOneStationCarryTheirOwnSteuerartAndAnUnseenCardCannotBeNamed` ·
  Portal `fahrzeugProfile.test.ts` (26) + `LadevorgaengeSection.test.tsx` (+5) +
  `steuerungJetzt.test.ts` (+3) · **Rig `edge-app/test/e2e-ocpp.sh` L16a–d** (Docker-frei:
  zwei Karten, zwei Steuerarten am selben Ladepark — und die Wagen TAUSCHEN die Plätze,
  die Ladung wandert mit der KARTE; die leere Liste nimmt beide Profile zurück).
- **Ops:** keine neue Pflicht-Variable, kein Flag. **Die EDGE-Hälfte reist mit dem nächsten
  Edge-Release** — eine laufende Box überliest `vehicle_profiles` und fährt weiter die Bahn
  der Säule; Cloud und Portal sind sofort lieferbar und sagen das ehrlich.

