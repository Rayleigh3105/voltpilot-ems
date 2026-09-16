# UEMS-Fläche: die Box an der Quelle (AP-13 IP-12, L6 · W10)

Bis hierher sagte die Messstellen-Welt, welches **Gerät** misst — nie, welche **Box** es liest. Das steht in der
Zuständigkeit der Datenquelle (AP-06 IP-3) und stand in keiner Kundenfläche. IP-12 holt es an die zwei Stellen, an
denen der Kunde nach der Herkunft einer Zahl fragt: die Quelle-Karte der Messstellen-Seite und die Register-Spalte
„Quelle (führend)“ — dazu die Marker des Verlaufs.

Der Satz steht an **einer** Stelle, `frontend/portal/src/boxAnQuelle.ts`:

```
gelesen von {box} seit {zeitpunkt}   →   „gelesen von Box Halle 2 (neu) seit 04.11.2026 09:38“
```

Die Fläche reicht nur ihren Zeitpunkt-Text herein (Register „04.11.2026 09:38“, Karte „04.11.2026, 09:38 Uhr“).

## W10 — es gibt eine Box JE QUELLE, nicht je Anlage

Das Anlagen-Modell sagt „eine Anlage hat genau EINE VoltPilot-Box“. Für die Flächen, die AP-13 berührt, stimmt das
nicht: das Referenzunternehmen führt vier Boxen und sieben Datenquellen, und die Zuständigkeit wechselt mit der Zeit.
Das Wort wurde deshalb **genau dort** berichtigt, wo AP-13 es berührt — `komponenten.ts` (Kopf) und
`pages/AnlagenModellSection.tsx` (`boxRef`); dort ist „genau EINE Box“ jetzt die Bedingung für den WEG zur Geräteseite,
keine Aussage über die Anlage. **`edgeBoxLine` und die Box-Seite bleiben unangetastet — sie gehören AP-06 IP-16.**

## Die Regeln (keine zweite Regel-Logik)

- Welche Box zu einem Zeitpunkt liest, urteilt der Vertrags-Zwilling `uemsDatenquelle.zustaendigeBox` — halboffen auf
  die Minute, `effective_to` gehört **nicht** dazu. Der Tausch-Augenblick gehört schon der neuen Box.
- `zustaendigkeit(quelle, t)` gibt Box **und** den Beginn ihres laufenden Zeitraums (das „seit“).
- **Nichts wird erfunden.** Keine Zuständigkeit → kein Satz. Keine 0, kein „unbekannt“, keine Box aus der
  Nachbarschaft. Auch eine Box ohne Kundennamen (entfernte Box, `name === null`) bekommt keinen Satz: „gelesen von
  8f3e…“ ist kein Kundensatz. Dieselbe Regel wie `letzter_wert` in AP-04 IP-14.
- Eine Lücke zwischen zwei Zeiträumen bleibt eine Lücke — die nächste Box wird nie vorgezogen.

## Box-Tausch oder Übergabe — aus der Zeitachse gelesen

Die Werte-Route liefert an einem Ereignis nur `{id, art, von, bis}`; `handover` braucht aber `anlass`, `box_alt` und
`box_neu`. `boxWechsel(quelle, alle)` liest sie aus den Zuständigkeits-Zeiträumen: ein Wechsel ist die **Naht** zweier
Zeiträume mit verschiedenen Boxen (`effective_to` der alten = `effective_from` der neuen).

| Fall | Was die Zeitachse zeigt | Satz |
|---|---|---|
| `box_tausch` | die alte Box gibt **alle** ihre Zuständigkeiten in diesem Augenblick ab und behält keine (AP-06 E7) | „Box-Tausch: Box Halle 2 (neu) ersetzt Box Halle 2 — keine Werte von … bis …“ |
| `uebergabe` | nur diese eine Quelle wechselt, die alte Box liest anderswo weiter | „Übergabe von Box Halle 1 an Box Halle 2 (neu): keine Werte von … bis …“ |

⚠ Das Urteil gilt über die Quellen, die der Aufrufer geladen hat (heute: die einer Anlage). Liest eine Box über
Anlagen hinweg, braucht es die Quellen aller Anlagen — sonst hieße eine Übergabe fälschlich Box-Tausch. Ohne Treffer
zum Augenblick des Ereignisses bleibt der Kurz-Satz der Art stehen; **eine Box wird nie geraten.**

## ⚠ Der Weg Komponente → Datenquelle geht über die GERÄTE-Route (Befund an AP-06)

AP-13 §8 setzt „die Zuständigkeit der Datenquelle **der Komponente**“ voraus. `GET …/sites/{id}/data-sources` nennt
aber weder Komponenten noch Geräte einer Quelle — `geraete_ids` sind Modbus-Geräte-IDs, keine Kennungen des Portals.
Das Portal verbindet deshalb über `GET …/sites/{id}/geraete` und dessen `data_source_id`
(`boxAnQuelle.quellenJeGeraet`): **zwei Aufrufe je Anlage statt einem**, gemerkt in `useBoxenAnQuellen.ts`. Der Weg ist
echt (Fremdschlüssel `geraet → data_source`), gehört aber an die Datenquelle. Schlägt einer der beiden Aufrufe fehl,
steht die Fläche still genau so da wie vorher.

## Wo es hängt

| Fläche | Stelle |
|---|---|
| Register-Spalte „Quelle“ | `messstellen.ts` (`ZeileWoerter.quelle.box`, `WortKontext.boxen`), Render `pages/MessstellenPage.tsx` (`.vp-ms-box`) |
| Quelle-Karte | `quelleBinden.ts` (`QuelleWort.box`, dritter Parameter von `quelleKarte`), Render `components/QuelleKarte.tsx` (`.vp-qk-box`) |
| Verlauf-Marker | `uemsVerlauf.markerSatz`/`marker` (vierter Parameter), durchgereicht von `WerteSektion` → `MessstellenVerlauf` |
| Laden | `useBoxenAnQuellen.ts` — je Anlage einmal, Fehler bleiben still |

⚠ Die Karte fragt für eine **laufende** Bindung nach der Box von jetzt, für eine **geplante** nach der ihres ersten
Tages; das Register fragt zum `zeitpunkt` der Antwort (mit Stichtag also zu dessen Beginn).

⚠ Die Gerät-Kennungen der Fixtures sind EINE Reihe: `test/datenquellenFixtures.geraetId` — Register,
`quelleBindenFixtures` und die Datenquellen teilen sie. Wer eine ändert, ändert alle; `datenquellenFixtures.test.ts`
vergleicht Namen, Zeitpunkte, Adressen und die Zuordnung Gerät → Datenquelle Zeile für Zeile gegen
`docs/contracts/v2/uems-referenzunternehmen.json` (die Bühne darf `docs/contracts` nicht laden).
