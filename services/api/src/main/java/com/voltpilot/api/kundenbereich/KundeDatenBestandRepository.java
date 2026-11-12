package com.voltpilot.api.kundenbereich;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Datenbestand eines Kundenbereichs für das Löschen (vp-kunde-sofort-loeschen-mit-daten: jeder
 * Kundenbereich ist sofort löschbar, dieser Befund trägt nur noch den Anlass und die Dialog-Fakten,
 * nie eine Sperre) - die Abfrage aus {@link KundeDatenBestand}, über die Admin-Verbindung
 * ({@code voltpilot_admin}, BYPASSRLS) wie {@code KundenbereichEndeRepository}: der Befund gilt dem
 * Betreiber über jeden Mandanten, nie einer Kundenrolle. {@link #datenarten(Connection, UUID)} läuft
 * zusätzlich auf der VERBINDUNG DES LÖSCHZUGS, damit die Wache unter der {@code FOR UPDATE}-Sperre
 * denselben Stand sieht, den sie gleich löscht.
 */
@Repository
public class KundeDatenBestandRepository {

    private final JdbcTemplate jdbc;

    public KundeDatenBestandRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Eine Zeile des Bestands: der Kunde, sein Vertragsende (leer = aktiv) und die gefundenen Datenarten. */
    public record Zeile(UUID tenantId, String name, Optional<KundenbereichEnde> beendet, List<String> datenarten) {
        public boolean sofortLoeschbar() {
            return datenarten.isEmpty();
        }
    }

    /** Der Bestand EINES Kunden - leer, wenn es ihn nicht gibt. */
    public Optional<Zeile> fuerKunde(UUID kundenbereich) {
        return jdbc.query(KundeDatenBestand.abfrage() + " WHERE t.id = ?",
                KundeDatenBestandRepository::zeile, kundenbereich).stream().findFirst();
    }

    /** Was ein Löschen umfasst - die Folgen-Fakten für den Bestätigungs-Dialog des Portals. */
    public record Folgen(int anlagen, List<String> boxen, int personen) {}

    /**
     * Die Folgen eines Löschens: Anlagen, die nicht ausgebauten Boxen (ihre Kennungen werden wieder
     * anmeldbar) und die Personen des Kunden (Spiegel {@code benutzer}: Konten UND offene Einladungen).
     */
    public Folgen folgen(UUID kundenbereich) {
        Integer anlagen = jdbc.queryForObject("SELECT count(*) FROM site WHERE tenant_id = ?",
                Integer.class, kundenbereich);
        List<String> boxen = jdbc.queryForList("SELECT external_ref FROM device WHERE tenant_id = ?"
                + " AND ausgebaut_am IS NULL ORDER BY external_ref", String.class, kundenbereich);
        Integer personen = jdbc.queryForObject("SELECT count(*) FROM benutzer WHERE tenant_id = ?",
                Integer.class, kundenbereich);
        return new Folgen(anlagen == null ? 0 : anlagen, boxen, personen == null ? 0 : personen);
    }

    /** Nur die Datenarten eines Kunden, auf einer BESTEHENDEN Verbindung - für die Wache des Löschzugs. */
    public static List<String> datenarten(Connection con, UUID kundenbereich) throws SQLException {
        try (PreparedStatement st = con.prepareStatement(KundeDatenBestand.abfrage() + " WHERE t.id = ?")) {
            st.setObject(1, kundenbereich);
            try (ResultSet rs = st.executeQuery()) {
                return rs.next() ? datenarten(rs) : List.of();
            }
        }
    }

    private static Zeile zeile(ResultSet rs, int rowNum) throws SQLException {
        UUID id = rs.getObject("tenant_id", UUID.class);
        OffsetDateTime beendetAm = rs.getObject("beendet_am", OffsetDateTime.class);
        Optional<KundenbereichEnde> beendet = beendetAm == null ? Optional.empty()
                : Optional.of(new KundenbereichEnde(id, beendetAm.toInstant(),
                        rs.getInt("beendet_frist_tage"), rs.getString("beendet_von")));
        return new Zeile(id, rs.getString("name"), beendet, datenarten(rs));
    }

    private static List<String> datenarten(ResultSet rs) throws SQLException {
        List<String> datenarten = new ArrayList<>();
        if (rs.getBoolean(KundeDatenBestand.HERZSCHLAG)) {
            datenarten.add(KundeDatenBestand.HERZSCHLAG);
        }
        for (String datenart : KundeDatenBestand.AUFZEICHNUNGEN.keySet()) {
            if (rs.getBoolean(datenart)) {
                datenarten.add(datenart);
            }
        }
        return List.copyOf(datenarten);
    }
}
