# Messstellen-Vertrag (UEMS AP-04 IP-1)

Stand 11.09.2026 · Vertrag 1.0 · Bezug: AP-04 §4.1–§4.6, §5.12–§5.14, §7 und die
Captain-Entscheide **E1, E2, E3, E7, E8, E9, E12** vom 10.09.2026 (alle Option A).

Dieser Vertrag sagt, **was eine logische Messstelle ist** — Kennzeichen, Größen, Quellen,
elektrische Stellung, Lebenszyklus — und **welche Regeln jede Änderung daran hält**: wie ein
Kennzeichen vergeben und geprüft wird, welche Größe es gibt, wann eine Messstelle
eingerichtet ist, wie eine Quelle gebunden, gewechselt und abgelehnt wird und wohin
„Unterzähler von …“ zeigen darf.

| Datei | Rolle |
|---|---|
| [`messstelle.schema.json`](./messstelle.schema.json) | JSON Schema 2020-12: die Wurzel ist EINE Messstelle, `$defs/vektorDatei` die Form der Vektor-Datei |
| [`fixtures/messstelle/`](./fixtures/messstelle/) | MS-06 und MS-21 aus dem Referenzunternehmen (gültig) und zwei ungültige Gegenbeispiele ([README](./fixtures/messstelle/README.md)) |
| [`messstelle-vectors.json`](./messstelle-vectors.json) | 87 Fälle in acht Familien, dazu Vokabular, Größen-Katalog und Fehlertabelle |
| `services/api/.../uems/MessstelleRegeln.java` | der Java-Zwilling (rein: ohne Spring, ohne Datenbank, ohne Uhr) |
| `frontend/portal/src/uemsMessstelle.ts` | der TS-Zwilling |
| `…/uems/MessstelleRegelnVectorsTest.java` · `src/uemsMessstelle.test.ts` | beide fahren DIESELBE Datei — plus Schema, Beispiele, Regel-Konstanten und jeden Fall gegen [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json); zwei Zweige, die die Referenzdatei nicht erreicht, prüfen beide als Einheit (zwei verschiedene Vergleichsquellen nebeneinander; zwei Hauptzähler gleicher Richtung am selben Zähler) |

**Wer eine Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

> ⚠ **Noch ruft niemand an.** Es gibt noch keine Tabelle `messstelle` (IP-2), keinen
> Endpunkt (IP-3) und keine Fläche (IP-5/IP-6). Dieser Vertrag ist das Ziel, gegen das sie
> bauen — nicht ihr Vollzug. Die Box kennt keine Messstellen; der Edge-Vertrag bleibt
> unverändert.

## 1. Die Messstelle

| Feld | Regel | MS-06 (Referenzunternehmen) |
|---|---|---|
| `kennzeichen` | Pflicht, E7 (§3); ändert sich nie durch Technik | `MS-06` |
| `name` | Pflicht, frei; je Standort eindeutig empfohlen (Warnung, keine Sperre) | Spritzguss SG01–SG06 |
| `art` | `gemessen` · `berechnet` (E9); nie änderbar | gemessen |
| `medium` | geschlossen: Strom · Gas · Wärme · Kälte · Wasser · Druckluft; im ersten Umfang bietet der Dialog nur „Strom“ an (AP-00 E11); nie änderbar | Strom |
| `hauptgroesse` | GENAU EINE (E1): Größe · Richtung · Einheit · Wertart aus dem Katalog (§2); identitätsstiftend, nie änderbar — eine andere Größe ist eine andere Messstelle | Wirkenergie · Bezug · kWh · Zählerstand |
| `fuehrende_quelle` | die Quellen der Hauptgröße, zeitgültig auf die Minute (§5) | K-5 @ Z-5a bis 18.11.2026 10:40, @ Z-5b ab 10:40 |
| `vergleichsquellen` | 0..n, jede mit Zweck (E3) — gezeigt, nie bewertet, nie Ersatz | — |
| `nebengroessen` | 0..n Größen desselben Messortes, je mit eigener führender Quelle und eigenen Vergleichsquellen; aktiv · archiviert; nie in einer Bilanz (E1) | Wirkleistung · Bezug · kW · Momentanwert |
| `orte` | tagesgenau gültig (AP-02 E9), je Tag genau einer | B-1 ab 12.03.2024 |
| `elektrische_stellung` | tagesgenau gültig: Anlage + Stellung + „Unterzähler von“ (§6) | AN-1 · Unterzähler von MS-01 |
| `kadenz_s` | abgeleitet aus der führenden Quelle; leer ohne Takt (abgelesen, berechnet) | 60 |
| `lebenszyklus` | Entwurf · eingerichtet · aktiv · angehalten · archiviert (§4) | aktiv |
| `notiz` | frei, optional | — |

