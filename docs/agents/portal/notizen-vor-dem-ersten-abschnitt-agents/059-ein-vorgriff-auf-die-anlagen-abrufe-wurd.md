# ⚠ Ein Vorgriff auf die Anlagen-Abrufe wurde GEMESSEN und wieder ENTFERNT.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 1, Punkt 059).

- **⚠ Ein Vorgriff auf die Anlagen-Abrufe wurde GEMESSEN und wieder ENTFERNT.** Naheliegend, weil die Anlagen-Id von der ersten Sekunde an in der Adresse steht: `/topology`, `/entities`, `/overview` schon beim Anmelde-Ende anzustossen, statt auf `/sites` zu warten. Ergebnis war das GEGENTEIL - Fast 4G 1.965 → 2.148 ms, Slow 4G 6.306 → 6.853 ms, Anfragen 18 → 21. Grund: die Vorgriffe waren FERTIG, bevor die Haken der Seite überhaupt montiert waren, also griff die In-flight-Bündelung nicht mehr und es blieben drei zusätzliche Anfragen, die den kritischen um Verbindungsplätze konkurrierten. Ein Vorgriff bräuchte einen kurzlebigen ERGEBNIS-Zwischenspeicher - also genau die stille Veraltung, die dieses Portal sonst nirgends duldet. Wer es erneut versucht, misst zuerst.

