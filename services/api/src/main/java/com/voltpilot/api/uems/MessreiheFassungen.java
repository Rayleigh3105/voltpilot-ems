package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Was die beiden Beleg-Tabellen von AP-08 IP-12 gemeinsam haben ({@code messreihe_ersatzwert},
 * {@code messreihe_korrektur}, Migration V20260913190000): die Kennung je Kundenbereich und Jahr
 * und die Fassungen — Fassung 1 legt an, jede weitere schreibt nur den Status fort.
 *
 * <p>Die Regeln hält die Datenbank (Vokabular, Übergänge, lückenlose Fassungen, append-only); hier
 * steht nur, wie die Kennung vergeben und die nächste Fassung gezählt wird.
 */
public final class MessreiheFassungen {

    /** Eine Fassung: welcher Status, mit welchem Grund, von wem, wann. */
    public record Fassung(int fassung, String status, String grund, ProtokollAkteur akteur, Instant am) {
    }

    private MessreiheFassungen() {
    }

    /**
     * Die nächste Kennung {@code <praefix>-<Jahr>-<lfd. Nr.>} je Kundenbereich: das Jahr der
     * Erfassung in {@code zone} (derselbe Augenblick wie {@code created_at} der Zeile), die Nummer
     * folgt auf die höchste je vergebene. Die Zeilen werden nie gelöscht (nur das Offboarding räumt
     * den ganzen Kundenbereich), darum braucht es keinen Zähler — nur die Sperre je Kundenbereich
     * und Jahr, bis die Transaktion endet. Nur innerhalb einer Transaktion aufrufen.
     */
    static String naechsteKennung(JdbcTemplate jdbc, String tabelle, String praefix, UUID tenantId, ZoneId zone) {
        int jahr = jdbc.queryForObject("SELECT extract(year FROM now() AT TIME ZONE ?)::int", Integer.class,
                zone.getId());
        String kopf = praefix + "-" + jahr + "-";
        jdbc.queryForList("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?, 0))", Integer.class,
                tabelle + ":" + tenantId + ":" + kopf);
        Integer hoechste = jdbc.queryForObject("SELECT max(substring(kennung FROM ?)::int) FROM " + tabelle
                + " WHERE tenant_id = ? AND fassung = 1 AND starts_with(kennung, ?)", Integer.class,
                "^" + praefix + "-[0-9]{4}-([0-9]+)$", tenantId, kopf);
        return String.format("%s%04d", kopf, hoechste == null ? 1 : hoechste + 1);
    }

    /** Die Fassungen einer Kennung, erste zuerst — die letzte ist ihr Stand. */
    static List<Fassung> fassungen(JdbcTemplate jdbc, String tabelle, UUID tenantId, String kennung) {
        return jdbc.query("SELECT fassung, status, grund, actor_sub, actor_name, actor_rolle, actor_art, created_at "
                + "FROM " + tabelle + " WHERE tenant_id = ? AND kennung = ? ORDER BY fassung",
                MessreiheFassungen::fassung, tenantId, kennung);
    }

    /**
     * Schreibt den Status fort: Fassung n + 1 mit Grund und Urheber, ohne anlegende Spalten. Ob der
     * Status auf den letzten folgen darf, sagt die Datenbank ({@code …_status_folgt}); schreiben
     * zwei gleichzeitig dieselbe Fassung, gewinnt eine (Primärschlüssel).
     */
    static void fortschreiben(JdbcTemplate jdbc, String tabelle, UUID tenantId, String kennung, int naechste,
            String status, String grund, ProtokollAkteur akteur) {
        jdbc.update("INSERT INTO " + tabelle + " (tenant_id, kennung, fassung, status, grund, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?,?,?,?,?,?,?,?,?)",
                tenantId, kennung, naechste, status, grund,
                akteur.sub(), akteur.name(), akteur.rolle(), akteur.art());
    }

    static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static Fassung fassung(ResultSet rs, int n) throws SQLException {
        return new Fassung(rs.getInt("fassung"), rs.getString("status"), rs.getString("grund"),
                new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"),
                        rs.getString("actor_rolle"), rs.getString("actor_art")),
                zeit(rs, "created_at"));
    }
}
