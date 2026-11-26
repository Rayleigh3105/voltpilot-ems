package com.voltpilot.api.repo;

import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die CROSS-TENANT Lesequelle der Direktvermarktung-Übersicht (Plattform › Übersicht, Geräteakte ›
 * Verbindung; Konzept vp-direktvermarktung-konzept d2 §7.7). Dasselbe Muster wie
 * {@link AdminFleetRepository}: eine eigene {@code adminJdbcTemplate}-Verbindung als BYPASSRLS-Rolle
 * {@code voltpilot_admin}, erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Read-only - jede Änderung läuft über die
 * mandantengefenzten Kundenrouten.
 */
@Repository
public class AdminDirektvermarktungRepository {

    /**
     * Eine Zeile der Plattform-Liste: Anlage, Mandant, Partner, Zustand, wie lange schon (Plattform ›
     * Übersicht, "Braucht dich"). {@code zugangGueltigBis} ist der der AKTUELLEN Zugangsdatei (noch
     * nicht zurückgezogen, jüngste zuerst) - ohne Zustellung (eigener Auftrag) bleibt die Spalte leer.
     * {@code leadDeviceRef} ist die Kennung der Leitbox der Anlage (für die Geräteakte-Route der
     * "Braucht dich"-Zeile) - {@code null}, solange die Anlage keine trägt.
     */
    public record Zeile(UUID siteId, String siteName, UUID tenantId, String tenantName, String partner,
            String zustand, LocalDate startdatum, LocalDate ende, Instant aktualisiertAm,
            Instant letzteAbfrageAm, Instant lebenszeichenAm, Instant zugangGueltigBis, String leadDeviceRef) {}

    /**
     * Die Geräteakte › Verbindung-Sicht EINER Anlage (§7.7): der aktuelle Anschluss, sein Herzschlag
     * (ohne Zeile unbekannt, §5.1) und sein Zugang (nie Chiffrat/Nonce - das Schlüsselmaterial geht an
     * keine Route, Konzept §7.7 "Nie sichtbar").
     */
    public record SiteDetail(UUID siteId, UUID tenantId, String partner, String zustand, Instant zustimmungAm,
            LocalDate startdatum, LocalDate ende, Instant aktualisiertAm, Instant tunnelObenSeit,
            Instant handshakeAm, String gegenstelle, Double abfragenJeMinute, Instant letzteSchreibungAm,
            Instant lebenszeichenAm, Integer vorgabePct, Integer einspeisungW, Integer erzeugungW,
            Integer netzbetreiberPct, Integer referenzW, String zugangHochgeladenVon, Instant zugangGueltigBis,
            String zugangFingerabdruck, Instant zugangZurueckgezogenAm) {}

    /** Eine Ereignis-Zeile des Protokolls, plattformweit lesbar (append-only, nie geändert). */
    public record ProtokollZeile(long id, String ereignis, String von, String rolle, Instant am) {}

    private final JdbcTemplate jdbc;

    public AdminDirektvermarktungRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Jede Anlage mit einem nicht beendeten Anschluss, plattformweit. */
    public List<Zeile> aktive() {
        return jdbc.query("""
                SELECT dv.site_id, s.name AS site_name, dv.tenant_id, t.name AS tenant_name, dv.partner,
                       dv.zustand, dv.startdatum, dv.ende, dv.aktualisiert_am,
                       dvs.letzte_abfrage_am, dvs.lebenszeichen_am, dvz.gueltig_bis AS zugang_gueltig_bis,
                       lead.external_ref AS lead_device_ref
                FROM direktvermarktung dv
                JOIN site s ON s.id = dv.site_id
                JOIN tenant t ON t.id = dv.tenant_id
                LEFT JOIN direktvermarktung_stand dvs ON dvs.site_id = dv.site_id
                LEFT JOIN device lead ON lead.id = s.lead_device_id
                LEFT JOIN LATERAL (
                    SELECT z.gueltig_bis FROM direktvermarktung_zugang z
                    WHERE z.direktvermarktung_id = dv.id AND z.zurueckgezogen_am IS NULL
                    ORDER BY z.hochgeladen_am DESC LIMIT 1
                ) dvz ON true
                WHERE dv.zustand <> 'beendet'
                ORDER BY t.name, s.name
                """, AdminDirektvermarktungRepository::mapZeile);
    }

