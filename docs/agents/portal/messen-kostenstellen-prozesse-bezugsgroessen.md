# Messen: Kostenstellen, Prozesse und Bezugsgrößen

Stand: Messen-Bau m3, PR3 (Konzept `data/vp-messen-konzept-m1` §6.6-§6.8, Captain-Freigabe 05.10.2026).

## Kostenstellen (`#/portfolio/messstellen?reiter=kostenstellen`)

- Die reine Ableitung steht in `src/kostenstellenUebersicht.ts` (`kostenstellenBild`), gerendert in `pages/KostenstellenSection.tsx` mit den Bausteinen der Messstellen-Liste (`MessstellenPage.css`: `.vp-ms-ort`, `.vp-ms-reihe`).
- Jeder Reiter trägt seinen eigenen Kopf (Titel = Reiter, Satz, Aufklapper „Was ist …?“); die Zeitwahl kennt nur Monat · Jahr, ein `periode=tag` der Adresse zeigt seinen Monat.
- Es gibt keine Summe über Kostenstellen und keinen Satz darüber; das Warum steht im Aufklapper (`KOSTENSTELLEN_MEHR`). `copy.test.ts` hält „nicht summierbar“ von diesen Flächen fern.
- Ein Posten nennt seine Herkunft („ganz“, „30 % von 88.200 kWh“); die Menge hinter „von“ kommt aus der Werte-Route der Messstelle, nie aus Anteil × Posten.
  „von …“ steht nur, wenn EIN Anteil den ganzen Zeitraum trägt (`traegtGanz`); sonst die Spanne („70 % · ab 15.10.2026“, bei Ablesungen in Monaten „ab Jul 2026“) - und dann wird die Werte-Route dafür nicht gefragt (Prüfung r4 S18).
- Dieselbe Messstelle kann in zwei Herkünften derselben Karte stehen (bis 14.10. ganz, ab 15.10. 70 %): der React-Key ist `PostenBild.schluessel` (`Herkunft:ID`), nie die ID allein.
- „Ohne Kostenstelle“ ist die Differenz Register minus alle Posten aller Kostenstellen des Zeitraums (eine Aussage über die Zuordnung, keine Menge) und steht erst, wenn jede Kostenstelle geantwortet hat. Der Block `nicht_verteilt` der Route nennt nur Messstellen MIT Wert und reicht dafür nicht.
- Ablesezähler (Verteilung 1.5, Messen PR4): über Monat und Jahr trägt ein Posten aus Ablesungen `monate[]` statt `tage[]` - der Anteil steht am Monat, „von 88.200 kWh“ ist bei einem Monat `monate[0].quelle_menge` (keine Werte-Abfrage), über ein Jahr die Werte-Route. `anteil_wechselt_im_ablesezeitraum` wird zu „Anteil am {Tag} geändert · für diesen Ablesezeitraum keine Menge“, `keine_ablesung` zu „für {Monat} noch keine Ablesung“; die Codes und „Verteilung geändert am …“ stehen dann nicht noch einmal.
  Wechselt der Anteil nur in EINEM Monat eines Jahres, bleiben Anteil und Spanne stehen und der Satz gilt nur dem Monat („… · Anteil am 15.11.2026 geändert · für Nov 2026 keine Menge“, Prüfung r4 S19).
- Liefert eine ältere API nur Tage mit `kein_tageswert` für einen Ablesezähler, steht EIN ruhiger Satz (`ABLESUNG_OHNE_TAGESWERT`); mit Monaten verschwindet er von selbst.
- Messen PR5: die Reiter lesen das Register mit `letzterMonat: true`; im letzten vollständigen Monat ist `letzter_monat.wert` der Wert einer Reihe („Ohne Kostenstelle“, Prozesse), sonst fragt die Fläche die Werte-Route.

## Prozesse (`#/portfolio/messstellen?reiter=prozesse`)

