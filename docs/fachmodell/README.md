# Fachmodell des Unternehmens-Energiemanagements

**Zweck.** Dies ist das EINE Glossar für alle Pakete des Programms
Unternehmens-Energiemanagement. Wer „Standort“, „Anlage“, „Messstelle“, „Messkanal“,
„Datenquelle“ oder „liefert Daten“ schreibt — in einem Konzept, einer Migration, einer
Portal-Fläche oder einem Vertrag — meint das, was hier steht. Ein Wort mit zwei Bedeutungen
ist ein Fehler, kein Stilproblem.

## Die Dateien

| Datei | Inhalt |
|---|---|
| [`glossar.md`](glossar.md) | Die 23 Begriffs-Einträge: Definition · Erläuterung · Beispiel aus dem Referenzunternehmen · „Heute im Code“ mit Belegen `datei:zeile` · Abgrenzung zu den Nachbarbegriffen. |
| [`beziehungen.md`](beziehungen.md) | Die Beziehungsliste mit Kardinalität und **Zeitgültigkeit**, die offenen Spannungen (W1–W4) und was AP-00 den Nachbarpaketen vorgibt. |
| [`zustaende.md`](zustaende.md) | Das Zustandsvokabular: Lebenszyklus (Entwurf · eingerichtet · aktiv · angehalten · archiviert) und Beobachtung (liefert Daten · steuert), Matrix je Objekt, Übergänge, Entscheidungslog. |
| [`fachmodell.svg`](fachmodell.svg) | Das Diagramm: die drei Sichten Ort (blau) · Organisation (grün) · elektrisch (orange) und die graue Erfassungskette um die logische Messstelle. |
| [`auswirkungen.md`](auswirkungen.md) | Die Auswirkungs-Karte: je heutiger Tabelle, Klasse und Portal-Datei das Zielobjekt und die Art der Änderung (bleibt · bekommt Verweis · Felder ziehen um · neu daneben). |

Dazu gehört das **Referenzunternehmen Ahrenberg**, an dem jeder Begriff ein Beispiel hat:
[`docs/contracts/v2/uems-referenzunternehmen.json`](../contracts/v2/uems-referenzunternehmen.json)
— es entsteht als eigenes Paket (AP-00 IP-2) und fehlt daher möglicherweise noch. Bis dahin
sind die Beispiele im Glossar die Wahrheit über Ahrenberg.

## Herkunft

Der Stand kommt aus dem Konzeptpaket **AP-00 „Fachmodell“**, entschieden vom Captain am
**10.09.2026** (Entscheide E1–E12). Verfeinert haben ihn — ebenfalls am 10.09.2026 — die
Pakete **AP-01** (Portalaufbau), **AP-02** (Ortsstruktur), **AP-03** (Rechte), **AP-04**
(Messstellenregister), **AP-05** (WAGO), **AP-06** (mehrere Edges) und **AP-07**
(Messdatenstrecke).

Der AP-00-Text steht unverändert; was ein späteres Paket geschärft, ergänzt oder **ersetzt**
hat, steht im Glossar als eigener Kasten „Verfeinert durch AP-0x Ey“. Zwei Entscheide ersetzen
eine AP-00-Aussage ausdrücklich:

- **AP-04 E1** ersetzt „Messstelle 1 : 1 Messgröße“: eine Messstelle hat genau EINE
  **Hauptgröße** (identitätsstiftend, nie änderbar) und 0..n **Nebengrößen** (AP-04 W1).
- **AP-07 E2** ersetzt „die Reihe bleibt am Gerät geschlüsselt“: die Messreihe ist an der
  **Komponente** geschlüsselt (Komponente + Messkanal); Gerät, lesende Box und
  Einstellungs-Fassung reisen als Herkunft **je Wert** mit (AP-07 W1).

Die vollständigen Konzept-Berichte samt Optionen und Begründungen liegen in der Konzept-Ablage
des Programms (`data/vp-uems-ap00-fachmodell/` … `data/vp-uems-ap07-messdaten/`), nicht in
diesem Repo. Dieses Verzeichnis trägt das Ergebnis.

## Pflegeregel

**Jedes weitere Konzeptpaket ergänzt oder ändert HIER** — mit Datum und Paket-Verweis, bevor
sein Bau-Paket eine Zeile Produktcode anfasst. Konkret:

1. **Nur `tools/fachmodell.py` ändern.** `glossar.md`, `beziehungen.md`, `zustaende.md` und
   `fachmodell.svg` sind ERZEUGT. Danach:
   ```bash
   python3 docs/fachmodell/tools/build_fachmodell.py            # neu bauen
   python3 docs/fachmodell/tools/build_fachmodell.py --check     # prüft, ob sie aktuell sind
   ```
2. **Einen bestehenden AP-00-Text nie überschreiben.** Eine Verfeinerung kommt als Eintrag in
   `VERFEINERUNGEN` (Schlüssel = `id` des Begriffs), Form `("AP-0x Ey", "was heute gilt")`.
   Ersetzt ein Entscheid eine AP-00-Aussage, beginnt der Text mit „⚠ ERSETZT …“ und nennt den
   Widerspruchs-Kasten, in dem der Konflikt aufgelöst wurde.
3. **Eine Beziehung wird in `BEZIEHUNGEN` geändert**, samt Spalte „Herkunft“ (Paket +
   Entscheid). Zeitgültig oder nicht ist eine Entscheidung, keine Formsache: zeitgültig heißt
   „gültig ab / gültig bis, nie überschrieben“; nicht zeitgültig heißt „eine Änderung ist ein
   NEUES Objekt“.
4. **`auswirkungen.md` wird von Hand gepflegt** — sie ist Prosa über den Bestand, kein
   Datensatz. Wer eine Zeile ergänzt, nennt Beleg und Entscheid.
5. **Die beiden Prüfskripte müssen grün bleiben:**
   ```bash
   bash docs/fachmodell/tools/check_belege.sh          # jeder Beleg zeigt auf eine existierende Datei
   bash docs/fachmodell/tools/check_auswirkungen.sh    # jede genannte Tabelle existiert in den Migrationen
   ```
6. **Kundensprache.** Interne Namen (`tenant`, `site`, `measurement_point`, `entity_id`,
   `point_key` …) stehen ausschließlich in den Abschnitten „Heute im Code“ und in
   `auswirkungen.md`. Überall sonst gilt die Sprachregel des Portals
   (`frontend/portal/AGENTS.md`), einschließlich deutscher Anführungszeichen.

## Was hier NICHT wohnt

- **Kein Schema und keine Migration.** `auswirkungen.md` sagt, welcher Art eine Änderung ist —
  die Spalten entscheidet die Migration ihres Bau-Pakets und ist danach unveränderlich.
- **Keine Verträge.** Das Referenzunternehmen (AP-00 IP-2) und die Zustands-Vektoren (IP-3)
  wohnen in `docs/contracts/v2/` und sind eigene Pakete.
- **Keine Sprachregel-Änderung.** Die Kundenwort-Liste und ihr Wächter (`copy.test.ts`) sind
  AP-00 IP-4.
- **Keine Umbenennung im Portal.** Das Feld „Standort“ der Anlagen-Einstellungen behält seinen
  Namen (AP-00 E9 = B); IP-5 ist damit entfallen.
