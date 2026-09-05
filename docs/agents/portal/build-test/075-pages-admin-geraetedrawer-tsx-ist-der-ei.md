# pages/admin/GeraeteDrawer.tsx ist der EINE Geräte-Drawer

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 075).

- **`pages/admin/GeraeteDrawer.tsx` ist der EINE Geräte-Drawer** — von der Geräte-Zeile des Inventars UND der Geräte-Zeile einer Aktualisierung geöffnet. Sein Eingabe-Typ `DrawerDevice` ist bewusst ein eigener, schmaler Typ: die zwei Seiten sind verschiedene Server-Aggregate, und ohne ihn wäre der Drawer entweder dupliziert (zwei Wahrheiten über dasselbe Gerät) oder an eines der Aggregate gefesselt. Ohne `onAssign` ist er eine reine Ansicht (einer gedruckten ID lässt sich nichts zuweisen).
