package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.VerbrauchRegeln.Teilperiode;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
    private final MeasurementCatalog katalog;

    public ZeitraumMenge(JdbcTemplate jdbc, MeasurementCatalog katalog) {
        this.jdbc = jdbc;
        this.katalog = katalog;
    }

    /**
     * Der Träger der Reihe: Einheit des Messkanals aus dem Katalog, Zone des Standorts zum (UTC-)Tag
     * von {@code von} — dieselbe Kette wie Viertelstunden- und Tageslauf.
     */
    private ReihenKontext reihe(Connection con, UUID tenantId, UUID entityId, String messkanal, Instant von)
            throws SQLException {
        ReihenKontext.Zeitzone zone = ReihenKontext.zeitzonen(con,
                List.of(new ReihenKontext.Frage(tenantId, entityId, LocalDate.ofInstant(von, ZoneOffset.UTC))))
                .get(0);
        return ReihenKontext.aus(katalog, messkanal, zone.zone());
    }

    /**
     * Die Kadenz-Kette der Reihe über {@code [von, bis)} — für die Erwartung ZUR MESSZEIT
     * ({@link ViertelstundenTeile#erwartet}), nie die Kadenz der jüngsten Viertelstunde für den ganzen Zeitraum.
     */
    private ViertelstundenTeile.Kadenzkette kadenzkette(Connection con, UUID tenantId, UUID entityId,
            String messkanal, Instant von, Instant bis) throws SQLException {
        MeasurementCatalog.Point p = katalog.resolve(messkanal);
        return ViertelstundenTeile.kadenzkette(con, tenantId, entityId, messkanal,
                p == null ? null : p.defaultCadenceS(), von, bis);
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
            Teilperiode menge = ViertelstundenTeile.zaehlerstand(reihe(con, tenantId, entityId, messkanal, von),
                    v.teile(), v.ereignisse(), v.deklaration(), v.wertart(), v.kadenzS(), von, bis);
            int erhalten = v.innen(von, bis).stream().mapToInt(t -> t.ergebnis().erhalten()).sum();
            int erwartet = ViertelstundenTeile.erwartet(v.innen(von, bis), von, bis,
                    kadenzkette(con, tenantId, entityId, messkanal, von, bis));
            Integer abdeckung = erwartet == 0 ? null : Math.min(100, (int) (100L * erhalten / erwartet));
            String zustand = TagRegeln.zustand(v.vorhanden(), v.endgueltig(), TagRegeln.endgueltigAb(bis), jetzt);
            return new Zeitraum(von, bis, VerbrauchRegeln.stunden(von, bis), v.wertart(), v.kadenzS(), menge,
                    erhalten, erwartet, abdeckung, v.vorhanden(), v.endgueltig(), zustand);
        });
    }

    /**
     * Ein Schritt eines gröberen Rasters im Lesepfad (AP-07 IP-14): was die Regel über die gespeicherten
     * Viertelstunden für ihn sagt.
     *
     * @param menge Zählerstand: die Menge aus den Periodenständen — {@code null} = keine bildbar, nie 0
     * @param mengeZustand vollständig · unvollständig · keine Werte (beim Momentanwert: seine
     *     Vollständigkeit, M3); {@code null} für eine Wertart ohne Regel
     * @param kennzeichen die Kennzeichen der Regel, Wortlaut und Reihenfolge wie im Vertrag
     * @param energie Momentanwert mit Integration: die Energie UNGERUNDET wie in der Spalte
     *     {@code energie}; sie steht nur, wenn {@code kennzeichen} „aus Leistung integriert" trägt
     * @param erhalten die guten Werte seiner Viertelstunden
     * @param erwartet die Erwartung des SCHRITTS zur Messzeit ({@link ViertelstundenTeile#erwartet}): eine
     *     Viertelstunde ohne Zeile zählt mit {@code Länge ÷ Kadenz zu ihrer Zeit} — nie die Summe über die
     *     vorhandenen Zeilen (F8 17:00: 29 von 60, nicht 29 von 30)
     */
    public record Schritt(Instant von, Instant bis, String wertart, BigDecimal menge, String mengeZustand,
            List<String> kennzeichen, BigDecimal energie, int erhalten, int erwartet) {}

    /**
     * Die Schritte eines Rasters — je Beginn dieselbe Regel wie {@link #zeitraum} über
     * {@code [Beginn, Beginn + Raster)}, NIE die Summe der Viertelstunden-Mengen: sie verlöre den
     * gemessenen Zuwachs über jede Lücke im Schritt (eine Viertelstunde ohne Rohwert hat keine Zeile)
     * und wäre schon ohne Lücke eine Summe gerundeter Teilmengen. Für Momentanwerte dieselbe Regel wie
     * am Tag ({@link VerbrauchRegeln#momentanwertAusTeilperioden}).
     *
     * <p>{@code erhalten} und {@code erwartet} sind ein ERGEBNIS des Schritts und reisen mit ihm nach oben —
     * für jede Wertart, auch ohne Mengenregel (Zustand, Text). Sie gehören nicht in {@link ReihenKontext}: der
     * trägt, was über die Reihe VOR der Rechnung feststeht, nicht was sie ergibt.
     *
     * <p>Über die App-Verbindung hinter RLS: eine fremde Reihe liefert keinen Schritt.
     *
     * @return je Beginn mit Viertelstunden ein Schritt; ein Beginn ohne eine einzige fehlt
     */
    public Map<Instant, Schritt> raster(UUID tenantId, UUID entityId, String messkanal, Collection<Instant> beginne,
            int rasterS) {
        if (rasterS < 900 || rasterS % 900 != 0) {
            throw new IllegalArgumentException("ein Raster besteht aus ganzen Viertelstunden: " + rasterS + " s");
        }
        for (Instant b : beginne) {
            if (b.getEpochSecond() % 900 != 0 || b.getNano() != 0) {
                throw new IllegalArgumentException("ein Schritt beginnt im Viertelstunden-Raster: " + b);
            }
        }
        return jdbc.execute((Connection con) -> {
            Map<Instant, Schritt> aus = new LinkedHashMap<>();
            if (beginne.isEmpty()) {
                return aus;
            }
            Instant erster = Collections.min(beginne);
            ReihenKontext reihe = reihe(con, tenantId, entityId, messkanal, erster);
            ViertelstundenTeile.Kadenzkette kette = kadenzkette(con, tenantId, entityId, messkanal, erster,
                    Collections.max(beginne).plusSeconds(rasterS));
            for (ViertelstundenTeile.Schritt s : ViertelstundenTeile.schritte(con, reihe, tenantId, entityId,
                    messkanal, beginne, Duration.ofSeconds(rasterS))) {
                int erhalten = s.innen().stream().mapToInt(t -> t.ergebnis().erhalten()).sum();
                int erwartet = ViertelstundenTeile.erwartet(s.innen(), s.von(), s.bis(), kette);
                if (s.menge() != null) {
                    VerbrauchRegeln.Ergebnis e = s.menge().ergebnis();
                    aus.put(s.von(), new Schritt(s.von(), s.bis(), s.wertart(), e.menge(), e.zustand(),
                            e.kennzeichen(), null, erhalten, erwartet));
                } else if (s.werte() != null) {
                    VerbrauchRegeln.Ergebnis e = s.werte().teil().ergebnis();
                    aus.put(s.von(), new Schritt(s.von(), s.bis(), s.wertart(), null, e.zustand(), e.kennzeichen(),
                            s.werte().energie(), erhalten, erwartet));
                } else if (!s.innen().isEmpty()) {
                    // Eine Wertart ohne Mengenregel (Zustand, Text): keine Menge, aber dieselbe Abdeckung.
                    aus.put(s.von(), new Schritt(s.von(), s.bis(), s.wertart(), null, null, List.of(), null,
                            erhalten, erwartet));
                }
            }
            return aus;
        });
    }
}
