package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.FeststellungDto;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-19: die Verzeichnis-Quelle „Feststellungen“ in der Gruppe {@code audits_feststellungen} („Interne
 * Audits und Feststellungen“, Zuschnitt „Feststellung, Maßnahme, Wirksamkeit“). Je Feststellung bis zum Stichtag eine
 * Zeile (Art {@code feststellung}, Kennzeichen F-…, entschieden von = festgestellt von, eingetragen von = das Konto,
 * Tag = festgestellt am, ohne Prüfsumme — R3 zählt F-2029-0001 am 12.02.2029 mit) und je freigegebenen Stand der
 * Wirksamkeit bis zum Stichtag eine Zeile (Art {@code wirksamkeit}, Nr. n, entschieden von, Tag des Stands, Prüfsumme
 * der Kopie). Alles liegt in VoltPilot. Gelesen über {@link FeststellungService} — mit dem Zaun des Aufrufers.
 */
@Component
@Order(95)
public class FeststellungVerzeichnis implements VerzeichnisQuelle {

    private final FeststellungService feststellungen;

    public FeststellungVerzeichnis(FeststellungService feststellungen) {
        this.feststellungen = feststellungen;
    }

    @Override
    public List<Map<String, Object>> zeilen(LocalDate stichtag) {
        var aus = new ArrayList<Map<String, Object>>();
        for (var f : feststellungen.liste(stichtag).feststellungen()) {
            if (f.festgestelltAm().isAfter(stichtag)) {
                continue;
            }
            aus.add(zeile(f.kennzeichen(), "feststellung", f.wortlaut(), null,
                    f.festgestelltVon() == null ? null : f.festgestelltVon().name(),
                    f.eingetragen().akteur().name(), f.festgestelltAm(), null));
            for (FeststellungDto.Stand s : feststellungen.staende(f.id())) {
                if ("freigegeben".equals(s.status()) && !s.am().isAfter(stichtag)) {
                    var eingetragen = s.zweitePerson() != null ? s.zweitePerson() : s.eingetragen();
                    aus.add(zeile(f.kennzeichen(), "wirksamkeit", "Wirksamkeit: " + s.ergebnis(), s.nr(),
                            s.entschiedenVon() == null ? null : s.entschiedenVon().name(),
                            eingetragen.akteur().name(), s.am(), s.pruefsumme()));
                }
            }
        }
        return aus;
    }

    private static Map<String, Object> zeile(String kennzeichen, String art, String titel, Integer nr,
            String entschiedenVon, String eingetragenVon, LocalDate tag, String pruefsumme) {
        Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(new EnergiemanagementRegeln.VerzeichnisEingang(
                AuditVerzeichnis.GRUPPE, art, kennzeichen, titel, nr, entschiedenVon, eingetragenVon, tag.toString(),
                pruefsumme, "in_voltpilot", null));
        if (zeile.containsKey("fehler")) {
            throw new IllegalStateException("Verzeichnis-Zeile der Feststellung " + kennzeichen + ": " + zeile.get("fehler"));
        }
        return zeile;
    }
}
