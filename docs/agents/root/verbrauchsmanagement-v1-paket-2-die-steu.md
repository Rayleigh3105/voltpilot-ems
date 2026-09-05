# Verbrauchsmanagement v1 — Paket 2: die Steuerart SCHREIBEN

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 165).


Der Schreibweg zu P1s Lese-Aggregat (Konzept `data/vp-verbrauchsmgmt-konzept-v1`
§3 komplett, §6.2, §7.1/§7.4; Captain-Entscheide **E1** Typ-Sätze · **E2**
Ableitung · **E7** Preisgrenze in ct · **E8** kWh-Ziel 20 kWh). **Kein
Edge-Release, keine Migration, kein neues Datenformat.**

- **⚠ DIE STEUERART IST EINE OBERFLÄCHE AUF DER POLICY-MASCHINE, nie eine
  zweite Maschine.** `PUT /api/v1/sites/{id}/verbraucher/{entity}/steuerart`
  (`SiteVerbraucherController` → `SteuerartService`) stellt ein
  `consumer_profile` sicher, legt die Requirement-Projektion (§3.3) als NEUE
  `consumer_policy`-Fassung ab und aktiviert sie über den BESTEHENDEN Pfad
  (`ConsumerPolicyActivationService`) — mit dessen flowc-Kompilierung, seiner
  V-5-Anspruchsprüfung, seinen zwei Flag-Toren und seiner Audit-Spur. Ein
  Dokument, das hier entsteht, ist von einem aus dem Regel-Baukasten nicht zu
  unterscheiden.
- **⚠ DER RUNDLAUF IST DIE ABNAHME.** `SteuerartDokument` ist die exakte INVERSE
  von `SteuerartProjektion` (§7.1), und `SteuerartWunsch` die SPIEGELFORM von
  `Steuerart` ohne `herkunft`. `SteuerartRundlaufTest` fährt je Steuerart × Typ
  schreiben → **echten `ConsumerPolicyValidator`** → projizieren und verlangt
  denselben Satz zurück; wer eine der drei Hälften anfasst, fährt ihn.
