package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * {@code ueberwachung_externer_empfaenger} (Alerting Scheibe 6, Entscheid 11B, {@code V20261017060000}):
 * ein freier externer E-Mail-Empfänger EINER Überwachung - erst wirksam nach Bestätigung über einen
 * einmaligen Link, mit eigenem, nie ablaufendem Abbestellen-Token.
 *
 * <p>Verwalten (anlegen/listen/entfernen) geht über die RLS-Verbindung des Kundenbereichs; die
 * Bestätigung und das Abbestellen haben KEINE Anmeldung und damit keinen {@code TenantContext} - sie
 * finden die Zeile ausschließlich über ihren jeweiligen, global eindeutigen Token und schreiben über
 * die BYPASSRLS-Admin-Rolle (derselbe Zuschnitt wie {@code ZustellwegRepository}).
 */
@Repository
public class ExterneEmpfaengerRepository {

    /** Wie die Einstellungsfläche/das Blatt der Überwachung einen externen Empfänger zeigt. */
    public record ExternerEmpfaenger(UUID id, String email, boolean bestaetigt, boolean aktiv, Instant erstelltAm) {
    }

    /** Dieselbe Zeile, wie der Versand sie braucht (nur bestätigt UND aktiv). */
    public record VersandZeile(UUID id, String email, String abbestellenToken) {
    }

    private final JdbcTemplate jdbc;
    private final JdbcTemplate admin;

    public ExterneEmpfaengerRepository(JdbcTemplate jdbc, @Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.jdbc = jdbc;
        this.admin = admin;
    }

    /** Alle externen Empfänger EINER Regel (für ihr Blatt/ihre Verwaltung). */
    public List<ExternerEmpfaenger> eigene(UUID ueberwachungId) {
        return jdbc.query("""
                SELECT id, email, bestaetigt_am, aktiv, erstellt_am FROM ueberwachung_externer_empfaenger
                 WHERE tenant_id = ? AND ueberwachung_id = ? ORDER BY erstellt_am
                """, ExterneEmpfaengerRepository::zeile, TenantContext.get(), ueberwachungId);
    }

    /** Legt einen neuen externen Empfänger an und gibt (id, Bestätigungs-Token) zurück. */
    public record Angelegt(UUID id, String bestaetigungToken) {}

    public Angelegt anlegen(UUID ueberwachungId, String email, String bestaetigungToken, Instant bestaetigungAblauf,
            String abbestellenToken, String hinzugefuegtVon) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO ueberwachung_externer_empfaenger (tenant_id, ueberwachung_id, email,
                       bestaetigung_token, bestaetigung_ablauf, bestaetigung_versandt_am, abbestellen_token,
                       hinzugefuegt_von)
                VALUES (?, ?, ?, ?, ?, now(), ?, ?)
                RETURNING id
                """, UUID.class, TenantContext.get(), ueberwachungId, email, bestaetigungToken,
                Timestamp.from(bestaetigungAblauf), abbestellenToken, hinzugefuegtVon);
        return new Angelegt(id, bestaetigungToken);
    }

    /** Ausdrücklich entfernen (durch die verwaltende Person) - anders als Abbestellen eine echte Löschung. */
    public boolean entfernen(UUID id, UUID ueberwachungId) {
        return jdbc.update("""
                DELETE FROM ueberwachung_externer_empfaenger WHERE id = ? AND tenant_id = ? AND ueberwachung_id = ?
                """, id, TenantContext.get(), ueberwachungId) > 0;
    }

    /**
     * Bestätigt per Token: {@code true}, wenn er gültig (nicht abgelaufen) und noch unverbraucht
     * war. Der Token wird in jedem Fall verbraucht (auf NULL gesetzt) - derselbe Vertrag wie
     * {@code ZustellwegRepository#bestaetigen}.
     */
    public boolean bestaetigen(String token, Instant jetzt) {
        return admin.update("""
                UPDATE ueberwachung_externer_empfaenger SET bestaetigt_am = ?, bestaetigung_token = NULL,
                       geaendert_am = ?
                WHERE bestaetigung_token = ? AND bestaetigung_ablauf >= ?
                """, Timestamp.from(jetzt), Timestamp.from(jetzt), token, Timestamp.from(jetzt)) == 1;
    }

    /**
     * "Abbestellen" (Entscheid 11B: Link in jeder externen Mail, KEINE Anmeldung) - idempotent: ein
     * zweiter Aufruf desselben (nie ablaufenden) Tokens findet die Zeile weiterhin und bleibt ohne
     * Fehler, auch wenn sie schon {@code aktiv = false} war.
     */
    public boolean abbestellen(String token, Instant jetzt) {
        return admin.update("""
                UPDATE ueberwachung_externer_empfaenger SET aktiv = false, abbestellt_am = ?, geaendert_am = ?
                WHERE abbestellen_token = ?
                """, Timestamp.from(jetzt), Timestamp.from(jetzt), token) > 0;
    }

    /** Für den Bestätigungs-/Abbestellen-Erfolgstext: welche Regel das war (ohne Anmeldung lesbar). */
    public Optional<UUID> ueberwachungIdFuerAbbestellenToken(String token) {
        return admin.query("SELECT ueberwachung_id FROM ueberwachung_externer_empfaenger WHERE abbestellen_token = ?",
                (rs, n) -> rs.getObject("ueberwachung_id", UUID.class), token).stream().findFirst();
    }

    /** Alle bestätigten, aktiven externen Empfänger EINER Regel - für den Versand (Scheibe 6, Zusteller-Vorstufe). */
    public List<VersandZeile> fuerVersand(UUID ueberwachungId) {
        return jdbc.query("""
                SELECT id, email, abbestellen_token FROM ueberwachung_externer_empfaenger
                 WHERE ueberwachung_id = ? AND aktiv AND bestaetigt_am IS NOT NULL
                """, (rs, n) -> new VersandZeile(rs.getObject("id", UUID.class), rs.getString("email"),
                        rs.getString("abbestellen_token")), ueberwachungId);
    }

    private static ExternerEmpfaenger zeile(ResultSet rs, int n) throws SQLException {
        Timestamp erstelltAm = rs.getTimestamp("erstellt_am");
        return new ExternerEmpfaenger(rs.getObject("id", UUID.class), rs.getString("email"),
                rs.getTimestamp("bestaetigt_am") != null, rs.getBoolean("aktiv"),
                erstelltAm == null ? null : erstelltAm.toInstant());
    }
}
