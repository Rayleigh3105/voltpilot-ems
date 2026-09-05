# Steuerung Stufe 3 (A6): die Vorrang-Texte drehen

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 20).


Die Portal-Hälfte von „Vorrang technisch" (Konzept `data/vp-steuerung-konzept-b3` §3.6/§3.7 A6;
die Technik steht im Wurzel-`AGENTS.md`). Sie ist **zwei Konstanten, kein Umbau** — genau der
Umschaltpunkt, den Stufe 2 im Doc-Kommentar von `regeln/satz.ts` benannt hatte.

- **`VORRANG_FOLGEN` und `VORRANG_ZEILE` sagen seit Stufe 3 auf BEIDEN Zweigen „Ihre Regel geht
  vor".** Die Trennung nach `VorrangArt` (`speicher`/`geraet`) BLEIBT, transportiert aber jetzt die
  FOLGE statt des Gewinners: der Speicher-Zweig nennt zusätzlich, dass ein laufendes
  Betriebsmodell dafür pausiert (§3.7 A5b — der Server legt es bei der Aktivierung wirklich still
  und nennt es in der Antwort), der Geräte-Zweig nicht, weil es dort keines gibt.
- **⚠ Keiner der Sätze verspricht eine ZAHL.** „Was das kostet" ist Stufe 7; bis dahin wäre sie
  erfunden (die Echtheits-Regel des Hauses). `migration.test.ts` prüft das mit einem Muster auf
  `\d+[,.]\d+ €|kWh` über ALLE vier Sätze.
- **⚠ `VORRANG_ZEILE` bleibt ein Record, obwohl beide Zweige gerade gleich lauten** — der Speicher
  bekommt in Stufe 7 die Variante 2 (dieselbe Aussage MIT Zahl), das Gerät nicht.
- **Beweise:** `regeln/folgen.test.ts` (die zwei Zweige + die Zahl-Sperre) · `regeln/zustand.test.ts`
  (die Zeile an der Regel-Karte, weiterhin nur MIT Anspruch) · `migration.test.ts` (+2 Wächter).
  Im echten Chrome an „Demo Site Berlin" durchgespielt (1440 und 375 über
  `chrome-devtools-axi emulate --viewport`): Regel-Karte und Folgen-Karte tragen den Satz,
  0 px horizontaler Überlauf, 0 überstehende Elemente.

