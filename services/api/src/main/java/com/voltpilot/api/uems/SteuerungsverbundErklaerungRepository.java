package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Lese- und Schreibwege der Erklärung einer Gemeinsamen Steuerung (UEMS AP-15, Konzept §5.2, Migration
 * V20260922070000): die ungesteuerten Erzeuger (Frage 4) und was der Bestand je Box vorschlägt (Namen, Nennleistung
 * der Verbraucher). Alles unter RLS des aktuellen Mandanten (TenantContext); jede Abfrage nennt die Anlage.
 */
@Repository
public class SteuerungsverbundErklaerungRepository {

    /** Ein wirksamer ungesteuerter Erzeuger. */
    public record ErzeugerZeile(UUID id, String bezeichnung, BigDecimal nennKw, Instant createdAt, String createdBy) {}

    private final JdbcTemplate jdbc;

    public SteuerungsverbundErklaerungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die wirksamen ungesteuerten Erzeuger des Verbunds, in der Reihenfolge der Erklärung. */
    public List<ErzeugerZeile> erzeuger(UUID verbundId, UUID siteId) {
        return jdbc.query("SELECT id, bezeichnung, nenn_kw, created_at, created_by FROM steuerungsverbund_erzeuger "
                + "WHERE steuerungsverbund_id = ? AND site_id = ? AND aufgehoben_am IS NULL ORDER BY created_at, id",
                (rs, n) -> new ErzeugerZeile(rs.getObject("id", UUID.class), rs.getString("bezeichnung"),
                        rs.getBigDecimal("nenn_kw"), rs.getTimestamp("created_at").toInstant(),
                        rs.getString("created_by")), verbundId, siteId);
    }

    public void erzeugerEintragen(UUID tenant, UUID verbundId, String bezeichnung, BigDecimal nennKw, String wer) {
        jdbc.update("INSERT INTO steuerungsverbund_erzeuger (tenant_id, steuerungsverbund_id, site_id, bezeichnung, "
                + "nenn_kw, created_by) SELECT ?::uuid, v.id, v.site_id, ?, ?, ? FROM steuerungsverbund v WHERE v.id = ?",
                tenant, bezeichnung, nennKw, wer, verbundId);
    }

    /** Hebt alle wirksamen Erzeuger des Verbunds auf (aufheben statt ändern). */
    public int erzeugerAufheben(UUID verbundId, UUID siteId) {
        return jdbc.update("UPDATE steuerungsverbund_erzeuger SET aufgehoben_am = now() WHERE steuerungsverbund_id = ? "
                + "AND site_id = ? AND aufgehoben_am IS NULL", verbundId, siteId);
    }

    /**
     * Setzt NUR den Vorbehalt der Einspeiseseite (die Summe der Erzeuger). wer/wann des Vorbehalts bleiben stehen, wenn
     * sie schon gesetzt sind — sonst verlöre ein gemessener Bezugs-Vorbehalt seine Herkunft (IP-13 erkennt sie an
     * {@code vorbehalt_am}); die Erklärung selbst trägt wer/wann in {@code steuerungsverbund_erzeuger} und im Protokoll.
     */
    public void vorbehaltEinspeisungSetzen(UUID verbundId, BigDecimal kw, String wer) {
        jdbc.update("UPDATE steuerungsverbund SET vorbehalt_einspeisung_kw = ?, "
                + "vorbehalt_von = COALESCE(vorbehalt_von, ?), vorbehalt_am = COALESCE(vorbehalt_am, now()), "
                + "updated_at = now() WHERE id = ?", kw, wer, verbundId);
    }

    /** Die Nennleistung der Verbraucher aus ihrem Profil ({@code consumer_profile.rated_power_kw}), soweit gesetzt. */
    public Map<UUID, BigDecimal> nennleistungVerbraucher(UUID siteId) {
        Map<UUID, BigDecimal> out = new LinkedHashMap<>();
        jdbc.query("SELECT entity_id, rated_power_kw FROM consumer_profile WHERE site_id = ? "
                + "AND rated_power_kw IS NOT NULL", rs -> {
                    out.put(rs.getObject("entity_id", UUID.class), rs.getBigDecimal("rated_power_kw"));
                }, siteId);
        return out;
    }

    /** Gibt es die Komponente in dieser Anlage (unter RLS)? */
    public boolean komponenteDerAnlage(UUID siteId, UUID komponente) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM measurement_point WHERE id = ? AND site_id = ?",
                Integer.class, komponente, siteId);
        return n != null && n > 0;
    }

    /** Die angemeldeten Boxen der Anlage mit ihrem Namen (sonst der externen Kennung), in fester Reihenfolge. */
    public Map<UUID, String> boxen(UUID siteId) {
        Map<UUID, String> out = new LinkedHashMap<>();
        jdbc.query("SELECT id, COALESCE(NULLIF(btrim(name), ''), external_ref) AS name FROM device WHERE site_id = ? "
                + "AND ausgebaut_am IS NULL ORDER BY created_at, id", rs -> {
                    out.put(rs.getObject("id", UUID.class), rs.getString("name"));
                }, siteId);
        return out;
    }
}
