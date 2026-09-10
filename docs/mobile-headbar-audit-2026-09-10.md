# Mobile Kopfzeilen – Audit vom 10.09.2026

Gezielter Nachlauf zum [plattformweiten Mobile-Audit](mobile-ui-audit-2026-09.md).
Der bestehende Arbeitsstand wurde als Vorher-Zustand gesichert; vorhandene
Änderungen bleiben erhalten. Die visuelle Review liegt in
`.lavish/headbar-review.html` mit lokalen Browseraufnahmen und Messprotokollen
unter `.lavish/headbar-audit/`.

## Behobene Befunde

| Bereich | Messbarer Befund | Korrektur |
| --- | --- | --- |
| Mobile Anlagen-Kopfzeile | Die innere Namenszeile wuchs durch eine alte `.crumbs { flex: 1 }`-Regel auf 47 px. Die Statuszeile endete direkt am inneren unteren Rand. | Flex-Wachstum auf die direkte Seiten-Brotkrume begrenzen; Name + Status bilden einen zentrierten 44-px-Block. Den zusätzlichen leeren Abstandshalter auf kompakten Breiten entfernen. |
| Lange Anlagen-Namen | Der Text im transparenten Picker-Auslöser erzeugte auf 320 px 81 px Dokumentüberlauf, obwohl der sichtbare Name gekürzt war. | Inhalt des unsichtbaren Auslösers begrenzen. Das portallierte Menü bleibt davon unberührt. Lange Seitenüberschriften dürfen zusätzlich innerhalb ihrer Breite umbrechen. |
| Admin auf dem Telefon | Bei 390 px blieben der Anlage mit Mandantenpicker nur 128 px; der Mandantenpicker stand auf Flottenseiten bei x=168 statt x=16. | Bei offener Anlage eigene zweite Zeile für den Mandanten; sonst links ausrichten und freien Platz nutzen. Anlagenidentität nun 302 px breit. Kosten: 126 statt 68 px Kopfzeilenhöhe ausschließlich bei Admin + Anlage bis 720 px. |
| Tablet / schmales Notebook | Bei 768 px mit Admin und langem Namen schrumpfte der sichtbare Anlagenname auf 0 px; der Umschalter wurde vom Rückweg verdrängt. | Kompakte zweizeilige Identität auch bis 1279 px, ohne zusätzlichen Konto-Text. Name im 768-px-Grenzfall nun 352 px breit. Avatar und Picker bleiben bedienbar; Portfolio bleibt im Anlagenpicker erreichbar. Die 1440-px-Shell-Aufnahme ist unverändert. |
| Edge-Kopfzeile | Betrieb: 106 px, Einrichten: 64 px. Der Technik-Hinweis mit festem `top:52px` verschwand beim Scrollen hinter dem Kopf. | Beide Zeilen in einem gemeinsamen Sticky-Wrapper; Kopf auf beiden Telefonseiten 64 px, kein geratenes Offset. Lange Cloud-Statuswörter können sich verkürzen, ohne die Technikaktion zu verdrängen. |
| Cockpit-Aktionen | Bei langem Aktualitätshinweis brach das Zahnrad allein auf eine neue Zeile links um. | Anpassen und Einstellungen als zusammenhängende Gruppe, beide Aktionen 44 × 44 px. Bei der Integration in den neueren `main` bleibt dessen reservierte Aktualitätszeile darüber erhalten (Bewegung · P7). |

## Prüfumfang

- 28 Portal-Adressen auf dem vorhandenen lokalen `vp-ui-audit`-Demo-Stack:
  19 Kunden-/Anlagen-/Geräte-/Hilfe-Adressen und neun Verwaltungsadressen.
  Die aktuelle Konfiguration und alle Steuerungsaktionen bleiben unberührt;
  der Rundgang erlaubt am API-Transport ausschließlich GET.
- Chromium + WebKit, je 320 / 390 / 768 / 1440 px: 224 Ansichten ohne
  Dokumentüberlauf und ohne unbehandelte Seitenfehler. Breiten werden gegen
  die angeforderte Viewport-Breite geprüft, da mobile Browser `innerWidth`
  bei Überlauf selbst vergrößern können.
