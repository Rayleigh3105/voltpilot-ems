# Erste UEMS-Produktfreigabe: Tore, Termine des Betreibers, Fallen

Entschieden am 18.09.2026 (Konzept „Erste Produktfreigabe“, AP-14). **E1 = B: es gibt kein
Freigabe-Tor je Kundenbereich** — am Rollout-Tag bekommen alle alles; „Pilot“ heißt eine
Handvoll betreuter Kunden, nicht eine freigeschaltete Gruppe.

Werkzeug: `bash tools/freigabe/pruefe-tor.sh G0|G1|GA|GB` — es legt je Tor vor, was belegt
ist und was fehlt, und **öffnet kein Tor**. Aufruf, Belegregeln und Stand-Blatt des
Betreibers: [`tools/freigabe/README.md`](../../../tools/freigabe/README.md).

## Die vier Tore

Es gibt **nur** diese vier. Die Vorlage kannte G2 bis G4 mit den Stufen S1 bis S4; mit
E1 = B sind daraus Termine des Betreibers geworden (unten), und NW-3, NW-4, NW-5 und NW-6
sind von G2/G3 an **G1** gewandert — nach dem Rollout-Tag kommt kein Tor mehr, hinter dem
ein Nachweis noch jemanden schützen könnte.

| Tor | Öffnet | Nachweise |
|---|---|---|
| **G0** Zusammenführen | `uems` → `main` in einem Stück | V0 · NW-2 · M-2 · IP-3, IP-4, IP-14, IP-15, IP-9, IP-19 gemergt |
| **G1** Ausrollen | Rollout-Tag; zugleich Beginn des Piloten | M-1 · NW-1 · NW-8 · NW-3 · NW-4 · NW-5 · NW-6 · Kapazität nach L6 · Pilotkunden eingewilligt · M-4 als gitops-PR · Support-Weg geprobt · Kundennachricht samt Release-Notiz |
| **GA** Edge-Release A | additive Box-Pakete, je Box zugewiesen | NW-3 gegen das NEUE Image · Q08/IP-17 · Core und Palette gemeinsam · `automation_paused_until_revoked` im Herzschlag gemeldet |
| **GB** Edge-Release B | `RUNTIME_VERSION`, WAGO | ganze Flotte auf Release A · Q10 `pending_edge` · AP-05-Hardware-Pilot |

Die acht Nachweise NW-1…NW-8 und wer sie trägt: Konzept §4.13. Das Drehbuch des
Rollout-Tags steht in [`docs/rollout/uems-erste-freigabe.md`](../../rollout/uems-erste-freigabe.md),
die Generalprobe in [uems-generalprobe.md](uems-generalprobe.md), NW-3 in
[uems-nw3-box-image.md](uems-nw3-box-image.md).

Die **gemessenen Suiten-Summen** des Zweiges, auf die der Tor-Prüfer mit `--laeufe` zeigt,
stehen je Gesamtlauf unter `docs/rollout/gesamtlauf-<datum>.md` — zuletzt
[gesamtlauf-2026-09-19.md](../../rollout/gesamtlauf-2026-09-19.md) (Stand `957217b6`,
G0 = 9 von 9 belegt). Ein Bericht belegt **nur seinen** Commit: der Prüfer hält `stand.txt`
gegen `HEAD` und lehnt einen Bericht eines anderen Standes ab.

## Termine des Betreibers — keine Tore

Sie öffnen **nichts im System**; der Betreiber setzt sie selbst und hält sich daran.
Wer sie als Tor behandelt, baut eine Sperre, die es mit E1 = B nicht gibt.

| Termin | Woran er hängt |
|---|---|
| **Pilot beginnt** | der Rollout-Tag selbst |
| **Pilot-Ende** | NW-7: 14 Tage ohne Befund der Stufe 1 an P1–P3 **und** ein abgeschlossener voller Monat mit freigegebenem Bericht bei P4. Endgültige Zahlen frühestens Monatsende + 7 Tage |
| **Ansprache des Bestands** | nach dem Pilot-Ende, in betreuten Wellen; eine Betreuungs-Reihenfolge, technisch hat jeder alles |
| **Quoten-Termin** | `…HISTORIE_UNGEKLEMMTE_QUOTEN_ENABLED` von AUS auf AN, angekündigt mit Release-Notiz |

## Fallen

