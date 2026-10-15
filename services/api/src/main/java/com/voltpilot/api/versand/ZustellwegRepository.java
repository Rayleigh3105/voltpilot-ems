package com.voltpilot.api.versand;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * {@code zustellweg} (Alerting Scheibe 0, §6.6, {@code V20261015120000}): wie eine Person per E-Mail
 * erreicht wird, erst wirksam nach Bestätigung über einen einmaligen, ablaufenden Link.
 *
 * <p>Anlegen/Lesen des EIGENEN Zustellwegs geht über die RLS-Verbindung des Kundenbereichs (Hausregel:
 * Mandant aus dem Token, nie aus einem Anfragekörper). Die Bestätigung selbst hat KEINE Anmeldung und
 * damit keinen {@code TenantContext} - sie findet die Zeile ausschließlich über den global eindeutigen
 * Token und schreibt über die BYPASSRLS-Admin-Rolle, genau wie die self-service Registrierung vor dem
 * ersten Token auskommt.
 */
@Repository
public class ZustellwegRepository {

    /** Der eigene Zustellweg E-Mail, wie ihn „So erreichen wir Sie“ anzeigt. */
    public record Zustellweg(UUID id, String ziel, Instant bestaetigtAm, boolean aktiv) {
        public boolean bestaetigt() {
            return bestaetigtAm != null;
        }
    }

    private final JdbcTemplate jdbc;
    private final JdbcTemplate admin;

    public ZustellwegRepository(JdbcTemplate jdbc, @Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.jdbc = jdbc;
        this.admin = admin;
    }

    /** Eigener Zustand (für die Anzeige „So erreichen wir Sie“), leer ohne jeden Eintrag. */
    public Optional<Zustellweg> eigener(String benutzerSub) {
        return jdbc.query("SELECT id, ziel, bestaetigt_am, aktiv FROM zustellweg "
                        + "WHERE tenant_id = ? AND benutzer_sub = ? AND weg = 'email'",
                ZustellwegRepository::zustellweg, TenantContext.get(), benutzerSub).stream().findFirst();
    }

    /**
     * Legt den eigenen E-Mail-Zustellweg an oder ändert ihn (eine Person, ein Weg - {@code uq_zustellweg_person_weg}):
     * eine geänderte Adresse ist wieder UNBESTÄTIGT, bis der neue Link geklickt wird - ein alter Link
     * verliert dadurch seinen Token (der Teil-Index ist je Token eindeutig, nicht je Zeile).
     */
    public UUID anlegenOderErneuern(String benutzerSub, String ziel, String token, Instant ablauf) {
        return jdbc.queryForObject("""
                INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigung_token,
                                        bestaetigung_ablauf, bestaetigung_versandt_am)
                VALUES (?, ?, 'email', ?, ?, ?, now())
                ON CONFLICT (tenant_id, benutzer_sub, weg) DO UPDATE SET
                    ziel = excluded.ziel,
                    bestaetigung_token = excluded.bestaetigung_token,
                    bestaetigung_ablauf = excluded.bestaetigung_ablauf,
                    bestaetigung_versandt_am = excluded.bestaetigung_versandt_am,
                    bestaetigt_am = CASE WHEN zustellweg.ziel = excluded.ziel THEN zustellweg.bestaetigt_am
                                         ELSE NULL END,
                    geaendert_am = now()
                RETURNING id
                """, UUID.class, TenantContext.get(), benutzerSub, ziel, token, Timestamp.from(ablauf));
    }

    /**
     * Bestätigt per Token: {@code true}, wenn er gültig (nicht abgelaufen) und noch unverbraucht war.
     * Der Token wird in jedem Fall verbraucht (auf NULL gesetzt), damit ein zweiter Aufruf desselben
     * Links nichts mehr findet - "einmalig" (§6.7-Festlegung).
     */
    public boolean bestaetigen(String token, Instant jetzt) {
        return admin.update("""
                UPDATE zustellweg SET bestaetigt_am = ?, bestaetigung_token = NULL, geaendert_am = ?
                WHERE bestaetigung_token = ? AND bestaetigung_ablauf >= ?
                """, Timestamp.from(jetzt), Timestamp.from(jetzt), token, Timestamp.from(jetzt)) == 1;
    }

    /** Die zur Sendezeit gültige Adresse - bestätigt und aktiv - für den Zusteller. */
    public Optional<String> bestaetigtesZiel(UUID tenantId, String benutzerSub) {
        return admin.query("SELECT ziel FROM zustellweg WHERE tenant_id = ? AND benutzer_sub = ? "
                        + "AND weg = 'email' AND bestaetigt_am IS NOT NULL AND aktiv",
                (rs, n) -> rs.getString("ziel"), tenantId, benutzerSub).stream().findFirst();
    }

    private static Zustellweg zustellweg(ResultSet rs, int n) throws SQLException {
        Timestamp bestaetigtAm = rs.getTimestamp("bestaetigt_am");
        return new Zustellweg(rs.getObject("id", UUID.class), rs.getString("ziel"),
                bestaetigtAm == null ? null : bestaetigtAm.toInstant(), rs.getBoolean("aktiv"));
    }
}
