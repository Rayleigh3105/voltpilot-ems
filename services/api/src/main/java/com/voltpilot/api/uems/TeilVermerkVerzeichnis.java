package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementTeilVermerkDto;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Konzept Nachweisen n1, Entscheid 5: die Verzeichnis-Quelle „Trifft bei uns zurzeit nicht zu“. Je Vermerk, der bis
 * zum Stichtag entschieden ist, eine Zeile in der Gruppe seines Teils ({@link #GRUPPE}): Art {@code teil_vermerk},
 * Kennzeichen der Name des Teils, Titel „&lt;Teil&gt;: trifft bei uns zurzeit nicht zu“, entschieden von, eingetragen
 * von, Tag = entschieden am, ohne Nr. und Prüfsumme, in VoltPilot. Ein Vermerk, der bis zum Stichtag aufgehoben ist,
 * bleibt eine Entscheidung: seine Zeile sagt es im Titel („· aufgehoben am TT.MM.JJJJ“). Gelesen über
 * {@link EnergiemanagementTeilVermerkService#vermerke}: wer nicht unternehmensweit liest, bekommt keine Zeile.
 */
@Component
@Order(25)
public class TeilVermerkVerzeichnis implements VerzeichnisQuelle {

    /** Die Gruppe des Verzeichnisses je Teil (Vokabular {@code teil} → {@code verzeichnis_gruppe}). */
    static final Map<String, String> GRUPPE = Map.ofEntries(Map.entry("energiepolitik", "grundlagen"),
            Map.entry("anwendungsbereich", "grundlagen"), Map.entry("rechtliche_anforderungen", "grundlagen"),
            Map.entry("kontext", "grundlagen"), Map.entry("risiken_chancen", "risiken_chancen"),
            Map.entry("aufgaben", "verantwortung"), Map.entry("kompetenz", "kompetenz_kommunikation"),
            Map.entry("kommunikation", "kompetenz_kommunikation"), Map.entry("betrieb", "betrieb_auslegung_beschaffung"),
            Map.entry("auslegung", "betrieb_auslegung_beschaffung"),
            Map.entry("beschaffung", "betrieb_auslegung_beschaffung"),
            Map.entry("energetische_bewertung", "bewertung_messplanung"),
            Map.entry("bezugsbasen", "kennzahlen_bezugsbasen"), Map.entry("massnahmen", "ziele_massnahmen_abweichungen"),
            Map.entry("interne_audits", "audits_feststellungen"), Map.entry("feststellungen", "audits_feststellungen"),
            Map.entry("managementbewertung", "managementbewertung"), Map.entry("berichte", "berichte"));

    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    private final EnergiemanagementTeilVermerkService vermerke;

    public TeilVermerkVerzeichnis(EnergiemanagementTeilVermerkService vermerke) {
        this.vermerke = vermerke;
    }

    @Override
    public List<Map<String, Object>> zeilen(LocalDate stichtag) {
        var aus = new ArrayList<Map<String, Object>>();
        for (var v : vermerke.vermerke().vermerke()) {
            if (v.entschiedenAm().isAfter(stichtag)) {
                continue;
            }
            aus.add(zeile(v, stichtag));
        }
        return aus;
    }

    private Map<String, Object> zeile(EnergiemanagementTeilVermerkDto.Vermerk v, LocalDate stichtag) {
        LocalDate aufgehoben = v.aufgehoben() == null ? null : vermerke.tag(v.aufgehoben().am());
        String titel = v.teilWort() + ": trifft bei uns zurzeit nicht zu"
                + (aufgehoben == null || aufgehoben.isAfter(stichtag) ? "" : " · aufgehoben am " + aufgehoben.format(TAG));
        Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(new EnergiemanagementRegeln.VerzeichnisEingang(
                GRUPPE.get(v.teil()), "teil_vermerk", v.teilWort(), titel, null,
                v.entschiedenVon() == null ? null : v.entschiedenVon().name(), v.eingetragen().akteur().name(),
                v.entschiedenAm().toString(), null, "in_voltpilot", null));
        if (zeile.containsKey("fehler")) {
            throw new IllegalStateException("Verzeichnis-Zeile des Vermerks " + v.id() + ": " + zeile.get("fehler"));
        }
        return zeile;
    }
}
