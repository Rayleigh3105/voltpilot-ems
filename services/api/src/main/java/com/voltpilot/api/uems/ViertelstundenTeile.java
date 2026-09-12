package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Teilperiode;
import com.voltpilot.api.uems.VerbrauchRegeln.Werteteil;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

/**
 * Die gespeicherten VIERTELSTUNDEN einer Reihe als {@link Teilperiode}n — der gemeinsame Eingang
 * von Tag, Monat und freiem Zeitraum (UEMS AP-08 IP-5).
 *
 * <p><b>Gerechnet wird hier nichts.</b> Diese Klasse liest nur, was die Viertelstunde trägt
 * (Periodenstände, erster/letzter Wert, Menge, Kennzeichen, Abdeckung), und reicht es an
 * {@link VerbrauchRegeln#zaehlerstandAusTeilperioden}. Eine Viertelstunde ohne einen einzigen
 * Rohwert hat keine Zeile (IP-12) — sie fehlt hier und wird nie zur Null.
 *
 * <p><b>Gelesen wird ein wenig mehr als die Periode</b>: die Viertelstunde an {@code bis} und die
 * letzte mit einem guten Wert vor {@code von} (höchstens einen Tag zurück). Aus ihnen bestimmt die
 * Regel die Periodenstände an den Grenzen, wenn dort selbst keine Viertelstunde anliegt.
 *
 * <p><b>Seit AP-08 IP-3</b> dieselben Zeilen auch als {@link Werteteil} (Summe, Energie, gemessene
 * Zeit, Lücke im Intervall) für {@link VerbrauchRegeln#momentanwertAusTeilperioden} und
 * {@link VerbrauchRegeln#intervallmengeAusTeilperioden} — dazu die erste Viertelstunde mit gutem
 * Wert AB {@code bis} (höchstens einen Tag voraus): der Nachbar der Lücke und des Haltens über die
 * Endgrenze. Sie geht NICHT in {@code teile} ein; die Zählerstand-Regel sieht, was sie vorher sah.
 */
