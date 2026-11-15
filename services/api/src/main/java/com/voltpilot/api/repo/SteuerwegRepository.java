package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Steuerweg je Anlage ({@code steuerweg}) und seine Schritte ({@code steuerweg_schritt}), unter RLS des aktuellen
 * Mandanten (V20261115230000__steuerweg.sql, V20261116000000__steuerweg_geraete.sql). Ohne Zeile gilt der alte Weg.
 */
@Repository
public class SteuerwegRepository {

    public static final String ALT = "alt";
    public static final String MITLAUF = "mitlauf";
    public static final String KERN = "kern";

    /**
     * Der Schalter einer Anlage: Modus der Regeln, seit wann, wer ihn gestellt hat; dazu der Modus der Geräte
     * (Steuerarten und Heizstab-Regler, Stufe 6, dritter Teil, V20261116000000) und seit wann.
     */
    public record Weg(String modus, Instant seit, String von, String rolle, String geraeteModus, Instant geraeteSeit) {

        public static final Weg AB_WERK = new Weg(ALT, null, null, null, ALT, null);
    }

    /** Ein Schritt am Schalter; {@code vonName} ist der Anzeigename des Kontos, sonst die Kennung. */
    public record Schritt(String was, Instant am, String von, String vonName, String rolle, String datenJson) {}

    private final JdbcTemplate jdbc;

    public SteuerwegRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Der Schalter der Anlage; ohne Zeile ab Werk {@code alt}. */
    public Weg weg(UUID siteId) {
        List<Weg> w = jdbc.query("SELECT modus, seit, von, rolle, geraete_modus, geraete_seit FROM steuerweg "
                + "WHERE site_id = ?", (rs, i) -> new Weg(rs.getString(1), rs.getTimestamp(2).toInstant(),
                        rs.getString(3), rs.getString(4), rs.getString(5),
                        rs.getTimestamp(6) == null ? null : rs.getTimestamp(6).toInstant()), siteId);
        return w.isEmpty() ? Weg.AB_WERK : w.get(0);
    }

    /** Stellt den Schalter der Regeln und hält den Schritt fest. In der Transaktion des Aufrufers. */
    public void stelle(UUID tenantId, UUID siteId, String modus, String was, String von, String rolle,
            String datenJson, Instant jetzt) {
        Weg alt = weg(siteId);
        stelle(tenantId, siteId, modus, alt.geraeteModus(), was, von, rolle, datenJson, jetzt);
    }

    /**
     * Stellt beide Gruppen des Schalters (Regeln, Geräte) und hält den Schritt fest; eine Gruppe, die sich nicht
     * ändert, behält ihr „seit“. In der Transaktion des Aufrufers.
     */
    public void stelle(UUID tenantId, UUID siteId, String modus, String geraeteModus, String was, String von,
            String rolle, String datenJson, Instant jetzt) {
        Weg alt = weg(siteId);
        Instant seit = modus.equals(alt.modus()) && alt.seit() != null ? alt.seit() : jetzt;
        Instant geraeteSeit = geraeteModus.equals(alt.geraeteModus()) && alt.geraeteSeit() != null
                ? alt.geraeteSeit() : jetzt;
        jdbc.update("""
                INSERT INTO steuerweg (site_id, tenant_id, modus, seit, von, rolle, geraete_modus, geraete_seit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (site_id) DO UPDATE SET modus = EXCLUDED.modus, seit = EXCLUDED.seit,
                    von = EXCLUDED.von, rolle = EXCLUDED.rolle, geraete_modus = EXCLUDED.geraete_modus,
                    geraete_seit = EXCLUDED.geraete_seit
                """, siteId, tenantId, modus, Timestamp.from(seit), von, rolle, geraeteModus,
                Timestamp.from(geraeteSeit));
        jdbc.update("""
                INSERT INTO steuerweg_schritt (id, tenant_id, site_id, was, am, von, rolle, daten)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
                """, UUID.randomUUID(), tenantId, siteId, was, Timestamp.from(jetzt), von, rolle, datenJson);
    }

    /** Die jüngsten Schritte der Anlage, neueste zuerst. */
    public List<Schritt> schritte(UUID siteId, int grenze) {
        return jdbc.query("""
                SELECT s.was, s.am, s.von,
                       COALESCE((SELECT NULLIF(btrim(b.anzeigename), '') FROM benutzer b
                                 WHERE b.tenant_id = s.tenant_id AND b.sub = s.von), s.von),
                       s.rolle, s.daten::text
                FROM steuerweg_schritt s WHERE s.site_id = ? ORDER BY s.am DESC LIMIT ?
                """, (rs, i) -> new Schritt(rs.getString(1), rs.getTimestamp(2).toInstant(), rs.getString(3),
                rs.getString(4), rs.getString(5), rs.getString(6)), siteId, grenze);
    }
}
