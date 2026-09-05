# Erklärbarkeit Stufe 0: die Echtheits-Regel für Begründungs-Sätze

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 128).


Konzept `data/vp-warum-erklaerbar-e2` (§4.1/§4.4/§10), Captain-Freigabe 17.08.2026. Bindend für
JEDE Fläche, die erklärt, warum der Optimierer so entschieden hat:

> **Ein Satz, der eine URSACHE behauptet, muss an einem exportierten Entscheidungs-Fakt hängen,
> der genau diese Ursache trägt. Trägt kein Fakt sie, sagt die Fläche nur die BEOBACHTUNG.**

Der Anlass war ein plausibler, aber unechter Satz über einem ruhenden Speicher („der
Preisunterschied ist kleiner als Verluste und Verschleiß") — arithmetisch richtig, kausal falsch,
und eine mehrstündige Untersuchung teuer. Die Regel ist die Verallgemeinerung dreier bestehender
Hausregeln (`idleReason` „null when the optimizer recorded nothing", K1 „ohne belegbare Aussage
der GRUND, ohne Grund NICHTS", und die Ingest-Regel „ein Wort, das wir nicht verstehen, darf kein
Satz werden").

- **Der Grund, warum die Klasse überhaupt entstand:** `explain.py`s Rollen-Klassifikation
  beschreibt das ERGEBNIS (idle ⇒ `warten`), nie den TREIBER — und für Ruhe gibt es strukturell
  mehrere, von denen nur zwei als Flag exportiert sind. **Neue Rollen/Flags erben dieses Problem:
  wer eine Rolle hinzufügt, prüft, ob ihr Satz aus ihren FAKTEN folgt oder nur plausibel ist.**
- **`optimizer/SlotEconomics.whyText`s Ruhe-Zweig ist der api-Anteil** (der Betreiber-Blick hätte
  am 17.08. dieselbe falsche Geschichte erzählt): er nennt jetzt die Beobachtung plus die eine
  Zahl, die wirklich vorliegt (λ), **ohne Kausal-Verknüpfung** — die Kunden-Zwillinge in
  `frontend/portal/src/{fahrplanWhy,schedule}.ts` wurden im selben Zug entschärft, und der Zweig
  hat seither einen eigenen Wächter-Test in `SlotEconomicsTest`.
- **Der strukturelle Schutz ist `frontend/portal/src/begruendung.test.ts`** — er ruft jede
  Ableitung mit FAKTEN-FREIER Eingabe auf und verbietet im Ergebnis Kausal-Vokabular (plus je
  kausalem Zweig ein „Gates absent ⇒ unerreichbar"-Test). Details + die bewussten Ausnahmen
  stehen in `frontend/portal/AGENTS.md`.
- **NICHT in dieser Stufe:** der Export der drei fehlenden Treiber-Fakten (Anker des
  Speicherwerts, Knappheit/Marge aus den schon geholten reduced costs, Morgen-Ausblick) — das ist
  Stufe 1 und ein eigener Auftrag; Stufe 0 verhindert nur, dass sie erfunden werden.

