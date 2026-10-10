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
> Abschnitt ist bis dahin die VEREINBARUNG, nicht der Stand. **§6 (Fassungen) ist seit AP-10 IP-3
> gebaut**, **§0 `rest`/`saldo` und §2.1 seit AP-10 IP-4** (§6.2); §1.1 (IP-5) ist es noch nicht.

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

> **Wer anruft (Stand AP-10 IP-3):** die Tabellen `messstelle_formel_term`
> (`V20260912093000`) und `messstelle_formel_fassung` (`V20260912210000`), der Dienst
> `MessstelleFormelService` und die Endpunkte `POST /api/v1/messstellen/berechnet`,
> `GET …/{id}/formel` (mit `?am=`), `POST …/{id}/formel/fassungen`, `…/{id}/wert`,
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

### 1.2 Einstiegskontext für neue Summenwerte (additiv, 16.09.2026)

`POST /api/v1/messstellen/berechnet` nimmt optional `kontext` entgegen:

- Anlage: `{ "art": "anlage", "site_id": "…" }` erlaubt mehrere Geräte der Anlage.
- Gerät: `{ "art": "geraet", "site_id": "…", "box_id": "…", "geraet_id": "inverter" }`
  begrenzt alle Eingänge auf dieses physische Gerät. `geraet_id` ist die stabile Kennung
  der Geräteseite (`inverter`, Quellen-Pin oder `cp-<charge_point_id>`). Box-ID und
  Gerätekennung bilden zusammen die Referenz; die Box allein ist keine Gerätegrenze.
- Ohne Kontext bleiben bestehende Anlagen-Aufrufer kompatibel. Neue Portal-Aufrufe
  senden ihren Kontext ausdrücklich. Diese Anlegeregel verändert keine Bestandsformel.

`GET /api/v1/sites/{siteId}/summenwert-quellen?boxId=…&geraetId=…` verwendet dieselbe
serverseitige Auflösung wie das Anlegen. Ohne beide Parameter bleibt die Liste anlagenweit.
Komponentenlisten aus dem Client, Namen, Modellbezeichnungen oder Transportadressen sind
kein Nachweis. Zugeordnet wird über `edge_source_id`, `device_charge_point.entity_id`
oder die ausdrücklich komponierte Grundausstattung (`battery-hybrid`, `grid-meter`,
`house-load`) des primären Wechselrichters. Für ältere Grundausstattung ohne
`source_kind` gilt nur die ungebundene Form ohne eigene Kommunikation/Verbindung.
Unzugeordnete sonstige Komponenten werden keinem Gerät zugeschlagen.

Der Server prüft sämtliche direkt und rekursiv gelesenen Komponenten. Bei gemessenen
Quellmessstellen zählt die aktuell gültige führende Quelle der Hauptgröße; Grenzen
sind minutengenau halboffen. Nicht auflösbare, leere, archivierte oder zyklische
Quellen werden abgelehnt. Eine andere Anlage bzw. unsichtbare Quelle ergibt **404**.
Ein anderes Gerät derselben Anlage ergibt **422**, Code `summenwert_kontext_verletzt`,
`grund: anderes_geraet`; eine unauflösbare Herkunft denselben Code mit
`grund: quelle_nicht_aufloesbar`. Eine unvollständige Kontextform ergibt **400**.

Der verfügbare Registerkatalog bleibt gefiltert: gespeicherte Komponentenfamilie
führt, andernfalls die Familie der exakt zugeordneten `local_setup`-Meldung derselben
Box. OCPP-Komponenten tragen ihre Protokollfamilie aus der OCPP-Zuordnung. Unbekannte
Familien erweitern den Katalog nicht. Ohne bekannte Familie trägt die Katalogantwort
`availabilityReason: registerfamilie_nicht_zugeordnet`; das Portal nennt
„Registerfamilie nicht zugeordnet“. Verfügbarkeit benötigt keine Telemetrie.

Gemeinsame Java-/TS-Prüffälle: [summenwert-kontext-vectors.json](summenwert-kontext-vectors.json),
`SummenwertKontextVectorsTest` und `summenwertQuellen.test.ts`. Die API-Abnahme
`UemsSummenwertAbnahmeTest` prüft die tatsächliche Auflösung, rekursive Eingänge,
RLS, Familien-Vorrang und den unveränderten Mehrgeräte-Bestand.

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
- Ein Messwert **ohne Katalog-Richtung** (`direction: null`) ist kein Term — es sei denn,
  der Term trägt den **AP-08-Haken `gilt_als_erzeugung`** (§2.2).
