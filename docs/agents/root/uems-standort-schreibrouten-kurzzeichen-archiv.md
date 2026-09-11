# UEMS-Standort-Schreibrouten: anlegen, bearbeiten, archivieren, wiederherstellen

Neu angelegt am 11.09.2026 (AP-02 IP-4). Routen `StandortController`
(`POST /api/v1/standorte`, `PUT …/{id}`, `POST …/{id}/archivieren`, `POST …/{id}/wiederherstellen`,
`GET …/kurzzeichen-vorschlag`) und `UnternehmenController` (`PUT /api/v1/unternehmen`); Arbeit in
`uems/StandortService` und `uems/UnternehmenService`; Migration `V20260911210000__uems_ort_kurzzeichen.sql`.
Beweise: `StandortApiTest` (Keycloak + Timescale), `StandortLesemodellTest` (die Archiv-Lücke),
`OrtsbaumAbleitungVectorsTest` / `uemsOrtsbaum.test.ts` (A10 über `nameBelegt`).

## Die gemeinsamen Bausteine (IP-5 benutzt sie mit)

- **`OrtsbaumAbleitung` urteilt, sonst niemand.** Namensregel (`nameBelegt` + `nameBelegtSatz`,
  aus `wiederherstellen` herausgelöst, in beiden Zwillingen), Sperrgründe (`archivieren`),
  Wiederherstellen. Der Service baut dafür DENSELBEN Baum wie das Lesemodell
  (`StandortLesemodell.baum`) und schlüsselt ihn auf die KURZZEICHEN um — nur so sagen die Sätze
  „Werk Lindach (ST-2)“ statt einer UUID. Anlagen bleiben per ID im Baum.
- **`OrtKurzzeichen` + `V20260911210000`:** EINE Belegung `ort_kurzzeichen` für Standorte UND
  Gebäude/Bereiche (Trigger an beiden Tabellen, SECURITY DEFINER, App-Rolle nur SELECT) — ein
  Kurzzeichen ist über beide Tabellen eindeutig und nie wiederverwendet (auch früher getragen,
  archiviert, gelöscht). Zähler je Art in `ort_kurzzeichen_seq`, vergeben NUR über
  `uems_ort_kurzzeichen(tenant, art)` in der Transaktion des Schreibers (springt über Belegtes),
  Vorschlag über `uems_ort_kurzzeichen_vorschlag` (bewegt nichts).
- **`OrtProtokoll`:** genau EIN `ort_aenderung`-Eintrag je Schreibvorgang; die EINE Stelle, die
  `ProtokollAkteur` auf `akteur_sub`/`akteur_name` abbildet (Plattform-Betrieb →
  „VoltPilot (admin)“); `rueckwirkend` über `OrtsbaumAbleitung.rueckwirkung`.
- **`OrtFelder`** (Form, 400) · **`OrtAbgelehnt`** (`{code, message, …Fakten}`) ·
  **`OrtAbgelehntHandler`** (nur für die Ortsstruktur-Controller — IP-5 trägt seinen ein) ·
  **`web/OrtAnfrage`** (streng: unbekanntes Feld 400).
- **`OrtsbaumMessstellen`** ist der Haken für AP-04 IP-7: bis dahin keine Messstellen am Ort,
  die Sperre kennt nur aktive Anlagen. IP-7 liefert eine Bean (Eltern = Kurzzeichen).

## ⚠ Die Fallen

- **Die Archiv-Lücke eines Standorts lebt NUR im Protokoll.** Nach dem Wiederherstellen ist
  `archiviert_am` wieder NULL; das Lesemodell schneidet je Paar `archiviert` (gilt ab A) →
  `wiederhergestellt` (gilt ab W) die Tage A … W−1 heraus (`StandortLesemodell.bestehen`).
  Wer einen Standort anders archiviert/wiederherstellt als über `StandortService`, schreibt
  genau diese beiden Einträge — sonst ist die Lücke aufgefüllt.
- **„Heute“ hängt an der Uhr des Service** (`uhrStellen`, nur Tests) und an der Zeitzone des
  Standorts; `created_at` kommt beim Anlegen von DERSELBEN Uhr. Die Antwort ist der Standort
  zum Stichtag „heute“ dieser Uhr.
- **PLZ ist optional.** Pflicht sind Straße, Ort, Land (`StandortLesemodell.adresseVollstaendig`,
  auch für „es fehlt: Adresse“): das Referenzunternehmen führt aktive Standorte mit
  `plz: null` (nicht erhoben). Ist sie da, prüft `OrtFelder` das Format je Land.
- **Kein Löschen eines Standorts** (§4.1; App-Rolle ohne DELETE) — Löschen ohne Historie ist
  IP-15, nur Gebäude/Bereiche. Mitarchivierte Kinder: ihr offenes Intervall endet am Vortag;
  begann es erst heute, wird es AUFGEHOBEN (`gueltig_bis >= gueltig_ab` ist ein CHECK).
- **PUT ist die ganze Menge**; ein fehlendes Feld ist leer. Ohne Änderung: kein Eintrag.
