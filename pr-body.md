Der Wechselrichter empfahl, den Wechselrichter zu wählen: die Lane verschwindet für den Benutzer

**Was der Captain am 21.08. sah** (Punkt 5 des Reviews, Scout `vp-geraeteseite-rev-b8` §2.5): auf der Seite des Deye stand statt des Register-Knopfs der Satz

> „Dieses Gerät wird über den Solarman-Logger gelesen - bitte den primären Wechselrichter als Ziel wählen."

Der Deye **IST** der primäre Wechselrichter. Die Seite schickte einen Menschen dorthin, wo er schon stand — und der Knopf, der dort fehlte, funktionierte ausgerechnet auf der Box-Seite und schrieb von dort an genau dieses Gerät.

Dieser PR baut den Captain-Entscheid **E4** (Abnahme 21.08.: „transparent per Server-Alias"). Er lockert **keine einzige Regel**: die Box bekommt weiterhin einen Auftrag auf der primären Lane, `Admit`/`WriteOnce`, die Selbstkonflikt-Sperre, die Notiz-Pflicht und der Verantwortungs-Satz sind unberührt.

## Die zwei Hälften

**1 · Der Server BILDET AB, statt abzulehnen** (`RegisterWriteTargets.componentTarget`). Eine Komponente am Solarman-Logger wird ein Ziel mit `lane: primary` + `primaryAlias: true` — **die `entityId` bleibt gesetzt**, damit der Vorgang der KOMPONENTE gehört (Journal, Geräte-Verlauf). Auf dem Draht ändert sich **nichts**: der Umschlag der primären Lane trägt per Konstruktion gar kein `entity_id` (`RegisterWritePublisher:138`), die Box bekommt also zeichengleich, was sie immer bekam.

**⚠ Eine gemeldete QUELLE am eigenen Logger bleibt eine echte Ablehnung** — dort meint die primäre Lane den Wechselrichter, den die Box selbst eingerichtet hat; ein Alias schickte den Auftrag an ein ANDERES Gerät. Ihr Satz nennt jetzt den Weg („Richten Sie es zuerst als Komponente ein") statt eines Transports.

**2 · Die Seite kennt ihr EINES Ziel** (`geraetRegisterZugang`). Sie bekommt die Gattung: ein **Hauptgerät** wählt die primäre Lane seiner Box vor (es ist sie), ein Gerät dahinter seine Komponente — und ein Alias zählt dabei wie jede andere Komponente. Der Picker zeigt „Speicher · **Komponente**", nie ein Lane- oder Logger-Wort (`ziele()` überschreibt das Lane-Wort für Aliase).

## Nebenbei ehrlicher geworden

- Der HTTP-Fall war dreimal verschieden formuliert („spricht kein Modbus" / „wird nicht über Modbus gelesen"). Er steht jetzt EINMAL, in Kundenworten: **„Dieses Gerät wird über seine Web-Schnittstelle gelesen - Modbus-Register gibt es dort nicht."**
- Ein Gerät, das die Box zwar MELDET, das aber noch keine Komponente ist, bekommt seinen **Weg** statt nur des Fehlens (`ERST_ALS_KOMPONENTE` + Link ins Anlagen-Modell). Eine Vorwahl auf seine freie Adresse gibt es weiterhin nicht — dass dort GENAU dieses Gerät antwortet, weiß nur die Box.

## Beweise

- api rein `RegisterWriteTargetsTest` (10, davon 2 neu): die Solarman-Komponente wird abgebildet statt abgelehnt und steht **neben** dem Wechselrichter-Ziel (wer „Speicher" sucht, findet ihn weiterhin); die Quelle am eigenen Logger nennt den Weg und kein Transport-Wort.
- Portal `registerWrite.test.ts` (44, davon 3 neu) + `GeraetSeiteSection.test.tsx` (19, davon 1 neu): der Captain-Fall als Test — auf der Deye-Seite steht der Knopf, vorgewählt ist das Gerät selbst, und **nirgends** ein „Solarman"/„primären Wechselrichter als Ziel". **Mutationsgeprüft** (ohne die Hauptgerät-Regel fällt er um).
- Ganze Portal-Suite grün (3997), `tsc` sauber.
- Im echten Chrome bei **1440 und 375** gegen einen Wegwerf-Harness mit der Pilsting-Lage (Deye am Logger + Fronius + Zähler + Shelly + Säule): 0 px horizontaler Überlauf, 0 überstehende Elemente, keine Konsolenfehler. Der Picker zeigt den Deye vorgewählt, „Speicher · Komponente" wählbar und die ehrliche Web-Schnittstellen-Absage am Shelly.

## Was NICHT drin ist

Die Geräte-GESICHTER (§4) und die Modell-Suche (NACHTRAG 5) folgen in denselben Stufe-2-Runden; der Register-LESEN-Knopf (§7 zweiter Absatz) gehört zur Gattung B und kommt mit ihr.
