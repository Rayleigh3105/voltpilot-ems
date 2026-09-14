# Formel-Vertrag der berechneten Messstelle (UEMS AP-10)

Stand 12.09.2026 · Vertrag 1.0, **additiv erweitert 12.09.2026 (AP-10 IP-1)** (additiv zum
Messstellen-Vertrag [`messstelle.md`](./messstelle.md)) · Captain-Rahmenentscheide aus dem Konzept
`vp-helfer-konzept-h1`, Erweiterung aus `data/vp-uems-ap10-bilanzen` (Entscheide E1, E4, E5, E11
vom 12.09.2026).

> **Was die Erweiterung ändert — und was nicht.** Alles unter §1 bis §5 gilt UNVERÄNDERT weiter:
> die gewichtete Summe bleibt der Typ 1 mit ihrer Richtungsregel, ihren Fehlern und ihren Vektoren
> (`messstelle-formel-vectors.json`). Dazu kommen additiv: **§0** die drei Formel-Typen, **§2.1**
> die Ergebnis-Richtung je Typ, **§1.1** die Term-Art `verteilung` und das Feld `anteil`, **§6**
> die Fassungen je Tag. Es entsteht KEIN zweites Modell und kein zweiter Assistent. Die Regeln der
> neuen Typen stehen in [`bilanz.md`](./bilanz.md) (`bilanz-vectors.json`), die der Verteilung in
> [`verteilung.md`](./verteilung.md); der Code zieht mit AP-10 IP-3, IP-4 und IP-5 nach — dieser
> Abschnitt ist bis dahin die VEREINBARUNG, nicht der Stand.

## 0. Die drei Formel-Typen (AP-10 E1)

Eine berechnete Messstelle hat genau EINEN Typ, und der Typ entscheidet die Richtungsregel:

| `formel_typ` | Was er rechnet | Gespeichert? |
|---|---|---|
| `gewichtete_summe` | die Terme dieses Vertrags (§1), mit Vorzeichen und Faktor | ja, als Terme |
| `rest` | die Bilanzdifferenz eines Hauptzählers: Zufluss − Abfluss − zugeordnet | **nein** — je Tag aus der STELLUNG abgeleitet (AP-10 E3) |
| `saldo` | Bezug − Abgabe derselben Grenze | ja, als zwei Terme |

`rest` speichert keine Terme: zieht ein Unterzähler in ein anderes System um, ändern sich beide
Reste am selben Tag, ohne dass jemand eine Formel anfasst. Die Fassung eines `rest` ist deshalb
nicht eine Nummer, sondern der Satz „aus der Stellung, Stand T“ (siehe
[`bilanzwert-herkunft.md`](./bilanzwert-herkunft.md)).