Eine **Quelle** (`quellenbindung`) nennt Komponente, Messwert (`kanal`), Gerät und das konkret
eingebaute Gerät (`einbau` — bei einem Zählerwechsel wechselt es, die Messstelle bleibt), die
Wertart des Messwerts (`counter` · `gauge` · `state` · `bitfield` · `text`, AP-07 E12),
`gueltig_ab`/`gueltig_bis` auf die Minute mit dem Versatz der Standort-Zeitzone und die
freiwilligen Ablesestände `anfangsstand`/`endstand` (Wert + Einheit, E2). Der Zeitraum einer
Quelle ist halboffen `[ab, bis)`; leer heißt „bis auf Weiteres“.

Zuordnungen (`orte`, `elektrische_stellung`) gelten dagegen **tagesgenau** (AP-02 E9):
`gueltig_ab`/`gueltig_bis` sind Kalendertage (`JJJJ-MM-TT`), und „bis“ ist der LETZTE gültige
Tag — ein Wechsel ab 01.03.2027 beendet das Alte am 28.02.2027. Das ist dieselbe Mechanik wie
im Ortsbaum ([`ortsbaum-vectors.json`](./ortsbaum-vectors.json), AP-02 IP-1), die AP-04
übernimmt. Das Schema erzwingt beide Formen.

Prozesse und Kostenstellen (§4.1) sind Zuordnungen mit eigener Tages-Mechanik und kommen mit
IP-7 additiv in dieses Dokument; das Änderungsprotokoll (wer · wann · rückwirkend) mit IP-21.

## 2. Der Größen-Katalog

Geschlossen. Eine Größe steht nur mit Medium, Einheit, Richtung und Wertart zusammen im
Katalog; sonst `groesse_ungueltig` mit dem ERSTEN verletzten Merkmal
(groesse → medium → einheit → richtung → wertart).

| Größe | Medium | Einheit | Richtungen | Wertarten | gespeist aus |
|---|---|---|---|---|---|
| Wirkenergie | Strom | kWh | Bezug · Abgabe · Erzeugung · Laden · Entladen · Laden / Entladen | Zählerstand · Intervallmenge | Wirkenergie-Zähler (`counter`); Wirkleistung (`gauge`) nur zur Intervallmenge |
| Wirkleistung | Strom | kW | Bezug · Abgabe · Erzeugung · Laden · Entladen · richtungslos | Momentanwert | Wirkleistung (`gauge`) |
| Blindenergie | Strom | kvarh | Bezug · Abgabe | Zählerstand · Intervallmenge | Blindenergie-Zähler (`counter`) |
| Scheinleistung | Strom | kVA | richtungslos | Momentanwert | Scheinleistung (`gauge`) |
| Ladestand | Strom | % | richtungslos | Momentanwert | Ladestand (`gauge`) |
| Volumen | Gas | m³ | Bezug | Zählerstand · Intervallmenge | — (abgelesen, AP-09) |

Die übrigen Medien sind im Vokabular vorbereitet, aber noch ohne Größe — sie kommen mit AP-09.
Ein Messwert darf eine umrechenbare Einheit tragen: Wh/kWh/MWh, W/kW/MW, varh/kvarh, VA/kVA, %.

## 3. Kennzeichen (E7)

- **Automatisch** `MS-` + laufende Nummer, mindestens vierstellig (`MS-0022`), fortlaufend je
  Kundenbereich. Der Vorschlag ist die kleinste Nummer über dem Zähler, deren Kennzeichen
  niemand trägt oder trug; eine übersprungene Nummer wird nie mehr vergeben. Der Zähler rückt
  nur vor, wenn ein automatisches Kennzeichen gespeichert wird.
