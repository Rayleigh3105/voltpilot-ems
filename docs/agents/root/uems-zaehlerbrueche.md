# UEMS-Zählerbrüche: Gerätegrenze, Rücksetzung, Überlauf, Neustart (AP-08 IP-4)

Migrationen `V20260912220000__uems_zaehler_ueberlauf.sql` (Vokabular + Deklaration) und
`V20260912221000__uems_zaehlerbrueche_arbeit.sql` (Arbeitslisten-Grund `ereignis`). Regel
`uems/VerbrauchRegeln` ⟷ Python `verbrauch.py` (Vertrag `docs/contracts/v2/verbrauch.md` §2,
Tabelle der vier Brüche); Deklaration `uems/ZaehlerDeklaration`; Neubildung `uems/BruchEreignisse`;
Writer `UeberlaufErkennung` + `UeberlaufRegel`. Tests: `UemsZaehlerbruecheTest` (Testcontainers,
F4/F5/F6/F7/F12/F22), `VerbrauchVectorsTest` + `test_verbrauch.py` + `UeberlaufRegelZwillingTest`
(dieselbe Z6-Ableitung aus derselben Datei), `WriterPipeTest` (drei Überlauf-Fälle),
`MessreiheEreignisMigrationTest` (24 Arten zeilengleich).

## Die vier Brüche und ihre Kennzeichen

| Bruch | Erkannt an | Rechenbar macht ihn | Fehlt die Angabe |
|---|---|---|---|
| Gerätegrenze (Z4) | `device_boundary` (Kunde) in `(vorher, nachher]` | Endstand + Anfangsstand | Beitrag 0, „… ohne Ablesestände“ + „Zuwachs am Wechsel nicht messbar …“ |
| Rücksetzung (Z5) | Stand fällt, kein Überlauf | ein nachgetragener Endstand (→ Gerätegrenze, E3) | Beitrag 0, „Rücksetzung HH:MM ohne Endstand — bis zu 1 Kadenz nicht gezählt“ |
| Überlauf (Z6) | Stand fällt UND `VerbrauchRegeln.ueberlauf` | Wertebereich UND Höchstzuwachs je Kadenz | KEIN Überlauf — es ist die Rücksetzung (E4: der Höchstwert wird nie geraten) |
| Neustart (Z7) | `device_restart` (Box, je DATENQUELLE) in `(von, bis]` | der Zählverlust der Karte (`neustart_verlust_s`) | „bis zu 255 s“ (AP-05) — immer unvollständig, nie hochgerechnet |

Fehlt eine Angabe, entsteht **keine Zahl für den Bruch**, sondern die benannte Unvollständigkeit.

## ⚠ Die Deklaration ist HEUTE LEER

`messreihe_zaehler_deklaration(tenant, entity, messkanal, zeit)` → `wertebereich_modul`,
`hoechstzuwachs_je_kadenz`, `kadenz_s`, `neustart_verlust_s` — die EINE Stelle, aus der Writer,
Viertelstunden-, Tages-, Monats-/Jahres-Lauf und freier Zeitraum lesen. Die Felder dahinter baut
**AP-08 IP-7** (Vorlage `wertebereich_modul`/`laeuft_ueber`, Messstelle `anschlussleistung_kw`); IP-7
ersetzt NUR den Rumpf (gleiche Signatur). Bis dahin: jeder fallende Stand ist eine Rücksetzung, jeder
Neustart „bis zu 255 s“. Tests ersetzen den Rumpf (`deklarieren()` / `deklaration(...)`). ⚠ Der
Höchstzuwachs gilt je `kadenz_s`; `ZaehlerDeklaration.hoechstzuwachsFuer(kadenz)` rechnet ihn auf die
Kadenz der Rechnung um. `verlust_s` steht NICHT im Vokabular von `device_restart` (Box-Draht-Vertrag
unverändert); die Strecke liest die Nutzlast trotzdem zuerst — sie ist heute immer leer.

## Das neue Wort `counter_overflow` (24. Art, additiv)

