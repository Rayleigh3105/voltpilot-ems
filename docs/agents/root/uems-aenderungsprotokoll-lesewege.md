## UEMS-Änderungsprotokoll: drei Lesewege, zwei Zeitachsen (AP-04 IP-21)

**Kein neuer Schreibweg.** Einträge schreiben seit AP-02/AP-04/AP-06 die Fachwege selbst
(Messstelle anlegen · bearbeiten · anhalten · fortsetzen · archivieren, Ort und elektrische
Stellung, Quellenbindung, Einstellungs-Fassung, Zählerwechsel, Datenquelle). IP-21 macht sie
LESBAR — je Messstelle, je Gerät und für das ganze Unternehmen über einen Zeitraum:

- `GET /api/v1/messstellen/{id}/aenderungen`
- `GET /api/v1/geraete/{id}/aenderungen`
- `GET /api/v1/unternehmen/aenderungen`

Alle drei: `von` · `bis` · `achse` · `limit` (Vorgabe 100, höchstens 500) · `nach`. Recht
`aenderungsprotokoll.lesen` im Routen-Kommentar (`AenderungsprotokollController`,
`RechteKennungenDerRoutenTest`); fremd ist 404, nie 403. Antwort: `ProtokollDto` bzw. das
OpenAPI-Schema `Protokoll`.

### ⚠ Die zwei Zeitachsen — die Falle dieses Pakets

Jeder Eintrag hat ZWEI Zeitpunkte, und sie sind verschieden:

| | |
|---|---|
| `gilt_ab` | WANN die Änderung gilt — die **Wirkung** |
| `eingetragen_am` (`created_at`) | WANN sie eingetragen wurde — der **Eintrag** |

Der Zählerwechsel von MS-06 gilt am 18.11.2026 um **10:40** und wurde um **11:05** eingetragen;
eine angekündigte Änderung gilt in der Zukunft. Ein Zeitraum-Filter auf der falschen Achse
verliert genau die Einträge, um die es geht.

**Entschieden:** `achse` ist ein AUSDRÜCKLICHER Parameter mit der Vorgabe `wirkung`
(= `gilt_ab`) — die Abnahme von IP-21 verlangt, dass der rückwirkende Wechsel im Zeitraum des
BETROFFENEN Zeitpunkts steht. `achse=eintrag` filtert und sortiert nach `eingetragen_am`.
Welche Achse gewirkt hat, steht in der **Antwort** (`achse`), nicht nur in der Anfrage — und
jede Zeile trägt BEIDE Zeitpunkte nebeneinander. `zeitform` ist das Urteil dazu:
`rueckwirkend` (das GESPEICHERTE Urteil des Schreibwegs, nie nachgerechnet) ·
`angekuendigt` (`gilt_ab` nach dem Eintrag) · `sofort`.

### ⚠ Die Überbrückung uneinheitlicher Journal-Spalten (Nacharbeit AP-03 IP-7)

Die drei Journale sind nicht zeichengleich. `AenderungsprotokollRepository` überbrückt das an
GENAU DREI Stellen, ohne eine Tabelle umzubenennen — wer sie vereinheitlicht, findet sie dort:

1. **Urheber.** `messstelle_aenderung` und `data_source_aenderung` tragen
   `actor_sub/name/rolle/art`; `ort_aenderung` kennt nur `akteur_sub`/`akteur_name`. Die Rolle
   eines Orts-Eintrags ist deshalb `null` = „nicht festgehalten“ — nie geraten; seine Art ist
   `voltpilot`, wenn der Name das Wort trägt, das `OrtProtokoll.akteurName` dafür schreibt.
2. **„gilt ab“.** In `ort_aenderung` ein TAG, sonst ein Zeitpunkt. Der Tag wird auf seinen
   Beginn in `MessstelleService.ZEITZONE` gehoben (Berlin/Wien/Zürich haben denselben Versatz).
3. **„rückwirkend“.** `messstelle_aenderung` und `ort_aenderung` haben die Spalte;
   `data_source_aenderung` hat sie NICHT — dort auf die Minute abgeleitet, wie ihr Schreibweg
   rechnet.

**Ein Gerät hat kein eigenes Journal.** Seine Einträge hängen an den Messstellen, die es
speist, und nennen es über sein EINBAU-KENNZEICHEN in ihrem JSON (`neu.einbau`, `alt.einbau`,
`neu.vorgaenger`, `neu.beendet.einbau`). Das Kennzeichen ist je Kundenbereich eindeutig
(`uq_geraet_einbau_kennzeichen`) und wird nie weitergegeben — ein Wechsel legt eine NEUE
`geraet`-Zeile an. Ein Zählerwechsel steht deshalb in BEIDEN Geräte-Protokollen: beim
ausgebauten und beim eingebauten.

### Der Unternehmens-Weg

Er führt `messstelle_aenderung`, `ort_aenderung` und `data_source_aenderung` in **EINER**
Abfrage zusammen (UNION ALL in einem einfachen CTE, Namen der Bezugsobjekte über LEFT JOINs —
keine N+1; 200+ Einträge in 44 ms bei genau 1 Abfrage, nachgezählt am DataSource). Sortierung
`achse DESC, quelle ASC, id DESC`; genau dieses Tripel ist der Fortsetzungszeiger `weiter`
(`<millis>:<quelle>:<id>`), deshalb springt die Seitenweise auch bei gleichen Zeitstempeln
nicht — ein Zählerwechsel schreibt an JEDER betroffenen Messstelle dasselbe „gilt ab“, und die
laufenden Nummern der drei Journale sind voneinander unabhängig. Keine neue Migration: die
Indizes `idx_*_aenderung_gilt_ab` bestehen seit V20260911100000/V20260911140000.

### Der Kundensatz

`AenderungSatz` (rein, ohne Spring) macht aus `art` + `alt`/`neu` den Satz „was wurde
geändert“ — „Zähler gewechselt: Z-5a → Z-5b“, „Quelle gebunden: Z-5b · Wirkenergie · Bezug
(führend)“. Größen-, Richtungs- und Stellungswörter stehen schon als Kundenwörter im JSON
(`messstelle.schema.json`) und werden übernommen; ein fehlendes Feld wird weggelassen statt
erfunden, eine unbekannte Art steht als ihr Code da statt zu verschwinden
(`AenderungSatzTest` hält die drei CHECK-Vokabulare vollständig).

### Portal

`src/uemsProtokoll.ts` (rein) setzt Zeiten, Urheber und Zeitform neben den Satz und gruppiert
nach Tagen — dieselbe Mechanik wie der Befehls-Verlauf (`befehleVerlauf.ts`), dieselben Klassen
(`pages/Befehle.css`), kein neues Gestaltungssystem. `components/ProtokollListe.tsx` rendert und
lädt; `ProtokollDialog` ist die Hülle. Wirte: die Gesamtwert-Karte (Zeilenmenü
„Änderungsprotokoll“, je Messstelle) und die Geräteseite (Block in der Sektion „Komponenten“ —
`GeraetProtokoll` geht über `geraetZuKomponenten` von der Komponente zum UEMS-Gerät und rendert
ohne auflösbares Gerät GAR NICHTS).

**Tests:** `AenderungsprotokollApiTest` (Testcontainers, MS-06-Zeitstrahl: beide Achsen,
angekündigt, je Eintragsart ein Wortlaut, beide Seiten des Wechsels, Seitenweise, Mandantenzaun,
Laufzeit), `AenderungSatzTest` (rein), `uemsProtokoll.test.ts` (Vitest).
