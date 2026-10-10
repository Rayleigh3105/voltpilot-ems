# UEMS-Vorschlagsliste der Bestandsübernahme: aus Komponenten werden Messstellen

Neu am 11.09.2026 (AP-04 IP-16, Entscheid E6, Konzept §5.10/§5.15, Abnahme A9). Routen
`GET /api/v1/standorte/{id}/messstellen-vorschlag` und `POST …/messstellen-vorschlag/uebernehmen`
(`web/MessstelleVorschlagController`), Arbeit in `uems/MessstelleVorschlagService`, Form in
`web/dto/MessstelleVorschlagDto`. Die REGEL steht allein in
`uems/MessstelleRegeln.vorschlagsliste` ⟷ TS `uemsMessstelle.ts` (`vorschlagsliste`), Fälle in
`docs/contracts/v2/messstelle-vectors.json` Familie `vorschlag`, Prosa `messstelle.md` §11.
Migration `V20260911310000` (nur die Spalte `messstelle_quelle.herkunft`). Beweis:
`uems/MessstelleVorschlagApiTest` (A9 mit Gleichheits-Beweis), `MessstelleRegelnVectorsTest`
(elf Fälle + „die acht Vorschläge SIND MS-01…MS-08 des Referenzunternehmens“),
`src/uemsMessstelle.test.ts`. Das Portal ruft beide Routen seit AP-01 IP-9b im Assistenten „Messen &
Auswerten“ (Schritt 3, `uems-messen-assistent.md`); dazu im selben API-Test WAGO C-1 → vier Messstellen und
„genau ein Hauptzähler je Anlage“ (`wagoC1…`, `einBestehenderHauptzaehler…`).

## ⚠ Die Fallen

- **Nichts entsteht ungefragt (E6).** Das GET liest nur; erst die Bestätigung legt an. Die
  Übernahme schreibt ausschließlich in die `messstelle*`-Tabellen — Komponenten, Mess-Selektion,
  Geräte, Reihen, Anlagen-Antworten und die zwei Pushes an die Box bleiben byte-gleich (der Test
  vergleicht sie vor dem GET, nach dem GET und nach der Übernahme).
- **Je Komponente und Fluss höchstens EIN Vorschlag.** Zählerstand vor Leistung (aus einer
  Leistung wird die Wirkenergie integriert, `herleitung: integration`, gekennzeichnet für AP-08);
  der Ladestand ist NEBENGRÖSSE des Speicher-Flusses derselben Komponente. Alles andere steht mit
  Grund unter `ausgelassen` — `attribut_kanal` (`soc_source_code`, Namensraum `bms_`, Grenzen,
  Freigaben), `abgeleitet` (Haus), `vergleich_kandidat` (die Netzleistung am Wechselrichter zum
  Hauptzähler, E3), `vorzeichen_wert` (`import_export` — keine eigene Messstelle, sein Anteil kommt von Hand an Bezug und Abgabe, AP-08 IP-7), `gleicher_fluss`,
  `passt_nicht` (Regel 7), `ohne_messkanal`, `ohne_geraet`, `keine_messgroesse`, `ohne_richtung`,
  `weitere_groesse`.
- **Die Stellung kommt aus der Topologie, nie aus einem Namen:** maßgebliche Netzmessung =
  Kapazität mit Topologie-Rolle `grid` und `primary` (`TopologyService`); ohne sie hat die Anlage
  keinen Netzanschluss und bekommt keinen Hauptzähler. Ist an der Anlage schon ein Hauptzähler
  derselben Richtung, wird der Messwert `vergleich_kandidat` statt ein zweiter Hauptzähler
  (Regel 8). Findet ein Bezug keinen Hauptzähler, bleibt seine Stellung LEER — nie geraten.
- **Der Beginn ist der Verlauf, aber nie über einen Gerätewechsel hinweg.** `ab` ist der Beginn
  der LAUFENDEN Speisung (`geraet_komponente`), nicht der des ganzen Verlaufs: ein Messkanal
  gehört genau einem Gerät (Regel 6/W2), und verkettet wird von Hand (Hinweis
  `geraet_gewechselt`). Dazu nie vor dem ersten Tag des Standorts (`standort_spaeter`) — sonst
  gäbe es den Ort nicht, an dem die Messstelle sitzt.
- **Die Reihenfolge der Liste IST die der Übernahme:** je Anlage Hauptzähler → Erzeuger →
  Speicher → Unterzähler → Stellungsloses. Nur so trägt ein Unterzähler beim Schreiben ein
  Kennzeichen, das es schon gibt; wird sein Hauptzähler NICHT mitbestätigt, ist das 422
  `stellung_ungueltig` (`grund: bezug_fehlt`), und nichts wird geschrieben.
- **Bestätigt wird, was gezeigt wurde.** Die Zeile reist zurück (Komponente, Kanal, Hauptgröße,
  Nebengrößen, Stellung, `ab`; nur `name` darf anders sein); weicht sie ab, ist das 409
  `vorschlag_geaendert`. Ein Messwert, der dieselbe Messstelle schon führend speist, zählt als
  `unveraendert` — ein zweiter Aufruf legt nichts an.
- **Geschrieben wird über die vorhandenen Wege**, nicht daneben: `MessstelleService.anlegen`,
  `MessstelleZuordnungService.ortZuordnen`/`stellungZuordnen`, `MessstelleQuelleService.binden` —
  alle in EINER Transaktion, mit ihren Regeln und ihren Protokoll-Einträgen (Grund
  „Bestandsübernahme“, Bindung zusätzlich `herkunft = bestandsuebernahme`).
- **Die Freischaltung „nur mit Messen & Auswerten“ (E6) gibt es noch nicht:** sie hängt an den
  Funktions-Objekten aus AP-01 IP-2. Bis dahin schützt nur die Mandanten-RLS (fremder Standort =
  404). Hier wurde bewusst keine zweite Sperre erfunden.
