package com.voltpilot.api.chargers;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der zuletzt zugestellte Bezugswert des Ladepark-Dokuments je Anlage (UEMS AP-15 IP-3, Folgepaket,
 * {@code V20260921170000}). Unter RLS — die App-Rolle sieht nur ihren Kundenbereich.
 */
@Repository
public class LadeparkNetzgrenzeRepository {

    /** Die Zeile einer Anlage; {@code kw} NULL = das Dokument reiste ohne Grenze (nie 0 kW). */
    public record Zugestellt(Double kw) {}

    private final JdbcTemplate jdbc;

    public LadeparkNetzgrenzeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Zugestellt> zuletzt(UUID siteId) {
        return jdbc.query("SELECT netzgrenze_kw FROM ladepark_netzgrenze_zugestellt WHERE site_id = ?",
                (rs, n) -> new Zugestellt((Double) rs.getObject("netzgrenze_kw")), siteId).stream().findFirst();
    }

    public void zugestellt(UUID tenant, UUID siteId, Double kw) {
        jdbc.update("INSERT INTO ladepark_netzgrenze_zugestellt (site_id, tenant_id, netzgrenze_kw) VALUES (?,?,?) "
                + "ON CONFLICT (site_id) DO UPDATE SET netzgrenze_kw = EXCLUDED.netzgrenze_kw, zugestellt_am = now()",
                siteId, tenant, kw);
    }

    /** Hat die Anlage einen Ladepark-Rahmen? Nur dann reist ein Dokument (nie ein neues). */
    public boolean hatRahmen(UUID siteId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM site_charging_config WHERE site_id = ?", Integer.class,
                siteId);
        return n != null && n > 0;
    }

    /** Die Anlagen des Kundenbereichs mit Ladepark-Rahmen — der Umfang des Tageslaufs. */
    public List<UUID> anlagenMitRahmen() {
        return jdbc.queryForList("SELECT site_id FROM site_charging_config ORDER BY site_id", UUID.class);
    }
}
