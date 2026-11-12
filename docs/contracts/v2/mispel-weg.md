# MiSpeL — Der Weg zu MiSpeL je Anlage (MP-55)

Stand 19.10.2026 · Vertrag 1.0 · Quelle: Bedienkonzept „MiSpeL für Interessenten“, BK-52 Variante A „Strecke mit
Stand an der Anlage, dazu der Artikel“ (Captain 13.10.2026), Teil A Stationstabelle und Abschnitt 3.3; Bauplan MP-55
(Bau „2. A“, 19.10.2026). Festlegung: BNetzA zur Marktintegration von Speichern und Ladepunkten („MiSpeL“,
Az. 618-25-02, Beschluss 01.10.2026), Tenor Ziff. 9a/9b.

Der Leseweg beantwortet je Anlage: „Wie wird diese Anlage zur MiSpeL-Anlage — und wo steht sie heute?“ Er liest die
vorhandenen MiSpeL-Quellen zusammen und gibt die Stationen der Strecke mit Zustand, einem Satz zum Stand und der Tür auf
die Fläche, die es dafür schon gibt. **Keine neue Tabelle, keine Migration, kein Schreibweg.** Die Fläche im Portal
(Blatt „Ihr Weg zu MiSpeL“, Zeile in der Übersicht, Hilfe-Artikel) ist MP-56.

| Datei | Rolle |
|---|---|
| `services/api/.../mispel/MispelWegRegeln.java` | rein: Stationsfolgen, Zustände, `jetzt`, Satz, Wörter |
| `services/api/.../mispel/MispelWegService.java` · `MispelWegRepository.java` | liest die Quellen unter RLS (§ 6) |
| `services/api/.../web/SiteMispelWegController.java` · `web/dto/MispelWegDto.java` | `GET /api/v1/sites/{siteId}/mispel-weg` |
| `docs/contracts/v2/mispel-weg-vectors.json` | Stationsfolgen mit Wortlaut, Vokabulare, 16 Fälle: die sechs Demo-Anlagen und Randfälle |
| `…/mispel/MispelWegRegelnTest.java` | die Vektoren gegen Regeln und Antwort (rein, ohne Datenbank) |
| `…/mispel/MispelWegApiTest.java` | die sechs Demo-Anlagen aus der Datenbank gegen dieselben Vektoren; Zaun (Testcontainers) |

## 1. Die Strecken einer Anlage

`strecken` ist eine Liste; die erste ist die der Übersichts-Zeile (`satz` oben = `satz` der ersten Strecke).

| `art` | Titel | Stationen | wann |
|---|---|---|---|
| `abgrenzung` | Ihr Weg zu MiSpeL | 8 (Gewerbe) | Anlage mit stationärem Speicher (`asset.type = 'battery'`), wenn nicht `pauschal` |
| `pauschal` | Ihr Weg zu MiSpeL | 8 (Haushalt) | Anlage mit stationärem Speicher, wenn die Pauschaloption gewählt, als Fassung vorgemerkt, als Pauschal-Vormerkung stehend oder gerechnet ist (Check mit Formelsatz P…), oder wenn das Profil `privat` ist und die Solarleistung im Aufbau 30 kWp nicht übersteigt (unbekannt zählt nicht dagegen) — es sei denn, die Abgrenzungsoption gilt oder ist vorgemerkt |
| `ladepunkt` | Das Auto als Speicher | 6 | je Ladepunkt (`ev-charger`, `wallbox`), der heute zurückspeisen kann; an einer Anlage ohne stationären Speicher auch ein Ladepunkt, der nur laden kann |

