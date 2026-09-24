# UEMS-Bezugsbasis: Datenhaltung (AP-17 IP-6, B1/B4/V3/F1)

Neu am 23.09.2026: Migration `V20260924071500__uems_bezugsbasis.sql`, sieben leere Tabellen, keine Route, kein
Leser. Leser und Grundlage bilden IP-7, Routen und `@Recht` IP-8, Anstoß-Schreiber IP-15 (unten), Faktor-Vorschlag IP-16.

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

## Anstoß-Schreiber (AP-17 IP-15, A2–A4)

`BezugsbasisAnstoss` setzt `bezugsbasis_anstoss` + Protokoll `anstoss_gesetzt` (Migration
`V20260924200500__uems_bezugsbasis_anstoss.sql`: Wort, Admin-INSERT, Wasserzeichen `bezugsbasis_struktur_gelesen`).
Pfad 1 hängt als Setter an `KennzahlKaskade` (nach der Neubildung, dieselbe Transaktion): Grundlage-Einträge (Monat)
mit Kennzahl-Version < neu, Messstelle im Korrekturzeitraum, Bezugsgröße mit älterer Fassung/Rücknahme, Ort bei
`flaeche_geaendert` → `grundlage_korrigiert`, Kennung = `KennzahlKaskade.ausloeser` (+ `/Fassung-n`, `/zurueckgenommen`).
Pfad 2 hängt als Setter an `StrukturAenderungLaeufer` (läuft also nur mit den Berichte-Schaltern): Faktoren
Fläche/Standort/Anlage (`ort_aenderung`), Prozess/Kostenstelle (`messstelle_aenderung`, Text-Treffer der ID),
`kennzahl_archiviert`, Bezugsgröße bearbeitet (nicht nur Name) / archiviert; nie Wortlaut; nur Zeilen NACH der Freigabe.
Schalter `voltpilot.uems.bezugsbasis.enabled`: aus → Pfad 2 schreibt nur Wasserzeichen `abgeschaltet`.
Beide Pfade lesen nur Fassungen von Basen mit `beendet_am IS NULL` (A4, Nachlese 1): die Archivierungs-Naht beendet
die Basis in ihrer Transaktion, ihr `kennzahl_archiviert` urteilt danach `ohne_bezugsbasis`.
Gelesen (Nachlese 3, §15): `BezugsbasisAnstoesse` hängt `anstoesse[]` mit Kundensatz an `GET …/bezugsbasen[/{bid}]`,
`BezugsbasisPflegeService#frist` die `frist` — ⚠ der Satz parst das `anlass`-Format des Pfads 1 (`<kennung> (<status>):
<treffer>, …`); wer es ändert, zieht `BezugsbasisAnstoesse` und `BezugsbasisPflegeApiTest` mit.
⚠ `bezugsbasis_vokabular()` steht jetzt in ZWEI Migrationen — wer sie weitet, nimmt `('protokoll', 13, 'anstoss_gesetzt')` mit.
⚠ A5 (Weitergabe an Leistungsvergleichs-Stände) fehlt: Quellenart `bezugsbasis` kommt mit IP-21a, die Weitergabe mit
IP-23 (`Gesetzt`-Rückgabe beider Pfade). Nachweis: `UemsBezugsbasisAnstossTest`.