- Je Prozess liest die Fläche `GET /unternehmen/prozesse/{id}/messstellen?am=` und je gezeigter Messstelle die Werte-Route mit EINEM Schritt über den Zeitraum.
  `am` ist der letzte Tag von Zeitraum ∩ Gültigkeit des Prozesses, nicht nach heute (`zuordnungsTag`): am ersten Tag sähe ein Prozess, der im Zeitraum beginnt, keine Messstelle (Prüfung r4 S20). Eine Zuordnung, die im Zeitraum ENDET, zeigt die Route so nicht mehr - sie kennt einen Tag, keinen Zeitraum.
- Eine berechnete Messstelle des Prozesses (Prozess-Summe) hat Vorrang vor den gemessenen; mehrere gemessene ohne Summe stehen einzeln und werden nie addiert.
- Ohne Messstelle führt „Messstelle zuordnen“ in die Liste der Messstellen; zugeordnet wird an der Messstelle (Karte „Zuordnung“).

## Bezugsgrößen (`#/portfolio/bezugsgroessen`, Seite `#/portfolio/bezugsgroessen/{id}`)

- Liste und Seite leiten in `src/bezugsgroessenUebersicht.ts` ab; geladen wird über `src/bezugsStand.ts` (Liste, Orte, Rechte, heute).
- `bezugsgroesseListe.ts` bleibt arithmetikfrei (Wächter `rechenstellen` im Test); die neue Ableitung rechnet nur mit Kalendern und Reihenfolgen, nie an einem Betrag - auch das hält ein Test fest.
- Beträge sind Dezimaltexte des Servers und werden nur mit Tausenderpunkt gezeigt (`zahlDe`), nie über `Number` geführt.
- Fällig ist die letzte abgeschlossene Periode, aber nur für Bezugsgrößen, die vor ihrem Ende angelegt waren.
- Unbekannt ist nie „eingetragen“ (Prüfung r4 M3): solange die Werte (bzw. das Stammdatum) einer Reihe unterwegs sind, zeigt sie ein Skelett (`abruf: 'unterwegs'`, `aria-busy`), bei einem Fehler „gerade nicht abrufbar“ - nie „noch kein Wert“, nie „Eintragen“. Die Statuszeile (`bzStatus`) schweigt, solange eine fällige Reihe nicht `da` ist; ein Fehler steht als „Einige Werte sind gerade nicht abrufbar.“ mit „Erneut versuchen“. E2E-Bühne: `&bezugs=werteunterwegs` / `&bezugs=wertefehler`.
- Die Flächen des Gebäudeplans sind KEINE Bezugsgrößen (eigene Liste `bezugsflaechen`, die Kacheln, `schreibbar` dort immer `false`). Ein Stammdatum einer Bezugsgröße ist immer „eigene Angabe“; sein `schreibbar` ist nur `false`, sobald sie archiviert ist (OpenAPI) - nie „aus dem Gebäudeplan“ (Prüfung r4 S21).
  Unter „Flächen“ stehen neben den Kacheln nur Bezugsgrößen der Art `bezugsflaeche` (`bzEigeneFlaechen`); Mitarbeitende, Zählerstände usw. in „Weitere Bezugsgrößen“ (`bzWeitere`); der Dialog spricht aus Art und Einheit („Mitarbeitende (Personen)“, `stammWort`).
- „Alle N“ auf der Seite zählt, was die Liste zeigt - auch zurückgenommene Werte (Prüfung r4 S22, Bühne `&bezugs=zurueckgenommen`).
- Die Seite ist eine Detailseite (`istDetailseite`): kein Reiter, Rückweg „‹ Alle Bezugsgrößen“; die E2E-Bühne `startansicht.tsx` folgt dafür Hash-Wechseln auf `portfolio-bezugsgroessen`.

## Prüfen

- Abnahme gegen die laufende Demo ohne Keycloak-Änderung: im Test-Browser `http://localhost:5173/**` auf die eigene Vorschau umleiten (nur `/api/` geht an die Demo) und die CSP des Demo-Portals mitgeben. Chromium blockiert dabei Keycloak im Rahmen (Local Network Access), solange das Dokument aus einer umgeleiteten Antwort kommt: mit `--disable-features=LocalNetworkAccessChecks` starten.
- Playwright der Portal-Specs nie auf dem festen Port 4174 neben anderen Worktrees: eigene Konfiguration mit freiem Port.
