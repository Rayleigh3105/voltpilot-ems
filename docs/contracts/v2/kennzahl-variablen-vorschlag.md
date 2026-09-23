# Variablen-Vorschlag einer Kennzahl aus dem Energieeinsatz (UEMS AP-17)

Stand 23.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap17-fundament` §4.4 V4/V5, §4.8 G4, Referenzfall R9, Entscheide
E3 = A und W1 vom 23.09.2026 · Bau-Paket IP-11a (der Lese-Teil; die Übernahme in eine Fassung der Bezugsbasis mit der
Ablehnung `variablen_abhaengig` ist IP-11b, nach IP-8/IP-9).

Eine Kennzahl hat genau einen Nenner, ein Energieeinsatz nennt seine Einflussgrößen — als Verweis auf eine Bezugsgröße
(BZ-…) oder als Wortlaut (AP-16, `energieeinsatz_einflussgroesse`). Die beiden Objekte kennen einander nicht, und das
bleibt so (W1): **am Einsatz wird nichts gerechnet** (AP-16 B5 wörtlich), an der Bezugsbasis wird mit Bezugsgrößen
gerechnet. Der Vorschlag ist die Brücke zum Ansehen — er übernimmt nichts und verändert nichts.

| Datei | Rolle |
|---|---|
| [`kennzahl-variablen-vorschlag.schema.json`](./kennzahl-variablen-vorschlag.schema.json) | die Form der Antwort (JSON-Schema 2020-12) |
| [`variablen-vorschlag-vectors.json`](./variablen-vorschlag-vectors.json) | Abhängigkeits-Regel G4 (Fälle, Schwelle, Vokabular) und die Kundensätze |
| `services/api/.../uems/VariablenAbhaengigkeit.java` | Java-Zwilling der Regel G4 |
| `frontend/portal/src/variablenAbhaengigkeit.ts` | TS-Zwilling der Regel G4 |
| `services/api/.../uems/VariablenVorschlag.java` | der Leser |
| `GET /api/v1/kennzahlen/{id}/variablen-vorschlag` | die Route (`KennzahlVariablenVorschlagController`), OpenAPI `KennzahlVariablenVorschlag` |

## 1. Welche Einsätze gelesen werden (V4)

1. Ist die Geltung der Kennzahl ein **Prozess**: die laufenden Energieeinsätze dieses Prozesses (jeder Träger) —
   `bezug` = `prozess`.
2. Sonst, oder wenn der Prozess keinen laufenden Einsatz hat: die laufenden Einsätze der Prozesse, denen eine
   **Zähler-Messstelle** der heute geltenden Fassung heute direkt zugeordnet ist (`messstelle_prozess`) —
   `bezug` = `zaehler_messstellen`.
3. Sonst `bezug` = `keiner`: leere Listen und der Satz „Zu dieser Kennzahl gehört kein Energieeinsatz: weder ihr Prozess
   noch die Messstellen ihres Zählers sind einem Energieeinsatz zugeordnet. Es gibt keine Einflussgrößen vorzuschlagen.“

Beendete Einsätze schlagen nichts vor. Einsätze stehen nach der Nummer ihres Kennzeichens.

## 2. Was aus einer Einflussgröße wird

- Ein **Verweis** wird ein Kandidat mit seiner Bezugsgröße (Kennzeichen, Name, Art, Wertart, Einheit, Periodenart,
  `hat_werte`, `hat_kanal`) und den Kennzeichen der Einsätze, die ihn nennen — eine Bezugsgröße, die mehrere Einsätze
  nennen, steht EINMAL da.
  - Ist sie der Nenner der heute geltenden Fassung: `vorschlag` = `variable_1` (V2). Variable 1 steht zusätzlich oben als
    `variable_1`, auch wenn kein Einsatz sie nennt; ein Nenner, der keine Bezugsgröße ist, macht `variable_1` = `null`.
  - Ist sie ein Stammdatum: `vorschlag` = `statischer_faktor` mit „Stammdatum — ein statischer Faktor, keine Variable.“
    (V2, V3) — keine Prüfung.
  - Sonst `vorschlag` = `variable` mit dem Hinweis `abhaengigkeit` gegen Variable 1 (§3).
- Ein **Wortlaut** bleibt Freitext: eine Zeile `ohne_zahl` mit Wortlaut, Art am Einsatz, Einsatz-Kennzeichen und dem
  Satz „ohne Zahl — erst als Bezugsgröße erfassen“ (§5.8). Nichts davon wird zur Variablen.

## 3. Die Abhängigkeits-Regel G4

Pearson-r zwischen Variable 1 und dem Kandidaten über die **Monatspaare der Referenzperiode**: je Monat der
Periodenwert, gelesen wie ein Nenner (wirksame Fassung, nie verteilt, nie interpoliert, `KennzahlEingangLeser`); ein
Monat zählt nur, wenn BEIDE einen Wert haben.

| Ergebnis | wann | `r` | `grund` |
|---|---|---|---|
| `variablen_abhaengig` | \|r\| ≥ 0,9 (Startwert, G6 — auch genau auf der Schwelle, auch gegenläufig) | ungerundet | `null` |
| `unabhaengig` | \|r\| < 0,9 | ungerundet | `null` |
| `nicht_pruefbar` | weniger als 3 Paare · eine Reihe konstant · Variable 1 fehlt oder ist ein Stammdatum | `null` | `zu_wenig_paare` · `keine_streuung` · `keine_variable_1` |

**Eine Wahrheit:** die Entscheidung an der Schwelle trifft die Regel der Bezugsbasis
([`bezugsbasis.md`](./bezugsbasis.md) G4, `BezugsbasisRegeln.abhaengigkeit` ⟷ `bezugsbasis.ts`, exakt als
`Sxy² ≥ 0,81 · Sxx · Syy`); `VariablenAbhaengigkeit` ⟷ `variablenAbhaengigkeit.ts` tragen nur die Paare, die Gründe
ohne Zahl und r für die Anzeige. `gegen` nennt Variable 1, `schwelle` den Startwert. Bei `variablen_abhaengig` trägt der Kandidat den Satz
„{Kandidat} hängt an {Variable 1} (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.“
(r mit drei Stellen, Komma, echtem Minus). Das ist ein **Hinweis**: der Vorschlag lehnt nichts ab. Abgelehnt — mit dem
§5.8-Satz „Betriebsstunden nicht aufgenommen: …“ und einem Eintrag im Protokoll — wird erst beim Übernehmen in eine
Fassung (IP-11b).

**Referenzperiode:** Parameter `referenzperiode=JJJJ-MM/JJJJ-MM` (beide Monate eingeschlossen, höchstens 120); ohne ihn
die zwölf abgeschlossenen Monate vor dem laufenden in der Zeitzone der Geltung (die Mindestlänge als Startwert). Ein
anderer Parameter, eine falsche Form oder eine umgekehrte Periode ist 400 `anfrage_ungueltig` mit `feld`.

## 4. Rechte und Zaun

Lesen wie die Kennzahl selbst: Kennung `messwerte.ansehen` (keine eigene Kennung, kein `@Recht` an der Lese-Route);
der Zaun ist `KennzahlService.eine` — eine unbekannte, fremde oder außerhalb der Sichtbarkeit liegende Kennzahl ist 404
`nicht_gefunden`, nie 403. Einsätze und Bezugsgrößen werden unter der RLS der Anwendungsrolle gelesen.

## 5. Referenzfall R9 (Kunststoffwerk Ahrenberg)

KZ-0004 (Geltung P-1 Spritzguss), EE-1 Spritzguss nennt BZ-1 Produktionsmenge (`produktion`) und BZ-3 Betriebsstunden
(`betriebszeit`): BZ-1 ist `variable_1`, BZ-3 ein Kandidat mit r = 0,997 über November 2026 bis Oktober 2027 →
`variablen_abhaengig` gegen BZ-1. Die Leckagerate steht im Referenzunternehmen als Freitext an EE-3 Druckluft (P-3) —
V4 liest nur die Einsätze der Geltung, sie erscheint an KZ-0004 also nur, wenn ein Einsatz von P-1 sie nennt
(`VariablenVorschlagApiTest` legt dafür einen zweiten Einsatz von P-1 mit Träger Druckluft an).