- **Änderbar** auf 2–16 Zeichen aus `A–Z`, `0–9`, `-`, `.`, `/` (`^[A-Z0-9./-]{2,16}$`).
  Nichts wird umgewandelt: `ms-01` ist ein Formfehler, nie still `MS-01`.
- **Eindeutig je Kundenbereich und nie an eine andere Messstelle weitergegeben** (Regel 9):
  belegt ist, was eine Messstelle trägt, ein archiviertes Kennzeichen UND das frühere einer
  umbenannten — ein Bericht aus der Zeit vor der Umbenennung nennt es. Die Messstelle selbst
  darf zu ihrem früheren Kennzeichen zurück.
- **Reihenfolge:** erst die Form (400 `kennzeichen_format`), dann die Belegung
  (409 `kennzeichen_belegt`, das Urteil nennt, wer es trägt oder trug).

## 4. Lebenszyklus und Beobachtung (E8, E9)

| Art | eingerichtet, wenn … | Ort Pflicht? |
|---|---|---|
| gemessen | Kennzeichen + Name + Hauptgröße + Ort | ja |
| berechnet | Kennzeichen + Name + Hauptgröße + Formel + alle Eingänge eingerichtet | nein |

- Eine **Quelle ist keine Voraussetzung** (E8). Ohne geltende führende Quelle ist
  `quelle_vorhanden` falsch — genau der Eingang `quelle_vorhanden` von
  [`uems-zustand-vectors.json`](./uems-zustand-vectors.json), und die Beobachtung heißt
  „Keine Datenquelle“: in Bilanz und Bericht „ohne Werte“, nie 0. Beide Zwillinge prüfen das
  über den Zustandsvertrag.
- Die **Formel** einer berechneten Messstelle kommt erst mit AP-10; bis dahin ist jede
  berechnete Messstelle ein Entwurf, und der Dialog bietet „berechnet“ nicht an (E9).
- Eingerichtet wird **von selbst aktiv** — Messen kann nichts schalten, kein Start-Knopf.
- Vorrang: `archiviert` → `entwurf` (es fehlt etwas) → `angehalten` → `aktiv`. `fehlt` nennt
  die Lücken in der Reihenfolge kennzeichen · name · hauptgroesse · ort · formel · eingaenge.
  Angehalten behält Quellen und Zuordnungen; archiviert beendet die Quellen zum
  Archivzeitpunkt, das Kennzeichen bleibt belegt.

## 5. Quellenbindung (Regeln 1, 2, 5, 6, 7; E1, E2, E3)

Je Größe (Haupt- ODER Nebengröße) und Zeitpunkt **höchstens eine führende Quelle**;
Vergleichsquellen beliebig viele, jede mit Zweck (Plausibilität · Ersatz bei Ausfall ·
Abrechnungszähler). Ein Messwert speist höchstens EINE Messstelle führend; innerhalb einer
Messstelle darf er zwei Größen speisen (MS-03: „PV-Leistung“ für Energie und Leistung).

Zwei Vorgänge: **`binden`** fügt eine Quelle hinzu (IP-13), **`wechsel`** löst die laufende
Quelle ab (Zählerwechsel, IP-17). Geprüft wird in dieser Reihenfolge; der erste Treffer
gewinnt:

1. Medium ≠ Strom → 422 `medium_ohne_quelle` (Regel 11)
2. Vergleich ohne Zweck aus dem Vokabular → 400 `vergleich_ohne_zweck` (Regel 1)
3. Passung Messwert → Größe (Regel 7) → 422 `quelle_passt_nicht` mit Grund
   - `wertart`: `state`/`bitfield`/`text`; ein Momentanwert aus einem Zählerstand; ein
     Zählerstand aus einer Leistung; die Katalog-Quelle verlangt eine andere Wertart
   - `groesse`: der Messwert misst etwas, das die Größe nicht speisen darf
   - `einheit`: die Einheit lässt sich nicht umrechnen
   - `richtung`: Bezug ist nicht Abgabe
4. Ende nicht nach Beginn → 400 `zeitraum_ungueltig`
5. Führend, und derselbe Messwert speist im Zeitraum eine ANDERE Messstelle führend →
   409 `kanal_bereits_fuehrend` (nennt sie)
