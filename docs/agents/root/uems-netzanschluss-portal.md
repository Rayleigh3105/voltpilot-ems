# Netzanschlüsse am Standort — AP-10 IP-13

Der Standort trägt den Reiter `#/standort/{id}/netzanschluesse`, mit Liste, Anlegen und
„Anlage binden / wechseln“. `StandortNetzanschluessePage` und `NetzanschlussDialog` verwenden
`VpPicker`, `VpDatePicker` und das bestehende `Modal`. Regeln und Anzeige:
`frontend/portal/src/netzanschlussListe.ts`, Fachprüfung über `uemsNetzanschluss.ts`.

- **Bestandsschutz:** `ebenenNav.ts` gibt Reiter, Telefonleiste und Direktadresse nur frei, wenn
  genau dieser Standort misst. Reine Betriebskunden bleiben unverändert (O18). Bei Messkunden
  ergänzt IP-13 die AP-13-Navigation um einen Reiter: Ahrenberg fünf, Lindach vier Bereiche;
  ohne Gebäude bleiben Übersicht, Messstellen und Netzanschlüsse. Keine neue Ebene.
- **Rechte:** `rollen.ts`/`Recht`: `netzanschluss.verwalten` am Standort; vor heute zusätzlich
  `aenderung.rueckwirkend`. Rückwirkung ist sichtbar und verlangt eine Begründung.
- **Gilt ab:** heute ist nur die Vorgabe, jeder zulässige Tag ist wählbar. Die Anlagenliste
  liefert den Beginn der Standortzuordnung, kein Bestehensdatum der Anlage; beide werden
  nicht gleichgesetzt. Der Server bleibt für konkurrierende Bindungen maßgeblich.
- **Alle Tage:** die Liste lädt ohne Stichtag und kennt damit auch beendete und geplante
  Bindungen. Die Prüfung verwendet `uemsNetzanschluss.bindung`: zwei Exklusionen, Vortag-Ende
  beim Wechsel, keine Überschreibung einer späteren Bindung. Der Picker nennt nur Anlagen
  dieses Standorts. Die API verlangt selbst keinen gleichen Standort (siehe API-Wegweiser).
- **Bilanzkopf:** die Bilanzroute trägt keinen Anschluss. `NetzanschlussBilanzKopf` liest
  `GET /standorte?stichtag=<bilanz.am>` und das dort gelieferte `anlage.netzanschluss`, dann
  `GET /standorte/{id}/netzanschluesse?stichtag=`. „Stand am …“ gilt ausdrücklich nur für
  diesen Tag, nicht für die gesamte Bilanzperiode. `null` heißt „nicht angelegt“;
  fehlende/fehlerhafte Antworten heißen nicht „kein Anschluss“. Bei Umzug kann der Anschluss
  am alten Standort bleiben: sein bekannter Bezug bleibt sichtbar, fehlende Details werden
  benannt. Die Bilanzroute liefert als Live-Wert den Rest, nicht die Momentanleistung des
  Netzanschlusses; der Kopf deutet ihn deshalb nicht als Anschlussleistung um. Ein solcher
  Momentanwert steht mangels Fakt im verwendeten Lesemodell nicht im Kopf.
- **Eine Formatierstelle:** `netzanschlussListe.leistung` ruft `uemsNetzanschluss.kopfzeile`
  und damit `uemsErgebnis.zahl` auf. Liste und Bilanz teilen sie. Das eigene Paket zur Rundung
  vereinbarter Werte muss dort bzw. im Vertragszwilling ansetzen; IP-13 rundet nicht selbst.
- **Verträge:** ausschließlich vorhandene IP-6-Routen, snake_case, Dezimalwerte ungerundet.
  Kein Preisumzug, keine Versorgung-Route und kein Formel-Assistent.

Prüfen: `netzanschlussListe.test.ts`, `apiNetzanschluss.test.ts`,
`components/NetzanschlussBilanzKopf.test.tsx`, `uemsNetzanschluss.test.ts`, `copy.test.ts`,
`uemsKeineRechnung.test.ts` (neue Ableitung aufgenommen), Navigation und Bestandsschutz.
Browser: `e2e/netzanschluesse.spec.ts` bei 375/1440, dazu `standort-ebenen.spec.ts`,
`energiebilanz.spec.ts` und `telefonleiste.spec.ts`; Wiederholung mit `--repeat-each=2`.
`NETZANSCHLUSS_BILDER=<Ordner>` erzeugt Bilder. Die Bühne `startansicht` verwendet ausschließlich
Ahrenberg aus `uems-referenzunternehmen.json`; keine Fixture im Produktionsbündel.

API, Randfälle und übrige Schreibwege: [Netzanschluss](uems-netzanschluss.md).
