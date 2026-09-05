# Geräteseiten Stufe 2: die LANE verschwindet für den Benutzer (E4)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 101).


Captain-Review 21.08.2026 Punkt 5, Scout `vp-geraeteseite-rev-b8` §7 (Entscheid **E4:
transparent per Server-Alias**). Der belegte Befund: die Seite des Deye zeigte statt des
Register-Knopfs den Satz „bitte den primären Wechselrichter als Ziel wählen" — und der Deye
IST der primäre Wechselrichter. Es wird **keine Regel gelockert**: die Box bekommt weiterhin
einen Auftrag auf der primären Lane, `Admit`/`WriteOnce`, Selbstkonflikt-Sperre, Notiz-Pflicht
und Verantwortungs-Satz sind unberührt.

- **⚠ Der Server BILDET AB, statt abzulehnen** (`RegisterWriteTargets.componentTarget`): eine
  Komponente am Solarman-Logger wird ein Ziel mit `lane: primary` + **`primaryAlias: true`**,
  und **die `entityId` BLEIBT gesetzt** — nur so gehört der Vorgang der KOMPONENTE (Journal,
  `geraeteVerlauf`). Auf dem Draht ändert sich nichts: der Umschlag der primären Lane trägt per
  Konstruktion gar kein `entity_id` (`RegisterWritePublisher`), die Box bekommt zeichengleich,
  was sie immer bekam.
- **⚠ Eine gemeldete QUELLE am eigenen Logger ist KEIN Alias.** Dort meint die primäre Lane den
  Wechselrichter, den die Box selbst eingerichtet hat — ein Alias schickte den Auftrag an ein
  ANDERES Gerät. Ihr Satz nennt deshalb den WEG („Richten Sie es zuerst als Komponente ein"),
  nie einen Transport.
- **Portal:** `geraetRegisterZugang` bekommt die GATTUNG. Ein **Hauptgerät** wählt die primäre
  Lane seiner Box vor (es ist sie), ein Gerät dahinter seine Komponente — ein Alias zählt dabei
  wie jede andere Komponente. `zielKey` gibt ihm einen EIGENEN Schlüssel (`alias:{entityId}`),
  sonst fiele es mit dem Wechselrichter-Ziel zusammen und der Picker verlöre die Komponente, nach
  der ein Mensch sucht; `ziele()` überschreibt sein Lane-Wort mit „Komponente" (**der Benutzer
  sieht nie eine Lane**), `zielInput` schickt `lane: primary` **mit** der Komponente.
- **Der HTTP-Fall steht EINMAL** (`RegisterWriteTargets.HTTP_KEIN_MODBUS`, vorher dreimal
  verschieden formuliert): „Dieses Gerät wird über seine Web-Schnittstelle gelesen - Modbus-
  Register gibt es dort nicht." Ein Gerät, das die Box zwar MELDET, das aber noch keine
  Komponente ist, bekommt seinen Weg (`ERST_ALS_KOMPONENTE` + Link ins Anlagen-Modell) statt
  nur des Fehlens — eine Vorwahl auf seine freie Adresse gibt es weiterhin nicht.
- **Beweise:** `RegisterWriteTargetsTest` (Abbildung statt Ablehnung, das Alias steht NEBEN dem
  Wechselrichter-Ziel, die Quelle nennt den Weg) · portal `registerWrite.test.ts` +
  `GeraetSeiteSection.test.tsx` (der Captain-Fall als Test, mutationsgeprüft).