„Die Abgrenzungsoption gilt“ heißt: Förderweg `marktpraemie_abgrenzung`, oder `ungefoerdert` mit einem Formelsatz der
Anlage 1 (Tenor Ziff. 1 S. 2; [Förderweg § 1](./mispel-foerderweg.md#1-die-fünf-werte-begriffe-aus-eeg-und-festlegung)).
Ohne Speicher und ohne Ladepunkt ist die Liste leer und `satz` lautet „Diese Anlage hat keinen Speicher und keinen
Ladepunkt im Aufbau – MiSpeL betrifft sie nicht.“

## 2. Zustand, `jetzt` und der Satz

| `zustand` | heißt |
|---|---|
| `erledigt` | die Station liegt hinter der Anlage |
| `jetzt` | die eine Station, an der als Nächstes gehandelt wird |
| `offen` | noch nicht erledigt; auch: die Quelle dafür gibt es noch nicht („Noch nicht erfasst: …“) |
| `wartet` | hängt an etwas, das nicht der Kunde tut: Genehmigung, vorgemerkter Monatserster, ein Lauf, der begonnen hat |
| `gesperrt` | kann nicht beginnen, bevor eine Sperre fällt (EU-Genehmigung, Prüfstand) |

**`jetzt`** ist die erste `offen`e Station, die nicht von selbst läuft (`wer` ≠ `voltpilot`), vor der ersten
`wartet`- oder `gesperrt`-Station; danach gibt es kein `jetzt`. Höchstens eine je Strecke.

**`satz`** je Strecke: „{n} von {m} erledigt“ und danach, in dieser Reihenfolge, das Erste, was zutrifft:

1. eine Sperre von außen, solange ihre Station wartet oder gesperrt ist: „wartet auf die EU“ (Pauschaloption,
   Station 5), „Zurückspeisen noch aus“ (Ladepunkt, Station 5);
2. der Check rät ab und noch ist nichts gewählt: „gerechnet: lohnt sich voraussichtlich nicht“ (ganze Euro < 0, wie
   die Check-Karte im Portal);
3. „jetzt: {Titel}“;
4. die erste wartende Station: „läuft: {Titel}“ (`wer` = `voltpilot`), sonst „wartet: {Titel}“;
5. die erste nicht erledigte: „als Nächstes: {Titel}“; sind alle erledigt, nur „{m} von {m} erledigt“.

## 3. Wer

| `wer` | Marke im Konzept |
|---|---|
| `portal` | im Portal — führt das Portal |
| `aussen` | außerhalb — erledigen Sie (oder ein Dritter wie die EU-Kommission) |
| `beides` | Portal + außerhalb |
| `voltpilot` | macht VoltPilot — läuft von selbst |

## 4. Türen

`tuer` ist `{ziel, beschriftung}` oder `null`. `ziel` ist eine Fläche, die es schon gibt; das Portal (MP-56) bildet es
auf seine Adresse ab:

| `ziel` | Fläche |
|---|---|
| `check` | die Rechnung (Schritt 1 des Dialogs „Förderweg ändern“, [Check](./mispel-check.md)) |
| `foerderweg` | der Dialog „Förderweg ändern“ (Förderweg, Formelsatz, Einverständnis, Vormerkung, Voraussetzungen) |
| `messstellen_register` | das Messstellen-Register mit den Zählerrollen |
| `partnerangaben` | der Schritt „Partner“ im Dialog „Förderweg ändern“ |
| `nachweis` | Monats- und Jahresnachweis (PDF und Tabelle je Empfänger) |
| `erloese` | Verlauf › Erlöse (Monat, Jahresstand, Erträge am Ladepunkt) |
| `aufbau` | Anlage › Aufbau (der Ladepunkt) |
| `wallbox_karte` | die Wallbox-Karte unter Steuerung › Laden (Abfahrt und Reserve, Zurückspeisen) |

## 5. Route

`GET /api/v1/sites/{siteId}/mispel-weg` — nur lesend, Leseweg der Anlage (`messwerte.ansehen`, außerhalb des Zugriffs
404, wie `GET …/mispel-check` und `GET …/foerderweg`). `heute` ist der Tag nach der Uhr des Förderwegs (Europe/Berlin).
Antwort (snake_case, gekürzt):

```json
{ "site_id": "…", "heute": "2026-10-19", "satz": "3 von 8 erledigt · jetzt: Förderweg wählen",
  "strecken": [
    { "art": "abgrenzung", "titel": "Ihr Weg zu MiSpeL", "komponente_id": null, "erledigt": 3, "gesamt": 8,
      "satz": "3 von 8 erledigt · jetzt: Förderweg wählen",
      "stationen": [
        { "nr": 1, "schluessel": "rechnen", "titel": "Rechnen: Lohnt es sich?",
          "erklaerung": "Dieselbe Anlage, heute gegen mit MiSpeL – über ein ganzes Jahr.", "wer": "portal",
          "zustand": "erledigt", "stand": "+ 1.899 € im Jahr · lohnt sich voraussichtlich",
          "tuer": { "ziel": "check", "beschriftung": "Rechnung ansehen" } },
        { "nr": 2, "schluessel": "foerderweg", "titel": "Förderweg wählen", "…": "…", "zustand": "jetzt",
          "stand": "Heute: Marktprämie mit Ausschließlichkeitsoption",
          "tuer": { "ziel": "foerderweg", "beschriftung": "Förderweg ändern" } } ] } ] }
```

`stand` ist ein fertiger Satz mit geschütztem Leerzeichen vor Einheiten und echtem Minus; `titel` und `erklaerung` sind
der Wortlaut des Konzepts, festgehalten in `stationsfolgen` der Vektoren.

## 6. Stationen und ihre Quellen

**Abgrenzungsoption (Gewerbe).** „gewählt“ = die Abgrenzungsoption gilt heute; „vorgemerkt“ = eine Fassung nach heute.

| Nr. | Station | `wer` | Quelle | Zustand |
|---|---|---|---|---|
| 1 | Rechnen: Lohnt es sich? | portal | `site_mispel_check` | `fertig` → erledigt mit Betrag und Urteil; ohne Rechnung, aber gewählt/vorgemerkt → erledigt; `wird_gerechnet` → wartet; ohne Zeile, `fehlgeschlagen`, `nicht_unterstuetzt` → offen |
| 2 | Förderweg wählen | portal | `site_foerderweg` | gewählt oder vorgemerkt → erledigt; sonst offen mit dem heutigen Förderweg |
| 3 | Zähler klären | beides | Zählerrollen mit Urteil des Registers ([MP-6](./mispel-zaehlerrolle.md)) | Netzanschluss (Z1) und Speicher (Z2/Z3) je `tauglich` → erledigt; sonst offen mit beiden Urteilen |
| 4 | Direktvermarkter beauftragen | aussen | Partner der jüngsten Fassung | eingetragen → erledigt; sonst offen |
| 5 | Einverständnis einholen | aussen | `einverstaendnis` der jüngsten Fassung | bestätigt oder nach dem 30.09.2027 → erledigt; sonst offen |
| 6 | Wechsel zum Monatsersten | portal | Fassung / Vormerkung | gewählt → erledigt („Seit …“); vorgemerkt → wartet; sonst offen „Frühestens zum …“ |
| 7 | Monat rechnen und abgleichen | voltpilot | jüngster `mispel_abgrenzung_monat` | gewählt: `endgueltig` → erledigt, `vorlaeufig` oder noch keiner → wartet; sonst offen |
| 8 | Nachweis weitergeben | beides | derselbe Lauf (der Nachweis liest ihn, MP-16) | endgültiger Monat → offen („liegt bereit“; die Weitergabe kann das Portal nicht sehen); vorläufig oder noch keiner → wartet; vor dem Wechsel offen mit dem frühesten Monat |

**Pauschaloption (Haushalt).** „gewählt“ = Förderweg heute `marktpraemie_pauschal`; „Vormerkung“ =
`site_pauschal_vormerkung` ([Förderweg § 5a](./mispel-foerderweg.md#5a-pauschaloption-vormerken-mit-offenem-termin-13-mp-27)).

| Nr. | Station | `wer` | Quelle | Zustand |
|---|---|---|---|---|
| 1 | Rechnen: Lohnt es sich? | portal | `site_mispel_check` | wie oben; schon vorgemerkt zählt wie gewählt |
| 2 | Pauschaloption vormerken | portal | Fassung / Vormerkung | gewählt, als Fassung vorgemerkt oder Vormerkung steht → erledigt („Termin offen“ oder der Monatserste des Läufers); sonst offen |
| 3 | Voraussetzungen prüfen | portal | Bestätigungen der Vormerkung, Solarleistung im Aufbau | mit Fassung → erledigt; Vormerkung mit „ein Betreiber“, Steckersolar in der Direktvermarktung (falls vorhanden) und höchstens 30 kWp → erledigt; sonst offen |
| 4 | Direktvermarkter beauftragen | aussen | Partner der Vormerkung, sonst der Fassungen | eingetragen → erledigt |
| 5 | Genehmigung der EU-Kommission | aussen | `voltpilot.mispel.pauschaloption-ab` | leer → wartet („einen Termin gibt es nicht“); gesetzt → erledigt |
| 6 | Wechsel am Monatsersten danach | voltpilot | Fassung, Vormerkung, Genehmigung | gewählt → erledigt; als Fassung vorgemerkt → wartet; ohne Genehmigung → gesperrt; Vormerkung steht → wartet auf den Monatsersten des `PauschalVormerkungLaeufer` — bis 30.09.2027 nicht, weil die Vormerkung kein Einverständnis trägt (Tenor S. 3 Ziff. 9a), also frühestens zum 01.10.2027 |
| 7 | Jahresstand verfolgen | voltpilot | jüngster `mispel_pauschal_jahr` | gewählt: `endgueltig` → erledigt, sonst wartet; ohne Genehmigung gesperrt, sonst offen |
| 8 | Jahresnachweis | beides | — | ohne Genehmigung und nicht gewählt → gesperrt; sonst **offen „Noch nicht erfasst“**: einen Jahresnachweis der Pauschaloption gibt es auf `mispel` noch nicht (der Nachweis MP-16 liest nur Läufe der Abgrenzungsoption) |

**Ladepunkt (Auto als Speicher)**, je Ladepunkt aus [MP-31](./mispel-ladepunkt-bidirektional.md):

| Nr. | Station | `wer` | Quelle | Zustand |
|---|---|---|---|---|
| 1 | Ladepunkt eintragen | portal | `ladepunkt_faehigkeit` heute | bidirektional → erledigt; sonst offen („nur Laden eingetragen“) |
| 2 | Zähler am Ladepunkt | beides | Z2 am Ladepunkt mit Urteil (Zählerrollen, signierte Werte über den Eichstatus) | alle `tauglich` → erledigt; sonst offen |
| 3 | Wann ist das Auto da? | portal | `ladepunkt_fahrzeugfenster` + `ladepunkt_anwesenheit` | Anwesenheit eingetragen → erledigt („Mo–Fr 17:45 bis 07:15 · Abfahrt 80 % · nie unter 40 %“) |
| 4 | Zurückspeisen wählen | portal | `ladepunkt_fahrer_einstellung` | gewählt (auch „Aus“) → erledigt; nie gewählt → offen |
| 5 | Zurückspeisen fahren | voltpilot | Schalter der Box `Config.V2XEntladen` (`edge-app/core/internal/config/config.go`) | **immer gesperrt**: der Schalter ist aus und hat keine Umgebungsvariable; freigeben können ihn erst der Prüfstand MP-42 und die Box-Freigabe des Captains. Die Cloud kann ihn nicht lesen — ändert sich das, ändert sich dieser Vertrag |
| 6 | Monat rechnen | voltpilot | jüngster `mispel_abgrenzung_monat` | Abgrenzungsoption gilt: `endgueltig` → erledigt, sonst wartet; sonst offen |

## 7. Was dieser Vertrag nicht regelt

- Ob ein Vertrag mit dem Direktvermarkter tatsächlich besteht, ob das Einverständnis schriftlich vorliegt und ob ein
  Nachweis weitergegeben wurde: das Portal kennt nur die Angaben der Fassung. Die Stationen sagen, was eingetragen ist.
- Die Fallkonstellationen ohne Zählerrolle (Gleichstrommessung, Wind oder Blockheizkraftwerk daneben) zeigt Station 3
  nur über die Befunde des Registers.
- Die Fläche, Adressen der Türen und der Hilfe-Artikel ohne Stand (MP-56); die Demo (MP-57).

## Prüfen

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='MispelWegRegelnTest,MispelWegApiTest' -Dsurefire.failIfNoSpecifiedTests=false)
```
