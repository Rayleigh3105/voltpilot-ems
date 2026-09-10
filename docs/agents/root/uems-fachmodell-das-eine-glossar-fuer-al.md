# UEMS-Fachmodell: das EINE Glossar für alle Pakete des Unternehmens-Energiemanagements

Neu angelegt am 10.09.2026 (AP-00 IP-1 + IP-6, erstes Bau-Paket des Programms
Unternehmens-Energiemanagement).

**[`docs/fachmodell/`](../../fachmodell/README.md) ist die Referenz** — wer „Standort“,
„Anlage“, „Messstelle“, „Messkanal“, „Datenquelle“ oder „liefert Daten“ schreibt, meint das,
was dort steht. Fünf Dateien: [`glossar.md`](../../fachmodell/glossar.md) (23 Begriffe mit
Definition, Beispiel aus dem Referenzunternehmen Ahrenberg, „Heute im Code“ mit Belegen
`datei:zeile`, Abgrenzung), [`beziehungen.md`](../../fachmodell/beziehungen.md) (Kardinalität +
**Zeitgültigkeit**), [`zustaende.md`](../../fachmodell/zustaende.md) (Lebenszyklus Entwurf ·
eingerichtet · aktiv · angehalten · archiviert **und** Beobachtung liefert Daten · steuert),
[`fachmodell.svg`](../../fachmodell/fachmodell.svg) (die drei Sichten Ort · Organisation ·
elektrisch um die Messstelle) und [`auswirkungen.md`](../../fachmodell/auswirkungen.md) (je
heutiger Tabelle das Zielobjekt und die Art der Änderung: bleibt · bekommt Verweis · Felder
ziehen um · neu daneben).

Herkunft: Konzeptpaket AP-00, Captain-Entscheide E1–E12 vom 10.09.2026, verfeinert durch die
Entscheide von AP-01 … AP-07 (alle 10.09.2026). Die vier Fakten, die man ohne Nachlesen
braucht:

1. **Die Anlage bleibt (AP-00 E1 = A).** `site` behält Kennung, Adresse `#/anlage/…`,
   MQTT-Topics, Betriebsmodell, Fahrplan und Erlöse; neu hängt sie unter einem **Standort**,
   ihr Anschluss wird ein eigenes Objekt **Netzanschluss**, und sie IST genau ein elektrisches
   System. Ein Standort mit zwei Anschlüssen hat zwei Anlagen. Das Portal-Feld „Standort“
   (Koordinaten) behält seinen Namen (E9 = B).
2. **Die logische Messstelle ist das neue Zentrum.** Sie überlebt Gerät, Kanal, Box und
   Erfassungsweg; ein Zählerwechsel ändert die Quelle, nie die Messstelle. Sie hat genau EINE
   Hauptgröße und 0..n Nebengrößen (AP-04 E1 — das **ersetzt** AP-00 „1 : 1 Messgröße“).
3. **Zeitgültig ≠ Journal.** Ein Journal (`component_change_event`, `component_definition`)
   sagt, WANN sich etwas geändert hat; eine zeitgültige Zuordnung sagt, WAS in einem Zeitraum
   galt. Berichte brauchen das Zweite. „gültig ab“ ist ein TAG, wirksam 00:00 Uhr in der
   Zeitzone des Standorts (AP-02 E9).
4. **Die Messreihe hängt an der Komponente** (Komponente + Messkanal); Gerät, lesende Box und
   Einstellungs-Fassung reisen als Herkunft JE WERT mit (AP-07 E2 — das **ersetzt** AP-00 §6.4
   „die Reihe bleibt am Gerät geschlüsselt“).

⚠ **Nur `docs/fachmodell/tools/fachmodell.py` ändern** — `glossar.md`, `beziehungen.md`,
`zustaende.md` und `fachmodell.svg` sind erzeugt
(`python3 docs/fachmodell/tools/build_fachmodell.py`, `--check` prüft die Aktualität). Ein
bestehender AP-00-Text wird nie überschrieben: eine Verfeinerung kommt als Eintrag in
`VERFEINERUNGEN` mit Paket- und Entscheid-Verweis. Zwei Prüfskripte müssen grün bleiben:
`bash docs/fachmodell/tools/check_belege.sh` (jeder Beleg zeigt auf eine existierende Datei)
und `bash docs/fachmodell/tools/check_auswirkungen.sh` (jede genannte Tabelle existiert in den
Migrationen). Die vollständige Pflegeregel steht in
[`docs/fachmodell/README.md`](../../fachmodell/README.md).

Nicht hier: Verträge (Referenzunternehmen `docs/contracts/v2/uems-referenzunternehmen.json` =
IP-2, Zustands-Vektoren = IP-3), die Kundenwort-Liste samt `copy.test.ts`-Wächter (IP-4) und
jede Migration — die entsteht in ihrem Bau-Paket und ist danach unveränderlich.
