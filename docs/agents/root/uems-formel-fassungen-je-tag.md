# UEMS-Formel-Fassungen je Tag (AP-10 IP-3) — PR #688 nachziehen, Teil 1 von 4

Die Formel einer berechneten Messstelle ist seit 12.09.2026 **tagesgenau zeitgültig** (Entscheid
E5 = A): was gestern galt, darf etwas anderes sein als heute, und die Auswertung eines alten Tages
sieht die alte Formel. Der Gesamtwert aus PR #688 (gewichtete Summe) und seine Portal-Fläche aus
PR #689 wurden **übernommen und nachgezogen, nicht abgelöst** (E7 = A). Vertrag:
`docs/contracts/v2/messstelle-formel.md` §6 und §6.1.

| Was | Wo |
|---|---|
| Migration | `V20260912210000__uems_messstelle_formel_fassung.sql` |
| Regel (rein) | `uems/MessstelleFormelRegeln` — `fassungEintrag`, `fassungAm`, `hauptgroesseAbweichung`, `FassungFehler` |
| Lesen/Schreiben | `uems/MessstelleFormelFassungRepository`, `MessstelleFormelTermRepository.derFassung`/`stand(id, tag)` |
| Dienst + Routen | `MessstelleFormelService.formel(id, am)`/`fassungEintragen`; `GET …/messstellen/{id}/formel?am=`, `POST …/{id}/formel/fassungen` |
| Tests | `MessstelleFormelFassungRegelnTest`, `MessstelleFormelSchnittstelleVertragTest` (rein) · `MessstelleFormelFassungMigrationTest`, `MessstelleFormelFassungApiTest` (Docker) |

## Die Tagesfassung

- Tabelle `messstelle_formel_fassung`: `nummer`, `formel_typ` (heute nur `gewichtete_summe` — `rest`
  und `saldo` weitet IP-4 im CHECK), `gueltig_ab`/`gueltig_bis` als TAGE mit inklusivem letztem Tag
  (Muster A wie Ort/Stellung/Fläche, NICHT halboffen auf die Minute), `aufgehoben_am`, `herkunft`
  (`bestand` · `anlage` · `eintrag`), `rueckwirkend`, Urheber. Jeder Term trägt `fassung_id`
  (NOT NULL, Fremdschlüssel über Fassung + Messstelle + Mandant).
- Regel: eine neue Fassung beginnt NACH dem Beginn der jüngsten (sonst 422
  `formel_fassung_ueberlappt` „Ab diesem Tag gilt schon Fassung 2.“), beendet die laufende am
  VORTAG, trägt `rueckwirkend` + `abzeichen` („rückwirkend (5 Tage)“). Fassungen reihen sich nur
  hinten an — die Nummer bleibt die Reihenfolge der Tage.
- Die Berechnung liest die Fassung DES TAGES: Live-Wert = heute, Verlauf = Tag, an dem der Bucket
  beginnt (Zeitzone des Standorts), Baustein = Fassung SEINER Messstelle am selben Tag.

## Fallen

1. ⚠ **Fassung 1 hat keinen ersten Tag** (`gueltig_ab` = `null` = „gilt seit Beginn“), für den
   Bestand UND für `POST …/berechnet`. Die Terme von PR #688 waren zeitlos; der Verlauf über 7/30 Tage
   zeigte auch Tage vor dem Anlegen. Mit „erster Tag = Anlagetag“ wären diese Tage nach der
   Migration leer gewesen (und `MessstelleFormelApiTest` um Mitternacht rot). Wer Fassungen liest,
   rechnet mit `null` am Anfang — `MessstelleFormelRegeln.Fassung.deckt` tut es.
2. ⚠ **Ohne `am` ist `GET …/formel` Zeichen für Zeichen die Antwort von vor IP-3** — der Block
   `fassung_am` steht NUR mit `am` im Körper (`@JsonInclude(NON_NULL)` an genau dieser Komponente).
   `gesamtwertQuelle.ts` ruft ohne Tag und liest weiter dieselben Felder. Neue Felder gehören in
   `fassung_am`, nie daneben.