- Gemeinsame Shell zusätzlich auf 17 Breiten von 320 bis 1440 px, einschließlich
  beider Seiten der relevanten Breakpoints. Lange Namen, Admin mit / ohne Anlage,
  Warnung / OK / unbekannter Zustand, Scrollen sowie unabhängige Klicks auf
  Anlagenpicker, Status, Mandantenpicker und Avatar.
- Edge: echte isolierte Go-App mit frischem Datenverzeichnis, beide Seiten in
  beiden Browsern bei sieben Breiten, Technikmodus und Scrollzustand;
  Formular-, Fokus-, Picker- und Querformatregressionen ebenfalls erfolgreich.
- Keycloak-Anmeldeseite in beiden Browsern bei vier Breiten, ohne Seitenüberlauf.
  Portal-Registrierung, Geräteformulare, Hilfe und Wallbox-Oberflächen sind im
  vorhandenen Browser-Testlauf enthalten.

Einige Geräte-/Ladeansichten zeigen Leerzustände. Das ist ein Rundgang durch
konkrete Zustände, keine Vollabdeckung aller Konfigurationen. Physische iPhones,
Notch/Statusleiste, Bildschirmtastatur und vergrößerte Systemschrift wurden nicht
neu getestet. Die kompakte Status-Unterzeile hat rund 31 px Trefferhöhe; der
Anlagenwechsler, Avatar, Mandantenpicker und die Cockpit-Aktionen sind größer.

## Integration in den aktuellen main

Die Audit-Korrekturen wurden gezielt auf `b315d22d` übertragen. Neuere Arbeiten am
Cockpit, an Animationen und am Hilfe-Center bleiben erhalten. Insbesondere bleibt
der unsichtbare Platzhalter der mobilen Aktualitätszeile erhalten, damit das Laden
der Übersicht keinen erneuten Layoutsprung auslöst. Die Aktionsgruppe steht rechts
unter dieser Zeile; die ursprüngliche lokale Review zeigt noch die Fassung davor.

Die schwebende Cockpit-Kurzfassung verwendet jetzt die gemessene Kopfzeilenhöhe
(`--vp-topbar-height`, `ResizeObserver`), damit sie bei der zweiten Admin-Zeile
nicht hinter dem Header verschwindet. Die Browserprüfung kontrolliert den Abstand
beim Scrollen und beim Wechsel der Bildschirmbreite.

## Reproduktion

```sh
cd frontend/portal
npm run test:e2e
npm run build
npm test -- src/pages/AnlagenPage.test.tsx src/shell/AppShell.test.tsx src/migration.test.ts src/nav.test.ts src/anlageNav.test.ts src/fieldBorder.test.ts

# Ab Repository-Wurzel:
node edge-app/test/ui-mobile.mjs
cd edge-app/core
go test ./internal/web
```

Die Browserregressionen liegen in `e2e/shell-layout.spec.ts`; ihr Harness verwendet
die echte gemeinsame Shell mit festgelegten Beispieldaten. Validiert: 100 Portal-Browsertests, danach 28 gezielte Tests über die finalen
17 Breiten; 266 relevante Unit-/Komponententests über die oben genannten sechs
Dateien, Portal-Build und Go-Webtests erfolgreich. Der Build behält seine
bereits bekannte Warnung zur Größe des Hauptbundles. Die ursprüngliche Prüfung bezog sich auf den lokalen Audit-Stand.

Auf dem integrierten `main` erneut erfolgreich: 28 Shell-/Cockpit-Browsertests in
vier Browser-/Gerätekonfigurationen, 221 Tests in `AnlagenPage`, `AppShell`,
`migration`, `motionTokens` und `agentsMdBudget`, Produktions-Build, beide
Edge-Browser und Go-Webtests. Der Build meldet weiterhin große Chunks.
Die no-mistakes-Pipeline wurde auf ausdrücklichen Wunsch nicht ausgeführt.
Eine Produktions-Abnahme ist nicht Teil dieser lokalen Prüfung.
