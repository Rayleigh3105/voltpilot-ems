package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Marktdaten der MiSpeL-Festlegung (BNetzA, Beschluss 01.10.2026) je Viertelstunde - der
 * Lesezugriff für Rechenwerk (MP-8, MP-25) und Erlöse (MP-12). MiSpeL MP-7.
 *
 * <ul>
 *   <li><b>SP¼</b> - "Viertelstundenwert des Spotmarktpreises nach § 3 Nr. 42a EEG" (Anlage 2
 *       S. 27, Formel (P5) S. 30): der DE-LU-Day-Ahead-Preis aus {@code day_ahead_prices}, je
 *       Viertelstunde über {@link PriceSlots} (eine Stundenzeile gilt für ihre vier Viertelstunden,
 *       die feinere Auflösung gewinnt) und in ct/kWh, der Einheit des EEG. Eine Viertelstunde ohne
 *       Preis bleibt {@code null} - nie 0 (dieselbe Lückenregel wie bei den Day-Ahead-Preisen).
 *   <li><b>AW¼ &gt; 0</b> - Formel (24)¼ = WENN [ AW¼ &gt; 0 ; 1 ; 0 ] (Anlage 1 S. 38) bzw.
 *       (P12)¼ (Anlage 2 S. 31). Rechengrundlage ist die Liste der Übertragungsnetzbetreiber
 *       (Anlage 1 S. 17 Fn. 8) in {@code eeg_aw_zeit} je {@code regel}. Fehlt eine Viertelstunde in
 *       der Liste, greift nur als Rückfall die vereinfachte Regel "keine Prämie bei SP¼ &lt; 0"
 *       ({@link AwHerkunft#RUECKFALL_SPOT}), und der Zeitraum ist {@link AwZeitraum#vorlaeufig()}
 *       (Bauplan § 8.5, W4). Ohne Liste UND ohne Preis ist die Viertelstunde {@link
 *       AwHerkunft#UNBEKANNT} - unbekannt ist keine Null.
 *   <li><b>Jahresmarktwert</b> - "anhand des energieträgerspezifischen Jahresmarktwerts" (Anlage 1
 *       S. 21 Vor. 5, Anlage 2 S. 20) aus {@code annual_market_value}.
 * </ul>
 *
 * <p>Welche AW-Regel für eine Anlage gilt, ist ein Stammdatum der Anlage (Förderweg, MP-5); dieser
 * Leser nimmt sie als Eingang. Marktweite Daten: kein Mandant, kein RLS, die App-Rolle liest
 * ({@code GRANT SELECT} in {@code V20261002110000}).
 */
@Repository
public class MispelMarktdatenRepository {

    /** Die Differenzierungen der UeNB-Übersichtstabellen (CHECK in {@code eeg_aw_zeit}). */
    public static final Set<String> REGELN = Set.of(
            "viertelstunde", "viertelstunde_2ct",
            "stunden_1", "stunden_2", "stunden_3", "stunden_4", "stunden_6");

    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);

    /** Woher der AW¼-Wert einer Viertelstunde stammt. */
    public enum AwHerkunft {
        /** Aus der veröffentlichten Liste der Übertragungsnetzbetreiber - amtlich. */
        UENB_LISTE,
        /** Liste fehlt: vereinfachte Regel "AW¼ = 0 bei SP¼ &lt; 0" - nur vorläufig. */
        RUECKFALL_SPOT,
        /** Weder Liste noch Spotpreis. */
        UNBEKANNT
    }

    /** SP¼ in ct/kWh; {@code null} = für diese Viertelstunde ist kein Preis gespeichert. */
    public record SpotViertelstunde(Instant beginn, BigDecimal spCtKwh) {
    }

    /** {@code awGroesserNull} = Formel (24)¼ als Wahrheitswert; {@code null} nur bei UNBEKANNT. */
    public record AwViertelstunde(Instant beginn, Boolean awGroesserNull, AwHerkunft herkunft) {
    }

    /**
     * Die Viertelstunden eines Zeitraums; {@code vorlaeufig}, sobald auch nur eine davon nicht aus
     * der UeNB-Liste stammt - ein Monat mit Rückfall bleibt "vorläufig" (Bauplan § 8.5).
     */
    public record AwZeitraum(String regel, List<AwViertelstunde> viertelstunden, boolean vorlaeufig) {
    }

    public record Jahresmarktwert(
            int jahr, String technologie, BigDecimal ctKwh, boolean vorlaeufig, String quelle) {
    }

    private final JdbcTemplate jdbc;

    public MispelMarktdatenRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** SP¼ über {@code [von, bis)}; beide Grenzen auf der Viertelstunde. */
    public List<SpotViertelstunde> spotmarktpreise(String gebotszone, Instant von, Instant bis) {
        Map<Instant, BigDecimal> preise = spotJeViertelstunde(gebotszone, von, bis);
        List<SpotViertelstunde> out = new ArrayList<>();
        for (Instant t = von; t.isBefore(bis); t = t.plus(VIERTELSTUNDE)) {
            BigDecimal eurMwh = preise.get(t);
            out.add(new SpotViertelstunde(t, eurMwh == null ? null : eurMwh.movePointLeft(1)));
        }
        return out;
    }

    /** AW¼ &gt; 0 je Viertelstunde für eine Regel über {@code [von, bis)}. */
    public AwZeitraum awZeiten(String regel, String gebotszone, Instant von, Instant bis) {
        if (!REGELN.contains(regel)) {
            throw new IllegalArgumentException("unbekannte AW-Regel: " + regel);
        }
        Map<Instant, Boolean> liste = listeJeViertelstunde(regel, von, bis);
        Map<Instant, BigDecimal> preise = spotJeViertelstunde(gebotszone, von, bis);
        List<AwViertelstunde> out = new ArrayList<>();
        boolean vorlaeufig = false;
        for (Instant t = von; t.isBefore(bis); t = t.plus(VIERTELSTUNDE)) {
            Boolean amtlich = liste.get(t);
            if (amtlich != null) {
                out.add(new AwViertelstunde(t, amtlich, AwHerkunft.UENB_LISTE));
                continue;
            }
            vorlaeufig = true;
            BigDecimal sp = preise.get(t);
            out.add(sp == null
                    ? new AwViertelstunde(t, null, AwHerkunft.UNBEKANNT)
                    : new AwViertelstunde(t, sp.signum() >= 0, AwHerkunft.RUECKFALL_SPOT));
        }
        return new AwZeitraum(regel, List.copyOf(out), vorlaeufig);
    }

    /** Der Jahresmarktwert eines Energieträgers ({@code solar}, {@code wind_an_land}, ...). */
    public Optional<Jahresmarktwert> jahresmarktwert(int jahr, String technologie) {
        return jdbc.query(
                "SELECT year, technology, value_ct_kwh, provisional, source FROM annual_market_value "
                        + "WHERE year = ? AND technology = ?",
                (rs, i) -> new Jahresmarktwert(rs.getInt("year"), rs.getString("technology"),
                        rs.getBigDecimal("value_ct_kwh"), rs.getBoolean("provisional"),
                        rs.getString("source")),
                jahr, technologie).stream().findFirst();
    }

    private Map<Instant, BigDecimal> spotJeViertelstunde(String gebotszone, Instant von, Instant bis) {
        pruefeRaster(von, bis);
        Map<Instant, BigDecimal> out = new HashMap<>();
        jdbc.query("WITH " + PriceSlots.forZone()
                        + "SELECT slot, price_eur_mwh FROM price_slot WHERE slot >= ? AND slot < ?",
                rs -> {
                    out.put(rs.getTimestamp("slot").toInstant(), rs.getBigDecimal("price_eur_mwh"));
                },
                gebotszone, Timestamp.from(von), Timestamp.from(bis),
                Timestamp.from(von), Timestamp.from(bis));
        return out;
    }

    /** Die Liste der UeNB, Stundenzeilen auf ihre vier Viertelstunden ausgerollt. */
    private Map<Instant, Boolean> listeJeViertelstunde(String regel, Instant von, Instant bis) {
        pruefeRaster(von, bis);
        Map<Instant, Boolean> out = new HashMap<>();
        jdbc.query("SELECT ts, aufloesung, aw_groesser_null FROM eeg_aw_zeit "
                        + "WHERE regel = ? AND ts > ?::timestamptz - INTERVAL '60 minutes' AND ts < ?",
                rs -> {
                    Instant beginn = rs.getTimestamp("ts").toInstant();
                    int viertel = "PT60M".equals(rs.getString("aufloesung")) ? 4 : 1;
                    boolean wert = rs.getBoolean("aw_groesser_null");
                    for (int q = 0; q < viertel; q++) {
                        Instant t = beginn.plus(VIERTELSTUNDE.multipliedBy(q));
                        if (!t.isBefore(von) && t.isBefore(bis)) {
                            out.put(t, wert);
                        }
                    }
                },
                regel, Timestamp.from(von), Timestamp.from(bis));
        return out;
    }

    private static void pruefeRaster(Instant von, Instant bis) {
        if (von.getEpochSecond() % 900 != 0 || bis.getEpochSecond() % 900 != 0 || bis.isBefore(von)) {
            throw new IllegalArgumentException(
                    "Zeitraum muss auf Viertelstunden liegen und vorwärts laufen: " + von + " .. " + bis);
        }
    }
}
