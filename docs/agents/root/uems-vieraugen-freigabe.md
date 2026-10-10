# UEMS Vier Augen bei Korrekturen: Vorgabe aus, Ersteller nie bei an, Unterstützer nie (AP-08 IP-15)

Neu angelegt am 14.09.2026. Entscheid AP-08 **E8 = A** (11.09.2026): „Konfigurierbar je Unternehmen durch den
Kundenadministrator: ‚Freigabe durch eine zweite Person‘ aus (Vorgabe) oder an; bei an: Ersteller ≠ Freigeber
(Energiemanager oder Kundenadministrator); jede Freigabe protokolliert Ersteller, Freigeber, Zeitpunkt, Begründung.“
Baut auf IP-12 (`uems-korrektur-ersatzwert.md`), IP-14 (`uems-korrektur-vorschlaege.md`) und IP-17
(`uems-korrektur-kaskade.md`) auf. **Die ersten UEMS-Routen, die ihr Recht DURCHSETZEN** — gemergt nur mit Captain-Wort.

| Teil | Stelle |
|---|---|
| Routen | `web/KorrekturFreigabeController`: `GET`/`PUT /api/v1/unternehmen/vieraugen`, `POST /api/v1/korrekturen/{kennung}/freigeben`, `POST …/zuruecknehmen` (OpenAPI Tag `korrekturen`) |
| Dienst | `uems/KorrekturFreigabeService` (Reihenfolge, Sperre, Protokoll), Ablehnungen `uems/KorrekturFreigabeAbgelehnt` |
| Rechte | `uems/KorrekturRechte` → `RechteAbleitung.darf` / `.korrekturEntscheiden` (Familie `vieraugen` in `rechte-vectors.json`, TS-Zwilling `rechte.ts`) |
| Matrix | `ersatzwert.erfassen` (wie `korrektur.erfassen`), `korrektur.freigeben`, `vieraugen.einstellen` (Nachtrag AP-08 §4.8), `korrektur.zuruecknehmen` (Nachtrag AP-08 §5); W-R12 |
| Migration | `V20260914201500`: `unternehmen.vieraugen_freigabe` (NULL = Vorgabe aus), `messreihe_korrektur.freigabe_vieraugen` + CHECK + Trigger `messreihe_korrektur_zweite_person` |

## ⚠ Die Fallen

- **Der Aufrufer heute:** Kundenbenutzer = Kundenadministrator unternehmensweit (E12); Plattform-Admin mit
  `X-Tenant-Id` = VoltPilot-Konto mit wirksamer Unterstützung „Einrichten und Bedienen“ (AP-03 E8) — also der
  Unterstützer, der an allen fünf Zeilen „-“ trägt. Ziel ist das Unternehmen: ein künftiger Bearbeiter (S) wird
  damit abgewiesen, nicht zugelassen, bis Zuweisungen je Standort existieren.
- **`KorrekturRechte.MATRIX` ist eine Kopie** der fünf Zeilen (die Matrix-Datei liegt nicht im Jar);
  `KorrekturRechteTest` hält sie Zelle für Zelle an `rechte-matrix.json`. Zelle ändern = Datei + Generator + diese Stelle.
- **Fremd ist 404, unberechtigt 403:** erst Kundenbereich und Korrektur (auch der Unterstützer eines ANDEREN
  Bereichs bekommt 404), dann das Recht. 403 `recht_fehlt` (mit `rolle_noetig`, beim Unterstützer null = „nie“)
  oder 403 `zweite_person_noetig`.
- **Die Einstellung wirkt zum Zeitpunkt der Freigabe:** gelesen als Erstes in der Transaktion `FOR SHARE` auf der
  Unternehmen-Zeile, das Umschalten nimmt sie `FOR UPDATE` — keine Freigabe wird unter „aus“ geprüft und nach einem
  „an“ geschrieben. Die geprüfte Einstellung steht an der Freigabe-Fassung; ableiten aus Zeitstempeln geht NICHT
  (`created_at` = Transaktionsbeginn, eine wartende Transaktion hätte den früheren).
- **Vier Angaben ohne Kopie:** Ersteller = `actor_*` der Fassung 1, Freigeber/Zeitpunkt/Begründung = die neue Fassung
  (`grund`). Begründung 10–500 Zeichen ist Pflicht (422 `begruendung_fehlt`); die DB verlangt sie, sobald die Fassung
  `freigabe_vieraugen` trägt. Das alte `repo.freigeben(…, grund, akteur)` ohne Einstellung bleibt für Tests/Bestand.
- **Ein Vorschlag des Systems** (`actor_sub` NULL) hält niemanden auf: bei an gibt jede berechtigte Person frei.
- **Widerruf (§5 wörtlich):** der Bearbeiter nur die eigene und nur bei aus; Energiemanager/Kundenadministrator ohne
  Ersteller-Sperre, auch bei an. Den Ersatzwert-Widerruf regelt `ersatzwert.erfassen` (W-R12, Captain-Frage bis IP-16).
- **Seit AP-09 IP-7** gibt dieselbe Route auch `BK-…` frei (die Berichtigung eines Bezugsgrößen-Werts): ein Zweig in
  `freigeben`, Reihenfolge und Ablehnungen gleich; Wert-Fassung und `correction` schreibt `uems/BezugswertService` in
  derselben Transaktion (`uems-bezugswert-eingeben.md`). `KENNUNG` im Controller und der OpenAPI-Pfad sind `^(K|BK)-…`.
- **Nicht gebaut:** Ablehnen eines Vorschlags, Anlegen von Korrekturen/Ersatzwerten (IP-16 samt Portal),
  Kundenadministratoren-Namen im Ablehnungssatz (API kennt sie nicht, AP-03 IP-2), jede weitere Durchsetzung.

## Prüfen

```bash
python3 docs/contracts/v2/tools/rechte_matrix.py --check
(cd services/api && ./mvnw test -Dtest='RechteAbleitungVectorsTest,RechteKennungenDerRoutenTest,KorrekturRechteTest,KorrekturFreigabeSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='UemsVierAugenFreigabeMigrationTest,KorrekturFreigabeApiTest')   # Testcontainers
(cd frontend/portal && npx vitest run src/rechte.test.ts)
```
