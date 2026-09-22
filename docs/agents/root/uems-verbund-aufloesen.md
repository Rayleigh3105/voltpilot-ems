# Gemeinsame Steuerung nach dem Scharfschalten auflösen

Verhalten, Zahlen und Wieder-Einrichten stehen im [Vertrag](../../contracts/v2/steuerungsverbund.md#auflösen-der-ganzen-gemeinsamen-steuerung-55-i4i5-g3g5-v5).

- Einstieg: `GemeinsameSteuerungService#aufloesen` → `GemeinsameSteuerungAusscheiden#aufloesen`.
- Übergang und Abschluss: `SteuerungsverbundAnteilDienst#ausscheidenBeginnen/#ausscheidenPruefen`; `aufloeseZiel` gibt der führenden Box den verteilbaren Rest ohne Geräte-Nennleistungs-Kappe.
- `steuerungsverbund.aufloesung_laeuft` unterscheidet den gemeinsamen Vorgang vom Einzel-Ausscheiden auch nach einem API-Neustart. Der Verbund-Lock serialisiert Quittung, Betreiber-Handgriff und Anteilsänderung.
- Kunden-GET: `aufloesen` zählt die erforderlichen Bestätigungen. Kundenkarte und Betreiber-Blatt verwenden `FLAECHE.wird_aufgeloest`.
- Abnahme: `GemeinsameSteuerungAusscheidenTest`; Portal-Bühnen und Specs `gemeinsame-steuerung` und `betreiberblatt`.
