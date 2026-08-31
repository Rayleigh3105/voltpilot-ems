package com.voltpilot.api.fahrzeuge;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Ladekarten einer Anlage ({@code site_vehicle_tag}, Migration
 * V20260866000000) - RLS-gefenced wie alle Kundendaten einer Anlage.
 *
 * <p>⚠ Eine Zeile ist eine SICHTUNG, und ein Profil ist eine Sichtung mit Namen
 * und Steuerart. Deshalb gibt es hier kein DELETE: „Profil entfernen" nullt die
 * Profil-Spalten und lässt die Sichtung stehen - sonst tauchte die Karte beim
 * nächsten Herzschlag als „neu" auf, und der Verlauf wäre weg.
 */
@Repository
public class SiteVehicleRepository {

    private final JdbcTemplate jdbc;

    public SiteVehicleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine gespeicherte Karte. */
    public record Row(String tagRef, String name, String source, BigDecimal minKw,
            Instant firstSeenAt, Instant lastSeenAt, String lastChargePointId) {}

    /** Alle Karten dieser Anlage, zuletzt gesehene zuerst. */
    public List<Row> forSite(UUID siteId) {
        return List.copyOf(jdbc.query(
                "SELECT tag_ref, name, source, min_kw, first_seen_at, last_seen_at, "
                        + "last_charge_point_id FROM site_vehicle_tag WHERE site_id = ? "
                        + "ORDER BY last_seen_at DESC, tag_ref",
                (rs, n) -> new Row(rs.getString("tag_ref"), rs.getString("name"),
                        rs.getString("source"), rs.getBigDecimal("min_kw"),
                        instant(rs.getTimestamp("first_seen_at")),
                        instant(rs.getTimestamp("last_seen_at")),
                        rs.getString("last_charge_point_id")),
                siteId));
    }

    /**
     * Die PROFILE dieser Anlage - genau die Karten, denen der Kunde eine
     * Steuerart gegeben hat. Sie sind es, die zur Box reisen; eine bloße
     * Sichtung ist keine Anweisung.
     */
    public List<Row> profilesForSite(UUID siteId) {
        return List.copyOf(jdbc.query(
                "SELECT tag_ref, name, source, min_kw, first_seen_at, last_seen_at, "
                        + "last_charge_point_id FROM site_vehicle_tag "
                        + "WHERE site_id = ? AND source IS NOT NULL ORDER BY tag_ref",
                (rs, n) -> new Row(rs.getString("tag_ref"), rs.getString("name"),
                        rs.getString("source"), rs.getBigDecimal("min_kw"),
                        instant(rs.getTimestamp("first_seen_at")),
                        instant(rs.getTimestamp("last_seen_at")),
                        rs.getString("last_charge_point_id")),
                siteId));
    }

    /**
     * Hält eine SICHTUNG fest: die Karte lädt gerade an dieser Säule.
     *
     * <p>⚠ Der Name und die Steuerart werden dabei NIE angefasst - eine
     * Sichtung ist eine Beobachtung, keine Entscheidung. Und {@code first_seen_at}
     * bleibt, was es war: „seit wann kennen wir diese Karte" ist eine Tatsache
     * über die Vergangenheit.
     */
    public void touch(UUID tenantId, UUID siteId, String tagRef, String chargePointId,
            Instant seenAt) {
        jdbc.update("INSERT INTO site_vehicle_tag (site_id, tag_ref, tenant_id, first_seen_at, "
                + "last_seen_at, last_charge_point_id) VALUES (?,?,?,?,?,?) "
                + "ON CONFLICT (site_id, tag_ref) DO UPDATE SET "
                + "last_seen_at = GREATEST(site_vehicle_tag.last_seen_at, EXCLUDED.last_seen_at), "
                + "last_charge_point_id = COALESCE(EXCLUDED.last_charge_point_id, "
                + "site_vehicle_tag.last_charge_point_id)",
                siteId, tagRef, tenantId, java.sql.Timestamp.from(seenAt),
                java.sql.Timestamp.from(seenAt), chargePointId);
    }

    /**
     * Speichert Name und/oder Steuerart einer BEKANNTEN Karte.
     *
     * <p>⚠ Es ist ein UPDATE, kein Upsert: benennen kann man nur, was schon
     * einmal geladen hat. Eine erfundene Zeile wäre ein Fahrzeug, das es an
     * dieser Anlage nie gab - und ein Profil darauf würde nie ein Auto treffen.
     *
     * <p>⚠ Die zwei Schalter sind der Grund für die {@code CASE}-Form: ein
     * {@code null}-Wert bei gesetztem Schalter LÖSCHT (der ausdrückliche Weg
     * zurück auf „lädt wie der Ladepunkt"), ein nicht gesetzter Schalter lässt
     * die Spalte in Ruhe. Ohne die Trennung wäre „nichts sagen" von „zurück auf
     * Anfang" nicht unterscheidbar. Gegen echtes Postgres bewiesen
     * ({@code ChargerApiTest}) - die untypisierten {@code null}-Parameter in
     * einem {@code CASE} sind für TEXT und NUMERIC unkritisch (anders als für
     * {@code timestamptz}, siehe die Haus-Notiz zu {@code applyAcknowledgement}).
     *
     * @param name  {@code null}-Schalter aus = nicht anfassen, {@code ""} = Namen löschen
     * @param setSource true = die Steuerart SCHREIBEN; mit {@code source == null}
     *              nimmt das Profil zurück, ohne den Namen zu verlieren
     * @return false, wenn diese Anlage die Karte nicht kennt
     */
    public boolean save(UUID siteId, String tagRef, String name, boolean setName,
            String source, BigDecimal minKw, boolean setSource, Instant now, String actor) {
        return jdbc.update("UPDATE site_vehicle_tag SET "
                + "name = CASE WHEN ? THEN ? ELSE name END, "
                + "source = CASE WHEN ? THEN ? ELSE source END, "
                + "min_kw = CASE WHEN ? THEN ? ELSE min_kw END, "
                + "updated_at = ?, updated_by = ? "
                + "WHERE site_id = ? AND tag_ref = ?",
                setName, name, setSource, source, setSource, minKw,
                java.sql.Timestamp.from(now), actor, siteId, tagRef) > 0;
    }

    /**
     * Nimmt das Profil zurück: Name und Steuerart fallen weg, die SICHTUNG
     * bleibt. Eine Rücknahme ist keine Beweisvernichtung.
     */
    public boolean clearProfile(UUID siteId, String tagRef, Instant now, String actor) {
        return jdbc.update("UPDATE site_vehicle_tag SET name = NULL, source = NULL, "
                + "min_kw = NULL, updated_at = ?, updated_by = ? WHERE site_id = ? AND tag_ref = ?",
                java.sql.Timestamp.from(now), actor, siteId, tagRef) > 0;
    }

    private static Instant instant(java.sql.Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
