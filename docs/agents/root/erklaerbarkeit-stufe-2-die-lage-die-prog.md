# Erklärbarkeit Stufe 2 „Die Lage": die Prognose-Erzählung auf der Fahrplan-Seite

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 130).


Die dritte Stufe des Erklärbarkeits-Konzepts (`data/vp-warum-erklaerbar-e2` §6 + §10 Stufe 2,
Captain-Entscheide F1-F6). **Sie ist REIN Portal — kein Endpunkt, keine Spalte, keine Migration:
alles, was sie sagt, steht seit langem in der Antwort** (`ScheduleSlot.pvKw`/`loadKw`/`priceEurMwh`,
die Stufe-1-Lauf-Fakten auf `SchedulePlanDto`, die Wetter-Route). Sie beantwortet W3 („warum ist mein
Speicher mittags schon leer?") und W9 („was erwartet die Anlage für morgen?"), bevor die Frage
entsteht — die echte Antwort auf W3 hatte ein Scout am 17.08.2026 von Hand aus Preiskurve und
Registern rekonstruieren müssen, weil sie NIRGENDS kundenlesbar stand.

- **⚠ Die kWh-Zahlen dürfen nur aus den Eingaben kommen, mit denen wirklich geplant wurde.** Das
  Portal zeichnet dieselben Reihen als Prognose-Linien über die Fahrplan-Balken, Zeile und Diagramm
  können sich damit nicht widersprechen; aus Bewölkung × kWp eine ZWEITE Erzeugungsprognose zu
  rechnen ist die im Haus dokumentierte Falle (`wetterLeistung.ts`). Das Wetter liefert deshalb nur
  ein WORT.
- **⚠ Der 24-h-Horizont endet je nach Lauf-Zeitpunkt MITTEN in morgen** — ein 13-Uhr-Lauf kennt von
  morgen nur die Stunden bis 13 Uhr. Eine Tages-Summe daraus wäre ein halber Tag und läse sich als
  „morgen kommt kaum Sonne"; die Fläche schweigt dort über die kWh und sagt, soweit belegbar, nur
  den Wetter-Satz bzw. den schon existierenden Horizont-Hinweis. **Wer künftig eine Größe „für
  morgen" aus dem Plan summiert, braucht dieselbe Abdeckungs-Prüfung.**
- **Bewusst KEINE Backend-Arbeit:** kein `/lage`-Endpunkt (die Fläche komponiert aus dem, was die
  Seite ohnehin lädt) und kein Server-Zwilling der Sätze — die Ableitung ist Anzeige, nicht
  Entscheidung. Die einzige Naht zum Optimierer sind die Stufe-1-Lauf-Fakten (Anker + freie
  Auffüll-Quote), an denen die zwei kausalen Halbsätze über den Speicher hängen; sie stehen in
  derselben Gate-Tabelle wie die Stufe-1-Zweige, also kann die Zeile nichts behaupten, was der
  Solver nicht exportiert hat.
- **NICHT in dieser Stufe:** die Abregel-/Grenzen-Verzweigung (Stufe 3) und die Eingaben-Diff-Zeile
  (Stufe 4, F3 zurückgestellt). Fläche, Regeln und Beweise: `frontend/portal/AGENTS.md`
  „Erklärbarkeit Stufe 2".