- Ein Vorzeichen-Wert `import_export` hat eine Katalog-Richtung (abgebildet als
  `richtungslos`). Als neuer Formel-Term bleibt er mit und ohne Haken gesperrt.
  Sein Anteil ist seit AP-08 IP-7 an der **Quellenbindung** zulässig
  (Messstellen-Vertrag §5); als Term-Feld `anteil` bleibt er benannt abgelehnt (§1.1).
  Ein Netz-Summenwert aus getrennten Bezugs-/Abgaberegistern braucht den Erzeugungs-Haken nie.

### 2.1 Die Ergebnis-Richtung je Typ (AP-10 E1)

Die Richtung ist **je Typ eine Regel**, keine Ableitung aus Vorzeichen — 100 kWh Bezug minus 60
minus 30 ergibt 10 kWh **Bezug**, nicht „richtungslos“:

| `formel_typ` | Ergebnis |
|---|---|
| `gewichtete_summe` | unverändert §2 (gemeinsame Richtung, sonst `richtungslos`, sonst `groessen_gemischt`) |
| `rest` | **fest** Wirkenergie · Bezug · kWh. Der Live-Wert ist ein Momentanwert und trägt die Katalog-Richtung der Wirkleistung (`richtungslos`) — E1 greift nur auf der Mengen-Ebene. |
| `saldo` | **fest** Wirkenergie · `saldiert` · kWh — ein additiver Katalog-Eintrag, zulässig NUR für `art = berechnet` und nie an einem Messkanal bindbar (`saldiert_nur_berechnet`). |

Der Eintrag `Wirkenergie · saldiert` steht seit AP-10 IP-4 in [`messstelle.md`](./messstelle.md)
§2 und `MessstelleRegeln.GROESSEN_KATALOG` (Feld `richtungen_nur_berechnet`); das Vokabular dazu
bleibt [`bilanz-vectors.json`](./bilanz-vectors.json) (`vokabulare.richtung_berechnet_additiv`),
beide Tests halten Katalog und Vokabular gleich.

### 2.2 Der AP-08-Haken „gilt als Erzeugung" am Term (AP-08)

Diese Stelle löst die in §2 reservierte AP-08-Frage ein — additiv, ein optionales Feld am Term
(`gewichtete_summe`):

| Feld | Regel |
|---|---|
| `gilt_als_erzeugung` | boolean, Vorgabe `false`. Nur an einem **Messkanal**-Term und nur an einem Kanal **ohne Katalog-Richtung** (der Katalog gibt keine, z. B. der Deye Gen-Port `generator-power`, `direction: null`). Mit gesetztem Haken ist der richtungslose Kanal als Term **zulässig** und zählt in der Richtungs-Ableitung (§2) als **Erzeugung** — so bleibt eine Summe aus lauter `+`-Erzeugungs-Termen `Erzeugung`, statt an dem einen richtungslosen Gen-Port zu `richtungslos` zu degradieren. |

Der Haken gilt **nur für einen richtungslosen Kanal**: an einem Kanal **mit** Katalog-Richtung
(auch `richtungslos` aus `direction: none` oder `import_export`) weist der Dienst ihn ab
(`anfrage_ungueltig`, Feld `terme[i].gilt_als_erzeugung`) — ein wirkungsloser Schalter wäre
unehrlich. An einem `messstelle`- und an einem `verteilung`-Term (§1.1) ist er ebenfalls unzulässig. Die Regel steht rein in beiden
Zwillingen (`MessstelleFormelRegeln.erzeugungsHakenErlaubt` / `richtungMitErzeugungsHaken`,
`uemsMessstelleFormel.ts`) und in den Vektoren (`cases.haken`); der normale Erzeugungs-Kanal
(PV 1/2/3, Katalog-Richtung `generation`) braucht den Haken nie.

**Bestandsschutz (W1):** Die Ablehnung gilt beim Setzen. Bereits gespeicherte
`import_export`-Terme mit Haken werden beim Lesen der Formel weiterhin wie bisher als
`Erzeugung` dargestellt. Live-Wert, Verlauf und gespeicherte Zeilen bleiben unverändert;
es gibt keine Datenmigration.

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
| `formel_zyklus` | 422 | `kette` | ein `messstelle`-Term verkettet im Kreis (beim Bearbeiten, seit IP-3: beim Eintragen einer Fassung) |
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

### 6.1 Wie IP-3 es gebaut hat (Stand 12.09.2026)