3. ⚠ **`formel_fassung_ueberlappt` steht nicht in `MessstelleFormelRegeln.Fehler`** — diese Tabelle
   pinnt `messstelle-formel-vectors.json` Zeile für Zeile, und die Vektor-Datei bleibt mit AP-10
   unberührt. Der Code lebt in `FassungFehler` (Vertrag: `bilanz-vectors.json` `fehler_neu`).
4. **snake_case an jedem neuen Feld** (`gueltig_ab`, `fassung_am`, `formel_typ` …): das Portal wandelt
   nichts um. Die Fassungs-Route liest STRENG — `gueltigAb` ist 400, nicht still leer.
   `MessstelleFormelSchnittstelleVertragTest` hält DTO, `openapi.yaml` und `api.ts` gleich.
5. **Terme sind Historie ihrer Fassung:** die App-Rolle hat auf `messstelle_formel_term` kein
   UPDATE/DELETE mehr; eine Änderung ist eine neue Fassung. Ein Schreiber OHNE `fassung_id` (altes
   Deployment, Tests) landet per Trigger `messstelle_formel_term_zu_fassung` in der EINZIGEN Fassung
   (oder erzeugt Fassung 1 ohne ersten Tag); bei mehreren Fassungen lehnt die Datenbank ab
   (`messstelle_formel_term_fassung_noetig`).
6. **Nummern werden nie wiederverwendet** (Unique je Messstelle zählt auch aufgehobene Fassungen):
   die neue Nummer ist `max(Regel, hoechsteNummer + 1)`. Alle Fassungs-Schreibvorgänge eines
   Kundenbereichs laufen nacheinander (Advisory-Lock auf den Mandanten) — sonst bestünden A→B und B→A
   gleichzeitig die Kreis-Prüfung. Die Kreis-Prüfung zählt nur Fassungen, die am ersten Tag der neuen
   oder danach gelten (vorsichtig: zwei Kanten an verschiedenen Tagen ab dort zählen zusammen).
7. ⚠ **Befund, nicht gelöst:** `messstelle_formel_term → measurement_point` ist seit PR #688
   `ON DELETE CASCADE`. Wird eine Komponente gelöscht, verschwinden auch die Terme BEENDETER
   Fassungen — der Verlauf dieser alten Tage rechnete dann ohne den Term weiter. Die Kaskade läuft als
   Eigner (das fehlende DELETE-Recht der App hält sie nicht auf). Umstellen auf RESTRICT berührt das
   Löschen/Entkoppeln von Komponenten und gehört in ein eigenes Paket.
8. **Offboarding** räumt `messstelle_formel_term` und `messstelle_formel_fassung` vor den Messstellen
   ab — die Term-Tabelle aus PR #688 fehlte dort bis IP-3 (ein Kundenbereich mit Gesamtwert ließ sich
   nicht offboarden).

## Rechte (E15) — Matrix-Nachtrag, keine Durchsetzung

Neue Zeile `messstelle.formel` (Nachtrag „AP-10 §4.10“, `wie: messstelle.bearbeiten`, zwei
`darf`-Fälle in `rechte-vectors.json`). `POST …/berechnet` und `POST …/formel/fassungen` nennen sie
im Routen-Kommentar (davor `messstelle.bearbeiten`); die Lese-Routen bleiben `messstelle.ansehen`
(Formel) und `messwerte.ansehen` (Wert, Verlauf). Durchgesetzt wird weiter nichts (AP-03): es gilt
`authenticated()` + RLS, fremd ist 404. Die übrigen E15-Kennungen (`messstelle.verteilung`,
`kostenstelle.verwalten`, `prozess.verwalten`, `netzanschluss.verwalten`) stehen unter `regeln` des
Nachtrags und entstehen mit IP-8/IP-7/IP-6.

## Nicht dieses Paket

Formel-Typen `rest`/`saldo` (IP-4), Term-Art `verteilung` + `anteil` (IP-5), Verlauf aus
Messstellen-Perioden (IP-10), Aufheben einer Fassung als Route, Portal-Fläche „Formel ändern ab Tag“
(IP-16), Ereignis `formel_fassung_geaendert` in `messreihe_ereignis`, eine Vektor-Familie `fassung`
(die Regel prüft heute nur Java).

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleFormelFassungRegelnTest,MessstelleFormelSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='MessstelleFormelFassungMigrationTest,MessstelleFormelFassungApiTest,MessstelleFormelApiTest')
```