6. `wechsel` mit einem Zeitpunkt nicht nach dem Beginn der laufenden Quelle, oder ein
   Zeitpunkt vor dem Beginn der Messstelle (Beginn ihres ersten Orts) → 422
   `zeitpunkt_vor_vorgaenger` (Regel 5; nennt die laufende Quelle). Der Beginn ist
   Mitternacht des ersten Ort-Tages in der Zeitzone des Standorts.
7. Überlappung mit einer Quelle derselben Größe und Rolle — beim Vergleich: desselben
   Messwerts — → 409 `bindung_ueberlappt` (nennt die früheste berührte Quelle)

**Die einzige Änderung an Bestehendem** (Regel 2): eine neue, offene führende Quelle beendet
die laufende genau zu ihrem Beginn, wenn sie nach deren Beginn liegt. Bereits beendete Quellen
werden nie verschoben; eine begrenzte Quelle passt nur in eine Lücke. **Lücken sind erlaubt**
und im Zeitstrahl ein eigener Abschnitt ohne Quelle („keine Quelle von … bis …“) — nie
aufgefüllt.

Das Urteil trägt bei Erfolg: den Status der neuen Quelle (`geplant` · `gilt` · `beendet`),
`rueckwirkend`/`angekuendigt` (auf die Minute gegen „jetzt“, E2), die **Herleitung**
(`zaehlerstand` · `differenzen` · `integration` — für AP-08 gekennzeichnet · `momentanwert`),
Hinweise (`ablesestand_pruefen`: ein Stand ohne Einheit oder ein Anfangsstand über dem Endstand
DESSELBEN Geräts — speichern bleibt erlaubt) und den **Zeitstrahl** der führenden Quellen ab
Beginn der Messstelle. Den Zeitstrahl gibt es auch für sich (`zeitstrahl` in beiden Zwillingen):
ohne jede Quelle ist er EIN offener Abschnitt ohne Quelle („keine Datenquelle seit …“), nach
einer ausdrücklich beendeten Quelle endet er mit „keine Quelle seit …“ — nie still.

## 6. Elektrische Stellung (Regel 8, E12)

Stellungen: Hauptzähler · Unterzähler · Erzeuger · Speicher · Abzweig · keine. Geprüft wird
in dieser Reihenfolge (422 `stellung_ungueltig` mit Grund):
`nicht_elektrisch` (berechnet oder Medium ≠ Strom — nur „keine“) → `bezug_nur_bei_unterzaehler`
→ `bezug_fehlt` → `selbst` → `fremde_anlage` („Unterzähler von“ zeigt auf eine MESSSTELLE
DERSELBEN Anlage, E12) → `zyklus` (das Urteil trägt den Kreis).

**Hauptzähler:** je Anlage und Richtung höchstens einer, und alle Hauptzähler einer Anlage
lesen DENSELBEN Zähler (dieselbe Komponente) — so sind MS-01 (Bezug) und MS-02 (Abgabe) an
K-3 zusammen erlaubt, ein zweiter Zähler nie: 409 `hauptzaehler_vorhanden`, das Urteil nennt
den ersten bestehenden in Register-Reihenfolge. Die Liste der Messstellen ist der Stand am
Stichtag (Tag).

## 7. Fehler-Codes

Die Sätze sind der Wortlaut von AP-04 §5.12; die Fläche baut sie aus den Fakten des Urteils.
Gepinnt werden sie mit dem Dialog (IP-6), nicht hier.

