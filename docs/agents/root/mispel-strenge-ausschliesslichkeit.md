# MiSpeL: strenge Ausschließlichkeit (MP-45) – aufgegangen in Netzladen „Verboten“ (EN-1 A, EN-2 A)

MP-45 hielt die strenge BNetzA-Lesart der Ausschließlichkeitsoption („kein Verbrauch im Stromspeicher, während es gleichzeitig einen Netzbezug gibt“, Anlage 1 S. 11) als Betreiber-Schalter je Anlage bereit (`VOLTPILOT_MISPEL_STRENGE_SITES`, Plan-Feld `strict_exclusivity`, Toleranz je Viertelstunde). Auf `main` wurde dieselbe Regel am 02.11.2026 ohne Schalter für **jede** Anlage mit Netzladen „Verboten“ eingeführt: im Optimierer als `strenge_ausschliesslichkeit` (EN-2 A, v1 und v2, ohne Toleranz) und an der Box als Netzladen-Sperre (EN-1 A, `guards.NetzladenSperre`, Reserve 1 kW). Beim Merge von `mispel` nach `main` (11.11.2026) blieb deshalb die Fassung von `main`; Schalter, Plan-Felder, Toleranz und die gelbe Zeile der Box-Seite sind entfernt.

- **Optimierer:** [Netzladen-Schalter](per-site-grid-charging-switch-site-netzl.md), Nachweis `services/optimization/tests/test_mispel_strenge.py`.
- **Box:** `edge-app/core/internal/guards/netzladensperre.go`, Regeln in [Edge-Laufzeit](../../edge-runtime.md#schutzgrenzen); welcher Förderweg die Klemme lösen darf, steht in [MP-14](mispel-box-foerderweg.md).
- **Messen, was trotzdem im Speicher landet:** [MP-2](mispel-ausschliesslichkeits-pruefer.md).
