# UEMS-Bezugsbasis: Datenhaltung (AP-17 IP-6, B1/B4/V3/F1)

Neu am 23.09.2026: Migration `V20260924071500__uems_bezugsbasis.sql`, sieben leere Tabellen, keine Route, kein
Leser. Leser und Grundlage bilden IP-7, Routen und `@Recht` IP-8, Anstoß-Schreiber IP-15, Faktor-Vorschlag IP-16.

| Stelle | Was |
|---|---|
| `bezugsbasis` | BB-0001 … je Kundenbereich (Zähler `bezugsbasis_kennzeichen_seq`), genau eine Kennzahl; `bezugsbasis_eine_laufende_uq`: je Kennzahl höchstens eine mit `beendet_am IS NULL`; beendet (`beendet_zum/_am/_grund`), nie gelöscht |
| `bezugsbasis_fassung` | `freigabe_status` `entwurf · beantragt · freigegeben · abgelehnt`; außerhalb des Entwurfs Begründung 10–500 Zeichen und Freigabe-Person (`freigabe_*`), bei Vier-Augen eine zweite Person (`entscheidung_*`, KA/EM, nie die Freigabe-Person); Fassung n + 1 außerhalb des Entwurfs mit Anpassungsgründen A1, `sonstiger` mit `anpassung_wortlaut`; Toleranz (2 %) und Wiedervorlage (12) je Fassung |
| Grundlage | `grundlage` ist kanonischer TEXT, kein JSONB; `pruefsumme = bericht_pruefsumme(grundlage)` hält ein CHECK |
| `bezugsbasis_variable` · `bezugsbasis_faktor` | Position 1/2 mit Bezugsgröße (RESTRICT) · Verweis (nur beim Anlegen geprüft, kein FK) oder Wortlaut mit Wert-Kopie; `aufgehoben_am` nur im Entwurf |
| `bezugsbasis_anstoss` · `bezugsbasis_aenderung` | je Fassung/Art/Anlass-Kennung einmal, Antwort `neue_fassung · beendet · bleibt` · Protokoll nur anhängen |
| Vokabulare | `bezugsbasis_vokabular()` + `bezugsbasis_wort()`; §6.1-Namen `bezugsbasis_methode()`, `…_anpassungsgrund()`, `…_urteil()`, `…_grund()`. Weiten = `CREATE OR REPLACE` der Funktion, kein CHECK |
| Rechte · Ereignisse | `bezugsbasis.verwalten/freigeben/ansehen` (reserviert, `RechtMatrixApiTest.OHNE_SCHREIBROUTE`); Reservierungen `bezugsbasis_freigegeben/_beendet/_anstoss` |

⚠ **Eingefroren:** `bezugsbasis_fassung_eingefroren` lässt außerhalb des Entwurfs nur Freigabe-Entscheid und das Ende
(einmal) zu; ein Schreibweg, der eine freigegebene Fassung „korrigiert“, scheitert mit 23514 — richtig ist Fassung n + 1.
⚠ **Löschwege:** eine Bezugsgröße als Variable hält `BezugsgroesseService.loeschen` per FK auf; seit IP-7 lesbar als
409 `bezugsgroesse_in_verwendung` mit `bezugsbasen` ([Grundlage und Routen](uems-bezugsbasis-grundlage.md)). Offboarding räumt die Tabellen vor Kennzahl/Benutzer ab.
Nachweis: `UemsBezugsbasisMigrationTest`.
