# Verbraucher im Cockpit (Phase 0): die Aufschlüsselung hinter der Haus-Zeile

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 22).


Konzept `data/vp-verbraucher-cockpit-k1` (Captain-Entscheide E1–E7, 28.08.2026), Phase 0 =
reine Anzeige aus vorhandenen Endpunkten: **kein Backend, keine Migration, kein Edge-Release.**
Ohne einen einzigen Verbraucher rendert das Board Zeichen für Zeichen wie vorher — und genau
das ist als Test festgenagelt (`livePuls.test.ts` „ohne Aufschlüsselung ist die Liste Zeichen
für Zeichen dieselbe", `LivePuls.test.tsx` „ohne `fold` …").

- **`src/verbrauchKomposition.ts` ist die EINE Ableitung** (rein + mutationsgeprüft, das
  `pvComposition`-Spiegelbild). Der Unterschied, der alles prägt: die PV-Summe IST ihre Teile,
  der Haus-Wert ist eine EIGENE Messung (`pv + grid − battery`), von der die Teile ABGEZOGEN
  werden. Daraus fällt die ganze Ehrlichkeits-Arithmetik.
- **⚠ Der Haus-Wert kommt vom `house-load`-MITGLIED, nie vom Knoten-Wert.** Der Knoten summiert
  seit je `house-load` PLUS jeden gemessenen Verbraucher und zählt die Wallbox damit doppelt
  (Konzept §1.2; die Rolle `charging` räumt das in Phase 1 auf). Eine Aufschlüsselung darf nicht
  auf einer Zahl fußen, von der sie ihre eigenen Teile abziehen will.
- **⚠ DIE REST-REGEL ist die einzige Stelle, die eine Zahl BILDET** — und deshalb die mit den
  meisten Regeln: sie rechnet NICHT, wenn ein Teil, der in die Summe gehörte, sich ihr entzieht
  (ein LAUFENDER Verbraucher ohne Messwert, ein gemessener mit veraltetem Wert). Dann steht dort
  der GRUND. Ein RUHENDER Verbraucher ohne Messwert blockiert NICHT (was aus ist, zieht nichts).
  Ein negativer Rest wird GESAGT („Messwerte passen nicht zusammen"), nie auf 0 geklemmt.
  ⚠ Das Konzept-Mockup zeigt an EINER Stelle einen Rest neben einer laufenden, messungslosen
  Wärmepumpe — seine eigenen Zahlen gehen dort ohnehin nicht auf (11,0 + 1,9 + 1,2 ≠ 12,2).
  Die geschriebene REGEL (§2.1 Regel 3) gewinnt; sie ist die vorsichtigere.
- **⚠ Geschlüsselt wird auf `LadeZustandKind`, nie auf den deutschen Satz** (`LAEDT`-Menge). Die
  Wortquelle ist und bleibt `ladepunkte.ladeZustand` — es gibt keine zweite.
- **⚠ `livePuls.istHausZeile` ist die EINE Antwort auf „welche Zeile ist das Haus"** — zwei Leser
  hängen daran (`liveDetail.withDayTotals` für die Heute-Spalte, `withVerbrauch` für die
  Aufschlüsselung). Eine Wallbox darf weder die Tagessumme des Hauses erben noch seine
  Zusammensetzung tragen.
- **Die Zeile hat ZWEI Ziele, nebeneinander, nie ineinander:** der Zeilen-Klick bleibt der
  Verlauf, das Aufklappen ist ein eigener 28-px-Knopf mit 44-px-Trefferfläche
  (`.vp-puls-fold::before`, das `.vp-am-pencil`-Muster). Ein `<button>` im `<button>` ist kein
  gültiges HTML; eine aufklappbare Zeile trägt deshalb NICHT auch noch ihr eigenes Chevron.
- **Das Panel ist ein GESCHWISTER der Zeile in `.vp-puls-rows`, kein Kind.** ⚠ Das Board ist ab
  900 px ZWEISPALTIG — ohne `grid-column: 1 / -1` stünde das Panel in einer Spalte unter einer
  fremden Zeile (im Browser gefunden). ⚠ Ebenso im Browser gefunden: eine Zeile OHNE
  Frische-Punkt (der Rest, die kollabierte Summe) braucht `grid-column: 1 / 3` auf ihrem Namen,
  sonst steht er in den 8 px der Punkt-Spalte und bricht Buchstabe für Buchstabe um.
- **Die Zeile ist ein GITTER** (Punkt · Name · Wert · heute [· Chevron]) — am Telefon fällt die
  Heute-Spalte in eine zweite Zeile, das Chevron BLEIBT in der ersten. Ab 1100 px stehen die
  Gruppen zweispaltig (Konzept §3), sonst läge die Zahl einen Meter vom Namen entfernt.
- **Chrome-Beweis 375/768/1440:** 0 px horizontaler Überlauf, 0 überstehende Elemente.
  ⚠ Chromes Fenster-Mindestbreite auf macOS ist ~500 px — ein echter 375-px-Viewport entsteht
  nur in einem `<iframe width="375">`; `resize 375` meldet 375 und liefert 500.

