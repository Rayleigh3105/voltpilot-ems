# Ladequelle „Sonne + Speicher“ (06.10.2026)

Wunsch des Kapitäns: Steckt ein Auto, soll im Hausspeicher nur so viel bleiben, wie das Haus laut Erzeugungs- und
Verbrauchsprognose bis zur nächsten Erzeugung ohne Netzbezug braucht. Alles darüber darf ins Auto.

## Bestandsaufnahme (Kurzfassung)

| Frage | Befund | Folge |
|---|---|---|
| Lastprognose je Anlage? | Ja, gewähltes Lastmodell, 15-min-Slots, 48 h (`inputs.py`) | Rechnung im Optimierer |
| Prognose-Unsicherheit? | Keine Quantile. Gemessen: relative Nacht-Lastfehler je Anlage (`night_reserve.py`, Q0,5…Q0,95) | Last mit Q0,9 aufschlagen; PV-Tagesfehler analog neu messen |
| Fließt Speicher physisch ins Auto? | Ja. Die Wallbox ist Hauslast (`house = pv + grid − battery`); Eigenverbrauch, Defizitdeckung und Lastfolge decken sie mit | Kein neuer Schreibhebel am Speicher |
| Wo nicht? | Plan-Viertelstunden, die den Speicher **laden** (PV-Bus: Laden aus PV, Haus aus dem Netz) | Edge senkt dort die Ladung, solange freigegeben wird |
| Quellen-Bahn | Box-Wörter `nur_sonne · sonne_zuerst · schnell`; unbekanntes Wort am Ladepunkt wird übersprungen | Neues Wort wäre für alte Boxen gefährlich → additives Flag |

## Entscheidungen

1. **Wort und Bahn.** Portal-Chip „Sonne + Speicher“ = Steuerart `quelle=ueberschuss`, `ueberschussModus=speicher`.
   Die Box bekommt `source: "nur_sonne"` plus das neue Flag `storage_release: true`. Eine Box ohne das Flag
   fährt damit genau den verlangten Rückfall „Nur Sonne“.
2. **Rechnung in der Cloud** (`services/optimization`, `storage_release.py`): Rückwärtsrechnung über den Horizont
   mit Wirkungsgraden, Lade-/Entladeleistung, Kapazität. Die Untergrenze reist je Viertelstunde im v1-Fahrplan
   (`ev_release_floor_soc_pct`) – nur in Viertelstunden, in denen der Plan nicht handelt.
3. **Durchsetzung auf der Box:** Freigabe nur mit frischem Plan, Untergrenze im laufenden Slot, frischem SoC,
   bereitem Speicherpfad und gemessener Wirkung. Sonst Verhalten „Nur Sonne“.
4. **Fahrplan gegen Kundenwahl:** In Handels-Viertelstunden (geplanter Netzbezug, Netzladen, Verkauf) gewinnt der
   Fahrplan, geplante Verkäufe erhöhen die Untergrenze. In Eigenverbrauchs-Viertelstunden gewinnt die Kundenwahl.
5. **Reserve** je Anlage in kWh (`site_charging_config.storage_release_reserve_kwh`), Standard 1,0 kWh.
6. **Horizont bis zur nächsten Erzeugung, nicht bis zum Planende.** Der Fahrplan endet mit den Börsenpreisen; vor der
   Day-Ahead-Veröffentlichung (gegen 13 Uhr) also um Mitternacht. Ohne Verlängerung sähe eine Untergrenze um 12:00 die
   Nacht nach 24:00 nicht und gäbe zu viel frei. Die Rechnung läuft deshalb über die frische gespeicherte Prognose
   weiter; reicht auch sie nicht bis zur nächsten Erzeugung, gibt es keine Freigabe.
7. **Ladeziel bleibt kombinierbar.** Das Ziel ist dieselbe Anforderung wie bei „Nur Sonne“ mit Ziel; die Freigabe
   kommt nur in Eigenverbrauchs-Viertelstunden dazu und verkleinert den Netzrest. Netzbezug während einer Freigabe
   nimmt die Wirkungsprüfung der Box zurück.
8. **Portal.** Chip neben den drei Quellen, gesperrt mit Grund statt unsichtbar; Erklärzeile aus der Box-Meldung
   (veraltet = unbekannt), sonst aus dem Fahrplan als Plan; Reserve-Karte neben „Vorrang vor dem Speicher“;
   gestrichelte Untergrenze im Ladestand-Band des Ladeplans.

Fachlich verbindlich ist [Verbrauchssteuerung](../../verbrauchssteuerung.md#sonne--speicher).
