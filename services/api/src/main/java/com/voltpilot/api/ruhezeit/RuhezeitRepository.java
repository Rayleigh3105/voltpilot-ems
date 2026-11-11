package com.voltpilot.api.ruhezeit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
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
 * {@code ruhezeit_person} und {@code stummschaltung} (Alerting Scheibe 3, Konzept §6.4,
 * {@code V20261016100000}/{@code V20261016110000}). Dieselbe Rechte-Form wie
 * {@link com.voltpilot.api.versand.ZustellwegRepository}: die eigene Zeile über RLS, der
 * fremdbezogene Lesezugriff beim Versand über die BYPASSRLS-Admin-Rolle (der Läufer/Zusteller hat
 * keinen Zugriffs-Kontext, §2.5).
 */
@Repository
public class RuhezeitRepository {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Die eigene Ruhezeit (§6.4: "wiederkehrend je Person"). */
    public record RuhezeitPerson(JsonNode regeln, String zeitzone, boolean dringendDurch) {
    }

    /** Eine Stummschaltung (§6.4: "einmalig mit Ende"). */
    public record StummZeile(UUID id, JsonNode auswahl, Instant von, Instant bis, String grund, String vonWem) {
    }

    private final JdbcTemplate jdbc;
    private final JdbcTemplate admin;

    public RuhezeitRepository(JdbcTemplate jdbc, @Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.jdbc = jdbc;
        this.admin = admin;
    }

    // --------------------------------------------------------------------- Ruhezeit der Person

    public Optional<RuhezeitPerson> eigene(String benutzerSub) {
        return jdbc.query("SELECT regeln::text AS regeln_json, zeitzone, dringend_durch FROM ruhezeit_person "
                        + "WHERE tenant_id = ? AND benutzer_sub = ?",
                RuhezeitRepository::ruhezeitPerson, TenantContext.get(), benutzerSub).stream().findFirst();
    }

    public void setzen(String benutzerSub, String regelnJson, String zeitzone, boolean dringendDurch) {
        jdbc.update("""
                INSERT INTO ruhezeit_person (tenant_id, benutzer_sub, regeln, zeitzone, dringend_durch)
                VALUES (?, ?, ?::jsonb, ?, ?)
                ON CONFLICT (tenant_id, benutzer_sub) DO UPDATE SET
                    regeln = excluded.regeln, zeitzone = excluded.zeitzone,
                    dringend_durch = excluded.dringend_durch, geaendert_am = now()
                """, TenantContext.get(), benutzerSub, regelnJson, zeitzone, dringendDurch);
    }

    /** Für den Zusteller: die Ruhezeit einer BELIEBIGEN Person, quer über alle Kundenbereiche. */
    public Optional<RuhezeitPerson> fuerVersand(UUID tenantId, String benutzerSub) {
        return admin.query("SELECT regeln::text AS regeln_json, zeitzone, dringend_durch FROM ruhezeit_person "
                        + "WHERE tenant_id = ? AND benutzer_sub = ?",
                RuhezeitRepository::ruhezeitPerson, tenantId, benutzerSub).stream().findFirst();
    }

    private static RuhezeitPerson ruhezeitPerson(ResultSet rs, int n) throws SQLException {
        return new RuhezeitPerson(json(rs.getString("regeln_json")), rs.getString("zeitzone"),
                rs.getBoolean("dringend_durch"));
    }

    // --------------------------------------------------------------------- Stummschaltung

    /** Die eigenen (sichtbaren) Stummschaltungen - für die Einstellungs-/Meldungsfläche. */
    public List<StummZeile> aktive(Instant jetzt) {
        return jdbc.query("""
                SELECT id, auswahl::text AS auswahl_json, von, bis, grund, von_wem FROM stummschaltung
                 WHERE bis > ? ORDER BY von
                """, RuhezeitRepository::stummZeile, Timestamp.from(jetzt));
    }

    public UUID anlegen(String auswahlJson, UUID standortId, Instant von, Instant bis, String grund, String vonWem) {
        return jdbc.queryForObject("""
                INSERT INTO stummschaltung (tenant_id, standort_id, auswahl, von, bis, grund, von_wem)
                VALUES (?, ?, ?::jsonb, ?, ?, ?, ?) RETURNING id
                """, UUID.class, TenantContext.get(), standortId, auswahlJson, Timestamp.from(von),
                Timestamp.from(bis), grund, vonWem);
    }

    /**
     * {@code true}, wenn eine Regel, ihre Anlage oder ihr Standort JETZT stummgeschaltet ist
     * (Alerting Scheibe 3, §6.4) - für den Zusteller, quer über alle Kundenbereiche.
     */
    public boolean istStumm(UUID tenantId, UUID ueberwachungId, UUID standortId, UUID anlageId, Instant jetzt) {
        String standortStr = standortId == null ? null : standortId.toString();
        String anlageStr = anlageId == null ? null : anlageId.toString();
        Boolean b = admin.queryForObject("""
                SELECT EXISTS (
                  SELECT 1 FROM stummschaltung
                   WHERE tenant_id = ? AND von <= ? AND bis > ?
                     AND ( auswahl ->> 'regel' = ?::text
                        OR (?::text IS NOT NULL AND auswahl ->> 'standort' = ?::text)
                        OR (?::text IS NOT NULL AND auswahl ->> 'anlage' = ?::text) )
                )
                """, Boolean.class, tenantId, Timestamp.from(jetzt), Timestamp.from(jetzt),
                ueberwachungId.toString(), standortStr, standortStr, anlageStr, anlageStr);
        return Boolean.TRUE.equals(b);
    }

    private static StummZeile stummZeile(ResultSet rs, int n) throws SQLException {
        return new StummZeile(rs.getObject("id", UUID.class), json(rs.getString("auswahl_json")),
                rs.getTimestamp("von").toInstant(), rs.getTimestamp("bis").toInstant(), rs.getString("grund"),
                rs.getString("von_wem"));
    }

    private static JsonNode json(String text) {
        try {
            return text == null ? null : JSON.readTree(text);
        } catch (IOException e) {
            throw new IllegalStateException("Ruhezeit: ungültiges JSON '" + text + "'", e);
        }
    }
}