- **Tabelle** `messstelle_formel_fassung` (`V20260912210000`): `nummer`, `formel_typ` (heute nur
  `gewichtete_summe`), `gueltig_ab`/`gueltig_bis` als TAGE (`daterange(ab, bis, '[]')`, Exklusion je
  Messstelle), `aufgehoben_am`, `herkunft` (`bestand` · `anlage` · `eintrag`), `rueckwirkend`, Urheber.
  Jeder Term trägt `fassung_id` (Pflicht); die Terme sind Historie ihrer Fassung (die App-Rolle hat
  kein UPDATE/DELETE mehr).
- ⚠ **„gilt seit Anlage“ heißt: Fassung 1 hat KEINEN ersten Tag** (`gueltig_ab` = `null`). Die Terme
  von PR #688 hatten keine Zeit — die Cloud rechnete sie auch für Tage vor dem Anlegen, und der
  Verlauf über 7/30 Tage zeigt diese Tage. Ein erster Tag = Anlagetag hätte diese Tage nach der
  Migration leer gemacht. Darum ist Fassung 1 des Bestands UND des Anlegens (`POST …/berechnet`)
  „gilt seit Beginn“; jede weitere Fassung (und eine Fassung 1, die über die Fassungs-Route an einer
  Messstelle ohne Formel entsteht) beginnt an ihrem Tag und gilt nie rückwärts.
- **Regel** `MessstelleFormelRegeln.fassungEintrag`: eine neue Fassung muss NACH dem Beginn der
  jüngsten beginnen (sonst `formel_fassung_ueberlappt` 422 mit `fassung` und `gueltig_ab`), beendet die
  laufende am Vortag, trägt `rueckwirkend` samt `abzeichen` („rückwirkend (5 Tage)“, die Wörter von
  `OrtsbaumAbleitung.rueckwirkung`). Die abgeleitete Hauptgröße muss die der Messstelle bleiben
  (`groessen_gemischt` mit `grund`). Der Code steht NICHT in `Fehler` (die Tabelle von
  `messstelle-formel-vectors.json`, unberührt), sondern in `FassungFehler`.
- **Lesen:** `GET …/formel?am=JJJJ-MM-TT` liefert die Terme der Fassung des Tages plus den Block
  `fassung_am {tag, fassung}`; OHNE `am` fehlt der Block, und die Antwort ist Zeichen für Zeichen die
  von vor IP-3.
- **Rechnen:** der Live-Wert liest die Fassung von heute, der Verlauf je 15-min-Bucket die Fassung
  des Tages, an dem der Bucket beginnt (Zeitzone des Standorts), ein Baustein die Fassung SEINER
  Messstelle am selben Tag. Die „Neuberechnung wie nach einer `correction`“ entfällt, solange die
  Werte on-the-fly gerechnet werden (gespeicherte Werte: AP-08 IP-9 / AP-10 IP-10).
- **Protokoll:** eine eingetragene Fassung schreibt GENAU EINEN Eintrag `formel_geaendert`
  (`alt` = beendete Fassung, `neu` = Nummer, Typ, erster Tag, Terme).

### 6.2 Die Typen je Typ (AP-10 IP-4, Stand 13.09.2026)

- **Verzweigung, keine zweite Rechnung.** `MessstelleFormelRegeln.hauptgroesse(typ, art, wertart,
  terme)` und `.periodenwert(typ, art, einheit, version, vermerke, eingaenge)` verzweigen je
  `formel_typ`: `gewichtete_summe` → `formelGroesse` (unverändert) bzw. `BilanzAbleitung.summe`;
  `rest` → `BilanzAbleitung.richtung`/`.rest`; `saldo` → `BilanzAbleitung.richtung`/`.saldo`. Der
  TS-Zwilling `uemsMessstelleFormel.ts` trägt dieselben zwei Funktionen ADDITIV unter den
  bestehenden (keine Zeile oberhalb geändert).
- **Richtung je Typ (E1):** `rest` fest Wirkenergie · Bezug — auch mit den Termen Bezug + · Bezug − ·
  Bezug − (F1), die als `gewichtete_summe` `groessen_gemischt` (`richtung`) wären; `saldo` fest
  Wirkenergie · `saldiert`, an einer gemessenen Messstelle `groessen_gemischt`
  (`saldiert_nur_berechnet`) — der KATALOG entscheidet die Art (`groessePruefen(medium, art, g)`).
