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
   bereitem Speicherpfad und gemessener Wirkung. Sonst Verhalten „Nur Sonne“. Bereit ist ein gesteuerter Speicher
   mit bestätigter Rückmeldung oder ein beobachteter Speicher (Entscheidung 9).
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

9. **Beobachteter Speicher (Kapitän, 07.10.2026).** Die Box muss den Speicher nicht steuern. Steuert VoltPilot ihn
   nicht (keine Modell-/Gerätefreigabe, so Edge Light mit nur gelesenem Deye), gibt die Box trotzdem frei
   (`frei_beobachtet`), wenn kein Haltegrund besteht und Ladestand und Speicherleistung frisch gemessen sind, das BMS
   nicht sperrt und die Cloud für die Anlage eine Untergrenze gerechnet hat. Der Wechselrichter deckt die Wallbox im
   Eigenverbrauch selbst; die Box nimmt an der Untergrenze zurück, und gemessener Netzbezug sperrt die Freigabe. Die
   Absenkung einer geplanten Ladung entfällt, weil es keinen Schreibhebel gibt. Ein **gesteuerter** Speicher ohne
   bestätigte Rückmeldung bleibt gesperrt: er folgt dem Sollwert der Box statt dem Haus und kann in einer erzwungenen
   Ladung stehen. Offen: die Box liest den Arbeitsmodus des Wechselrichters nicht. Den Optimierer schließt
   Entscheidung 10.

10. **Steuerstand im Fahrplan (Auftrag Kapitän, 07.10.2026).** Die Box meldet in jedem Herzschlag `battery_control`
    (`gesteuert`, `beobachtet`, `not_aus`), unabhängig von der Rücklesung
    ([Vertrag](../../contracts/speicher-steuerstand.md)); die API speichert es in `device_battery_control`. Einen frisch
    als nicht gesteuert gemeldeten Speicher plant der Optimierer als **reinen Eigenverbrauch** (die Regel des sturen
    Speichers, keine Handels-Viertelstunden, keine Vollmachten) und rechnet seine Untergrenze ohne Handelsprüfung und
    ohne Verkaufsentnahme. Verworfen: nur die Untergrenze ohne Handelsprüfung zu rechnen und den Handelsplan zu
    behalten. Das ließe den Fahrplan Handel zeigen, den niemand ausführt, und wäre nach einem Wechsel auf gesteuert
    unsicher (Untergrenze in einem Netzlade-Slot). Fehlende oder veraltete Meldung (über 10 min): gesteuert wie bisher.

Fachlich verbindlich ist [Verbrauchssteuerung](../../verbrauchssteuerung.md#sonne--speicher).
