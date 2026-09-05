# Verbrauchsmanagement v1 — Paket 3b: „Laden pausieren" als Geschwister des Boosts

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 31).


Konzept `data/vp-verbrauchsmgmt-konzept-v1` §4.6 + §8 P3b, **Captain-Entscheid E5** („Geschwister
des Boosts: `charging-boost.action`, sitzungsgebunden, endet beim Abstecken" — die Alternative
`consumer_override` über die Bridge wurde ausdrücklich verworfen). **Ohne das Feld verhält sich
JEDE Anlage byte-identisch**, und das ist auf beiden Seiten festgenagelt.

- **⚠ ES IST EINE ZWEITE RICHTUNG, KEIN ZWEITER MECHANISMUS.** Derselbe Vertrag, dasselbe Topic,
  dasselbe `requested_at`-Fenster, dieselbe Bindung an EINE Transaktion, dieselbe Rücknahme („Automatik
  fortsetzen" ist EINE Handlung für beide) — und auf der Box derselbe Kern (`Agent.OcppBoost`, den auch
  die `:8484`-Taste ruft). Es gibt weiterhin genau EINEN Übersteuerungs-Pfad, der abzusichern wäre.
- **Vertrag: additives `action` (`voll` | `pause`)** in `docs/contracts/mqtt-charging-boost.schema.json`,
  `schema_version` bleibt 1.0; Fixture `mqtt-charging-boost.valid.laden-pausieren.json`. **⚠ ABWESEND
  heißt `voll`, und das ist die Kompatibilitäts-Zusage:** eine Cloud, die das Feld nicht sendet, erteilt
  genau den Boost von vorher, und eine Box, die es nicht kennt, überliest es und tut dasselbe. Deshalb
  SENDET der Publisher es auch nur für die zweite Richtung — hätten wir es immer geschrieben, wäre der
  Beweis dafür weg. Ein UNBEKANNTES Wort wird auf beiden Seiten ABGELEHNT, nie auf `voll` aufgelöst
  (das schaltete einen Ladevorgang ein, den jemand stoppen wollte) und auch nicht auf `pause`.
- **⚠ Die Wirkung ist RESTRICT-ONLY und trifft GENAU EINE Sitzung** (`lastmgmt.Session.PauseUntil`, das
  Geschwister von `BoostUntil`): sie deckelt diesen Ladevorgang auf 0 kW und lässt jede andere Zuteilung
  byte-gleich. Budget, Sicherheitsabstand, §14a, Rotation, Vorrang, Mindestleistung, TxDefault-Profil
  und der OCPP-eigene Totmann binden unverändert. Boost und Pause schließen einander per Konstruktion
  aus (die Box hält EINE Zuweisung je Stecker); käme je beides an, gewinnt die Pause — wer einen Stopp
  verlangt hat, bekommt einen Stopp.
- **⚠ Der Grund heißt `handeingriff`, nicht `regel`** (`lastmgmt.ReasonManual`, Text „pausiert —
  Handeingriff"). Er wird im Verteiler VOR dem K3-Deckel geprüft: beide pausieren nur, die Reihenfolge
  entscheidet also allein das WORT — und ein Stopp, den der Kunde selbst ausgelöst hat, muss nach ihm
  benannt sein, nicht nach einem Plan, den er nicht angefasst hat („eine Regel hält diese Säule"
  schickte ihn in den Regel-Editor statt zu seinem eigenen „Automatik fortsetzen").
- **Der Rückkanal ist der BESTEHENDE `reason`** (Herzschlag → `device_charge_connector.reason` →
  `GET /sites/{id}/chargers`) — es gibt KEIN neues Wire-Feld und keine Migration. Auf `:8484` steht
  zusätzlich `hand_paused` im `/api/state` (die Karte zeigt dort die Pause und bietet den Rückweg an;
  PAUSIEREN selbst bietet die Box bewusst nicht an — es kommt aus dem Portal).
- **Papier-Spur:** neue Punkt-Ereignisse `laden_pausiert` / `laden_pausiert_beendet` im Ladepunkt-Strom.
  **⚠ Das Wort folgt der GESENDETEN Richtung, auch bei der Rücknahme** — die Box kann uns nicht sagen,
  was gerade lief, und „Jetzt voll laden beendet" über einer Pause wäre eine Falschaussage im
  Kommando-Verlauf. Deshalb schickt das Portal `action` AUCH beim Abbrechen mit. `device_command_log.event_kind`
  ist freier Text (kein CHECK), es braucht also keine Migration.
- **Portal:** die geteilte Schicht `ladepunkte.ts` bekam den dritten Menü-Eintrag (`laden_pausieren`,
  Beschriftung + Hinweis wörtlich aus dem Mockup), `pausierbar`, `ladepunktBanner(name, richtung)`,
  `pauseFolgenKarte` und `boostEndeKarte(richtung)`; `LadeZustand`/`LadevorgangRow` tragen
  `handeingriff` (abgeleitet aus dem MASCHINEN-Wort, nie aus dem Satz). **⚠ `pausierbar` hängt NICHT an
  der Überschuss-Bahn** — pausieren kann man auch eine Ladung, die mit voller Leistung aus dem Netz
  läuft; nur der BOOST braucht eine Bahn, die etwas zurückhält. Angeboten wird sie ausschließlich, wo
  eine Sitzung nachweislich LÄUFT (die Portal-Hälfte der Server-Ablehnung „An diesem Stecker läuft
  gerade kein Ladevorgang"). Die Zeile liest „pausiert · Handeingriff", der Banner nennt die Richtung,
  und die Rücknahme-Karte beschreibt, was WIRKLICH läuft.
- **⚠ Was OHNE Edge-Release nicht wirkt:** die Box-Hälfte (`action` lesen, `PauseUntil`, der Grund
  `handeingriff`). Bis dahin überliest eine laufende Box das Feld und behandelt eine Pause-Anfrage wie
  einen VOLL-Boost — deshalb reisen P3b/P5/P6/P7 in DEMSELBEN Release. Cloud, Portal und Papier-Spur
  sind sofort lieferbar; die Fläche zeigt eine Pause erst, wenn die Box sie meldet.
- **Beweise:** Go `internal/chargingboost` (Vertrag + die drei Fixtures PER PFAD) ·
  `agent/charging_boost_test.go` (an den SÄULEN gemessen: pausiert und gibt zurück, der Nachbar bleibt
  unberührt, Abstecken beendet und das nächste Fahrzeug erbt nicht, ein Umschlag OHNE `action` ist
  weiterhin der Boost von vorher) · api `ChargingBoostPublisherTest` (die Draht-Form, „voll reist als
  Abwesenheit", das Audit-Wort je Richtung, die benannte Ablehnung) + `ChargerApiTest` ·
  Portal `ladepunkte.test.ts` / `steuerungJetzt.test.ts` / `JetztZone.test.tsx` ·
  **Rig `edge-app/test/e2e-ocpp.sh` L9c–e** (Docker-frei, an den simulierten Zählern gemessen).

