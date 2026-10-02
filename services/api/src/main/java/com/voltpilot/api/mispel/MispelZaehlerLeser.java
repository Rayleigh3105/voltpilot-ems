package com.voltpilot.api.mispel;

import com.voltpilot.api.uems.MessstelleWerteRegeln;
import com.voltpilot.api.uems.MessstelleWerteService;
import com.voltpilot.api.uems.ViertelstundeRegeln;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Die Viertelstundenmengen eines Zählers der Festlegung, gelesen über seine Messstelle (Vertrag
 * {@code mispel-zaehlerrolle.md}: „Messpunkte werden über ihre zugeordnete Komponente gelesen“) — der Weg, den auch
 * Kennzahlen und Berichte nehmen ({@link MessstelleWerteService#werte}). Eine Viertelstunde ohne Menge fehlt im
 * Ergebnis: unbekannt ist keine Null. MiSpeL MP-8.
 */
@Component
public class MispelZaehlerLeser {

    /** Eine Viertelstundenmenge in kWh und ob die Viertelstunde endgültig ist (AP-07, Frist der Verdichtung). */
    public record Menge(BigDecimal kwh, boolean endgueltig) {}

    // Höchstens 2 200 Viertelstunden je Anfrage (MessstelleWerteRegeln.hoechstensSchritte) — ein Monat hat bis 2 980.
    private static final Duration STUECK = Duration.ofDays(20);

    private final MessstelleWerteService werte;

    public MispelZaehlerLeser(MessstelleWerteService werte) {
        this.werte = werte;
    }

    /** Die Mengen je Viertelstundenbeginn über {@code [von, bis)}. */
    public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
        Map<Instant, Menge> out = new LinkedHashMap<>();
        for (Instant a = von; a.isBefore(bis); a = a.plus(STUECK)) {
            Instant b = a.plus(STUECK).isBefore(bis) ? a.plus(STUECK) : bis;
            MessstelleWerteDto.Werte w = werte.werte(kennzeichen, MessstelleWerteRegeln.Raster.VIERTELSTUNDE.wort(),
                    a.toString(), b.toString(), null);
            BigDecimal faktor = faktor(w.messstelle().einheit(), kennzeichen);
            for (MessstelleWerteDto.Wert v : w.werte()) {
                if (v.menge() == null) {
                    continue;
                }
                Instant beginn = ZonedDateTime.parse(v.von(), DateTimeFormatter.ISO_DATE_TIME).toInstant();
                out.put(beginn, new Menge(v.menge().multiply(faktor),
                        ViertelstundeRegeln.ENDGUELTIG.equals(v.fassung())));
            }
        }
        return out;
    }

    /** Anlage 1 rechnet in kWh (A1 S. 32); jede andere Einheit als Wh/kWh/MWh ist keine Strommenge. */
    static BigDecimal faktor(String einheit, String kennzeichen) {
        return switch (einheit == null ? "" : einheit) {
            case "kWh" -> BigDecimal.ONE;
            case "Wh" -> new BigDecimal("0.001");
            case "MWh" -> new BigDecimal("1000");
            default -> throw new MispelAbgrenzungAbgelehnt("einheit_passt_nicht", "Die Messstelle " + kennzeichen
                    + " liefert „" + einheit + "“ — die Formelsätze rechnen mit Strommengen in kWh (Anlage 1 S. 32).");
        };
    }
}
