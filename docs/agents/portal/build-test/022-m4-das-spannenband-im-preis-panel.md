# M4 · Das Spannenband im Preis-Panel

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 022).

- **M4 · Das Spannenband im Preis-Panel: Bezugspreis UND Einspeisewert als Stufenlinien-Paar** (`schedule.priceSpread` aus `importPriceCtKwh`/`exportValueCtKwh`, die EINE serverseitige `SlotEconomics`-Komposition). Die Fläche dazwischen ist eine **F3-Ausnahme** (sie TRÄGT die Aussage: die Spanne ist der Grund fürs Laden) und hat ihr **Namensschild IM BILD** an der größten Spanne (K10) — nicht nur eine Legendenzeile.
  - **Die untere Kante ist das MINIMUM der beiden Linien, nicht „der Einspeisewert":** bei negativem Börsenpreis kann er über dem Bezugspreis liegen, und eine gestapelte Fläche mit negativer Höhe zeichnete sich nach unten aus dem Band heraus.
  - **Der Einspeisewert nimmt `flowGridLine`, nicht Grün** — bewusste Abweichung vom Rev-1-Mockup: dessen Grün war genau die Grün×Grün-Kollision (Ladebalken kW vs. Einspeisewert ct), für die es diese Stufe gibt. Grün bleibt auf dieser Leinwand AUSSCHLIESSLICH der Speicher; gemessen ΔE 16,4 (normal) / 15,8 (Deutan) gegen das Preis-Blau. Der Chroma-Floor-FAIL des Tons ist der dokumentierte, bewusste Stufe-0b-Entscheid („das Netz ist die ruhigste Serie").
  - **F6-Korrektur:** beide Preislinien bleiben DURCHGEZOGEN — ein feststehender Börsenpreis darf keine Unsicherheit behaupten; gepunktet ist nur, was wirklich prognostiziert ist. Ohne die zwei Größen fällt das Panel ehrlich auf den nackten Börsenpreis zurück, ohne jeden Preis entfällt es.
