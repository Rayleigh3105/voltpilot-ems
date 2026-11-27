package com.voltpilot.api.consumers;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Tabelle {@code schaltspur} (V20261127120000) unter RLS des aktuellen Mandanten. Nur {@link SchaltSpur} schreibt
 * und liest sie; die Regeln, WAS ein Herzschlag bedeutet, stehen in {@link SchaltSpurAbgleich}.
 */
@Repository
public class SchaltSpurRepository {

    /** So viele Spuren behält ein Verbraucher; ältere gehen beim nächsten Eingriff. */
    static final int JE_VERBRAUCHER = 20;

    /** Eine Spur, wie sie gespeichert ist. Zeitpunkte {@code box*} in der Uhr der Box, alle übrigen in der der API. */
    public record Zeile(UUID id, UUID siteId, UUID entityId, UUID deviceId, String requestId, String art,
            String kommando, BigDecimal wert, List<Integer> ausgaenge, Instant apiEingang, Instant gesendet,
            String zustellung, Instant ersteMeldung, Instant boxEmpfangen, Instant boxEntschieden,
            Instant boxGeschrieben, Instant boxZurueckgelesen, Instant boxGemeldet, String boxUrteil,
            Instant gehalten, String grund, Instant bestaetigt, String ergebnis, Integer portalAntwortMs,
            Integer portalSichtbarMs, Instant portalGemeldet) {

        SchaltSpurAbgleich.Wunsch wunsch() {
            return new SchaltSpurAbgleich.Wunsch(art, kommando, wert, ausgaenge);
        }
    }

    private static final String SPALTEN = "id, site_id, entity_id, device_id, request_id, art, kommando, wert, "
            + "ausgaenge, api_eingang_at, gesendet_at, zustellung, erste_meldung_at, box_empfangen_at, "
            + "box_entschieden_at, box_geschrieben_at, box_zurueckgelesen_at, box_gemeldet_at, box_urteil, "
            + "gehalten_at, grund, bestaetigt_at, ergebnis, portal_antwort_ms, portal_sichtbar_ms, portal_gemeldet_at";

    private final JdbcTemplate jdbc;