- **W1 — die alte api heilt sich selbst kaputt.** Startet die alte api auf dem neuen
  Schema, schreibt sie 18 DELETE-Marker in die Flyway-Historie; danach startet die neue
  nicht mehr. Darum: Fenster statt Verträglichkeit. Die Entscheidung über einen
  Start-Wächter auf `main` ist **offen** — das Drehbuch ist mit und ohne ihn fahrbar
  ([Drehbuch §9.1](../../rollout/uems-erste-freigabe.md)).
- **Z08 ist der Schadensmelder dazu.** Ein Generalprobe-Lauf mit
  `geloescht_markiert > 0` oder `fehlgeschlagen > 0` ist kein bestandener Lauf, auch nicht
  mit sonst grünen Zahlen. Exit 26 hat Vorrang vor allem anderen.
- **gitops PR 37 gehört mindestens einen Tag VOR das Fenster**, nie hinein: die ConfigMap
  bekommt einen neuen Hash und startet die api neu — harmlos auf dem **alten** Schema, im
  Fenster genau der Fehlstart. Und **Auto-Sync lässt sich nur per gitops-Commit anhalten**,
  nicht nebenbei ([Drehbuch §2.2, §3](../../rollout/uems-erste-freigabe.md)).
- **Zwei Platzhalter in PR 37 stehen auf `CHANGE-ME`**: die DB-Warnschwelle (aus **Q14**
  und der nutzbaren Platte, nicht „0,5 TB“ blind) und der Tenant des Dauerläufers (IP-18).
  Ungesetzt alarmiert die Überwachung am Rollout-Tag falsch oder gar nicht.
- **Wegwerf-Zahlen sind keine Fensterplanung.** Eine Migrationssumme aus einer leeren
  Datenbank liegt bei Millisekunden; die Fensterlänge ist *gemessene Summe × 3, mindestens
  30 Minuten*. Der Tor-Prüfer weist eine Summe unter einer Sekunde ausdrücklich zurück.
- **„Messen“ kennt kein Starten.** Gespeichert wird `entwurf`; `aktiv` wird abgeleitet.
  Wer auf `zustand = 'aktiv'` filtert, trifft niemanden (PR 975) —
  [uems-messanlage.md](uems-messanlage.md).
- **Die geteilte E2E-Bühne trägt fremde Specs.** Wer `startansicht.tsx`, eine `*-buehne.ts`
  oder gemeinsame Fixtures anfasst, fährt **alle** Specs, die sie lesen, nicht nur die
  eigenen (PR 980) — `rg -l "<bühnen-datei>" frontend/portal/e2e`.
- **Die Mess-Auswahl ist der scharfe Punkt an alten Boxen.** Der Go-Core liest sie strikt
  (`DisallowUnknownFields`): ein einziges neues Feld am `MeasurementConfigPublisher`
  bricht jede Box im Feld (PR 982) — [uems-nw3-box-image.md](uems-nw3-box-image.md).
- **Aus dem Tag gebaut ≠ Release-Artefakt.** Das NW-3-Paar wurde aus dem Release-Tag
  gebaut; das Artefakt liegt als Container-Image-Paar in der privaten Registry. Prüfbar
  sind Versionsstempel, Palette-Inhaltsmarke und der Stand, den die Box selbst meldet —
  nicht die Identität mit dem ausgelieferten Image.
- **NW-3 Punkt 4 ist gefahren** (`--strecke`, Samples 2.0 der echten Box bis in den
  Writer und in `device_measurement_sample`, beide Verwurf-Familien 0). Der **Befund** zu
  X7 steht weiter, und er allein hält NW-3 beim Tor-Prüfer offen: nach einer Trennung
  länger als das rollierende Ende läuft die Ruhe an der alten Box ab und die Automatik
  setzt von selbst wieder ein, während die Cloud weiter „bis auf Widerruf“ hält.
- **Eine angenommene Mess-Auswahl ist keine gelesene.** Die Box quittiert `accepted`,
  `rejected: []` — und sendet trotzdem nichts, wenn kein Wechselrichter gewählt ist oder
  der Punkt eine SunSpec-Modell-Erkennung braucht, die das Gerät nicht bedient. Wer einen
  Messnachweis liest: die Quittung ist nicht der Beleg, die Sample-Umschläge sind es.
- **Ein Testlauf belegt nur den Stand, auf dem er lief.** Der Tor-Prüfer nimmt einen
  Surefire-Bericht nur an, wenn er nicht älter ist als der geprüfte Commit — oder wenn
  `stand.txt` im Lauf-Verzeichnis denselben Commit nennt. Übersprungen ist nicht grün.