| Code | Status | Fakten im Urteil | Wortlaut (§5.12) |
|---|---|---|---|
| `kennzeichen_format` | 400 | — | „Erlaubt sind 2–16 Zeichen: Großbuchstaben, Ziffern, „-“, „.“, „/“.“ |
| `kennzeichen_belegt` | 409 | wer es trägt/trug, archiviert, früher | „MS-01 ist bereits vergeben (Netzbezug Halle 1). Kennzeichen sind je Unternehmen eindeutig — auch archivierte bleiben belegt.“ |
| `groesse_ungueltig` | 400 | Grund | *(Ergänzung dieses Vertrags — der Dialog bietet nur Katalog-Größen an)* |
| `medium_ohne_quelle` | 422 | — | „Eine Messstelle mit Medium Gas kann keinen Messwert aus dem Katalog binden.“ |
| `vergleich_ohne_zweck` | 400 | — | *(aus IP-13 „Vergleich ohne Zweck 400“)* |
| `quelle_passt_nicht` | 422 | Grund | „Der Messwert „Wirkleistung“ (kW, Momentanwert) kann die Größe „Wirkenergie · Zählerstand“ nicht liefern. …“ |
| `kanal_bereits_fuehrend` | 409 | die andere Messstelle | „Dieser Messwert speist bereits MS-06 (führend). Ein Messwert kann nur eine Messstelle führend speisen — als Vergleichsquelle ist er möglich.“ |
| `zeitraum_ungueltig` | 400 | — | *(Ergänzung dieses Vertrags)* |
| `zeitpunkt_vor_vorgaenger` | 422 | die laufende Quelle (beim Wechsel) | „Der Zeitpunkt liegt vor dem Einbau von Z-5a (12.03.2024). Wählen Sie einen späteren Zeitpunkt.“ |
| `bindung_ueberlappt` | 409 | die berührte Quelle | „MS-06 hat ab 18.11.2026 10:40 bereits eine führende Quelle (Z-5b). Beenden Sie diese oder wählen Sie einen anderen Zeitpunkt.“ |
| `hauptzaehler_vorhanden` | 409 | die bestehende Messstelle | „Werk Ahrenberg – Halle 1 hat bereits einen Hauptzähler: MS-01 Netzbezug Halle 1. Wählen Sie „Unterzähler von MS-01“ oder ändern Sie MS-01.“ |
| `stellung_ungueltig` | 422 | Grund, Ziel oder Kreis | „MS-11 gehört zu Halle 2. Ein Unterzähler kann nur auf eine Messstelle derselben Anlage zeigen.“ / „Eine Messstelle kann nicht ihr eigener Unterzähler sein.“ |
| `anteile_summe` | 422 | — (prüft IP-7) | „Die Anteile ergeben 90 %. Sie müssen 100 % ergeben.“ |
| `ort_ungueltig` | 422 | — (prüft IP-7) | „Halle 2 Lager ist seit 30.06.2027 archiviert. Wählen Sie einen aktiven Ort.“ |
| Hinweis `ablesestand_pruefen` | — | — | „Der Anfangsstand 1 083 500 kWh liegt über dem Endstand 1 083 415,2 kWh desselben Zählers. Prüfen Sie die Werte.“ |

Eine fremde Messstelle ist 404, nie 403 (AP-03); das ist Sache der Schnittstelle, nicht dieser
Regeln.

## 8. Die Fälle

| Familie | Fälle | belegt |
|---|---|---|
| `kennzeichen_vorschlag` | 3 — nächste Nummer MS-0022, überspringt eine belegte, erster Kundenbereich MS-0001 | E7, A12 |
| `kennzeichen_pruefen` | 13 — kürzen MS-0006 → MS-06, eigener Nummernkreis, belegt (MS-01), archiviert (MS-13), früheres Kennzeichen, eigenes früheres zurück, unverändert, fünf Formfehler, Kante 16 Zeichen | E7, A12, §5.12, Regel 9 |
| `groesse` | 9 — MS-06, MS-21 Gas, MS-04 „Laden / Entladen“, Ladestand; vier Merkmale abgelehnt, Wasser noch ohne Größe | §4.1, E1, AP-00 E11 |
| `lebenszyklus` | 8 — MS-06 aktiv, MS-21 ohne Quelle, neuer Entwurf, MS-20 ohne Formel, MS-19 mit Formel und ohne Eingang, angehalten, MS-13 archiviert | §4.5, E8, E9, A10, A13 |
| `passung` | 13 — Regel 7 als Tabelle ohne Anlage: vier erlaubte Herleitungen, Wh umrechenbar, Gas, Zustand, Momentanwert aus Zählerstand, Zählerstand aus Leistung, Energie als Momentanwert, Ladestand speist keine Energie, kW statt kWh, Abgabe statt Bezug | Regel 7, Regel 11 |
| `bindung` | 25 — **MS-06-Zeitstrahl** (A1), angekündigt (A3), Nebengröße mit eigener Quelle, **Überlappung**, Wechsel vor und genau beim Einbau (A15), **Lücke** (MS-07), MS-08-Umzug K-7 → K-8.7, Leistung integriert (MS-03), vier Passungsgründe, Gas ohne Quelle, Messwert speist schon MS-06, Vergleich mit/ohne Zweck und derselbe Messwert doppelt, Ablesestand-Hinweise (gleiches Gerät, ohne Einheit) und die Gegenprobe (anderes Gerät), Zeitraum verkehrt und null Minuten, vor Beginn der Messstelle; „jetzt“ auf die Minute | Regeln 1, 2, 5–7, E1–E3 |
| `zeitstrahl` | 3 — MS-06 ohne Fuge, MS-21 ein offener Abschnitt ohne Quelle, MS-07 „keine Quelle seit 07:00“ | Regel 2, E8 |
| `stellung` | 13 — Bezug + Abgabe desselben Zählers, **zweiter Hauptzähler** (A11) und gleiche Richtung, **Fremdanlage** (MS-08-Umzug, MS-11), Umzug erlaubt, sich selbst, **Zyklus**, berechnet und Gas nur „keine“, Bezug fehlt, Bezug ohne Unterzähler | Regel 8, E12 |

