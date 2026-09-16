# UEMS-Unterstützung: gewähren, verlängern, beenden, Anfrage und Notfall-Zugriff (AP-03 IP-8)

Neu angelegt am 16.09.2026. Spezifikation: AP-03 §4.6 (Unterstützungszugriff), §4.7 (Entzug), §4.8, E6–E9,
A4/A5/A14, §8 IP-8. Code: `unterstuetzung/` (`UnterstuetzungService`, `UnterstuetzungRepository`,
`UnterstuetzungAbgelehnt`, `AblaufLaeufer`, `UnterstuetzungSchedulingConfig`),
`web/UnterstuetzungController`, `web/AdminUnterstuetzungController`, `web/dto/UnterstuetzungDto`,
Migration `V20260916070000`. Beweis: `UnterstuetzungApiTest` (A4, A5, A14), `UnterstuetzungWiringTest`,
`UnterstuetzungSchnittstelleVertragTest`.

## Was gilt

- **Eine Unterstützung IST eine Zuweisung, nichts daneben.** Sie entsteht als eine Zeile `zugriff` je Standort
  (Rolle `unterstuetzer`, Art, Umfang, Ende) — dieselbe Tabelle aus IP-2. Wer hineindarf, entscheidet allein
  `zugriff_zeitraum(gueltig_ab, endet_am, beendet_am) @> jetzt`, gefragt bei JEDER Anfrage (IP-4). Die beiden
  neuen Tabellen sind Wunsch und Postfach, nie Erlaubnis.
- **Ihr GRIFF ist die kleinste `zugriff.id` der Gewährung** — der Zeilen, die Person, Art, Umfang und Zeit
  teilen (dieselbe Gruppierung, mit der die Selbstauskunft ihre Banner baut). Es gibt KEINE eigene Tabelle und
  KEIN eigenes Kennzeichen für die Gewährung; weil eine Zeile nie umgeschrieben wird, bleibt der Griff stabil,
  auch nachdem sie endete.
- **Sie endet von selbst.** Der Ablauf braucht keinen Läufer: die Zeile ist mit ihrem `endet_am` unwirksam.
  `AblaufLaeufer` (minütlich, `voltpilot.uems.unterstuetzung.enabled`, im Testlauf AUS, in Produktion AN) trägt
  nur NACH, was die Uhr getan hat: Protokollwort `ablaufen` („Endete am … durch Zeitablauf“) und ein Hinweis —
  und er erinnert 7 Tage vorher (E6). **Ein ausgefallener Läufer ist ein fehlender Protokolleintrag, nie ein
  offener Zugang.**
- **Der Notfall-Zugriff ist eng und laut** (E8): `POST /api/v1/admin/tenants/{t}/unterstuetzung/notfall` —
  genau 24 h (`gueltig_bis` gibt es dort nicht, nur `endet_am`), **Grund Pflicht** (ohne ihn 422 `grund_fehlt`,
  und es wird NICHTS angelegt), Banner bei allen Benutzern, ein Hinweis an jeden Kundenadministrator. Beenden
  kann ihn der Kundenadministrator wie jede Unterstützung; verlängert wird er nie (409).
- **VoltPilot gewährt sich nichts selbst.** `…/unterstuetzung/anfrage` legt einen Wunsch an (Zustand
  ABGELEITET: ohne Entscheidung `offen`, mit Zugriff `bestaetigt`, ohne `abgelehnt`) plus Hinweise. Erst
  `POST /api/v1/unterstuetzung` mit `anfrage_id` durch den Kundenadministrator macht daraus einen Zugang — mit
  geändertem Umfang oder anderer Dauer, wie §4.6 es erlaubt. Ohne `anfrage_id` gibt es keine
  VoltPilot-Unterstützung (400 `anfrage_id`).
- **Verlängern ist ein NEUES Enddatum** (AP-00 Invariante 4): die laufende Gewährung wird jetzt beendet, eine
  neue beginnt lückenlos — die Route antwortet darum einen neuen Griff. Im Protokoll steht `verlaengern`, nicht
  `entziehen`.
- **Der Hinweis ist der Weg ohne SMTP.** `unterstuetzung_hinweis` ist der Ausgang: je Anlass und Empfänger EINE
  Zeile (zwei Teil-Indizes halten das, damit ein zweiter Takt nicht doppelt meldet). `email_versandt_am` bleibt
  NULL, solange kein SMTP steht (`vp-login-smtp-reset-d6`); steht es, versendet der Sender dieselben Zeilen und
  trägt es nach. Gelesen wird nur das EIGENE Postfach (`konto.eigenes`, das Subject des Aufrufers — nie ein
  Pfad-Parameter).
- **Das Recht ist `unterstuetzung.verwalten`** (Matrix-Zelle U = nur Kundenadministrator, E2) — an den
  Schreibwegen über `@Recht`, an den Lesewegen über `RechtPruefung.pruefen` im Rumpf (der Interceptor bindet
  nur Schreibwege). Ein Unterstützer gewährt nie eine Unterstützung.