    /** Der jüngste Eintrag einer Anlage, gleich welchem Zustand (Geräteakte zeigt auch "beendet"). */
    public SiteDetail fuerSite(UUID siteId) {
        List<SiteDetail> r = jdbc.query("""
                SELECT dv.id, dv.site_id, dv.tenant_id, dv.partner, dv.zustand, dv.zustimmung_am,
                       dv.startdatum, dv.ende, dv.aktualisiert_am,
                       dvs.tunnel_oben_seit, dvs.handshake_am, dvs.gegenstelle, dvs.abfragen_je_minute,
                       dvs.letzte_schreibung_am, dvs.lebenszeichen_am, dvs.vorgabe_pct, dvs.einspeisung_w,
                       dvs.erzeugung_w, dvs.netzbetreiber_pct, dvs.referenz_w,
                       dvz.hochgeladen_von AS zugang_hochgeladen_von, dvz.gueltig_bis AS zugang_gueltig_bis,
                       dvz.fingerabdruck AS zugang_fingerabdruck, dvz.zurueckgezogen_am AS zugang_zurueckgezogen_am
                FROM direktvermarktung dv
                LEFT JOIN direktvermarktung_stand dvs ON dvs.site_id = dv.site_id
                LEFT JOIN LATERAL (
                    SELECT z.* FROM direktvermarktung_zugang z WHERE z.direktvermarktung_id = dv.id
                    ORDER BY z.hochgeladen_am DESC LIMIT 1
                ) dvz ON true
                WHERE dv.site_id = ?
                ORDER BY dv.erstellt_am DESC LIMIT 1
                """, AdminDirektvermarktungRepository::mapDetail, siteId);
        return r.isEmpty() ? null : r.get(0);
    }

    /** Die Ereignisse einer Anlage, neueste zuerst - dieselbe Tabelle wie die Kundenansicht, ohne RLS. */
    public List<ProtokollZeile> protokoll(UUID siteId, int grenze) {
        return jdbc.query("""
                SELECT id, ereignis, von, rolle, am FROM direktvermarktung_protokoll
                WHERE site_id = ? ORDER BY am DESC, id DESC LIMIT ?
                """, (rs, i) -> new ProtokollZeile(rs.getLong("id"), rs.getString("ereignis"), rs.getString("von"),
                        rs.getString("rolle"), ts(rs, "am")), siteId, grenze);
    }

    private static Zeile mapZeile(ResultSet rs, int i) throws SQLException {
        Date startdatum = rs.getDate("startdatum");
        Date ende = rs.getDate("ende");
        return new Zeile(rs.getObject("site_id", UUID.class), rs.getString("site_name"),
                rs.getObject("tenant_id", UUID.class), rs.getString("tenant_name"), rs.getString("partner"),
                rs.getString("zustand"), startdatum == null ? null : startdatum.toLocalDate(),
                ende == null ? null : ende.toLocalDate(), ts(rs, "aktualisiert_am"), ts(rs, "letzte_abfrage_am"),
                ts(rs, "lebenszeichen_am"), ts(rs, "zugang_gueltig_bis"), rs.getString("lead_device_ref"));
    }

    private static SiteDetail mapDetail(ResultSet rs, int i) throws SQLException {
        Date startdatum = rs.getDate("startdatum");
        Date ende = rs.getDate("ende");
        // ⚠ abfragen_je_minute ist NUMERIC(6,2) - pgJDBC liefert dafür ein BigDecimal (Muster
        // DirektvermarktungRepository.mapStand), ein (Double)-Cast auf rs.getObject(...) wirft
        // ClassCastException, sobald die Spalte je nicht NULL ist.
        java.math.BigDecimal abfragenJeMinute = rs.getBigDecimal("abfragen_je_minute");
        return new SiteDetail(rs.getObject("site_id", UUID.class), rs.getObject("tenant_id", UUID.class),
                rs.getString("partner"), rs.getString("zustand"), ts(rs, "zustimmung_am"),
                startdatum == null ? null : startdatum.toLocalDate(), ende == null ? null : ende.toLocalDate(),
                ts(rs, "aktualisiert_am"), ts(rs, "tunnel_oben_seit"), ts(rs, "handshake_am"),
                rs.getString("gegenstelle"), abfragenJeMinute == null ? null : abfragenJeMinute.doubleValue(),
                ts(rs, "letzte_schreibung_am"), ts(rs, "lebenszeichen_am"), (Integer) rs.getObject("vorgabe_pct"),
                (Integer) rs.getObject("einspeisung_w"), (Integer) rs.getObject("erzeugung_w"),
                (Integer) rs.getObject("netzbetreiber_pct"), (Integer) rs.getObject("referenz_w"),
                rs.getString("zugang_hochgeladen_von"), ts(rs, "zugang_gueltig_bis"),
                rs.getString("zugang_fingerabdruck"), ts(rs, "zugang_zurueckgezogen_am"));
    }

    private static Instant ts(ResultSet rs, String spalte) throws SQLException {
        var t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