    public SchaltSpurRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Legt eine Spur an (RLS stempelt den Mandanten) und schließt ältere, noch offene Spuren desselben Verbrauchers
     * als {@code ersetzt}: ein neuer Tipp ersetzt den Wunsch des vorigen im selben Quellslot der Box. Danach bleiben
     * je Verbraucher die {@link #JE_VERBRAUCHER} jüngsten.
     */
    public void anlegen(UUID id, UUID siteId, UUID entityId, String requestId, String art, String kommando,
            BigDecimal wert, List<Integer> ausgaenge, Instant eingang) {
        jdbc.update("UPDATE schaltspur SET ergebnis = 'ersetzt' WHERE site_id = ? AND entity_id = ? "
                + "AND ergebnis IN ('offen', 'gehalten', 'abweichung')", siteId, entityId);
        jdbc.update("INSERT INTO schaltspur (id, tenant_id, site_id, entity_id, request_id, art, kommando, wert, "
                        + "ausgaenge, api_eingang_at) VALUES "
                        + "(?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, siteId, entityId, requestId, art, kommando, wert,
                ausgaenge == null || ausgaenge.isEmpty() ? null : ausgaenge.toArray(Integer[]::new),
                Timestamp.from(eingang));
        jdbc.update("DELETE FROM schaltspur WHERE site_id = ? AND entity_id = ? AND id NOT IN "
                + "(SELECT id FROM schaltspur WHERE site_id = ? AND entity_id = ? "
                + "ORDER BY api_eingang_at DESC LIMIT " + JE_VERBRAUCHER + ")", siteId, entityId, siteId, entityId);
    }

    /** Der Umschlag ist beim Broker (oder warum nicht: {@code zustellung}). */
    public void gesendet(UUID id, UUID deviceId, Instant at, String zustellung) {
        jdbc.update("UPDATE schaltspur SET device_id = ?, gesendet_at = ?, zustellung = ? WHERE id = ?",
                deviceId, at == null ? null : Timestamp.from(at), zustellung, id);
    }

    /**
     * Die offenen Spuren einer Box an diesen Verbrauchern: gesendet, weder bestätigt noch ersetzt, und jünger als
     * eine Stunde (länger hält keine Schutzregel der Box einen Wunsch; danach misst die Spur nichts mehr).
     */
    public List<Zeile> offen(UUID siteId, UUID deviceId, Collection<UUID> entityIds) {
        if (entityIds.isEmpty()) {
            return List.of();
        }
        return jdbc.query(con -> {
            var ps = con.prepareStatement("SELECT " + SPALTEN + " FROM schaltspur WHERE site_id = ? AND device_id = ? "
                    + "AND entity_id = ANY(?) AND ergebnis IN ('offen', 'gehalten', 'abweichung') AND gesendet_at IS NOT NULL "
                    + "AND api_eingang_at > now() - interval '1 hour'");
            ps.setObject(1, siteId);
            ps.setObject(2, deviceId);
            ps.setArray(3, con.createArrayOf("uuid", entityIds.toArray()));
            return ps;
        }, (rs, i) -> zeile(rs));
    }

    /**
     * Schreibt das Ergebnis eines Herzschlags fort. Jeder Zeitpunkt wird nur EINMAL gesetzt (der erste Herzschlag,
     * der ihn belegt, zählt) - ein späterer Herzschlag überschreibt nie, was ein früherer schon zeigte.
     */
    public void fortschreiben(UUID id, Instant ersteMeldung, Instant boxEmpfangen, Instant boxEntschieden,
            Instant boxGeschrieben, Instant boxZurueckgelesen, Instant boxGemeldet, String boxUrteil,
            Instant gehalten, String grund, Instant bestaetigt, String ergebnis) {
        jdbc.update("UPDATE schaltspur SET "
                        + "erste_meldung_at = COALESCE(erste_meldung_at, ?), "
                        + "box_empfangen_at = COALESCE(box_empfangen_at, ?), "
                        + "box_entschieden_at = COALESCE(box_entschieden_at, ?), "
                        + "box_geschrieben_at = COALESCE(box_geschrieben_at, ?), "
                        + "box_zurueckgelesen_at = COALESCE(box_zurueckgelesen_at, ?), "
                        + "box_gemeldet_at = COALESCE(box_gemeldet_at, ?), "
                        + "box_urteil = COALESCE(?, box_urteil), "
                        + "gehalten_at = COALESCE(gehalten_at, ?), "
                        + "grund = COALESCE(?, grund), "
                        + "bestaetigt_at = COALESCE(bestaetigt_at, ?), "
                        + "ergebnis = ? WHERE id = ? AND ergebnis IN ('offen', 'gehalten', 'abweichung')",
                ts(ersteMeldung), ts(boxEmpfangen), ts(boxEntschieden), ts(boxGeschrieben), ts(boxZurueckgelesen),
                ts(boxGemeldet), boxUrteil, ts(gehalten), grund, ts(bestaetigt), ergebnis, id);
    }

    /** Was das Portal selbst gemessen hat - nur der erste Bericht zählt. */
    public boolean portal(UUID siteId, UUID entityId, UUID id, Integer antwortMs, Integer sichtbarMs) {
        return jdbc.update("UPDATE schaltspur SET portal_antwort_ms = COALESCE(portal_antwort_ms, ?), "
                        + "portal_sichtbar_ms = COALESCE(portal_sichtbar_ms, ?), "
                        + "portal_gemeldet_at = COALESCE(portal_gemeldet_at, now()) "
                        + "WHERE id = ? AND site_id = ? AND entity_id = ?",
                antwortMs, sichtbarMs, id, siteId, entityId) > 0;
    }

    /** Die jüngsten Spuren eines Verbrauchers, neueste zuerst. */
    public List<Zeile> liste(UUID siteId, UUID entityId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM schaltspur WHERE site_id = ? AND entity_id = ? "
                + "ORDER BY api_eingang_at DESC LIMIT " + JE_VERBRAUCHER, (rs, i) -> zeile(rs), siteId, entityId);
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static Integer ganz(ResultSet rs, String spalte) throws SQLException {
        int v = rs.getInt(spalte);
        return rs.wasNull() ? null : v;
    }

    private static Zeile zeile(ResultSet rs) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getObject("entity_id", UUID.class), rs.getObject("device_id", UUID.class),
                rs.getString("request_id"), rs.getString("art"), rs.getString("kommando"), rs.getBigDecimal("wert"),
                ausgaenge(rs.getArray("ausgaenge")), zeit(rs, "api_eingang_at"), zeit(rs, "gesendet_at"),
                rs.getString("zustellung"), zeit(rs, "erste_meldung_at"), zeit(rs, "box_empfangen_at"),
                zeit(rs, "box_entschieden_at"), zeit(rs, "box_geschrieben_at"), zeit(rs, "box_zurueckgelesen_at"),
                zeit(rs, "box_gemeldet_at"), rs.getString("box_urteil"), zeit(rs, "gehalten_at"),
                rs.getString("grund"), zeit(rs, "bestaetigt_at"), rs.getString("ergebnis"),
                ganz(rs, "portal_antwort_ms"), ganz(rs, "portal_sichtbar_ms"), zeit(rs, "portal_gemeldet_at"));
    }

    private static List<Integer> ausgaenge(Array arr) throws SQLException {
        if (arr == null) {
            return null;
        }
        List<Integer> out = new ArrayList<>();
        for (Object o : (Object[]) arr.getArray()) {
            out.add(((Number) o).intValue());
        }
        return List.copyOf(out);
    }
}