Urheber nur `writer`, Zeitpunkt auf der Messzeit, Bezug Komponente + Messkanal (+ Box, Messstelle),
Pflichtfelder = die Rechnung: `stand_alt`, `stand_neu`, `messzeit_alt`, `wertebereich_modul`,
`hoechstzuwachs_je_kadenz`, `kadenz_s`. Die Prüfung ruft dieselbe Z6-Entscheidung (ein Sprung über dem
Höchstzuwachs wird `regel_verletzt`). Gleichzeitig geweitet: DB-Funktion `messreihe_ereignis_vokabular()`
(ganz abgeschrieben vom Stand V20260912190000) + Art-CHECK, beide `EreignisVokabular`-Zwillinge,
`uemsEreignis.ts` (Kundensatz), `events-vocabulary.md`, `events-vocabulary-vectors.json` (zwei F7-Fälle),
`events-raw.event.schema.json`, Ingest `BoxEventsValidator.ARTEN`. Das MQTT-Schema der Box NICHT
(Writer-Art). ⚠ Die Meldung ist die Rechnung zum Nachlesen, **nie die Quelle der Menge**. ⚠ Der Bestand
(`device_measurement_event`) kennt das Wort nicht und schreibt für denselben Sprung weiter
`counter_reset` (Spiegel `aus_bestand`, ohne Komponente) — ein Leser, der beides sieht, nimmt die
Writer-Meldung — so tut es der Lesepfad (`uems-lesepfad-verlauf-herkunft-rueckfall.md` §8).

## ⚠ Ein Fehler in der Überlauf-Erkennung kostet NIE einen Messwert

`UeberlaufErkennung.pruefen` läuft NACH dem Einfügen, nur an guten Zählerständen der Spur
(führend/Vergleich), in EIGENEM Savepoint, und wirft nie. Scheitert sie: Rollback auf den Savepoint,
`log.error`, `voltpilot_writer_ueberlauf_erkennung_total{ergebnis="fehler",grund}` — der Wert ist
geschrieben, der Bestand meldet `counter_reset` wie immer, es gibt keine Überlauf-Meldung. Die Menge
leidet nicht: sie bildet der Lauf aus Werten + Deklaration. Weitere Ergebnisse: `nicht_deklariert`
(heute jeder Wert, eine Abfrage), `kein_ueberlauf`, `ueberlauf`. Die Meldung selbst geht über
`vomWriter` (ebenfalls eigener Savepoint). Grenzen: nur gegen den VORIGEN guten Wert ≤ 1 Tag zurück; ein
nachgelieferter Wert vor einem gespeicherten und eine später eingetragene Gerätegrenze bleiben
unbemerkt — die Menge stimmt trotzdem.

## Die Strecke

- **Viertelstunde:** liest Ereignisse in `[von, bis]`, zählt/verankert `[von, bis)`, die Regel wendet
  `(von, bis]` an — ⚠ vorher fiel ein Wechsel GENAU auf der Grenze (10:45) aus der Viertelstunde
  10:30–10:45 heraus und wurde dort zur Rücksetzung. `device_restart` kommt über
  `measurement_point.data_source_id` (wie `handover`), nie über die Komponente.
- **Später eingegangen (Grund `ereignis`):** im Zeiger-Fenster der Rohwerte (Viertelstunde) bzw. der
  gebildeten Viertelstunden (Tag) trägt jede neue `device_boundary`/`device_restart`/`counter_overflow`
  ihre Viertelstunde (auf der Grenze: auch die davor) und ihren UTC-Tag ein; Kanäle aus den
  Viertelstunden ± 1 Tag, Ereigniszeit ≥ jetzt − 90/91 Tage. ⚠ Den Tag direkt, weil ein Wechsel in
  einer Lücke über die Viertelstundengrenze (F4/F5) keine Viertelstunde ändert. Monat/Jahr folgen über
  „Tag geschrieben“. Eine ENDGÜLTIGE Zeile bleibt stehen (Nachtrag danach = Vorschlag, IP-14); die
  `version` bleibt 1 (F12 „Version 2“ prüft Menge/Zustand/Kennzeichen, die Versionierung ist IP-12 ff.).
- **Tag, Monat, Jahr, freier Zeitraum:** `ViertelstundenTeile` liest Deklaration + Ereignisse und gibt
  sie an `zaehlerstandAusTeilperioden` — der Test prüft jede Periode gegen die Regel über ALLE Rohwerte.

Grenzen: keine Korrektur/Kaskade/Version (IP-12 ff.), keine Ersatzwerte (E7), keine
Route/Fläche, kein Edge-Release, keine Umklassifizierung Rücksetzung ↔ Überlauf (Korrektur).
