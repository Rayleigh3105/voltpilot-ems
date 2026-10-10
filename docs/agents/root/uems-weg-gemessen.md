# UEMS — der gemessene Weg: Ebene → Welt → Zahl → Nachweis (AP-13 IP-13)

Konzept: AP-13 §4.12 (M1–M5), Kasten E14 = A, Referenzfall O17 (`frontend/portal/src/test/oberflaechenFaelle.json`);
die Flächen selbst: `uems-oberflaechen-ebenen.md`, `uems-werte-je-messstelle.md`, `uems-verlauf-messstelle.md`,
`uems-vergleich-messstelle.md`, `uems-versionen-lesen.md`, `uems-gebaeude-karte.md`, `uems-bilanz-flaeche.md`,
`uems-kostenstellen-flaeche.md`.

Dieses Paket baut KEINE Fläche. Es beweist die gebauten: einen Durchlauf mit echten Klicks, bei 375 und 1440 px,
mit einer Zahl je Zusicherung statt einer Behauptung.

## Was wo steht

| Was | Wo |
|---|---|
| Der Lauf | `frontend/portal/e2e/weg.spec.ts` — zwei Prüfungen: *der gemessene Weg* (ein Lauf über acht Stationen) und *die Welten, die die Bühne öffnet* (jede Station einzeln) |
| Bühne | `frontend/portal/e2e/startansicht.tsx` (`startansicht.html`) — dieselbe Schale, dieselben Seiten wie `App.tsx` |
| Bilder | `WEG_BILDER=<Ordner>` legt je Station `<name>-<breite>.png` und je Breite `messung-weg-<breite>.json` / `messung-welten-<breite>.json` ab |
| Zahlen | allein aus den Fixtures der Referenzfälle (`werteKarteFixtures`, `wertVersionenFixtures`, `vergleichFixtures`, `messstelleSeiteFixtures`, `messstellenRegisterFixtures`) — die Bühne erfindet keine |

## Die Adressen der Bühne (IP-13)

| Adresse | Was sie öffnet |
|---|---|
| `?bild=unternehmen&ansicht=werk-gebaeude` | Standort › Gebäude mit dem Ortsbaum (IP-2) und den Gebäude-Karten (IP-10) |
| `?bild=standort&stand=2026-11-21&ansicht=werte&ms=MS-10&tag=2026-11-03` | Messstellen-Seite › Werte für diesen Tag |
| `…&ansicht=verlauf&ms=MS-10&mon=2026-11` | derselbe Abschnitt im Monat — der Verlauf in Tagen |
| `…&ansicht=vergleich&ms=MS-10&mon=2026-11&v=vorperiode` | dazu der Umschalter des Vergleichs (O11) |
| `?bild=unternehmen&ansicht=bilanz&an=AN-2` | Anlage › Verlauf › Energiebilanz (IP-8) |
| `?bild=unternehmen&ansicht=kostenstellen` | Unternehmen › Messstellen › Kostenstellen (IP-9) |

`&stand=` ist der Stichtag, den das Register als „heute“ ausgibt — er entscheidet, auf welchem Tag der Einstieg
„Werte“ des Registers landet (Stichtag, sonst Vortag; AP-13 IP-3). `&ms=`/`&tag=`/`&mon=`/`&v=`/`&version=` sind
Periode, Version und Vergleich des Abschnitts „Werte“.

## Was der Lauf misst — mit Zahlen

- **Querlauf 0** am Dokument UND an jedem sichtbaren Element von `.vp-main`/`.vp-modal`, im Dialog zusätzlich am
  Körper (`.dbody`). Ausgenommen ist nur die Reiter-Leiste der Bereiche (`.vp-bereich-tabs`), ihr eigener
  Rollbereich — wie in `standort-ebenen.spec.ts`.
- **Tippflächen ≥ 44 px** bei 375 px, je Station die kleinste gemessen und benannt.
- **Keine Konsolenfehler** — gesammelt über den ganzen Lauf (`console.error` + `pageerror`), nicht je Station.

## Die Fallen

- ⚠ **Eine Tippfläche ist nicht `getBoundingClientRect()` des Knopfes.** Am Telefon ist die GANZE Register-Karte der
  Einstieg in die Werte; gebaut ist das über ein `::after { position: absolute; inset: 0 }` am Knopf, der nur den
  Namen umschließt (`MessstellenPage.css`, `.vp-ms-karte-werte`). Wer den Knopf misst, misst 20 px und meldet einen
  Fehler, den es nicht gibt. `weg.spec.ts` löst das `::after` auf seinen gestellten Vorfahren auf (`flaeche()`).
- ⚠ **Der Einstieg „Letzter Wert“ steht nur an einer Zeile MIT Wert.** Das Register des Referenzunternehmens trägt
  seine Momentanwerte allein am 20.10.2026 (`messstellenRegisterFixtures`: `heute = tag === REGISTER_HEUTE`); an jedem
  anderen Stand führt am Rechner nur das Zeilenmenü in die Werte.
- ⚠ **Der Einstieg landet auf dem VORTAG** — einen älteren Tag erreicht der Kunde über „Stand am …“ (dann ist die
  Periode der Stichtag selbst). Deshalb geht der Lauf am 21.11.2026 und stellt das Register auf den 03.11.2026
  zurück: nur so liegen die Versionen der Zahl (06.11. und 20.11.2026) vollständig in der Vergangenheit.
- ⚠ **Die Bühne stellt das Register jetzt mit seinem Wirt wie `App.tsx`** — mit `onOeffnen`/`onWerte` und damit mit
  der Spalte „Aktionen“ am Rechner. `messstellen.spec.ts` zählt die Spalten und wurde mitgezogen.
- ⚠ **Die Werte-Route der Bühne antwortet nur im Weg-Bild** (`&ansicht=werte|verlauf|vergleich` oder `&stand=`).
  Sonst fragt allein der Bericht-Nachweis nach einem Wert („heutigen Wert zeigen“, AP-12 IP-13) und bekommt weiter
  seine eigene Antwort — sonst läse die Berichtsseite plötzlich Monatswerte aus `vergleichFixtures`.
- ⚠ **Die Bühne führt ihre Adresse als `data-route`**, nicht im echten Hash. Periode, Version und Vergleich der
  Messstellen-Seite hängen deshalb als Zustand an der Bühne und werden an `data-route` angehängt; 14 Specs messen
  diese Zeichenkette.
- ⚠ **Die Spec importiert keine Fixtures** — sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt.

## Befund (an AP-08)

Der Verlauf des 03.11.2026 zeigt die GEMESSENEN Viertelstunden mit der Lücke 14:00–17:31 (F8/O1), während die Karte
desselben Tages den Ersatzwert nennt (F21, Version 3: 2 354,4 kWh „Zuwachs nach dem Profil der Vergleichsquelle
verteilen“). Die Referenzdatei trägt keine ERSETZTEN Viertelstunden — ob ein Ersatzwert das feine Raster füllt oder
nur die Tagesmenge bildet, ist eine Regel von AP-08, nicht von AP-13. Die Bühne zeigt beides so, wie die Fixtures es
tragen, und erfindet nichts dazwischen.

## Nicht gebaut

WebKit (`mobile-webkit`) läuft im Repo nicht — der Browser ist nicht installiert; der Lauf fährt `desktop-chromium`
und `mobile-chromium`, beide über BEIDE Breiten. Der Weg endet am Nachweis der Messstelle; die Kette weiter zur
Kennzahl und zum Bericht prüft `uems-spruenge-kette.md` (IP-11).
