package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * Was eine Zählerreihe zur Zeit rechenbar macht (UEMS AP-08 IP-4, Z6/Z7) — gelesen aus der EINEN
 * Datenbank-Funktion {@code messreihe_zaehler_deklaration()} (V20260912220000), aus der auch die
 * Überlauf-Erkennung des Writers liest. So entscheiden Writer und Verdichtung nie mit zwei
 * verschiedenen Deklarationen.
 *
 * <p><b>Heute leer.</b> Die Felder dahinter baut AP-08 IP-7 (Vorlage: Wertebereich, „läuft über“;
 * Messstelle: Anschlussleistung). Bis dahin ist nichts deklariert: jeder fallende Stand bleibt eine
 * Rücksetzung (E4 — der Höchstwert wird nicht geraten), jeder Neustart kostet „bis zu 255 s“.
 *
 * @param wertebereichModul Z6: bei diesem Stand beginnt der Zähler bei 0, {@code null} = nicht deklariert
 * @param hoechstzuwachsJeKadenz Z6: der größte plausible Zuwachs je {@code kadenzS}
 * @param kadenzS die Kadenz, auf die sich der Höchstzuwachs bezieht
 * @param neustartVerlustS Z7: so viele Sekunden Zählung kann ein Neustart kosten, {@code null} = unbekannt
 */
record ZaehlerDeklaration(
        BigDecimal wertebereichModul,
        BigDecimal hoechstzuwachsJeKadenz,
        Integer kadenzS,
        Integer neustartVerlustS) {

    static final ZaehlerDeklaration NICHTS = new ZaehlerDeklaration(null, null, null, null);

    private static final MathContext RECHNUNG = new MathContext(28, RoundingMode.HALF_EVEN);

    /** Die Deklaration einer Reihe zur Zeit {@code zeit}; {@link #NICHTS}, wenn keine Zeile kommt. */
    static ZaehlerDeklaration lesen(Connection con, UUID tenant, UUID entity, String kanal, Instant zeit)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT wertebereich_modul, hoechstzuwachs_je_kadenz, "
                + "kadenz_s, neustart_verlust_s FROM messreihe_zaehler_deklaration(?, ?, ?, ?)")) {
            ps.setObject(1, tenant, Types.OTHER);
            ps.setObject(2, entity, Types.OTHER);
            ps.setString(3, kanal);
            ps.setTimestamp(4, Timestamp.from(zeit));
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? aus(rs, 1) : NICHTS;
            }
        }
    }

    /** Eine Zeile ab Spalte {@code erste} (vier Spalten in der Reihenfolge der Funktion). */
    static ZaehlerDeklaration aus(ResultSet rs, int erste) throws SQLException {
        return new ZaehlerDeklaration(zahl(rs.getBigDecimal(erste)), zahl(rs.getBigDecimal(erste + 1)),
                (Integer) rs.getObject(erste + 2), (Integer) rs.getObject(erste + 3));
    }

    /** Das Kennzeichen nennt den Wertebereich wörtlich — „65536“, nie „65536.000“. */
    private static BigDecimal zahl(BigDecimal x) {
        return x == null ? null : new BigDecimal(x.stripTrailingZeros().toPlainString());
    }

    /**
     * Der Höchstzuwachs je Kadenz der RECHNUNG — die Regel misst den Zeitabstand in ihrer Kadenz
     * ({@link VerbrauchRegeln#ueberlauf}); deklariert ist er je {@link #kadenzS}. {@code null},
     * wenn Wertebereich, Höchstzuwachs oder deren Kadenz fehlt: dann gibt es keinen Überlauf.
     */
    BigDecimal hoechstzuwachsFuer(Duration kadenz) {
        if (wertebereichModul == null || hoechstzuwachsJeKadenz == null || kadenzS == null || kadenzS < 1) {
            return null;
        }
        if (kadenz.getSeconds() == kadenzS && kadenz.getNano() == 0) {
            return hoechstzuwachsJeKadenz;
        }
        return hoechstzuwachsJeKadenz.multiply(BigDecimal.valueOf(kadenz.toNanos()))
                .divide(BigDecimal.valueOf(Duration.ofSeconds(kadenzS).toNanos()), RECHNUNG);
    }

    /** Der Wertebereich, aber nur, wenn ein Überlauf überhaupt rechenbar ist. */
    BigDecimal modulFuer(Duration kadenz) {
        return hoechstzuwachsFuer(kadenz) == null ? null : wertebereichModul;
    }

    /** Z7: der Zählverlust eines Neustarts dieser Reihe — deklariert, sonst die Vorgabe (255 s). */
    long neustartVerlust() {
        return neustartVerlustS == null ? VerbrauchRegeln.Ereignis.VERLUST_VORGABE : neustartVerlustS;
    }
}