- **Terme eines `rest` (E3):** `speichertTerme("rest")` ist `false`; die Terme eines Tages leitet
  `BilanzAbleitung.restAusStellung(hauptzaehler, tag, stellungen)` aus den Stellungen ab (Regel
  `rest_aus_stellung` in `bilanz-vectors.json`).
- **Seit AP-10 IP-16:** Anlegen nimmt optional `formel_typ` (`gewichtete_summe` oder `saldo`)
  und `gueltig_ab` entgegen. Ohne beide bleibt Fassung 1 wie bisher eine Summe seit Beginn.
  Saldo liest genau zwei gemessene Wirkenergie-Messstellen: Hauptzähler Bezug mit `+` und
  Hauptzähler Abgabe mit `-` derselben Anlage am Beginn, jeweils Faktor 1 und Anteil `gesamt`.
  Die Geräte-Kontext-Prüfung gilt auch für diese Quellen. Ergebnis ist eine Intervallmenge;
  die CHECK-Erweiterung `V20260917106000` erlaubt `saldiert` ausschließlich an berechneten
  Hauptgrößen. Auch Saldo-Fassungen laufen durch die bestehenden Tages-/Größen-/Kreisprüfungen.
  Ungültige Paare liefern `groessen_gemischt` mit `grund: saldo_braucht_zwei` (F9).
- **Seit AP-10 IP-9 (13.09.2026) ist ein `rest` anlegbar — nur als bestätigter Vorschlag** „Rest
  anlegen“ (`POST /api/v1/sites/{siteId}/bilanz/rest`, E18): Fassung 1 vom Typ `rest` ohne ersten Tag
  und OHNE Terme, mit ihrem einzigen Parameter `rest_hauptzaehler_id` (`V20260913235700`: CHECK Rest ⇔
  Hauptzähler, höchstens ein nicht aufgehobener Rest je Hauptzähler, kein Term an einer Rest-Fassung).
  `POST …/{id}/formel/fassungen` lehnt einen Rest ab (400 `formel_typ`). Live-Wert und Verlauf eines
  Rests rechnen die Terme des Tages aus der Stellung und antworten in kW (Wirkleistung der
  Term-Messstellen). Das befristete Kennzeichen, das `wert` und `verlauf` von IP-9 bis IP-10 trugen, ist
  entfallen (§6.4).

### 6.4 Periodenwerte berechneter Messstellen (AP-10 IP-10, Stand 14.09.2026)

E6 = A ist gebaut: Viertelstunde, Tag, Monat und Jahr einer berechneten Messstelle (`gewichtete_summe`,
`rest`, seit IP-16 auch `saldo`) liegen in der Speicherklasse — Spur `berechnet` von `messreihe_viertelstunde`, `messreihe_tag`,
`messreihe_periode` (`messstelle_id`, `formel_fassung_id`, `formel_typ`; ohne Reihe) — mit ihren
Eingängen in `bilanzwert_eingang` (`V20260914100300`). Gerechnet vom Stundenlauf NACH den gemessenen
Stufen, in der Abhängigkeitsordnung der Fassungen; ein Formel-Kreis wird benannt abgelehnt
(`formel_kreis`/`haengt_an_kreis`). Der Wert je Periode ist `periodenwert` (§6.2) über die
Periodenwerte der Eingänge (nie Summe der Viertelstunden), vorläufig/endgültig über die Eingänge.
Gelesen über `GET /api/v1/messstellen/{kennzeichen}/werte`. Der Live-Wert (`wert`) und der Verlauf
(`verlauf`, Geräte-Verdichtung) bleiben für Summe und Rest unverändert und werden nie gespeichert.
Für Saldo liefern diese Sample-Leser keinen Wert bzw. keine Punkte: Zählerstände und Leistungs-Samples
sind keine Energiemengen desselben Intervalls. Der Mengen-Leseweg ist `werte`.
Nicht gerechnet: eine Formel mit Momentanwert (nur live), ein Term mit `anteil`
positiv/negativ oder Verteilung (verteilte Werte = IP-11) — der Eingang steht mit Grund und ohne Menge
im Satz; eine Periode, an deren Tagen verschiedene Terme gelten (`terme_wechseln`).

### 6.3 Die Term-Art `verteilung` und der `anteil` (AP-10 IP-5, Stand 13.09.2026)

§1.1 ist gebaut — als Speicher, Schnittstelle und Rechenweg, aber mit einem **benannt fehlenden
Leseweg**: den Teil eines Messwerts (`positiv`/`negativ`) liest erst die Quellenbindung mit Anteil
(AP-08 IP-7), den Anteil des Tages einer Kostenstelle erst die Verteilung (AP-10 IP-8). Bis dahin
wird **abgelehnt, nie geraten**.