Jeder Fall mit `referenz` übernimmt die Quellen der genannten Messstelle unverändert (oder
zeigt den Stand VOR einem eingetragenen Ende); `ergebnis_wie_referenz` heißt, sein Zeitstrahl
IST der des Referenzunternehmens; `fortschreibung` spielt nach dessen letztem Ereignis
(12.04.2027). Jede Zeile eines Stellungs-Falls ist die Stellung des Referenzunternehmens am
Stichtag. Beide Zwillinge prüfen das.

## 9. Widersprüche und Annahmen

Wo Konzept und Referenzdatei auseinanderlaufen, gewinnt für Kennzeichen, Werte und Zeitpunkte
die Referenzdatei, für Regeln der Entscheid-Wortlaut.

1. **„Genau ein Hauptzähler je Anlage“** (Regel 8, AP-00 Inv. 1) gegen die Referenzdatei, in
   der MS-01 (Bezug) UND MS-02 (Abgabe) Hauptzähler von AN-1 sind — E1 macht Bezug und Abgabe
   zu zwei Messstellen. Der Vertrag liest die Regel wie der Invarianten-Test des
   Referenzunternehmens: je Anlage und Richtung einer, alle am selben Zähler. Fälle
   `ms-02-abgabe-neben-bezug-desselben-zaehlers`, `ms-03-zweiter-hauptzaehler-abgelehnt`.
2. **§5.13, Zeile „10:40–10:47 · Gerät —“** gegen §5.14, A1 und die Referenzdatei („Z-5b ab
   10:40“). Die Quelle Z-5b gilt ab 10:40; die sieben Minuten sind die WERTE-Lücke der
   Beobachtung („wartet auf erste Daten von Z-5b“, AP-07), keine Bindungslücke. Fall
   `ms-06-zaehlerwechsel-zeitstrahl`.
3. **Regel 10 „ohne Ort ist sie ein Entwurf“** gegen §4.5 (die Zeile „berechnet“ verlangt
   keinen Ort) und MS-20 der Referenzdatei (berechnet, ohne Ort; AP-00 Inv. 2 gilt der
   gemessenen). Die Ort-Pflicht gilt der gemessenen Messstelle. Fall
   `ms-20-berechnet-ohne-formel-ist-entwurf`.
4. **MS-21 `zustand` „eingerichtet · liefert keine Daten (kein Kanal)“** (Referenzdatei, Prosa)
   gegen den Wortlaut von E8 „keine Datenquelle“. Der Vertrag folgt E8. Fall
   `ms-21-ohne-quelle-keine-datenquelle`.
5. **Kadenz und Wertart von MS-06:** §4.1 nennt „15 Minuten (Zählerstand)“ und „Intervallmenge
   (aus Zählerstand)“, die Referenzdatei 60 s und „Zählerstand“. Beispiel und Fälle folgen der
   Datei.