- **⚠ „Sofort" hat GAR KEIN Dokument.** Das Schema verlangt `minItems: 1`
  („Empty is not a policy"), §3.3 sagt für diese Quelle „keine Anforderung" —
  also NIMMT der Schreibpfad die aktive Fassung ZURÜCK (der flag-unabhängige
  `deactivate`, der auch das retained Artefakt zurückzieht: „Flag aus ≠
  gestoppt"). Die Projektion liest das danach als `sofort` (Regel 2), der
  Rundlauf schliesst sich. Ohne aktive Fassung ist es ein NO-OP mit ehrlichem
  Satz, nie ein 409.
- **⚠ `sofort` steht in JEDEM Typ-Satz — eine argumentierte Abweichung von der
  Tabelle §3.1** (dort trägt ihn nur der Ladepunkt). Es ist der
  ANFANGSZUSTAND jeder Komponente („VoltPilot steuert dieses Gerät nicht", genau
  das, was Projektions-Regel 2 zurückgibt); ohne ihn im Satz gäbe es keinen Weg
  ZURÜCK, und die Fläche wäre ein Editor, der nur in eine Richtung schreibt. Er
  steht am Ladepunkt VORNE (die abgenommene Mockup-Reihenfolge) und sonst
  HINTEN — dort ist er die Rücknahme, nicht der Vorschlag. **Das WORT hängt am
  Typ und wohnt im Portal** („Sofort laden" am Ladepunkt, „Ohne Steuerung durch
  VoltPilot" sonst).
- **⚠ `SteuerartSatz` ist zugleich die ANZEIGE und der ZAUN.** Dieselbe reine
  Klasse liefert die Karten der Zeile (`VerbraucherDto.Eintrag.optionen`, mit
  Sperrgrund und Startwerten) UND prüft den `PUT` ein zweites Mal — dem Client
  zu glauben wäre keine Prüfung, und zwei Ableitungen könnten auseinanderlaufen.
  Eine gesperrte Wahl ist SICHTBAR und trägt IMMER ihren Grund.
- **⚠ „Ohne Tarif" ist NICHT „fester Tarif".** §3.1 sperrt „Günstige Stunden"
  bei `tarif_art != dynamisch`; der GRUND ist aber verschieden — `fest` heisst
  „Ihr Stromtarif hat keine stündlichen Preise", `ohne` heisst „noch nicht
  hinterlegt" und nennt den Weg (Vergütung & Tarif). Eine Aussage über einen
  Vertrag, den uns niemand genannt hat, wäre erfunden.
- **⚠ Der OCPP-Ladepunkt (`ev-charger`) ist hier NICHT schreibbar** — seine
  Quelle fährt die Quellen-Bahn der Box, die Arbiter-Brücke dorthin ist Paket
  P5. Er sagt das auf der Route (422) UND in seinen `optionen`
  (`schreibbar: false` + Grund), statt eine Auswahl anzubieten, die der Server
  danach ablehnt.
- **⚠ Der Beginn des ZIEL-Fensters kommt vom Server, und er wird GESAGT.** §3.2
  fragt nur nach der Frist; der Server setzt `von = bis − 12 h`
  (`SteuerartSatz.ZIEL_FENSTER_STUNDEN`, kann per Konstruktion nie ein Fenster
  der Länge 0 ergeben, das der Validator ablehnt), und der Dialog zeigt das
  entstehende Fenster wörtlich. Der Wunsch darf `von` überschreiben.
- **Die Preisgrenze-Vorgabe ist E7** (`SteuerartPreisVorgabe`): das 25.
  Perzentil des BEZUGSPREISES der letzten 7 Tage, gerechnet mit der EINEN
  Kompositions-Wahrheit `SlotEconomics.importPriceCtSql` (der nackte Spot läge
  systematisch zu tief und ergäbe eine Regel, die nie greift). Auflösungen
  werden NICHT gemischt; ohne belastbare Preise gibt es KEINE Vorgabe und das
  Feld startet leer.
- **⚠ Bewusst KEIN `@Transactional` um den ganzen Schreibvorgang** (die
  `RolloutService`-Disziplin): Entwurf speichern, DANN aktivieren — genau die
  Reihenfolge der bestehenden Fläche. Eine umschliessende Transaktion rollte
  eine abgelehnte Aktivierung samt ENTWURF zurück; er soll stehen bleiben, und
  die Antwort sagt das (`aktiv:false` + Grund + Satz).
- **⚠ `UsageProfileService.measuredRoles(row)` ist dafür ÖFFENTLICH geworden** —
  die MIG-§4-Regel („hasPv ist capability-basiert, nie kategorie-basiert") war
  schon einmal an einer zweiten Stelle falsch abgeschrieben und liess jede
  Hybrid-Anlage `hasPv:false` melden. Der Aufrufer bringt die Zeilen mit; es
  entsteht keine zweite Abfrage und keine zweite Ableitung.
- **`ConsumerService` bekam zwei Einstiege**: `ensureProfile` (das Profil einer
  Komponente, die noch keines hat — `create` mintet IMMER eine neue Entität und
  war der einzige Aufrufer von `insertProfile`) und `updateZyklus`
  (Mindestlaufzeit/Sperrzeit, die zwei Folgefragen, die im PROFIL wohnen und
  über den Registry-Push zum Zyklen-Wächter der Box reisen).
- **Beweise:** rein `SteuerartSatzTest` (12) + `SteuerartRundlaufTest` (14, mit
  dem echten Validator) · Testcontainers `SteuerartApiTest` (5: die Reise
  setzen → umstellen → zurücknehmen mit append-only Fassungen, jede gesperrte
  Wahl abgelehnt OHNE Schreibvorgang, die OCPP-Säule auf beiden Wegen ehrlich,
  die Optionen samt Vorgaben, der Mandanten-Zaun). Portal-Seite in
  `frontend/portal/AGENTS.md`.
- **NICHT in diesem Paket:** die Steuerart einer OCPP-Säule (P5), der
  Anlagen-Standard als Schreibweg (P5) und die Box-Quellenbahn
  (`charging-config.charge_points[].source/min_kw`, P5) — die Rangliste ORDNEN
  ist seit P4 gebaut und steht im Abschnitt darunter. Der
  Dialog bietet deshalb für einen Ladepunkt die Folgefrage „Mindestleistung
  halten oder pausieren?" (§3.2) NICHT an: sie beschreibt genau diese Bahn, und
  die Policy-Sprache kann ein „entweder/oder" nicht ausdrücken, ohne
  mehrdeutig zu werden (Projektions-Regel 9).

