# UEMS-Fläche: Standort-Dialog und die Liste „Unternehmen › Standorte“ (AP-02 IP-6)

Die erste Portal-Fläche der Ortsstruktur: der Kunde sieht seine Standorte mit Kurzzeichen, Adresse,
Gebäuden, Anlagen und Fläche (Mockup T1), legt einen an und bearbeitet oder vervollständigt ihn im
selben Dialog (T2). Kein Backend, keine Migration: gelesen und geschrieben über die Routen aus
IP-3/IP-4 (`uems-standort-lesemodell-unternehmen-st.md`, `uems-standort-schreibrouten-kurzzeichen-archiv.md`).

| Teil | Datei |
|---|---|
| Ableitung (rein): Fassung, Vorbelegung, Prüfung, Anfrage, Listenzeile | `frontend/portal/src/standorte.ts` · `standorte.test.ts` |
| Dialog (anlegen · bearbeiten · vervollständigen) | `src/components/StandortDialog.tsx` (+ `.css`, `.test.tsx`) |
| Standort-Kopf (Name, Kurzzeichen, Zeile, „Bearbeiten“ / „Adresse nachtragen“) | `src/components/StandortKopf.tsx` (+ `.css`) |
| Liste mit „Archiviert“ und „Noch nicht zugeordnet“ | `src/pages/StandortePage.tsx` (+ `.css`, `.test.tsx`) |
| Wirt heute | Reiter „Standorte“ der Übersicht, `#/portfolio/standorte` (`PORTFOLIO_WELT_PAGES` in `nav.ts`, `PortfolioTabs`) |
| Daten | `api.standorte`, `api.unternehmen`, `api.standortKurzzeichenVorschlag`, `api.standortAnlegen`, `api.standortBearbeiten` |
| 375/1440 px + Bilder | `e2e/standorte.spec.ts` (+ Bühne `standorte.html/.tsx`, Antworten `src/test/standorteFixtures.ts`); `STANDORTE_BILDER=<Ordner>` legt Bilder und `messung-*.json` ab |

## Die Fallen

1. **Die Bezugsfläche eines STANDORTS hat keine Schreibroute.** `PUT /api/v1/orte/{id}/flaeche`
   nimmt nur Gebäude und Bereiche, `StandortDto.Stammdaten` kennt keine Fläche. Der Dialog zeigt sie
   darum nur lesend („8 450 m²“, „2 600 m² · aus Gebäuden summiert“); die Eingabe mit „gültig ab“
   über `VpDatePicker` kommt mit der Route — nie ein Feld, das nichts speichern kann.
2. **PUT ist die ganze Menge.** Die Lage auf der Karte zeigt der Dialog nicht; `anfrage()` trägt
   sie beim Bearbeiten unverändert mit, sonst wäre sie danach leer. POST sendet kein Kurzzeichen
   (der Server vergibt ST-n, der Vorspann nennt es aus `kurzzeichen-vorschlag`).
3. **Sätze sind die des Servers, Zeichen für Zeichen** (`OrtFelder`, `StandortService`); die
   Namensregel wird AUFGERUFEN (`nameBelegt`/`nameBelegtSatz` aus `uemsOrtsbaum.ts`), nie
   nachgebaut. Eine Ablehnung trägt ihren Körper jetzt in `ApiError.body` (additiv) — `feld`
   entscheidet, an welchem Eintrag der Satz steht, sonst steht er über dem Fuß.
4. **Der Adress-Satz steht EINMAL**, am ersten fehlenden Adressfeld; die übrigen sind nur rot
   markiert (`sichtbareFehler`). Dreimal derselbe Satz machte das Formular bei 375 px 84 px länger
   (Vorschau IP-6, Variante B).
5. **PLZ ist optional** (wie im Backend; das Referenzunternehmen führt `plz: null`) — T2 zeigt ein
   Sternchen, das der gebaute Schreibweg nicht kennt. Ist sie da, prüft das Formular die Stellen je Land.
6. **`#/standorte` ist belegt** (Alt-Adresse der Technik in `LEGACY_ROUTES`). Die Liste wohnt unter
   `#/portfolio/standorte`, bis die Ebenen-Navigation aus AP-01 IP-5/IP-7 steht; Einzel-Anlagen-Kunden
   erreichen die Portfolio-Ebene nicht (`canonicalShellRoute`) — ihr Weg ist IP-8 („Meine Anlage“).
7. **Vier Reiter am Telefon:** mit 12 px Polster 347 px, bei 375 px stehen 343 px zur Verfügung.
   Nur die Leiste mit VIER Reitern bekommt 8 px (`vp-bereich-tabs-dicht`, 315 px); jede Leiste mit
   bis zu drei bleibt, wie sie war. Die Zeitzone „vom Unternehmen“ steht UNTER dem Feld, im Auslöser
   würde „Europe/Berlin (vom Unternehmen)“ bei 375 px abgeschnitten.
8. **Nicht hier:** „Stand am …“ (IP-13), Archivieren/Wiederherstellen (IP-15), Anlage zuordnen
   (IP-11), Datenlage je Standort („14 von 14 Messstellen liefern“), Ortsbaum (IP-7).
