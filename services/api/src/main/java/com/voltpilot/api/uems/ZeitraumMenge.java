package com.voltpilot.api.uems;

import com.voltpilot.api.uems.VerbrauchRegeln.Teilperiode;
import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der FREIE ZEITRAUM (UEMS AP-08 IP-5, P7): die Menge über einen beliebigen Anfang und ein
 * beliebiges Ende im Viertelstunden-Raster — nach DERSELBEN Regel wie Tag, Monat und Jahr.
 *
 * <p><b>Nicht aus vorgerechneten Perioden zusammengeklebt.</b> Der Zeitraum hat seine EIGENEN
 * Periodenstände an {@code von} und {@code bis} und wird aus den gespeicherten Viertelstunden
 * gebildet ({@link VerbrauchRegeln#zaehlerstandAusTeilperioden}). Ein Zeitraum über zwei Tage, an
 * deren Grenze kein Stand gemessen wurde, ist darum VOLLSTÄNDIG, obwohl beide Tage für sich
 * unvollständig sind (F20: 20.–21.10.2026, 4 608 kWh) — die Summe der Tagesmengen (4 416 kWh)
 * hätte den Zuwachs über die Lücke verloren.
 *
 * <p><b>Mandantenzaun:</b> gelesen wird über die App-Verbindung hinter RLS; eine fremde Reihe
 * liefert keine einzige Viertelstunde und damit „keine Werte", nie die Zahl eines anderen.
 *
 * <p>Noch ohne Route: das Lese-Modell „Werte je Messstelle" ist AP-08 IP-9.
 */
@Component
public class ZeitraumMenge {

    private final JdbcTemplate jdbc;

    public ZeitraumMenge(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die Antwort für einen Zeitraum.
     *
     * @param menge die Menge samt Periodenständen — {@code null}, wenn die Reihe kein Zählerstand ist
     * @param stunden die Länge in Stunden (ein Umstellungstag darin zählt 23 bzw. 25)
     * @param zustand {@code vorlaeufig} oder {@code endgueltig}: endgültig erst, wenn jede
     *     vorhandene Viertelstunde endgültig ist UND die Frist von {@code bis} abgelaufen ist
     */
    public record Zeitraum(Instant von, Instant bis, long stunden, String wertart, Integer kadenzS,
            Teilperiode menge, int erhalten, int erwartet, Integer abdeckungProzent,
            int viertelstundenVorhanden, int viertelstundenEndgueltig, String zustand) {}

    public Zeitraum zeitraum(UUID tenantId, UUID entityId, String messkanal, Instant von, Instant bis,
            Instant jetzt) {
        if (!bis.isAfter(von)) {
            throw new IllegalArgumentException("bis muss nach von liegen");
        }
        if (von.getEpochSecond() % 900 != 0 || bis.getEpochSecond() % 900 != 0
                || von.getNano() != 0 || bis.getNano() != 0) {
            throw new IllegalArgumentException(
                    "ein freier Zeitraum liegt im Viertelstunden-Raster (P1/P7): " + von + "–" + bis);
        }
        return jdbc.execute((Connection con) -> {
            ViertelstundenTeile.Geladen v = ViertelstundenTeile.laden(con, tenantId, entityId, messkanal, von, bis);
            Teilperiode menge = ViertelstundenTeile.zaehlerstand(v.teile(), v.ereignisse(), v.wertart(),
                    v.kadenzS(), von, bis);
            int erhalten = v.innen(von, bis).stream().mapToInt(t -> t.ergebnis().erhalten()).sum();
            int erwartet = v.kadenzS() == null ? 0
                    : VerbrauchRegeln.erwartetAusTeilperioden(v.innen(von, bis), von, bis,
                            Duration.ofSeconds(v.kadenzS()));
            Integer abdeckung = erwartet == 0 ? null : Math.min(100, (int) (100L * erhalten / erwartet));
            String zustand = TagRegeln.zustand(v.vorhanden(), v.endgueltig(), TagRegeln.endgueltigAb(bis), jetzt);
            return new Zeitraum(von, bis, VerbrauchRegeln.stunden(von, bis), v.wertart(), v.kadenzS(), menge,
                    erhalten, erwartet, abdeckung, v.vorhanden(), v.endgueltig(), zustand);
        });
    }
}
