# Verlauf-Sprache P0: die Token des Bereichs „Verlauf" und ihre drei Wächter

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 169).


Konzept `data/vp-verlauf-sprache-konzept-v5` (Captain-Entscheide **E2 = (a)**, **E3 = (a) alle vier
Kästen**, 03.09.2026). **Reines Fundament: kein Stylesheet und keine Fläche ändert sich** — die
sechs Reiter (Messwerte · Erlöse · Marktpreise · Lastspitzen · Prognose · Wetter) ziehen in P1–P8
nach. Alles Folgende steht in `frontend/portal/src/index.css` (Token-Block) und den drei
`src/verlauf*.test.ts`; die Details stehen dort im Kommentar, hier nur die Regeln, die JEDE
Folge-Crew braucht.

- **⚠ KANONISCH ist `--vp-c-fs/fw/lh-*`; `--vp-erl-*` ist NUR NOCH EIN ZWEITER NAME**
  (`--vp-erl-fs-12: var(--vp-c-fs-12)`). Wer neu schreibt, nimmt `--vp-c-*`. Der Wert steht an
  genau EINER Stelle, und `erloeseSkala.test.ts` nagelt fest, dass jeder Erlöse-Name ein REINER
  Alias bleibt — stünde dort je wieder eine Pixelzahl, hätte das Portal zwei Skalen, die lautlos
  auseinanderlaufen. **Folge für jedes Muster, das Token liest: hinter `--vp-erl-fs-16:` steht
  kein `16px` mehr**, sondern ein `var()`; ein Regex, der eine Pixelzahl sucht, muss den
  kanonischen Namen lesen.
- **⚠ DIE RATSCHE IST DAS BAUPRINZIP DER DREI WÄCHTER.** Jede Verlauf-Datei steht mit einer Zahl
  erlaubter Verstöße in einer Tabelle im Test: umgestellte Flächen auf `0` (streng), die übrigen
  auf ihrem gemessenen IST-Stand. **Eine Zahl wird NUR KLEINER** — wer sie erhöht, hat den Wächter
  abgeschafft, nicht bestanden. Ein eigener Test zieht jede Zahl selbst nach unten fest (eine Zahl
  mit Luft bewacht nichts), und `verlaufMobil` verlangt zusätzlich, dass jeder Eintrag > 0 seine
  offenen Selektoren beim NAMEN nennt. **Wer ein Blatt ergänzt, trägt es in die Tabelle ein** —
  sonst prüft der Wächter es nie.
- **⚠ Die Chart-Reihen ERFINDEN KEINE FARBE.** `--vp-c-chart-{pv,load,grid,batt,soc,price,price-2}`
  ist eine ZUORDNUNG der Vier-Rollen-Palette des Energieflusses (`--vp-flow-*`) bzw. ihrer
  gemessenen Linien-Stufe; ein Test verweigert jeden Wert, den das Portal nicht schon führt.
  `-batt`/`-soc` sind EINE Speicher-Rolle in zwei Stufen (Fläche satt, Linie tief). Gemessen wird
  bei jedem Lauf: jede Reihe ≥ 3:1 auf `--vp-c-card` UND `--vp-c-bg`, jedes Paar ≥ ΔE 15 (CIE76).
  `chartTheme()` stellt sie als EIGENE Einträge (`cPv`…`cPrice2`) neben `pv`/`load`/`price` bereit
  — die alten tragen portalweit ihre Bedeutung, ein Chart wechselt sein Kleid erst, wenn SEIN
  Reiter-Paket ihn umstellt.
- **⚠ `--vp-c-motion` (200 ms) verstummt an GENAU EINER Stelle** — dem
  `prefers-reduced-motion`-Block direkt unter dem `:root`. Die übrigen Blöcke der Datei schalten je
  eine NAMENTLICHE Animation ab (`animation: none`); eine Dauer von 0 ms ersetzt das nicht.
  Zusammengelegt wird je Fläche erst, wenn sie ihre Übergänge auf `var(--vp-c-motion)` umgestellt
  hat. Die Kurve ist das Haus-Token `--vp-ease` — ein `--vp-c-ease` wäre ein Zwilling und ist im
  Wächter verboten.
- **⚠ Die Abstands-Skala `--vp-c-space-1…6` (px) ERSETZT `--vp-space-*` (rem) NICHT** — jene trägt
  die Schale.

