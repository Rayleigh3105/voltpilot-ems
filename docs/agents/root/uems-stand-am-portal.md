# UEMS-Fläche: „Stand am …“ auf der Liste „Standorte“ und im Ortsbaum (AP-02 IP-13)

Die Sicht aus §4.4 und Mockup H1: ein Datumsfeld „Stand am“ (Vorgabe heute) über der Liste
„Standorte“; ist ein anderer Tag gewählt, zeigt ein Banner „Sie sehen den Stand am 15.02.2027 —
Änderungen sind hier nicht möglich. Zurück zu heute“, die Karten und die Ortsbäume in ihnen zeigen
den Stand dieses Tages, und kein Schreibweg ist angeboten. Kein Backend, keine Migration: gelesen
über `GET /api/v1/standorte?stichtag=` (IP-3) und `GET …/standorte/{id}/orte?stichtag=` (IP-5).

| Teil | Datei |
|---|---|
| Ableitung (rein): Banner-Satz, „heute ist kein Stichtag“, Liste am Stichtag | `frontend/portal/src/standAm.ts` · `standAm.test.ts` |
| Banner + Datumsfeld | `src/components/StandAm.tsx` (+ `.css`) |
| Wirt | `StandortePage` (EIN Feld für die Seite); `Ortsbaum` nimmt `stichtag` |
| A12 (drei Stichtage, gegen die Vektoren `stand_am`) + „kein Schreibweg“ | `src/pages/StandortePageStandAm.test.tsx`, Antworten `src/test/standAmFixtures.ts` |
| 375/1440 px + Bilder | `e2e/stand-am.spec.ts` (Bühne `standorte.html`); `STAND_AM_BILDER=<Ordner>` |

## Die Fallen

1. **EIN Datumsfeld je Seite.** Die Ortsbäume in den Karten folgen dem Stichtag der Seite; ein Feld
   je Baum machte die Seite bei 375 px um 385 px länger (zwei Karten) und erlaubte zwei Tage auf
   einem Bildschirm (Vorschau IP-13, Variante „Feld je Baum“). Die Standort-Übersicht aus AP-01 trägt
   später `StandAm` + `<Ortsbaum stichtag>` genauso.
2. **Heute ist kein Stichtag.** Wählt man im Feld den heutigen Tag (nach dem SERVER, `stichtag` der
   Antwort ohne Parameter), fragt die Seite ohne `?stichtag=` und die Schreibwege sind zurück.
   Ein Tag in der Zukunft IST ein Stichtag (ein eingetragener Umzug ist dann zu sehen).
3. **Mit Stichtag kein Schreibweg**: kein „Standort anlegen“, kein „Bearbeiten“/„Adresse nachtragen“,
   kein Anlegen im Baum, kein Stift, kein „Fläche eintragen“, kein L1-Knopf. Der Test zählt die Knöpfe:
   der einzige ist „Zurück zu heute“ (ein Verweis im Satz wie in H1 — als Knopf in eigener Zeile war
   das Banner bei 375 px 120 statt 89 px hoch). Der Fokus geht danach an das Datumsfeld.
4. **„Gab es noch nicht“ wird benannt, nicht weggelassen**: `nichtGezeigt` mit `gab_es_noch_nicht`
   steht als stille Karte mit dem Satz des SERVERS (`bestandText`, sonst `bestandSatz` des Zwillings)
   an seinem Kurzzeichen-Platz — eine Karte springt nicht, wenn der Tag wechselt. Archivierte stehen
   in „Archiviert“ mit dem Satz des Stichtags. Gebäude und Bereiche, die es noch nicht gab, FEHLEN im
   Baum (§4.4): `GET …/orte` nennt sie nicht, und nachgerechnet wird im Portal nichts.
5. **„Noch nicht zugeordnet“ nur heute.** Das Lesemodell nennt dort am Stichtag jede Anlage, die es
   HEUTE gibt, ohne zu fragen, ob es sie damals schon gab — und die Gruppe ist eine Arbeitsliste.
6. **Jede Antwort gilt nur für ihren Tag**: Liste und Baum merken sich eine Anfrage-Nummer bzw. den
   Tag ihrer Antwort; bis die neue da ist, steht „… werden geladen“, nie der Stand des vorigen Tages.
7. **Nicht hier:** der Stichtag in der Adresse (ein Neuladen zeigt heute), das Änderungsprotokoll (H2),
   „seit 01.01.2027“ an der Fläche (die Antwort trägt kein „gilt ab“ der Fläche), das Recht
   `aenderungsprotokoll.lesen` (AP-03).

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/standAm.test.ts src/pages/StandortePageStandAm.test.tsx src/pages/StandortePage.test.tsx src/components/Ortsbaum.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/stand-am.spec.ts --project=desktop-chromium)
```