- **Zwei neue Protokollwörter** im `aenderung`-Vokabular des Rechte-Vertrags: `verlaengern` und `ablaufen`.
  Zwillinge: `rechte-vectors.json`, `rechte.schema.json`, `RechteAbleitung.AenderungsArt`, `rechte.ts`,
  `zugriff_vokabular()`. `zugriff_protokoll_zugriff_chk` nennt sie mit (beide tragen ihre Zuweisung).

## Fallen

- ⚠ **Ein frisch angelegtes Partner-Konto wird als `aktiv` gespiegelt, nicht als `angelegt`.**
  `RechteAbleitung.darf` antwortet für jeden anderen Zustand 401 `konto_nicht_aktiv`, und den Übergang
  `angelegt → aktiv` bei der ersten Anmeldung baut erst IP-14 — bis dahin wäre das Konto von seiner eigenen
  Unterstützung ausgesperrt. **Wer IP-14 baut, dreht das hier mit.**
- ⚠ **Das Startpasswort steht GENAU EINMAL in der Antwort des Gewährens** (E14) und entsteht nur, wenn für die
  E-Mail-Adresse ein neues Partner-Konto angelegt wurde. Es darf in keine Liste, kein Protokoll, keinen Hinweis
  und keine E-Mail geraten; `UnterstuetzungApiTest` prüft das an Liste UND Postfach.
- ⚠ **Ist Keycloak nicht erreichbar, wird NICHTS gewährt** (502 `konto_nicht_erreichbar`) — sonst entstünde für
  dieselbe Person ein zweites Konto, sobald die Suche nach der Adresse still leer zurückkäme.
- ⚠ **Der Mandanten-Umschalter `X-Tenant-Id` gilt weiter** (`voltpilot.uems.unterstuetzung.umschalter-enabled`,
  Vorgabe AN = das heutige Verhalten). AUS ist der Satz aus A5 („nicht der heutige `X-Tenant-Id`-Vollzugriff“):
  VoltPilot erreicht einen Kundenbereich dann nur noch über eine gewährte Unterstützung oder den Notfall-Zugriff,
  sonst 404 wie ein Partner ohne Gewährung. **Umgelegt wird er mit der Portal-Umstellung (IP-15)**, sonst würde
  die Admin-Konsole („Zur Anlage (Kundensicht)“) blind, bevor das Portal den neuen Weg anbietet.
  `/api/v1/admin/**` ist davon nie betroffen.
- ⚠ **Die Migration BAUT AUF `V20260915030000` AUF** (Fremdschlüssel auf `zugriff`, das geschärfte
  `zugriff_protokoll_zugriff_chk`, das erweiterte Vokabular). In der späten Ankunft der IP-2-Migration kommt sie
  darum MIT ihr: `UemsZugriffMigrationTest.BAUEN_DARAUF_AUF`. Wer eine weitere Migration auf `zugriff` setzt,
  trägt sie dort ein.
- ⚠ **Das Offboarding räumt die beiden Tabellen VOR `zugriff` ab** (`TenantRepository.offboard`): ein Hinweis
  nennt seinen Zugriff und seine Anfrage, eine Anfrage ihren Zugriff und ihre Standorte — alles RESTRICT.
- ⚠ **`grundDerZuweisung` war nicht null-fest.** Es gibt die Protokollzeile fast immer, nur ihr `grund` ist meist
  leer — `findFirst` auf einer Liste mit `null` darin wirft. Bis IP-8 fiel das nicht auf, weil die
  Selbstauskunft nur für den Notfall-Zugriff fragte und der seinen Grund immer trägt.
- ⚠ **Die Ende-Sätze nennen das ENDDATUM, nicht den Zeitpunkt danach.** „bis 15.12.2026“ heißt `endet_am` =
  16.12.2026 00:00 in der Zeitzone des Kundenbereichs. Sätze holt man bei `RechteAbleitung.unterstuetzung`, nie
  selbst gebaut — sonst steht im Hinweis ein anderer Tag als an der Gewährung.
- ⚠ **Es gibt noch keine Fläche im Portal** (IP-15) und keinen Eintrag im Dev-Seed (IP-16). `api.ts` trägt die
  Typen, niemand ruft sie. Die Karten-Wortlaute für Anfrage und Erinnerung stehen bis dahin im Dienst
  (`ANFRAGE_SATZ`, `ERINNERUNG_SATZ`) — der Rechte-Vertrag führt für sie keinen Text.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='UnterstuetzungSchnittstelleVertragTest,UnterstuetzungWiringTest')
(cd services/api && ./mvnw test -Dtest='UnterstuetzungApiTest')
(cd services/api && ./mvnw test -Dtest='UemsZugriffMigrationTest,RechteAbleitungVectorsTest')
(cd frontend/portal && npx vitest run src/rechte.test.ts)
```
