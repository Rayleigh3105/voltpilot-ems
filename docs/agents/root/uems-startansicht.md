# UEMS-Fläche: Startansicht-Weiche E1 und Pfad „Unternehmen › Standort › Anlage“ (AP-01 IP-5)

Nach der Anmeldung landet der Kunde auf der tiefsten Ebene, die alles zeigt (Captain-Entscheid E1 = A
vom 10.09.2026): 1 Standort/1 Anlage → Cockpit · 1 Standort/n Anlagen → Standort-Übersicht ·
n Standorte → Unternehmens-Übersicht; Betreiber, Admins und Kunden ohne Standorte landen wie vorher.
Der Seitenkopf trägt den Pfad, übersprungene Ebenen fehlen darin. Kein Backend, keine Migration:
gelesen über `GET /api/v1/standorte` und `GET /api/v1/unternehmen`
(`uems-standort-lesemodell-unternehmen-st.md`).

| Teil | Datei |
|---|---|
| Weiche (rein): `orteAus` → `startEbene` → `canonicalShellRoute`; Pfad `kopfPfad`, Umschalter-Zeilen `pfadZeile` | `frontend/portal/src/betriebsart.ts` · `startansicht.test.ts` (sechs Landungsfälle, Namen = Zeilen der Sprungregeln-Tabelle) |
| Bestandsschutz | `src/migration.test.ts` „Einzel-Anlagen-Kunde byte-identisch“ — Weiche, Pfad, Flags UND gerenderte Schale gegen die Eingabe ohne Ebene |
| Route `#/standort/{id}` | `nav.ts` (`STANDORT_PAGE`, `standortRoute`, `Route.standortId`); Stück in `pageChunks.ts`/`pageTransition.ts` |
| Standort-Übersicht | `src/pages/StandortUebersichtPage.tsx` (+ `.css`), Kopf `StandortKopf` aus AP-02; seit IP-6 das Portfolio-Cockpit mit Ebene „Standort“ (`uems-unternehmens-uebersicht.md`) |
| Pfad in der Kopfzeile | `src/shell/AppShell.tsx` (`AnlageNav.pfad`, `ortsPfad`), `Shell.css` (`.vp-crumbs-ort`), `Ortspfad.test.tsx` |
| Laden und Verdrahtung | `App.tsx` (`orteLaden` im selben `Promise.all` wie die Anlagen, `ebene`, `navigateSchale`) |
| 375/1440 px + Bilder | `e2e/startansicht.spec.ts` (+ Bühne `startansicht.html/.tsx`); `STARTANSICHT_BILDER=<Ordner>` legt Bilder und `messung-*.json` ab |

## Die Fallen

1. **Ohne Standorte ist ALLES wie vorher.** `startEbene` antwortet `heute` bei `orte == null` (nicht
   geladen, älteres Backend, Fehler), bei 0 Standorten, als Admin, als Betreiber und bei 0 Anlagen;
   dann ist jeder Zweig von `canonicalShellRoute` der alte. Wer die Weiche ändert, fährt
   `migration.test.ts`: der Byte-Vergleich rendert die Schale mit und ohne Pfad.
2. **Die Standorte reisen im SELBEN Schnappschuss wie die Anlagen** (`reload` in `App.tsx`). Kämen sie
   später, ersetzte die Weiche die Adresse zweimal (erst Cockpit, dann Standort-Übersicht). Eine
   Hintergrund-Auffrischung (`opts.background`) lädt sie nicht neu.
3. **Die Standort-Übersicht ist seit IP-6 immer das Portfolio-Cockpit mit Standort-Filter**
   (`ebene: { art: 'standort' }`, `uebersicht.anlagenDerEbene`): jede Summe geht nur über die Anlagen,
   die dem Standort heute zugeordnet sind — auch unter einem Unternehmen und in der Teilansicht. Die
   frühere Liste ohne Kennzahlen (`alleAnlagenHier`) ist entfallen.
4. **Eine Anlage ohne Standort hält die Unternehmensebene offen** (1 Standort, n Anlagen, eine davon
   nicht zugeordnet → `#/portfolio`). **1 Standort und 1 Anlage ist immer das Cockpit**, auch wenn die
   Anlage dem Standort noch nicht zugeordnet ist.
5. **Teilansicht (AP-03) = genau ein sichtbarer Standort bei `unternehmen.standortZahl` > 1** → dessen
   Standort-Übersicht, auch mit nur einer Anlage dort (A6). Heute liefert der Server jedem Benutzer
   alle Standorte; der Fall greift erst, wenn `GET /standorte` den Geltungsbereich filtert.
6. **`#/portfolio` im Standort-Fall** ist die übersprungene Unternehmensebene: die Weiche leitet es auf
   `#/standort/{id}`, Seitenleiste und Reiter „Übersicht“ gehen über `navigateSchale` gleich dorthin
   (kein Doppelsprung). Die Reiter Messwerte · Erlöse · Standorte bleiben erreichbar.
7. **Telefon: in einer Anlage steht der Pfad im Anlagen-Umschalter, nicht in der Kopfzeile**
   (Vorschau IP-5, Variante A). Die ganze Kopfzeile ist dort die Fläche des Umschalters; sichtbare
   Glieder lagen unter ihr (nicht antippbar) und kürzten „Werk Ahrenberg – Halle 1“ von 172 auf
   103 px (Variante B, gemessen). Die Zeilen „Ahrenberg · Unternehmen · Übersicht“ und „Werk Ahrenberg ·
   Standort · Übersicht“ kommen aus `pfadZeile` und ersetzen die Flotten-Zeile nur, wenn der Pfad NEUE
   Glieder hat. Auf den Übersichten (ohne Anlage) bleibt das Glied sichtbar, 44 px hoch (`.vp-crumbs-ort`).
8. **`#/standort` ist nicht `#/standorte`** — die Mehrzahl ist die Alt-Adresse der Technik
   (`LEGACY_ROUTES`); die Liste „Standorte“ wohnt weiter unter `#/portfolio/standorte`.
9. **Nicht hier:** Standort-Umschalter im mittleren Glied, Funktions-Karte der Übersichten (IP-8;
   Standort-Karten und Kopfzeile kamen mit IP-6), Telefon-Leiste je Ebene (IP-7), Messstellen als Grund
   für eine eigene Standort-Ebene (W2).
