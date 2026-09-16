package com.voltpilot.api.topology;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der massgebliche Rollen-Wert eines Geraets (die „verwenden als"-Zuordnung) auf dem
 * verallgemeinerten {@code entity_role_assignment} (V20260914100100): der zugeordnete Wert ist
 * ENTWEDER ein nativer Kanal ({@code capability}) ODER ein Gesamtwert / eine berechnete Messstelle
 * ({@code quell_messstelle_id}). Der Mandant ist die RLS.
 *
 * <p>Getrennt von {@link TopologyRepository}: dort lebt das Topologie-Lesemodell (nur die nativen
 * {@code capability}-Overrides), hier der massgebliche Rollen-Wert je (Geraet, Rolle) mit
 * is_primary-Semantik. Beide schreiben dieselbe Tabelle, stoeren sich aber nicht — die
 * Summenwert-Zeilen tragen {@code capability = NULL} und sind fuer das Lesemodell gefiltert.
 */
@Repository
public class RollenZuordnungRepository {

    /** Eine gespeicherte Rollen-Zuordnung: {@code capability} XOR {@code quellMessstelleId}. */
    public record Zuordnung(UUID id, UUID entityId, String capability, UUID quellMessstelleId,
            String role, boolean primary) {}

    private static final String SPALTEN =
            "id, entity_id, capability, quell_messstelle_id, role, is_primary";

    private final JdbcTemplate jdbc;

    public RollenZuordnungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static Zuordnung map(ResultSet rs, int n) throws SQLException {
        return new Zuordnung(rs.getObject("id", UUID.class), rs.getObject("entity_id", UUID.class),
                rs.getString("capability"), rs.getObject("quell_messstelle_id", UUID.class),
                rs.getString("role"), rs.getBoolean("is_primary"));
    }

    /** Die massgebliche (primaere) Zuordnung eines Geraets fuer eine Rolle, falls es eine gibt. */
    public Optional<Zuordnung> primaer(UUID entityId, String role) {
        return jdbc.query("SELECT " + SPALTEN + " FROM entity_role_assignment "
                + "WHERE entity_id = ? AND role = ? AND is_primary = TRUE ORDER BY id",
                RollenZuordnungRepository::map, entityId, role).stream().findFirst();
    }

    /** Alle massgeblichen Zuordnungen einer Rolle ueber die Geraete einer Anlage. */
    public List<Zuordnung> primaereDerAnlage(UUID siteId, String role) {
        return jdbc.query("SELECT " + SPALTEN + " FROM entity_role_assignment "
                + "WHERE site_id = ? AND role = ? AND is_primary = TRUE ORDER BY entity_id, id",
                RollenZuordnungRepository::map, siteId, role);
    }

    /**
     * Alle massgeblichen Zuordnungen einer Rolle ueber die GANZE Flotte des Mandanten, gruppiert je
     * Anlage — die eine Zuordnungs-Abfrage der Cockpit-Uebersicht (statt einer je Anlage). RLS-gezaeunt
     * wie die uebrigen Uebersichts-Abfragen ({@code OverviewRepository}): KEIN Anlagen-Praedikat, der
     * Mandant ist die RLS. Anlagen ohne Zuordnung sind ABWESEND — der Aufrufer faellt fuer sie auf
     * {@code telemetry.pv_power_kw} zurueck.
     */
    public Map<UUID, List<Zuordnung>> primaereJeAnlage(String role) {
        Map<UUID, List<Zuordnung>> jeAnlage = new HashMap<>();
        jdbc.query("SELECT site_id, " + SPALTEN + " FROM entity_role_assignment "
                + "WHERE role = ? AND is_primary = TRUE ORDER BY site_id, entity_id, id",
                rs -> {
                    jeAnlage.computeIfAbsent(rs.getObject("site_id", UUID.class), k -> new ArrayList<>())
                            .add(map(rs, 0));
                }, role);
        return jeAnlage;
    }

    /**
     * Nimmt jeder (Geraet, Rolle)-Zuordnung das Massgeblich-Kennzeichen (die is_primary-Semantik:
     * hoechstens ein massgeblicher je (Geraet, Rolle)). Die Zeile bleibt als nicht-massgeblicher
     * Kandidat bestehen — so geht keine Rollen-Zuordnung verloren, es zaehlt aber nur eine.
     */
    public int primaerLoesen(UUID entityId, String role) {
        return jdbc.update("UPDATE entity_role_assignment SET is_primary = FALSE "
                + "WHERE entity_id = ? AND role = ? AND is_primary = TRUE", entityId, role);
    }

    /** Setzt einen nativen Kanal als massgeblichen Rollen-Wert (idempotent). */
    public void setzeKanal(UUID siteId, UUID entityId, String capability, String role) {
        jdbc.update("INSERT INTO entity_role_assignment "
                + "(tenant_id, site_id, entity_id, capability, quell_messstelle_id, role, is_primary) "
                + "VALUES (?,?,?,?,NULL,?,TRUE) "
                + "ON CONFLICT (entity_id, capability) DO UPDATE SET role = EXCLUDED.role, "
                + "is_primary = TRUE",
                TenantContext.get(), siteId, entityId, capability, role);
    }

    /** Setzt einen Gesamtwert (berechnete Messstelle) als massgeblichen Rollen-Wert (idempotent). */
    public void setzeMessstelle(UUID siteId, UUID entityId, UUID quellMessstelleId, String role) {
        jdbc.update("INSERT INTO entity_role_assignment "
                + "(tenant_id, site_id, entity_id, capability, quell_messstelle_id, role, is_primary) "
                + "VALUES (?,?,?,NULL,?,?,TRUE) "
                + "ON CONFLICT (entity_id, quell_messstelle_id) DO UPDATE SET role = EXCLUDED.role, "
                + "is_primary = TRUE",
                TenantContext.get(), siteId, entityId, quellMessstelleId, role);
    }

    /** Serialisiert alle Änderungen der maßgeblichen Werte einer Anlage, auch bei leerer Rolle. */
    public void sperreAnlage(UUID siteId) {
        jdbc.query("SELECT id FROM site WHERE id = ? FOR UPDATE", (rs, n) -> rs.getObject(1), siteId);
    }

    /** Entfernt die Zuordnung vollständig: auch das native Topologie-Override ist danach weg. */
    public void entziehen(UUID entityId, String role) {
        jdbc.update("DELETE FROM entity_role_assignment WHERE entity_id = ? AND role = ?", entityId, role);
    }
}
