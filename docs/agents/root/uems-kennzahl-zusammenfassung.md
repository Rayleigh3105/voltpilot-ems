# UEMS-Kennzahl-Zusammenfassung über Ebenen (AP-11 IP-11, E5)

Neu am 15.09.2026. Summe durch Summe rechnet seit IP-6 (`uems-kennzahl-rechenlauf.md`); IP-11 macht die Form vollständig:
das Jahr nennt seine Paare, ein Paar mit Nenner 0 wird endgültig, der Assistent bekommt seine Paare. Keine Migration.
Spezifikation: AP-11 §8 IP-11, E5, §5.6; Referenzfälle K3, K9, K14.

| Teil | Stelle |
|---|---|
| Rechnen | NUR `KennzahlRegeln.wert` (Σ ÷ Σ, „x von y“, Richtung) — über `KennzahlLauf.ebene` (Paare) und `.zeit` (Teilperioden) |
| Herkunft der Zeit-Periode | `KennzahlLauf.zeit` schreibt die Paare DERSELBEN Periode als `kennzahl_wert_eingang` (`paarEingang`) |
| Paar ohne Zahl (K9) | `KennzahlLauf.zaehltMit` — als Teil endgültig, wenn seine eigenen Eingänge es sind |
| Naht | `KennzahlLauf.nachKorrektur` — derselbe Code, der Leser auf der Transaktion der Kaskade |
| Lesemodell | `GET …/werte` baut aus den gespeicherten Paaren den Satz (`KennzahlRegeln.herkunft`) — keine eigene Stelle |
| Assistent | `GET /api/v1/kennzahlen/paare?rechenform=&einheit=&standort_id=` → `KennzahlService.paare`; `api.ts` `KennzahlPaare` |

## ⚠ Fallen

- **Nie ein Mittel.** 0,3244 (K3) und 0,2346 (K14) sucht `UemsKennzahlRechenlaufTest` in jeder Zahl des Kundenbereichs —
  seit IP-11 samt der Paar-Jahreszeilen in der Herkunft; `KennzahlLaufQuelltextTest` verbietet `.divide(` in Lauf, Leser
  und Vorschau.
- **Gerechnet über die Teilperioden, genannt die Paare.** Der Wert des Jahres bleibt Σ ÷ Σ über die EIGENEN Monate (Vektor
  K14, auch „2 von 3 Monaten“); die Herkunft nennt die Jahreszeilen der Paare. Sind alle gebildet, sind deren Summen Zähler
  und Nenner des Jahres (Test). Im laufenden Jahr kann ein Paar „Periode nicht zu Ende“ tragen, während die
  Zusammenfassung schon vorläufig rechnet — die Herkunft zeigt, was gespeichert ist, sie gleicht nicht ab.
- **K9: ohne Zahl kein Zustand in der Tabelle** (`kennzahl_wert_version_zustand_chk`). Das „endgültig“ eines Paars ohne
  Zahl bestimmt der Lauf beim Lesen aus dessen Eingängen, geschrieben wird es nie. Nur für Kennzahlen, die die Periode
  direkt bilden; ein Paar ohne Zahl aus Teilperioden oder aus Paaren (Σ Nenner = 0) bleibt als Teil vorläufig — ebenso ein
  Paar ohne jede Zeile (Q6), die Zusammenfassung wartet dann.
- **Die Route ist streng:** ein unbekannter oder leerer Parameter ist 400 `anfrage_ungueltig` mit `feld`. Gruppen nach
  Rechenform (Vertragsreihenfolge), dann Einheit; die Kennzahl in der Form von `GET /kennzahlen`, nur nicht archiviert und
  mit heute geltender Fassung. `standort_id` vergleicht `Kennzahl.standort_id` — Unternehmens-, Prozess- und
  Kostenstellen-Kennzahlen fallen damit heraus. Die Sichtbarkeit R-A6 setzt erst AP-03 IP-11 durch (wie an der Liste).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='KennzahlSchnittstelleVertragTest,RechteKennungenDerRoutenTest,KennzahlLaufQuelltextTest')
(cd services/api && ./mvnw test -Dtest='UemsKennzahlRechenlaufTest,UemsKennzahlKaskadeTest')   # Testcontainers: K3, K9, K14, Naht
(cd services/api && ./mvnw test -Dtest='KennzahlApiTest,KennzahlWerteApiTest')                 # Testcontainers: Paar-Route
```