6. **„Laden / Entladen“** (E1, MS-04 der Referenzdatei) fehlt in der Katalogtabelle von §4.1;
   der Katalog führt sie bei der Wirkenergie. Fall `ms-04-laden-entladen`.
7. **„nie wiederverwendet“** (Regel 9) umfasst hier auch das frühere Kennzeichen einer
   umbenannten Messstelle — für jede ANDERE Messstelle; E7 nennt ausdrücklich nur die
   archivierten. Fälle `frueheres-kennzeichen-bleibt-belegt`,
   `eigenes-frueheres-kennzeichen-zurueck`.
8. **Ergänzte Codes:** `groesse_ungueltig` und `zeitraum_ungueltig` (Formregeln, 400) stehen
   nicht in §5.12; `vergleich_ohne_zweck` stammt aus der IP-13-Testliste.
9. **Wechsel oder Überlappung.** A15 verlangt `zeitpunkt_vor_vorgaenger` für einen Wechsel vor
   dem Einbau des Vorgängers, §5.12 `bindung_ueberlappt` für eine Quelle, die auf eine
   bestehende trifft. Der Vertrag unterscheidet am Vorgang: `wechsel` → Vorgänger,
   `binden` → Überlappung.
10. **„Überlappung derselben Rolle“ beim Vergleich** heißt „desselben Messwerts“ — sonst gäbe es
    keine 0..n Vergleichsquellen nebeneinander.
11. **Keine Vergleichsquelle und keine Bindungslücke in der Referenzdatei.** Die Vergleichs-Fälle
    fügen die Netzleistung am Wechselrichter K-1 an MS-01 hinzu (E3, §5.3) — als VORGANG; nur
    `ms-01-vergleich-derselbe-messwert-doppelt` setzt sie als BESTAND voraus und nennt das als
    `annahme` (dieselbe Annahme wie `messwert-herkunft-vectors.json`). Die Lücke spielt als
    Fortschreibung an MS-07 am 03.05.2027. Zwei Vergleichs-Messwerte für EINE Größe und zwei
    Messstellen, die einen Zähler in derselben Richtung lesen, kennt die Datei nicht — diese
    beiden Zweige prüfen die Zwillinge als Einheit mit neutralen Platzhaltern.
12. **A3** kündigt 10:00 an und korrigiert auf 10:40; der Fall nimmt gleich 10:40. **§5.4** lässt
    MS-08 die Quelle um 06:00 wechseln, die Referenzdatei um 00:00; der Fall folgt der Datei.
    Der Vertipper `1 083 500 kWh` (Fälle zum Ablesestand) ist der Wortlaut-Wert aus §5.12.
13. **Zwei Schreibweisen desselben Tages.** Die Referenzdatei schreibt Zuordnungen als
    Mitternachts-Zeitpunkt mit AUSSCHLIESSLICHEM Ende (MS-08: AN-1 „bis 2027-03-01T00:00“), der
    Ortsbaum-Vertrag (AP-02 IP-1) als Tag mit dem LETZTEN gültigen Tag („bis 2027-02-28“). Dieser
    Vertrag folgt dem Ortsbaum; beide Zwillinge rechnen beim Vergleich mit der Referenzdatei um.

## 10. Was dieser Vertrag nicht regelt

Die Tabelle `messstelle` samt Kennzeichen-Zähler (IP-2), Endpunkte und Rechte (IP-3, AP-03),
Register und Dialog samt Wortlaut (IP-4 bis IP-6), Zuordnungen mit Tages-Mechanik, Prozessen,
Kostenstellen-Anteilen und Ort-Prüfung (IP-7), Gerät, Messkanal-Katalog und
Einstellungs-Fassungen (IP-9 bis IP-11), die Beobachtung „liefert Daten“ selbst
([`uems-zustand-vectors.json`](./uems-zustand-vectors.json), IP-15), die Vorschlagsliste
(IP-16), Zähler- und Controllerwechsel als Transaktion (IP-17/IP-19) und das
Änderungsprotokoll (IP-21). Die Herkunft je Wert steht in
[`messwert-herkunft.md`](./messwert-herkunft.md).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleRegelnVectorsTest')   # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsMessstelle.test.ts)
```
