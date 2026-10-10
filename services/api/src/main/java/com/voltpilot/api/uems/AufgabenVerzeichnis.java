package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-10: die Verzeichnis-Quelle „Aufgaben“ — je laufende Zuordnung am Stichtag eine Zeile der Gruppe
 * {@code verantwortung} („Aufgaben und Verantwortliche“): Art {@code aufgabe}, Kennzeichen das Wort der Aufgabe (bei
 * „weitere“ ihr Wortlaut), Titel „Aufgabe: Person“, entschieden von, eingetragen von, Tag = gilt ab. Der Ort ist
 * „Geführt in Ihrem System: …“ mit der Ablage des Belegs, ohne Beleg „in VoltPilot“ (k_faelle, R3: zehn Zeilen am
 * 12.02.2029). Gelesen über {@link EnergiemanagementPersonenService#aufgaben}: wer nicht unternehmensweit liest,
 * bekommt keine Zeile.
 */
@Component
@Order(20)
public class AufgabenVerzeichnis implements VerzeichnisQuelle {

    static final String GRUPPE = "verantwortung";

    private final EnergiemanagementPersonenService personen;

    public AufgabenVerzeichnis(EnergiemanagementPersonenService personen) {
        this.personen = personen;
    }

    @Override
    public List<Map<String, Object>> zeilen(LocalDate stichtag) {
        var aus = new ArrayList<Map<String, Object>>();
        for (var a : personen.aufgaben(stichtag).aufgaben()) {
            for (var z : a.laufend()) {
                aus.add(zeile(z));
            }
        }
        return aus;
    }

    private static Map<String, Object> zeile(EnergiemanagementPersonenDto.Zuordnung z) {
        String aufgabe = z.wort();
        var beleg = z.beleg();
        Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(new EnergiemanagementRegeln.VerzeichnisEingang(
                GRUPPE, "aufgabe", aufgabe, aufgabe + ": " + z.person().name(), null,
                z.entschiedenVon() == null ? null : z.entschiedenVon().name(), z.eingetragen().akteur().name(),
                z.giltAb().toString(), beleg == null ? null : beleg.sha256(), beleg == null ? "in_voltpilot" : "verweis",
                beleg == null ? null : beleg.ablage()));
        if (zeile.containsKey("fehler")) {
            throw new IllegalStateException("Verzeichnis-Zeile der Zuordnung " + z.id() + ": " + zeile.get("fehler"));
        }
        return zeile;
    }
}
