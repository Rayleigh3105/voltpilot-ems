# Messen: Kostenstellen, Prozesse und Bezugsgrößen

Stand: Messen-Bau m3, PR3 (Konzept `data/vp-messen-konzept-m1` §6.6-§6.8, Captain-Freigabe 05.10.2026).

## Kostenstellen (`#/portfolio/messstellen?reiter=kostenstellen`)

- Die reine Ableitung steht in `src/kostenstellenUebersicht.ts` (`kostenstellenBild`), gerendert in `pages/KostenstellenSection.tsx` mit den Bausteinen der Messstellen-Liste (`MessstellenPage.css`: `.vp-ms-ort`, `.vp-ms-reihe`).
- Jeder Reiter trägt seinen eigenen Kopf (Titel = Reiter, Satz, Aufklapper „Was ist …?“); die Zeitwahl kennt nur Monat · Jahr, ein `periode=tag` der Adresse zeigt seinen Monat.
- Es gibt keine Summe über Kostenstellen und keinen Satz darüber; das Warum steht im Aufklapper (`KOSTENSTELLEN_MEHR`). `copy.test.ts` hält „nicht summierbar“ von diesen Flächen fern.
- Ein Posten nennt seine Herkunft („ganz“, „30 % von 88.200 kWh“); die Menge hinter „von“ kommt aus der Werte-Route der Messstelle, nie aus Anteil × Posten.
- „Ohne Kostenstelle“ ist die Differenz Register minus alle Posten aller Kostenstellen des Zeitraums (eine Aussage über die Zuordnung, keine Menge) und steht erst, wenn jede Kostenstelle geantwortet hat. Der Block `nicht_verteilt` der Route nennt nur Messstellen MIT Wert und reicht dafür nicht.
- Ablesezähler: solange die Kostenstellen-Sicht je Tag verteilt, haben ihre Posten `menge: null` mit Tagesgrund `kein_tageswert`; dann steht EIN ruhiger Satz (`ABLESUNG_OHNE_TAGESWERT`). Verteilt die Route Ablesezeiträume (Konzept Entscheid 3, Auftrag `vp-messen-api-m4`), tragen die Posten Mengen und der Satz verschwindet ohne Portal-Änderung; ein neuer Grund für „Anteil wechselt im Ablesezeitraum“ braucht nur einen eigenen Satz.

## Prozesse (`#/portfolio/messstellen?reiter=prozesse`)

- Je Prozess liest die Fläche `GET /unternehmen/prozesse/{id}/messstellen?am=` (am = erster Tag des Zeitraums) und je gezeigter Messstelle die Werte-Route mit EINEM Schritt über den Zeitraum.
- Eine berechnete Messstelle des Prozesses (Prozess-Summe) hat Vorrang vor den gemessenen; mehrere gemessene ohne Summe stehen einzeln und werden nie addiert.
- Ohne Messstelle führt „Messstelle zuordnen“ in die Liste der Messstellen; zugeordnet wird an der Messstelle (Karte „Zuordnung“).

## Bezugsgrößen (`#/portfolio/bezugsgroessen`, Seite `#/portfolio/bezugsgroessen/{id}`)

- Liste und Seite leiten in `src/bezugsgroessenUebersicht.ts` ab; geladen wird über `src/bezugsStand.ts` (Liste, Orte, Rechte, heute).
- `bezugsgroesseListe.ts` bleibt arithmetikfrei (Wächter `rechenstellen` im Test); die neue Ableitung rechnet nur mit Kalendern und Reihenfolgen, nie an einem Betrag - auch das hält ein Test fest.
- Beträge sind Dezimaltexte des Servers und werden nur mit Tausenderpunkt gezeigt (`zahlDe`), nie über `Number` geführt.
- Fällig ist die letzte abgeschlossene Periode, aber nur für Bezugsgrößen, die vor ihrem Ende angelegt waren.
- Eine Bezugsfläche mit `schreibbar: false` kommt aus dem Gebäude: kein „Wert eintragen“, sondern der Weg zum Gebäude.
- Die Seite ist eine Detailseite (`istDetailseite`): kein Reiter, Rückweg „‹ Alle Bezugsgrößen“; die E2E-Bühne `startansicht.tsx` folgt dafür Hash-Wechseln auf `portfolio-bezugsgroessen`.

## Prüfen

- Abnahme gegen die laufende Demo ohne Keycloak-Änderung: im Test-Browser `http://localhost:5173/**` auf die eigene Vorschau umleiten (nur `/api/` geht an die Demo) und die CSP des Demo-Portals mitgeben. Chromium blockiert dabei Keycloak im Rahmen (Local Network Access), solange das Dokument aus einer umgeleiteten Antwort kommt: mit `--disable-features=LocalNetworkAccessChecks` starten.
- Playwright der Portal-Specs nie auf dem festen Port 4174 neben anderen Worktrees: eigene Konfiguration mit freiem Port.
