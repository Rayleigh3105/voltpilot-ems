# Wo die Geräte gepflegt werden, sagt EIN Satz (Einheitsmodell Stufe 2; Backend + die Übernahme-Regeln in der Root-AGENTS.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 086).

- **Wo die Geräte gepflegt werden, sagt EIN Satz (Einheitsmodell Stufe 2; Backend + die Übernahme-Regeln in der Root-`AGENTS.md`).** `komponentenAssistent.ts` `verwaltungsHinweis(componentAuthority, adoptedAt)` ist die EINE Ableitung, gerendert über der Komponenten-Liste des Anlagen-Modells. **Drei Fälle, bewusst verschieden:** eine **box-verwaltete** Anlage sagt, dass sie noch wartet UND dass der Kunde dafür nichts tun muss — ohne diesen Satz wäre die Abwesenheit des Assistenten (der nur portal-verwaltet erscheint) unerklärlich; eine **übernommene** erklärt den Wechsel samt der Zusage „an Ihrer Anlage selbst hat sich dadurch nichts geändert" (das ist die Kundenübersetzung der No-op-Eigenschaft); eine Anlage, die **immer schon im Portal** entstanden ist, SCHWEIGT — es gibt nichts zu erklären. Ein Satz, kein Alarm: der Ton ist `is-unbekannt`, nie `is-warn`.
  - **⚠ `adoptedAt` ist der BELEG, nicht der Zustand.** `null` heißt „nie automatisch übernommen" und ist NICHT dasselbe wie box-verwaltet; die Autorität steht allein in `componentAuthority`. Genau daraus entsteht der dritte (schweigende) Fall.
  - Alles, was nicht wörtlich `portal` ist, gilt als box — die Autoritäts-Regel des Hauses, hier wie überall.

