# Die BRÜCKE zur Regel-Welt (Anforderung 9): selbstbauBruecke.vorbefuellteAktion.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 093).

- **Die BRÜCKE zur Regel-Welt (Anforderung 9): `selbstbauBruecke.vorbefuellteAktion`.** Ein FREIGEGEBENER Schalter wird die AKTION der vorbefüllten Regel; ohne Freigabe bleibt sie offen (leere Benachrichtigung). Entschieden wird das über dasselbe `regelAktion`, das auch die Komponenten-Karte fragt. Der Wunsch trägt IMMER eine TTL — so zieht der Arbiter ihn selbst zurück, wenn die Bedingung endet; und beim Sollwert wird der KLEINSTE freigegebene Wert vorbelegt, weil er der einzige ist, den wir aus der Freigabe WISSEN.