Dieser Vertrag löst die im Messstellen-Vertrag reservierte AP-10-Stelle ein: die **Formel**
einer Messstelle mit `art = berechnet` (messstelle.md:39 „`berechnet` (E9)", :108 „Formel +
alle Eingänge", FEHLT-Reihenfolge `… formel · eingaenge`).
Der erste — und vorerst einzige — Formel-Typ ist die **gewichtete Summe**: eine geordnete
Liste von **Termen**, je Term ein vorhandener Messkanal (oder eine andere Messstelle), mit
**Vorzeichen** und **optionalem Faktor**. **KEIN zweites Modell** neben der Messstelle
(Hausregel „Verträge sind additiv / erweitern statt duplizieren").

| Datei | Rolle |
|---|---|
| [`messstelle-formel-vectors.json`](./messstelle-formel-vectors.json) | die geteilten Vektoren: `groesse` (Ableitung), `zyklus`, `summe` (die Rechnung inkl. Ehrlichkeit) |
| `services/api/.../uems/MessstelleFormelRegeln.java` | der Java-Zwilling (rein: ohne Spring, ohne DB, ohne Uhr) — stützt sich auf `MessstelleRegeln`s Größen-Katalog |
| `frontend/portal/src/uemsMessstelleFormel.ts` | der TS-Zwilling |
| `…/uems/MessstelleFormelRegelnVectorsTest.java` · `src/uemsMessstelleFormel.test.ts` | beide fahren DIESELBE Vektor-Datei |

**Wer eine Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

> **Wer anruft (Stand AP-10):** die Tabelle `messstelle_formel_term`
> (`V20260912093000`), der Dienst `MessstelleFormelService` und die Endpunkte
> `POST /api/v1/messstellen/berechnet`, `GET …/{id}/formel`, `…/{id}/wert`,
> `…/{id}/verlauf`. Die Box kennt keine berechnete Messstelle; der Edge-Vertrag bleibt
> unverändert. Das Kundenwort („Gesamtwert") kommt erst mit dem Frontend-Assistenten.

## 1. Der Term (`messstelle_formel_term`)

Ein Term je Zeile, mandantengebunden (RLS wie alle UEMS-Tabellen), nur an einer **berechneten**
Messstelle (Trigger `messstelle_formel_term_nur_berechnet`):

| Feld | Regel |
|---|---|
| `position` | die stabile Reihenfolge, je Messstelle eindeutig |
| `eingang_art` | `messkanal` \| `messstelle` — der CHECK bindet ENTWEDER das eine ODER das andere |
| `entity_id` + `point_key` | bei `messkanal`: die Quellenbindung wie IP-13 (Komponente + Kanalname) — das Gerät wird NICHT gespeichert, der Cloud-Rechenweg löst die lesende Box zur Rechenzeit über `device_measurement_selection` auf |
| `quell_messstelle_id` | bei `messstelle`: die verkettete Messstelle (Baustein), nie sich selbst (CHECK), nie im Kreis (Zwilling) |
| `vorzeichen` | `+` \| `-` |
| `faktor` | numeric, Vorgabe 1, nie 0 |

Die Terme sind die AKTUELLE Definition (keine Historie): die App-Rolle darf sie ersetzen; das
Ändern schreibt `messstelle_aenderung`. `→ messstelle` ist `ON DELETE RESTRICT`
(archivieren statt löschen), `→ measurement_point` ist `ON DELETE CASCADE` wie jede Tabelle an
einer Komponente. Mit §6 wird „aktuell“ zu „die Fassung des Tages“; der Bestand ist Fassung 1.

### 1.1 Zwei additive Felder am Term (AP-10 E4, E11)

Beide Felder sind optional; ein Term ohne sie verhält sich genau wie heute.

| Feld | Regel |
|---|---|
| `eingang_art` = `verteilung` | eine dritte Art neben `messkanal` und `messstelle`: der Term meint den ANTEIL einer Kostenstelle an einer Messstelle („4100 von MS-07“) und trägt dafür `verteilung_ziel` (die Kostenstelle) + `quell_messstelle_id`. Er liest den Anteil des TAGES aus der Verteilung ([`verteilung.md`](./verteilung.md)) — er kopiert ihn nie als `faktor`. Ein solcher Term mit einem Faktor ≠ 1 wird abgelehnt (`verteilungs_term_ohne_faktor`): er liefe der Verteilung davon, sobald sie sich ändert. Seine Größe und Richtung sind die seiner Quell-Messstelle. |
| `anteil` | `gesamt` (Vorgabe) \| `positiv` \| `negativ` — welcher Anteil eines Messwerts eingeht. Eine Speicher-Messstelle mit der Richtung „Laden / Entladen“ geht mit ZWEI Termen ein: dem positiven (Laden) und dem negativen (Entladen), nie als Saldo und nie nur mit einer Hälfte. |

Die Schreibweise ist die von `MessstelleFormelDto`: **snake_case in der Schnittstelle**
(`terme[].entity_id`, `terme[].point_key`, `terme[].quell_messstelle_id`,
`terme[].gilt_als_erzeugung`, neu `terme[].verteilung_ziel` und `terme[].anteil`), camelCase nur im Java-Record. Das Portal wandelt
nichts um — ein camelCase-Feld wäre dort still `undefined`.

## 2. Die abgeleitete Hauptgröße (`formelGroesse`)

Die Hauptgröße der berechneten Messstelle wird aus den Termen **abgeleitet**, nie gewählt — so
ist sie sofort katalogkonform:

- Alle Terme tragen **dieselbe Vertrags-Größe** (Größe + Wertart), sonst `groessen_gemischt`
  mit dem ersten verletzten Merkmal (`groesse` → `wertart`).
- Die **Einheit** ist die Katalog-Einheit der Größe (W/kW/MW normiert die Berechnung, nicht die
  Definition).
- Die **Richtung** ist die gemeinsame Richtung, wenn alle Terme dieselbe tragen UND alle mit `+`
  eingehen; sonst `richtungslos` (ein Netto). Ergibt sich eine Größe, die der Katalog nicht
  kennt (z. B. ein Netto einer Größe ohne `richtungslos`), ist das ebenfalls `groessen_gemischt`
  (Grund `richtung`).
- Ein Messwert **ohne Vertrags-Richtung** (ein Vorzeichen-Wert `import_export`, oder ein Kanal,
  dem der Katalog keine Richtung gibt) ist kein Term — es sei denn, der Term trägt den
  **AP-08-Haken `gilt_als_erzeugung`** (§2.2). Ohne Haken bleibt ein solcher Messwert
  richtungslos und darf nicht summiert werden (wie im Messstellen-Vertrag §5).

### 2.1 Die Ergebnis-Richtung je Typ (AP-10 E1)

Die Richtung ist **je Typ eine Regel**, keine Ableitung aus Vorzeichen — 100 kWh Bezug minus 60
minus 30 ergibt 10 kWh **Bezug**, nicht „richtungslos“:

| `formel_typ` | Ergebnis |
|---|---|
| `gewichtete_summe` | unverändert §2 (gemeinsame Richtung, sonst `richtungslos`, sonst `groessen_gemischt`) |
| `rest` | **fest** Wirkenergie · Bezug · kWh. Der Live-Wert ist ein Momentanwert und trägt die Katalog-Richtung der Wirkleistung (`richtungslos`) — E1 greift nur auf der Mengen-Ebene. |
| `saldo` | **fest** Wirkenergie · `saldiert` · kWh — ein additiver Katalog-Eintrag, zulässig NUR für `art = berechnet` und nie an einem Messkanal bindbar (`saldiert_nur_berechnet`). |

Der Eintrag `Wirkenergie · saldiert` wandert mit AP-10 IP-4 in [`messstelle.md`](./messstelle.md)
§2 und `MessstelleRegeln.GROESSEN_KATALOG`; bis dahin steht er in
[`bilanz-vectors.json`](./bilanz-vectors.json) (`vokabulare.richtung_berechnet_additiv`).

### 2.2 Der AP-08-Haken „gilt als Erzeugung" am Term (AP-08)

Diese Stelle löst die in §2 reservierte AP-08-Frage ein — additiv, ein optionales Feld am Term
(`gewichtete_summe`):

| Feld | Regel |
|---|---|
| `gilt_als_erzeugung` | boolean, Vorgabe `false`. Nur an einem **Messkanal**-Term und nur an einem Kanal **ohne Katalog-Richtung** (der Katalog gibt keine, z. B. der Deye Gen-Port `generator-power`, `direction: null`). Mit gesetztem Haken ist der richtungslose Kanal als Term **zulässig** und zählt in der Richtungs-Ableitung (§2) als **Erzeugung** — so bleibt eine Summe aus lauter `+`-Erzeugungs-Termen `Erzeugung`, statt an dem einen richtungslosen Gen-Port zu `richtungslos` zu degradieren. |

Der Haken gilt **nur für einen richtungslosen Kanal**: an einem Kanal **mit** Katalog-Richtung
(auch der Katalog-Richtung `richtungslos` aus `direction: none`) weist der Dienst ihn ab
(`anfrage_ungueltig`, Feld `terme[i].gilt_als_erzeugung`) — ein wirkungsloser Schalter wäre
unehrlich. An einem `messstelle`-Term ist er ebenfalls unzulässig. Die Regel steht rein in beiden
Zwillingen (`MessstelleFormelRegeln.erzeugungsHakenErlaubt` / `richtungMitErzeugungsHaken`,
`uemsMessstelleFormel.ts`) und in den Vektoren (`cases.haken`); der normale Erzeugungs-Kanal
(PV 1/2/3, Katalog-Richtung `generation`) braucht den Haken nie.

## 3. Die Berechnung (Cloud, `MessstelleFormelBerechnung`/`gewichteteSumme`)

- **Live-Wert:** die gewichtete Summe der JEWEILS FRISCHESTEN Eingangswerte (aus
  `device_measurement_sample`), je Term auf die Anzeige-Einheit normiert.
- **Verlauf:** je 15-min-Bucket (aus `device_measurement_rollup_15m`) summiert, WENN alle Terme
  im Bucket einen Wert haben.
- **Die eine harte Regel — `null` statt Teilsumme:** fehlt oder veraltet EIN Pflicht-Term, ist
  das Ergebnis **`null` („unvollständig")**, NIE eine stillschweigend um den fehlenden Term
  reduzierte Summe — eine Summe mit heimlich fehlendem Summanden wäre ein Falschwert
  (unterschätzt). Die Antwort nennt, welcher Term fehlt (und warum: `kein_geraet` · `kein_wert`
  · `veraltet` · `unvollstaendig`). `null` und `0` sehen nie gleich aus.
- Ein `messstelle`-Term liest bei einer berechneten Quelle rekursiv, bei einer gemessenen aus
  ihrer führenden Quelle; ein Kreis (bereits besucht, oder zu tief) fehlt.

## 4. Lebenszyklus

Der Formel-Stand geht in `MessstelleRegeln.lebenszyklus` ein (die EINE Stelle, messstelle.md
§4): ohne Term ist die Messstelle **Entwurf** (`fehlt: formel`), mit einem Term, dessen Eingang
nicht mehr auflösbar ist, **Entwurf** (`fehlt: eingaenge`); sonst — mit Kennzeichen, Name,
abgeleiteter Hauptgröße, Formel und eingerichteten Eingängen — von selbst **aktiv** (eine
berechnete Messstelle braucht keinen Ort).

## 5. Fehler-Codes

| Code | Status | Fakten | Wann |
|---|---|---|---|
| `groessen_gemischt` | 422 | `grund` (`groesse` · `wertart` · `richtung`) | die Terme tragen nicht dieselbe Vertrags-Größe |
| `formel_zyklus` | 422 | `kette` | ein `messstelle`-Term verkettet im Kreis (beim Bearbeiten) |
| `anfrage_ungueltig` | 400 | `feld` | ein Feld fehlt, ist leer oder ohne Vertrags-Messgröße |

Eine fremde Messstelle ist 404, nie 403 (AP-03).

## 6. Fassungen: die Formel ist tagesgenau zeitgültig (AP-10 E5)

Eine Formel-**Fassung** ist der vollständige Termsatz einer berechneten Messstelle, gültig ab einem
Tag (00:00 Uhr in der Zeitzone des Standorts, Muster A wie jede zeitgültige UEMS-Beziehung):

- Fassung n + 1 beendet Fassung n am **Vortag**; nichts wird überschrieben, Fassung n bleibt
  lesbar. Eine Fassung, die vor dem Beginn der laufenden beginnt, überlappt und wird abgelehnt
  (`formel_fassung_ueberlappt`).
- Eine rückwirkend eingetragene Fassung ist erlaubt, aber nie unsichtbar: sie trägt ihr Abzeichen
  samt Zahl der Tage und löst für die betroffenen Tage dieselbe Neuberechnung aus wie eine
  `correction` an einem Eingang.
- Die Berechnung liest die Fassung DES TAGES. Ohne `am=` liefert `GET …/{id}/formel` weiter die
  heutigen Terme — für den Bestand ist das Fassung 1 („gilt seit Anlage“), und das Portal aus
  PR #689 liest unverändert weiter.
- Beim Typ `rest` gibt es keine gespeicherte Fassung: sie wird je Tag aus der Stellung abgeleitet.

Migration, Route (`POST …/messstellen/{id}/formel/fassungen`, `GET …/formel?am=`) und Backfill
„Fassung 1 = die heutigen Terme“ baut AP-10 IP-3; die Rechte der Routen wechseln dort nach AP-10
E15 auf `messstelle.formel` (Lesen bleibt `messstelle.ansehen`/`messwerte.ansehen`).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleFormelRegelnVectorsTest')          # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsMessstelleFormel.test.ts)
(cd services/api && ./mvnw test -Dtest='MessstelleFormelTermMigrationTest,MessstelleFormelApiTest')  # gegen die DB
```