- **Migration** `V20260913143000` (additiv): `anteil` (`positiv` | `negativ`, NULL = `gesamt` — genau
  EINE Schreibweise, keine Bestandszeile ändert sich), `verteilung_ziel` (die Kostenstelle, ⚠ noch
  OHNE Fremdschlüssel: `kostenstelle` entsteht mit IP-7, das den Schlüssel nachzieht). Die CHECKs sind
  vom aktuellen Stand abgeschrieben und geweitet: `eingang_art` + `verteilung`, die Bindung
  `verteilung` = Quell-Messstelle UND Ziel (kein Messkanal), ein Verteilungs-Term trägt Faktor 1.
- **Die EINE Stelle** `uems/AnteilLeseweg#lies`: Schreibweg, Live-Wert und Verlauf fragen nur sie.
  **Seit AP-10 IP-8 (13.09.2026) ist der Zweig `verteilung` eingelöst:** er liest die Zeilen von
  `messstelle_verteilung` am Tag, wählt über `VerteilungRegeln.amTag` die geltenden und rechnet über
  `AnteilLeseweg.tagesanteil(term, tag, abschnitte)` die Regel `term` aus
  [`verteilung-vectors.json`](./verteilung-vectors.json) (`VerteilungRegeln.term`). Ohne Zeile am Tag ist
  das Urteil `nicht_verteilt` (ein Zustand, nie eine Null). Der Zweig `anteil` wartet weiter.
- **Die Ablehnungen stehen im Vertrag**, Block `leseweg` von `verteilung-vectors.json`, mit Status,
  Feld, Paket und Kundensatz — in Prüfreihenfolge:

  | Code | Status | Fakten | Wann |
  |---|---|---|---|
  | `verteilungs_term_ohne_faktor` | 422 | `feld` | ein Verteilungs-Term mit Faktor ≠ 1 (Vertragsregel, wartet nie) |
  | `anteil_wartet_auf_ap08` | 422 | `feld`, `wartet_auf` | `anteil` = `positiv`/`negativ` |

  Form (400) und „fremd ist nicht da“ (404) gehen voraus. Nie `nicht_verteilt` oder
  `ziel_besteht_nicht`: die sagen etwas über eine VORHANDENE Verteilung. `verteilung_wartet_auf_ip8`
  (bis 13.09.2026 an dritter Stelle) ist mit AP-10 IP-8 eingelöst; an seiner Stelle prüft der
  Schreibweg, dass die Kostenstelle des Terms da ist (404 — nie der Fremdschlüssel als 500).
- **Rechnen:** steht ein solcher Term doch in der Datenbank, fehlt er — im Live-Wert unter
  `fehlende[]` mit dem Code als `grund`, im Verlauf ist der Bucket `null`. Der Anteil gilt je TAG: im
  Live-Wert der von heute, im Verlauf der des Tages, an dem der Bucket beginnt.
- **Zeichengleich:** `verteilung_ziel` und `anteil` stehen in `terme[]` NUR, wenn der Term sie trägt;
  jeder Term von vor IP-5 antwortet und protokolliert wie vorher. Eine Verkettung über einen
  Verteilungs-Term zählt für `formel_zyklus` wie ein Baustein.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='AnteilLesewegVectorsTest')                    # IP-5, rein
(cd services/api && ./mvnw test -Dtest='MessstelleFormelTermVerteilungMigrationTest,MessstelleFormelVerteilungsTermApiTest')  # IP-5, DB
(cd services/api && ./mvnw test -Dtest='MessstelleFormelRegelnVectorsTest')          # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsMessstelleFormel.test.ts)
(cd services/api && ./mvnw test -Dtest='MessstelleFormelTypenTest')                   # Typen je Typ (IP-4), rein
(cd frontend/portal && npx vitest run src/uemsMessstelleFormelTypen.test.ts)
(cd services/api && ./mvnw test -Dtest='MessstelleFormelFassungRegelnTest,MessstelleFormelSchnittstelleVertragTest')  # rein
(cd services/api && ./mvnw test -Dtest='MessstelleFormelTermMigrationTest,MessstelleFormelApiTest')  # gegen die DB
(cd services/api && ./mvnw test -Dtest='MessstelleFormelFassungMigrationTest,MessstelleFormelFassungApiTest')  # Fassungen, DB
```
