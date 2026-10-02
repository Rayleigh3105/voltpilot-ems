package com.voltpilot.api.mispel;

import com.voltpilot.api.uems.MessstelleWerteRegeln;
import com.voltpilot.api.uems.MessstelleWerteService;
import com.voltpilot.api.uems.ViertelstundeRegeln;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Die Viertelstundenmengen eines Zählers der Festlegung, gelesen über seine Messstelle (Vertrag
 * {@code mispel-zaehlerrolle.md}: „Messpunkte werden über ihre zugeordnete Komponente gelesen“) — der Weg, den auch
 * Kennzahlen und Berichte nehmen ({@link MessstelleWerteService#werte}). Eine Viertelstunde ohne Menge fehlt im
 * Ergebnis: unbekannt ist keine Null. MiSpeL MP-8.
 *
 * <p><b>Werte des Messstellenbetreibers (MP-15):</b> trägt die Zählerrolle die Wertequelle „Messstellenbetreiber“
 * und liegen für ihren Zählpunkt und ihre Richtung im Zeitraum eingelesene Werte vor, liest der Zähler NUR diese —
 * maßgeblich sind die Werte des Messstellenbetreibers (Tenor S. 28); eine Viertelstunde ohne sie bleibt eine Lücke
 * und wird nie mit Gerätewerten aufgefüllt. Ohne eingelesene Werte liest er vom Gerät (Vorschau), und der Lauf
 * trägt die Wertequelle „Gerät“.
 */
@Component
public class MispelZaehlerLeser {

    /** Eine Viertelstundenmenge in kWh und ob die Viertelstunde endgültig ist (AP-07, Frist der Verdichtung). */
    public record Menge(BigDecimal kwh, boolean endgueltig) {}

    // Höchstens 2 200 Viertelstunden je Anfrage (MessstelleWerteRegeln.hoechstensSchritte) — ein Monat hat bis 2 980.
    private static final Duration STUECK = Duration.ofDays(20);

    /** Die Mengen eines Zählers und woher sie stammen: {@code messstellenbetreiber} oder {@code geraet}. */
    public record Gelesen(Map<Instant, Menge> mengen, String quelle) {}

    public static final String MSB = "messstellenbetreiber";
    public static final String GERAET = "geraet";

    private final MessstelleWerteService werte;
    private final MsbWerteRepository msb;

    public MispelZaehlerLeser(MessstelleWerteService werte) {
        this(werte, null);
    }

    @Autowired
    public MispelZaehlerLeser(MessstelleWerteService werte, MsbWerteRepository msb) {
        this.werte = werte;
        this.msb = msb;
    }

    /** Die Mengen eines Zählers der Festlegung über {@code [von, bis)} aus seiner maßgeblichen Quelle (MP-15). */
    public Gelesen lesen(ZaehlerrolleRegeln.Knoten zaehler, Instant von, Instant bis) {
        ZaehlerrolleRegeln.Angaben a = zaehler.angaben();
        String richtung = MsbWerteCsv.richtungDerMessstelle(zaehler.richtung());
        if (msb != null && a != null && MSB.equals(a.wertequelle()) && a.zaehlpunkt() != null && richtung != null) {
            Map<Instant, BigDecimal> m = msb.werte(a.zaehlpunkt(), richtung, von, bis);
            if (!m.isEmpty()) {
                Map<Instant, Menge> out = new LinkedHashMap<>();
                m.forEach((t, kwh) -> out.put(t, new Menge(kwh, true)));
                return new Gelesen(out, MSB);
            }
        }
        return new Gelesen(lesen(zaehler.kennzeichen(), von, bis), GERAET);
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