final class ViertelstundenTeile {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);
    private static final Duration RUECKBLICK = Duration.ofDays(1);

    private ViertelstundenTeile() {}

    /**
     * Was für eine Periode gelesen wurde.
     *
     * @param teile die Viertelstunden in {@code [von, bis]} plus die letzte davor
     * @param vorhanden Viertelstunden-Zeilen IN {@code [von, bis)}
     * @param endgueltig davon endgültig
     * @param kadenzS die Kadenz der jüngsten Viertelstunde in der Periode, {@code null} ohne eine
     * @param wertart die Wertart der jüngsten Viertelstunde in der Periode
     * @param werteteile dieselben Viertelstunden wie {@code teile} als {@link Werteteil}, dazu die
     *     erste mit gutem Wert ab {@code bis}
     */
    record Geladen(List<Teilperiode> teile, List<VerbrauchRegeln.Ereignis> ereignisse, int vorhanden,
            int endgueltig, int nachgeliefert, Integer kadenzS, String wertart, UUID siteId,
            boolean siteEindeutig, List<Werteteil> werteteile) {

        /** Nur die Viertelstunden IN {@code [von, bis)}. */
        List<Teilperiode> innen(Instant von, Instant bis) {
            return teile.stream().filter(t -> !t.von().isBefore(von) && !t.bis().isAfter(bis)).toList();
        }
    }

    /** Die Viertelstunden und Ereignisse einer Reihe für {@code [von, bis)}. */
    static Geladen laden(Connection con, UUID tenant, UUID entity, String kanal, Instant von, Instant bis)
            throws SQLException {
        String spalten = "intervall_beginn, zustand, wertart, site_id, stand_anfang, stand_anfang_zeit, "
                + "stand_ende, stand_ende_zeit, erster_wert, erster_zeit, letzter_wert, letzter_zeit, "
                + "menge, menge_zustand, erhalten, erwartet, kennzeichen::text, kadenz_s, n_nachgeliefert, "
                + "summe, mittel, min_wert, max_wert, energie, gemessen_s, luecke_innen";
        List<Teilperiode> teile = new ArrayList<>();
        List<Werteteil> werteteile = new ArrayList<>();
        int vorhanden = 0;
        int endgueltig = 0;
        int nachgeliefert = 0;
        Integer kadenzS = null;
        String wertart = null;
        UUID site = null;
        boolean siteEindeutig = true;
        try (PreparedStatement ps = con.prepareStatement(
                "(SELECT " + spalten + " FROM messreihe_viertelstunde"
                        + " WHERE tenant_id = ? AND entity_id = ? AND messkanal = ?"
                        + " AND intervall_beginn < ? AND intervall_beginn >= ? AND letzter_zeit IS NOT NULL"
                        + " ORDER BY intervall_beginn DESC LIMIT 1)"
                        + " UNION ALL"
                        + " (SELECT " + spalten + " FROM messreihe_viertelstunde"
                        + " WHERE tenant_id = ? AND entity_id = ? AND messkanal = ?"
                        + " AND intervall_beginn >= ? AND intervall_beginn <= ?)"
                        + " ORDER BY intervall_beginn")) {
            int p = 1;
            for (int runde = 0; runde < 2; runde++) {
                ps.setObject(p++, tenant, Types.OTHER);
                ps.setObject(p++, entity, Types.OTHER);
                ps.setString(p++, kanal);
                if (runde == 0) {
                    ps.setTimestamp(p++, Timestamp.from(von));
                    ps.setTimestamp(p++, Timestamp.from(von.minus(RUECKBLICK)));
                } else {
                    ps.setTimestamp(p++, Timestamp.from(von));
                    ps.setTimestamp(p++, Timestamp.from(bis));
                }
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Instant beginn = zeit(rs, 1);
                    Teilperiode t = teilperiode(rs);
                    teile.add(t);
                    werteteile.add(werteteil(rs, t));
                    if (!beginn.isBefore(von) && beginn.isBefore(bis)) {
                        vorhanden++;
                        if (ViertelstundeRegeln.ENDGUELTIG.equals(rs.getString(2))) {
                            endgueltig++;
                        }
                        nachgeliefert += rs.getInt(19);
                        kadenzS = (Integer) rs.getObject(18);
                        if (rs.getString(3) != null) {
                            wertart = rs.getString(3);
                        }
                        UUID s = rs.getObject(4, UUID.class);
                        if (s != null) {
                            if (site == null) {
                                site = s;
                            } else if (!site.equals(s)) {
                                siteEindeutig = false;
                            }
                        }
                    }
                }
            }
        }
        try (PreparedStatement ps = con.prepareStatement("SELECT " + spalten + " FROM messreihe_viertelstunde"
                + " WHERE tenant_id = ? AND entity_id = ? AND messkanal = ?"
                + " AND intervall_beginn >= ? AND intervall_beginn < ? AND erster_zeit IS NOT NULL"
                + " ORDER BY intervall_beginn LIMIT 1")) {
            ps.setObject(1, tenant, Types.OTHER);
            ps.setObject(2, entity, Types.OTHER);
            ps.setString(3, kanal);
            ps.setTimestamp(4, Timestamp.from(bis));
            ps.setTimestamp(5, Timestamp.from(bis.plus(RUECKBLICK)));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    werteteile.add(werteteil(rs, teilperiode(rs)));
                }
            }
        }
        return new Geladen(teile, ereignisse(con, tenant, entity, kanal, von, bis), vorhanden, endgueltig,
                nachgeliefert, kadenzS, wertart, site, siteEindeutig, List.copyOf(werteteile));
    }

    /** Eine gelesene Viertelstunde (Spalten wie in {@link #laden}) als {@link Teilperiode}. */
    private static Teilperiode teilperiode(ResultSet rs) throws SQLException {
        Instant beginn = zeit(rs, 1);
        return new Teilperiode(beginn, beginn.plus(VIERTELSTUNDE),
                wert(rs, 5, 6), wert(rs, 7, 8), wert(rs, 9, 10), wert(rs, 11, 12),
                new Ergebnis(rs.getBigDecimal(13), null, null, null, null, rs.getString(14),
                        rs.getInt(15), rs.getInt(16), null, kennzeichen(rs.getString(17))));
    }

    /**
     * Die gespeicherte Viertelstunde als {@link Werteteil}: Mittel/Min/Max, ungerundete Summe und
     * Energie, gemessene Zeit, Lücke im Intervall (Spalten 20–26). Die Stände bleiben weg — ein
     * Momentanwert hat keinen Periodenstand. Die gerundete Energie liest die Zusammensetzung nie.
     */
    private static Werteteil werteteil(ResultSet rs, Teilperiode t) throws SQLException {
        Ergebnis e = t.ergebnis();
        Integer gemessen = (Integer) rs.getObject(25);
        Boolean luecke = (Boolean) rs.getObject(26);
        return new Werteteil(
                new Teilperiode(t.von(), t.bis(), null, null, t.erster(), t.letzter(),
                        new Ergebnis(e.menge(), rs.getBigDecimal(21), rs.getBigDecimal(22), rs.getBigDecimal(23),
                                null, e.zustand(), e.erhalten(), e.erwartet(), null, e.kennzeichen())),
                rs.getBigDecimal(20),
                rs.getBigDecimal(24),
                gemessen == null ? 0 : gemessen,
                luecke != null && luecke);
    }

    /**
     * Die Gerätegrenzen und Neustarts der Reihe in {@code (von, bis]} — dieselbe Auswahl und
     * dieselbe Umwandlung wie im Verdichtungs-Lauf ({@link ViertelstundeVerdichter#fuerVerbrauchRegeln}).
     */
    static List<VerbrauchRegeln.Ereignis> ereignisse(Connection con, UUID tenant, UUID entity, String kanal,
            Instant von, Instant bis) throws SQLException {
        List<ViertelstundeVerdichter.Ereignis> roh = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT e.art, e.zeit, e.nutzlast->>'endstand', e.nutzlast->>'anfangsstand',
                       e.nutzlast->>'verlust_s'
                  FROM messreihe_ereignis e
                 WHERE e.tenant_id = ? AND e.entity_id = ?
                   AND (e.messkanal IS NULL OR e.messkanal = ?)
                   AND e.zeit > ? AND e.zeit <= ?
                   AND e.art IN ('device_boundary', 'device_restart')
                 ORDER BY e.zeit
                """)) {
            ps.setObject(1, tenant, Types.OTHER);
            ps.setObject(2, entity, Types.OTHER);
            ps.setString(3, kanal);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    roh.add(new ViertelstundeVerdichter.Ereignis(rs.getString(1), zeit(rs, 2),
                            zahl(rs.getString(3)), zahl(rs.getString(4)),
                            rs.getString(5) == null ? null : Long.valueOf(rs.getString(5)),
                            null, null, null, null));
                }
            }
        }
        return List.copyOf(ViertelstundeVerdichter.fuerVerbrauchRegeln(roh));
    }

    /** Die Kennzeichen einer gespeicherten Zeile — ein jsonb-Array von Sätzen. */
    static List<String> kennzeichen(String json) {
        if (json == null) {
            return List.of();
        }
        try {
            List<String> aus = new ArrayList<>();
            for (JsonNode n : JSON.readTree(json)) {
                aus.add(n.asText());
            }
            return List.copyOf(aus);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Kennzeichen sind kein JSON-Array: " + json, e);
        }
    }

    /** Ein gespeicherter Stand mit seiner Messzeit, oder {@code null}. */
    static Rohwert wert(ResultSet rs, int wertSpalte, int zeitSpalte) throws SQLException {
        BigDecimal w = rs.getBigDecimal(wertSpalte);
        Instant t = zeit(rs, zeitSpalte);
        return w == null || t == null ? null : new Rohwert(t, w);
    }

    static Instant zeit(ResultSet rs, int spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static BigDecimal zahl(String s) {
        return s == null || s.isBlank() ? null : new BigDecimal(s);
    }

    /**
     * Momentanwert bzw. Intervallmenge von {@code [von, bis)} aus diesen Teilen (AP-08 IP-3) —
     * {@code null} für jede andere Wertart. Integriert wird genau dann, wenn JEDER Teil mit gutem
     * Wert in der Periode seine Energie trägt: fehlt einem die Bindung {@code integration} (oder war
     * er vor IP-3 gebildet), gibt es für die ganze Periode keine Energie — eine zu kleine Summe wäre
     * eine Behauptung.
     */
    static Werteteil werte(List<Werteteil> teile, String wertart, Integer kadenzS, Instant von, Instant bis) {
        String regel = ViertelstundeRegeln.regelWort(wertart);
        if (kadenzS == null || regel == null || "zaehlerstand".equals(regel)) {
            return null;
        }
        Duration kadenz = Duration.ofSeconds(kadenzS);
        if ("intervallmenge".equals(regel)) {
            return VerbrauchRegeln.intervallmengeAusTeilperioden(teile, von, bis, kadenz);
        }
        List<Werteteil> gut = teile.stream()
                .filter(w -> !w.teil().von().isBefore(von) && !w.teil().bis().isAfter(bis))
                .filter(w -> w.teil().erster() != null)
                .toList();
        boolean integrieren = !gut.isEmpty() && gut.stream().allMatch(w -> w.energie() != null);
        return VerbrauchRegeln.momentanwertAusTeilperioden(teile, von, bis, kadenz, integrieren);
    }

    /**
     * Die Menge von {@code [von, bis)} aus diesen Teilperioden — {@code null}, wenn die Reihe kein
     * Zählerstand ist (für sie hat AP-08 keine Periodenregel über Ständen).
     */
    static Teilperiode zaehlerstand(Collection<Teilperiode> teile, List<VerbrauchRegeln.Ereignis> ereignisse,
            String wertart, Integer kadenzS, Instant von, Instant bis) {
        if (!"counter".equals(wertart) || kadenzS == null) {
            return null;
        }
        return VerbrauchRegeln.zaehlerstandAusTeilperioden(List.copyOf(teile), von, bis,
                Duration.ofSeconds(kadenzS), ereignisse, ViertelstundeRegeln.FAKTOR_DER_FASSUNG, null, null);
    }
}
