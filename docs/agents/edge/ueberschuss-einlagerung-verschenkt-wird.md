# Überschuss-Einlagerung: verschenkt wird nichts, was die Anlage erzeugt

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 80).


Der SPIEGEL der Defizit-Deckung eine Sektion darüber, und der Ladeboden unter
den Wolken-Pflichten. Cloud-Seite und Begründung: root `AGENTS.md`
„Überschuss-Einlagerung im Fahrplan-Modus". Was HIER gelten muss:

- **`core/internal/guards/surplusstore.go` ist eine reine Entscheidung je Tick**
  (zustandslos - die einzige Hysterese, auf die es ankommt, ist das
  Engage/Release-Dwell des `SurplusCharger` auf dem Überschuss). Sie läuft am
  GLEICHEN Ort wie die drei anderen In-Slot-Pflichten: nach jeder
  Compliance-Klemme, nach der Holder-Übersteuerung, nach dem Follower und VOR
  dem Peak-Guard.
- **⚠ ZWEI EINTRITTE, und ihr Unterschied IST das Sicherheits-Argument.**
  **(B1) Der Plan LÄDT BEREITS** - die Speicher-gegen-Verkauf-Entscheidung hat
  die Wolke getroffen, korrigiert wird nur die MENGE; **kein Diskriminator
  nötig**, es gibt keinen Verkauf, den sie umdrehen könnte. **(B2) Der Plan
  RUHT** - das könnte auch „bewusst zum Spitzenpreis einspeisen" heissen, also
  gilt der EINE richtige Diskriminator der Wolke: `cover_load_from_battery`
  (Netz ≈ 0, nie ein Verkaufsslot), plus die Tore jeder lokal GESTARTETEN
  Richtung (`portableReady`).
- **⚠ Die SoC-Bandgrenze der engen Ladeseite ist ENTFALLEN** (`HighSocCharge`
  samt `high_soc_charge`): sie griff nur zwischen `soc_max − 5` und `soc_max`
  und verweigerte deshalb den Live-Fall 10:14 (Speicher **19 %**, PV 39,354,
  Haus 16,383, 22,8 kW ins Netz, Plan-Slot −7,17 kW vom Follower auf 0,0
  begrenzt). Der ENTLADE-Zwilling hatte diese Grenze am 28.08. bereits fallen
  lassen - die Ladeseite hat den Schritt jetzt nachgeholt. `highsoc.go` ist
  ersatzlos in `surplusstore.go` aufgegangen; das Wort bleibt in api/Portal
  lesbar, kein aktueller Build erzeugt es.
- **⚠ Ehrlicher Rest-Einwand (B2):** ein UNERWARTETER Überschuss in einem
  Abend-Deckungsslot wird eingelagert statt verkauft. Auszuschliessen wäre das
  nur mit dem Exportwert je Slot im Fahrplan-Kontrakt - Captain-Entscheid
  29.08.2026: die EINFACHE Variante, kein Vertragsfeld.
- **Sie autorisiert den BESTEHENDEN `SurplusCharger`**, statt einen zweiten
  Anhebe-Pfad zu bauen: der angehobene Zielwert läuft damit erneut durch die
  autoritative `guards.Clamp` (Nennband, SoC-Decke, EEG-Solarladen, §14a) und
  kann an keinem Wächter vorbeischreiben.
- **⚠ B1 ist MAGNITUDEN-ONLY, also OHNE gehaltenes Rücklesen** - anders als B2
  und die anderen Regeln, die eine Richtung aus der Ruhe STARTEN
  (`unplannedLoad`/`deficitCover`, die `portableReady` fordern). Die Box
  schreibt diese Richtung ohnehin schon; eine strengere Bedingung als die der
  größeren Wolken-Absorption daneben wäre nicht zu begründen.
- **Die native Automatik wird während einer Einlagerung zurückgenommen**
  (ihr Beleg zertifiziert nur autonome ENTLADUNG) - unverändert die Regel der
  abgelösten engen Ladeseite.
- **Ladung ≤ gemessener Überschuss ⇒ vorhergesagtes Netz ≤ 0:** sie kann keinen
  Import erzeugen oder erhöhen (§14a-Import und das Peak-Ziel bleiben unberührt)
  und bewegt einen Export nur in Richtung null - Einspeisegrenze und
  §14a-Export halten a fortiori.
- **Nie ein Richtungswechsel:** ein Verkauf und ein bloß ruhender Befehl liegen
  beide ausserhalb ihrer Eintrittsbedingung.
- **Wo die WOLKE autorisiert hat, behält sie ihren Namen** (`absorb`): die
  lokale Regel etikettiert nie eine Entscheidung um, die der Plan getroffen hat.
- Heartbeat/API/Portal nennen die Richtung als **`surplus_store` /
  „Live-Überschussladung"**. Regressionsvektoren (Herzogau 29.08.2026, aus den
  Box-Snapshots): **10:53** Plan +9,82 / PV 56,907 / Haus 29,013 / SoC 38 →
  **+27,894 kW**, Netz 0,000 (gemessen ~18 kW Export bei NEGATIVEM Preis);
  **10:14** Plan −7,17 (Follower → 0,0) / PV 39,354 / Haus 16,383 / SoC 19 →
  **+22,971 kW**, Netz 0,000 (gemessen 22,8 kW Export). Der abgelöste
  91-%-Vektor (11,4 / 2,9 → +8,5 kW) läuft unverändert durch dieselbe Regel.

