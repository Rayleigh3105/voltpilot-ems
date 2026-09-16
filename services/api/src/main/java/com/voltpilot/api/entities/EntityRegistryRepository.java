package com.voltpilot.api.entities;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * v2 entity-registry queries over {@code measurement_point} (a row with a
 * non-NULL {@code entity_type} IS a v2 entity) plus the master-data lookups the
 * bootstrap/push need (battery asset, site devices, netzladen posture).
 *
 * <p>RLS-scoped like every customer repository: no tenant predicate anywhere -
 * the session's {@code app.tenant_id} fences reads and RLS' WITH CHECK fences
 * writes. Admins reach a tenant through the {@code X-Tenant-Id} switcher.
 */
@Repository
public class EntityRegistryRepository {

    /** One measurement_point row seen as a v2 entity (or bootstrap candidate). */
    public record EntityRow(UUID id, String role, String label, String brand, String model,
            String family, String communication, String connectionJson, BigDecimal capacityKwp,
            UUID deviceId, boolean control, String entityType, String capabilitiesJson,
            String guardConfigJson, String edgeSourceId,
            // Einheitsmodell Stufe 0a/1: woher die Definition stammt, aus welcher
            // Vorlage in welcher Fassung, und die wievielte Fassung dieser
            // Komponente gerade gilt.
            String sourceKind, String templateRef, Integer templateVersion,
            int definitionVersion,
            // Einheitsmodell Stufe 2: die MaStR-Referenz des Betreibers. Sie ist
            // Teil dessen, was die Box als Quelle führt, reiste bis Stufe 2 aber
            // nicht im Push mit - eine Übernahme hätte sie beim ersten
            // Rückschreiben still verloren.
            String registryUnitId) {}

    /** The site's battery asset slice the battery-hybrid entity derives from. */
    public record BatteryAsset(UUID deviceId, BigDecimal maxChargeKw, BigDecimal maxDischargeKw,
            BigDecimal socMinPct, BigDecimal socMaxPct) {}

    private static final String ROW_COLUMNS =
            "id, role, label, brand, model, family, communication, connection_json::text AS conn, "
                    + "capacity_kwp, device_id, control, entity_type, capabilities::text AS caps, "
                    + "guard_config::text AS guards, edge_source_id, source_kind, template_ref, "
                    + "template_version, definition_version, registry_unit_id";

    private final JdbcTemplate jdbc;

    public EntityRegistryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * WER die Geräte-Konfiguration dieser Anlage besitzt (Einheitsmodell Stufe
     * 1). {@code null} = die Anlage ist für diesen Mandanten nicht sichtbar.
     */
    public String componentAuthority(UUID siteId) {
        java.util.List<String> rows = jdbc.query(
                "SELECT component_authority FROM site WHERE id = ?",
                (rs, n) -> rs.getString(1), siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** The consumer cycle-guard limits of one entity (Inkrement 3, D-9). */
    public record ConsumerCycleLimits(Integer minOnSeconds, Integer minOffSeconds,
            Integer maxStartsPerDay) {}

    /**
     * The site's consumer cycle-guard limits from consumer_profile - the ONE
     * profile truth, merged into the registry push at compose time so the
     * edge's temporal guard learns them (Verbrauchssteuerung §13.1). Only
     * rows with at least one bound set.
     */
    public java.util.Map<UUID, ConsumerCycleLimits> consumerCycleLimits(UUID siteId) {
        java.util.Map<UUID, ConsumerCycleLimits> out = new java.util.HashMap<>();
        jdbc.query(
                "SELECT entity_id, min_on_seconds, min_off_seconds, max_starts_per_day "
                        + "FROM consumer_profile WHERE site_id = ? AND (min_on_seconds IS NOT NULL "
                        + "OR min_off_seconds IS NOT NULL OR max_starts_per_day IS NOT NULL)",
                rs -> {
                    out.put(rs.getObject("entity_id", UUID.class), new ConsumerCycleLimits(
                            (Integer) rs.getObject("min_on_seconds"),
                            (Integer) rs.getObject("min_off_seconds"),
                            (Integer) rs.getObject("max_starts_per_day")));
                }, siteId);
        return out;
    }

    /**
     * Die OCPP-ChargePointId je Ladepunkt-Komponente der Anlage - die Bindung,
     * die {@code ChargerComponentComposer} in {@code device_charge_point}
     * gelegt hat (Cockpit Phase 1 / E1).
     *
     * <p>Sie reist additiv im Registry-Push, damit die BOX ihre eigenen
     * OCPP-Messwerte auf die Entitaet abbilden kann - genau das, was
     * {@code edge_source_id} fuer eine gemeldete Quelle tut. Eine Ladesaeule
     * ist keine Quelle in {@code sources.json} (sie waehlt die Box an), es gibt
     * also keinen anderen Schluessel, ueber den ihre Kilowatt je Komponente
     * zuzuordnen waeren.
     *
     * <p>Nur BEIDES gebunden zaehlt: eine Zeile ohne {@code entity_id} ist eine
     * noch nicht komponierte Saeule, und ohne Kennung gaebe es nichts zu
     * binden.
     *
     * <p>Nur die Säulen einer Box, die am Betrieb teilnimmt (UEMS AP-07 IP-11): die
     * Zeilen einer ausgebauten Box bleiben gespeichert, ihre Kennung reist aber
     * nicht mehr in Push und Steuerart.
     */
    public java.util.Map<UUID, String> chargePointIdsByEntity(UUID siteId) {
        java.util.Map<UUID, String> out = new java.util.HashMap<>();
        jdbc.query(
                "SELECT c.entity_id, c.charge_point_id FROM device_charge_point c "
                        + "WHERE c.site_id = ? AND c.entity_id IS NOT NULL AND EXISTS (SELECT 1 FROM device d "
                        + "WHERE d.id = c.device_id AND d.ausgebaut_am IS NULL)",
                rs -> {
                    out.put(rs.getObject("entity_id", UUID.class),
                            rs.getString("charge_point_id"));
                }, siteId);
        return out;
    }

    /** One stored capability→role assignment of an entity (AE1). */
    public record RoleAssignment(String channel, String role, boolean primary) {}

    /**
     * Die im Portal GESPEICHERTE Rollen-Zuordnung je Komponente der Anlage
     * (AE1 {@code entity_role_assignment}) - die Quelle des additiven
     * {@code role_assignment}-Blocks im Registry-Push (Befund L4).
     *
     * <p>Bis dahin schrieb {@code PUT …/topology-roles} die Tabelle, und
     * NIEMAND las sie für den Push: ein im Portal umgewidmeter Messpunkt oder
     * ein als maßgeblich markierter Zähler blieb auf {@code :8484} beim
     * Default, also zwei Energieflüsse, die sich widersprechen können.
     *
     * <p>Die Zuordnung wird per KANAL getroffen (nicht je Entität), deshalb
     * liefert die Karte je Entität eine LISTE. Sortiert nach Kanal, damit der
     * Push deterministisch ist. Eine Anlage ohne eine einzige gespeicherte
     * Zuordnung liefert eine leere Karte - und dann fehlt der Block überall,
     * die Nutzlast ist byte-gleich zu vorher.
     *
     * <p>Bewusst hier und nicht über {@code TopologyRepository}: jeder additive
     * Push-Block ({@code consumerCycleLimits}, {@code chargePointIdsByEntity},
     * {@code activeConsumerPolicies}) hat seinen Lesepfad an DIESER Repository,
     * und die Gegenrichtung wäre eine Paket-Abhängigkeit entities→topology, wo
     * topology→entities schon besteht.
     */
    public java.util.Map<UUID, java.util.List<RoleAssignment>> roleAssignments(UUID siteId) {
        java.util.Map<UUID, java.util.List<RoleAssignment>> out = new java.util.HashMap<>();
        jdbc.query(
                "SELECT entity_id, capability, role, is_primary FROM entity_role_assignment "
                        + "WHERE site_id = ? AND role IS NOT NULL AND role <> '' "
                        + "ORDER BY entity_id, capability",
                rs -> {
                    out.computeIfAbsent(rs.getObject("entity_id", UUID.class),
                            k -> new java.util.ArrayList<>())
                            .add(new RoleAssignment(rs.getString("capability"),
                                    rs.getString("role"), rs.getBoolean("is_primary")));
                }, siteId);
        return out;
    }

    /** One consumer's ACTIVE policy document + rated power (Inkrement 6). */
    public record ConsumerFlexSource(String documentJson, BigDecimal ratedPowerKw) {}

    /**
     * The ACTIVE consumer-policy documents of the site's ENABLED consumers -
     * the source of the registry push's additive {@code flex_requirements}
     * block (Verbrauchssteuerung Inkrement 6, D-20). A paused consumer
     * ({@code enabled=false}) deliberately drops out: the edge fallback must
     * never self-start a paused device. Rated power rides along so the
     * compose can resolve on_off/percent targets into a run power (the one
     * cloud truth).
     */
    public java.util.Map<UUID, ConsumerFlexSource> activeConsumerPolicies(UUID siteId) {
        java.util.Map<UUID, ConsumerFlexSource> out = new java.util.HashMap<>();
        jdbc.query(
                "SELECT p.entity_id, p.document::text AS doc, cp.rated_power_kw "
                        + "FROM consumer_policy p "
                        + "JOIN consumer_profile cp ON cp.entity_id = p.entity_id "
                        + "WHERE p.site_id = ? AND p.lifecycle = 'active' AND cp.enabled",
                rs -> {
                    out.put(rs.getObject("entity_id", UUID.class), new ConsumerFlexSource(
                            rs.getString("doc"), rs.getBigDecimal("rated_power_kw")));
                }, siteId);
        return out;
    }

    /** The site's v2 entities (entity_type set), stable order. */
    public List<EntityRow> entitiesForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point "
                        + "WHERE site_id = ? AND entity_type IS NOT NULL ORDER BY created_at, id",
                EntityRegistryRepository::mapRow, siteId);
    }

    /** ALL measurement points of the site (bootstrap candidates), stable order. */
    public List<EntityRow> pointsForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point WHERE site_id = ? "
                        + "ORDER BY created_at, id",
                EntityRegistryRepository::mapRow, siteId);
    }

    /** Whether the site has any v2 entity rows. */
    public boolean hasEntities(UUID siteId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM measurement_point WHERE site_id = ? AND entity_type IS NOT NULL",
                Integer.class, siteId);
        return n != null && n > 0;
    }

    /**
     * Stamp a point as a v2 entity (or refresh its config). capabilities /
     * guard_config carry the contract JSON verbatim
     * (docs/contracts/v2/edge-entity.schema.json $defs).
     */
    public void setEntityConfig(UUID pointId, String entityType, String capabilitiesJson,
            String guardConfigJson) {
        jdbc.update(
                "UPDATE measurement_point SET entity_type = ?, capabilities = ?::jsonb, "
                        + "guard_config = ?::jsonb WHERE id = ?",
                entityType, capabilitiesJson, guardConfigJson, pointId);
    }

    /** The site's battery-hybrid registry row id, or null when none exists yet. */
    public UUID batteryHybridPointId(UUID siteId) {
        List<UUID> ids = jdbc.query(
                "SELECT id FROM measurement_point WHERE site_id = ? AND role = 'battery-hybrid'",
                (rs, n) -> rs.getObject("id", UUID.class), siteId);
        return ids.isEmpty() ? null : ids.get(0);
    }

    /**
     * The Anbindungs-Herkunft of every row the automatic composition creates
     * (Einheitsmodell Stufe 0a, column {@code measurement_point.source_kind}):
     * these rows come from the site's v1 MASTER DATA, not from a component
     * template - so they carry no {@code template_ref} and never will.
     *
     * <p>Stamped ONLY where the composition CREATES a row. An older composed row
     * keeps {@code source_kind = NULL} = honestly "unknown" (it was made before
     * the concept existed); it is deliberately not retro-stamped from the
     * refresh path, because that same path also refreshes ADOPTED producer rows,
     * which are not composed - a blanket stamp there would mislabel them.
     */
    public static final String SOURCE_KIND_COMPOSED = "composed";

    /**
     * Create the battery-hybrid registry row for the primary inverter
     * (control = TRUE; since E1b control is granted per the type catalog's
     * controllable flag - the v1 control-only-battery CHECK and the
     * one-control-per-site index fell with V20260719010000).
     */
    public UUID createBatteryHybridPoint(UUID tenantId, UUID siteId, String label, UUID deviceId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, device_id, "
                        + "control, source_kind) "
                        + "VALUES (?, ?, 'battery-hybrid', ?, ?, TRUE, ?) RETURNING id",
                UUID.class, tenantId, siteId, label, deviceId, SOURCE_KIND_COMPOSED);
    }

    /** The site's measurement point of this role, or null when none exists. */
    public UUID pointIdByRole(UUID siteId, String role) {
        List<UUID> ids = jdbc.query(
                "SELECT id FROM measurement_point WHERE site_id = ? AND role = ? "
                        + "ORDER BY created_at, id",
                (rs, n) -> rs.getObject("id", UUID.class), siteId, role);
        return ids.isEmpty() ? null : ids.get(0);
    }

    /**
     * Create a COMPOSED measure-only point bound to the gateway device (MIG
     * §2.3/§2.4: the synthesized grid-meter / house-load). {@code control} is
     * FALSE - the DB CHECK forbids control on a non-battery role anyway, so
     * nothing composed here can carry an actuate capability to a device.
     */
    public UUID createComposedPoint(UUID tenantId, UUID siteId, String role, String label,
            UUID deviceId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, device_id, "
                        + "control, source_kind) "
                        + "VALUES (?, ?, ?, ?, ?, FALSE, ?) RETURNING id",
                UUID.class, tenantId, siteId, role, label, deviceId, SOURCE_KIND_COMPOSED);
    }

    /** One entity row of the site, or null (RLS: a foreign site yields null). */
    public EntityRow entityForSite(UUID siteId, UUID pointId) {
        List<EntityRow> rows = jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point "
                        + "WHERE site_id = ? AND id = ? AND entity_type IS NOT NULL",
                EntityRegistryRepository::mapRow, siteId, pointId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public record AuftragsQuelle(UUID dataSourceId) {}

    /** Includes legacy measurement points; null means absent, not merely unconfigured for v2. */
    public AuftragsQuelle auftragsQuelle(UUID siteId, UUID pointId) {
        List<AuftragsQuelle> rows = jdbc.query(
                "SELECT data_source_id FROM measurement_point WHERE site_id = ? AND id = ?",
                (rs, n) -> new AuftragsQuelle(rs.getObject("data_source_id", UUID.class)),
                siteId, pointId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Create a v2-native entity row (E1b admin CRUD: the open catalog types -
     * wallbox/heating-rod/generic-load/...). role mirrors the entity type;
     * control comes from the catalog's controllable flag.
     */
    public UUID createEntityPoint(UUID tenantId, UUID siteId, String role, String label,
            boolean control) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, control) "
                        + "VALUES (?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenantId, siteId, role, label, control);
    }

    /**
     * Create a v2-native entity row FROM an edge-reported source (U2 adoption):
     * role mirrors the entity type, {@code edgeSourceId} pins it to the source
     * it was adopted from so re-adoption is idempotent and drift is detectable.
     * capacity/registry carry the customer-only master data (kWp, MaStR SEE #).
     */
    public UUID createAdoptedPoint(UUID tenantId, UUID siteId, String role, String label,
            boolean control, String brand, BigDecimal capacityKwp, String registryUnitId,
            String edgeSourceId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, control, brand, "
                        + "capacity_kwp, registry_unit_id, edge_source_id) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenantId, siteId, role, label, control, brand, capacityKwp,
                registryUnitId, edgeSourceId);
    }

    /**
     * Dreht die Autorität einer Anlage und stempelt den Beleg der Übernahme
     * (Einheitsmodell Stufe 2). {@code at}/{@code by} {@code null} = der
     * Rückweg: der Stempel wird gelöscht, damit der getaktete Abgleich die
     * Anlage wieder betrachtet.
     */
    public void markComponentsAdopted(UUID siteId, String authority, java.time.Instant at,
            String by) {
        jdbc.update("UPDATE site SET component_authority = ?, components_adopted_at = ?, "
                        + "components_adopted_by = ? WHERE id = ?",
                authority, at == null ? null : java.sql.Timestamp.from(at), by, siteId);
    }

    /** Pin an existing entity row to the edge source it was adopted from. */
    public void setEdgeSource(UUID pointId, String edgeSourceId) {
        jdbc.update("UPDATE measurement_point SET edge_source_id = ? WHERE id = ?",
                edgeSourceId, pointId);
    }

    /**
     * The site's measurement point pinned to this edge source, entity or not.
     *
     * <p>Deliberately NOT filtered on {@code entity_type IS NOT NULL}: deleting a
     * COMPOSED entity (producer / grid-meter) only clears its entity config and
     * leaves the point (v1 master data) with its {@code edge_source_id} in place.
     * A re-adoption must find exactly that row and re-compose it - creating a
     * second row would violate {@code uq_measurement_point_edge_source} (HTTP 500)
     * and double-count the producer's kWp.
     */
    public EntityRow pointByEdgeSource(UUID siteId, String edgeSourceId) {
        List<EntityRow> rows = jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point "
                        + "WHERE site_id = ? AND edge_source_id = ?",
                EntityRegistryRepository::mapRow, siteId, edgeSourceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Re-point an adopted measurement point at a (possibly changed) role and
     * master data before its entity config is re-composed. Only rows created by
     * adoption carry an {@code edge_source_id}, so the role is ours to maintain.
     *
     * <p><b>⚠ Der NAME wird nur GEFÜLLT, nie überschrieben</b> (Alias-Kontinuität,
     * Live-Fall Herzogau 20.08.2026). Seit der Label-Hygiene (V20260812000000)
     * heißt {@code label != NULL} „von einem Menschen vergeben"; ein automatischer
     * Lauf (die Bestands-Übernahme meldet den NAMEN DER BOX) darf so einen Namen
     * niemals ersetzen. Ein leerer/absenter Wert behält den gespeicherten Namen -
     * gelöscht wird ein Name ausschließlich über {@link #updateLabel}, den
     * ausdrücklichen Weg des Kunden.
     */
    public void updateAdoptedPoint(UUID pointId, String role, String label,
            BigDecimal capacityKwp, String registryUnitId) {
        jdbc.update(
                "UPDATE measurement_point SET role = ?, "
                        + "label = COALESCE(NULLIF(?::text, \'\'), label), capacity_kwp = ?, "
                        + "registry_unit_id = ? WHERE id = ?",
                role, label, capacityKwp, registryUnitId, pointId);
    }

    /** The edge source ids already adopted into a v2 entity of the site. */
    public List<String> adoptedEdgeSourceIds(UUID siteId) {
        return jdbc.query(
                "SELECT edge_source_id FROM measurement_point WHERE site_id = ? "
                        + "AND edge_source_id IS NOT NULL AND entity_type IS NOT NULL",
                (rs, n) -> rs.getString(1), siteId);
    }

    /** Update an entity row's display label. */
    public void updateLabel(UUID pointId, String label) {
        jdbc.update("UPDATE measurement_point SET label = ? WHERE id = ?", label, pointId);
    }

    /**
     * Un-entity a v1-backed measurement point: the point (v1 master data)
     * stays, only its v2 entity config is cleared.
     */
    public void clearEntityConfig(UUID pointId) {
        jdbc.update(
                "UPDATE measurement_point SET entity_type = NULL, capabilities = NULL, "
                        + "guard_config = NULL WHERE id = ?",
                pointId);
    }

    /** Auch beim Behalten des v1-Messpunkts endet seine Live-Zuordnung. */
    public void deleteRoleAssignments(UUID pointId) {
        jdbc.update("DELETE FROM entity_role_assignment WHERE entity_id = ?", pointId);
    }

    /** Delete a v2-native entity row outright. */
    public boolean deletePoint(UUID pointId) {
        return jdbc.update("DELETE FROM measurement_point WHERE id = ?", pointId) > 0;
    }

    // ---- Bidirectional sync state (E1b) ------------------------------------

    /**
     * The last composed Soll of one site (entity_registry_state), or null. Seit UEMS AP-06 IP-6 hält
     * die Tabelle eine Zeile je (Anlage, Box); {@link #registryState} liest die JÜNGSTE. Ein Push-Lauf
     * schreibt alle seine Boxen mit derselben Revision, und eine Anlage mit einer Box hat genau ihre
     * eine Zeile wie bisher.
     */
    public record RegistryState(UUID deviceId, String revision, java.time.Instant composedAt) {}

    /**
     * Record the freshly composed Soll revision - on EVERY compose, even when
     * the best-effort publish fails (the Soll changed regardless; the edge's
     * echoed revision is compared against exactly this value). Je (Anlage, Box) seit IP-6: eine
     * andere Box überschreibt die Zeile nicht mehr, sie bekommt ihre eigene.
     */
    public void upsertRegistryState(UUID siteId, UUID tenantId, UUID deviceId, String revision) {
        jdbc.update(
                "INSERT INTO entity_registry_state (site_id, tenant_id, device_id, revision, composed_at) "
                        + "VALUES (?, ?, ?, ?, now()) "
                        + "ON CONFLICT (tenant_id, site_id, device_id) DO UPDATE SET "
                        + "revision = EXCLUDED.revision, composed_at = EXCLUDED.composed_at",
                siteId, tenantId, deviceId, revision);
    }

    /**
     * Das Soll ALLER Boxen eines Push-Laufs je Box (UEMS AP-06 IP-6, W7) in EINER Anweisung: die
     * Revision steht an jeder dieser Boxen oder an keiner, auch ohne umgebende Transaktion.
     */
    public void upsertRegistryStates(UUID siteId, UUID tenantId, List<UUID> deviceIds, String revision) {
        if (deviceIds.isEmpty()) {
            return;
        }
        StringBuilder sql = new StringBuilder("INSERT INTO entity_registry_state "
                + "(site_id, tenant_id, device_id, revision, composed_at) VALUES ");
        List<Object> args = new java.util.ArrayList<>();
        for (int i = 0; i < deviceIds.size(); i++) {
            sql.append(i == 0 ? "" : ", ").append("(?, ?, ?, ?, now())");
            args.add(siteId);
            args.add(tenantId);
            args.add(deviceIds.get(i));
            args.add(revision);
        }
        sql.append(" ON CONFLICT (tenant_id, site_id, device_id) DO UPDATE SET "
                + "revision = EXCLUDED.revision, composed_at = EXCLUDED.composed_at");
        jdbc.update(sql.toString(), args.toArray());
    }

    public RegistryState registryState(UUID siteId) {
        List<RegistryState> rows = jdbc.query(
                "SELECT device_id, revision, composed_at FROM entity_registry_state WHERE site_id = ? "
                        + "ORDER BY composed_at DESC, device_id NULLS LAST LIMIT 1",
                (rs, n) -> new RegistryState(
                        rs.getObject("device_id", UUID.class),
                        rs.getString("revision"),
                        rs.getTimestamp("composed_at").toInstant()),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Die Boxen, für die diese Anlage schon ein Soll aufgezeichnet hat (UEMS AP-06 IP-6): sie
     * bekommen ihre Vollmenge weiter, auch eine leere, damit sie eine Quelle sicher vergessen.
     */
    public List<UUID> boxenMitSoll(UUID siteId) {
        return jdbc.query("SELECT device_id FROM entity_registry_state WHERE site_id = ? "
                        + "AND device_id IS NOT NULL ORDER BY device_id",
                (rs, n) -> rs.getObject("device_id", UUID.class), siteId);
    }

    /**
     * Die Datenquelle je v2-Entität der Anlage ({@code measurement_point.data_source_id}), nur die
     * gesetzten, in Push-Reihenfolge. Leer ist der Stand jeder Bestandsanlage (UEMS AP-06 IP-6: dann
     * bleibt der Registry-Push der eine Push an die führende Box).
     */
    public java.util.Map<UUID, UUID> datenquelleJeEntitaet(UUID siteId) {
        java.util.Map<UUID, UUID> out = new java.util.LinkedHashMap<>();
        jdbc.query("SELECT id, data_source_id FROM measurement_point WHERE site_id = ? "
                        + "AND entity_type IS NOT NULL AND data_source_id IS NOT NULL ORDER BY created_at, id",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> out.put(
                        rs.getObject("id", UUID.class), rs.getObject("data_source_id", UUID.class)),
                siteId);
        return out;
    }

    /**
     * Alle Zeiträume der Datenquellen, hinter denen Entitäten dieser Anlage antworten — auch
     * beendete und geplante. Welche Box zum Zeitpunkt liest, entscheidet die reine Regel
     * ({@code uems.PushJeBox} über {@code DatenquelleRegeln.zustaendigeBox}), nicht diese Abfrage.
     */
    public List<com.voltpilot.api.uems.ZustaendigkeitRepository.Zeitraum> zustaendigkeitenDerQuellen(UUID siteId) {
        return jdbc.query("SELECT a.id, a.data_source_id, a.device_id, a.effective_from, a.effective_to "
                        + "FROM data_source_assignment a WHERE a.data_source_id IN (SELECT mp.data_source_id "
                        + "FROM measurement_point mp WHERE mp.site_id = ? AND mp.data_source_id IS NOT NULL) "
                        + "ORDER BY a.data_source_id, a.effective_from, a.id",
                (rs, n) -> {
                    java.time.OffsetDateTime bis = rs.getObject("effective_to", java.time.OffsetDateTime.class);
                    return new com.voltpilot.api.uems.ZustaendigkeitRepository.Zeitraum(
                            rs.getObject("id", UUID.class), rs.getObject("data_source_id", UUID.class),
                            rs.getObject("device_id", UUID.class),
                            rs.getObject("effective_from", java.time.OffsetDateTime.class).toInstant(),
                            bis == null ? null : bis.toInstant());
                },
                siteId);
    }

    /** The site's battery asset slice, or null when the site has no battery. */
    public BatteryAsset batteryAsset(UUID siteId) {
        List<BatteryAsset> rows = jdbc.query(
                "SELECT device_id, max_charge_kw, max_discharge_kw, soc_min_pct, soc_max_pct "
                        + "FROM asset WHERE site_id = ? AND type = 'battery' AND is_primary",
                (rs, n) -> new BatteryAsset(
                        rs.getObject("device_id", UUID.class),
                        rs.getBigDecimal("max_charge_kw"),
                        rs.getBigDecimal("max_discharge_kw"),
                        rs.getBigDecimal("soc_min_pct"),
                        rs.getBigDecimal("soc_max_pct")),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Ids of the site's claimed devices, stable order. */
    public List<UUID> siteDeviceIds(UUID siteId) {
        return jdbc.query("SELECT id FROM device WHERE site_id = ? AND ausgebaut_am IS NULL ORDER BY created_at, id",
                (rs, n) -> rs.getObject("id", UUID.class), siteId);
    }

    /**
     * Die ausdrücklich gewählte führende Box der Anlage ({@code site.lead_device_id}), oder
     * {@code null}: keine Wahl gespeichert (der Stand jeder Bestandsanlage) oder die Anlage ist
     * unter dem Mandanten nicht sichtbar. Ob die Box noch in DIESER Anlage angemeldet ist, prüft
     * {@link LeadDeviceService}, nicht die Spalte.
     */
    public UUID storedLeadDeviceId(UUID siteId) {
        List<UUID> rows = jdbc.query("SELECT lead_device_id FROM site WHERE id = ?",
                (rs, n) -> rs.getObject("lead_device_id", UUID.class), siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Set (or clear, with null) the site's v1->v2 history cutover instant (MIG).
     * RLS-scoped: only a row visible under the session tenant is updated.
     * Returns true when a row was affected (the site exists for the tenant).
     */
    public boolean setV2HistoryCutover(UUID siteId, java.time.Instant at) {
        return jdbc.update("UPDATE site SET v2_history_cutover_at = ? WHERE id = ?",
                at == null ? null : java.sql.Timestamp.from(at), siteId) > 0;
    }

    /** The site's history cutover instant, or null (un-migrated / pure v1). */
    public java.time.Instant v2HistoryCutover(UUID siteId) {
        List<java.time.Instant> rows = jdbc.query(
                "SELECT v2_history_cutover_at FROM site WHERE id = ?",
                (rs, n) -> {
                    java.sql.Timestamp ts = rs.getTimestamp("v2_history_cutover_at");
                    return ts == null ? null : ts.toInstant();
                }, siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Stamp the site as auto-backfilled (MIG §6). The marker is what makes the
     * rollback STICK: the runner only touches sites where it is NULL, so
     * deleting a site's entities is not silently undone by the next api restart.
     * Clearing the column re-arms the runner for that site.
     */
    public boolean markV2Backfilled(UUID siteId, java.time.Instant at) {
        return jdbc.update("UPDATE site SET v2_backfilled_at = ? WHERE id = ?",
                java.sql.Timestamp.from(at), siteId) > 0;
    }

    /** The site's backfill marker, or null (never auto-backfilled). */
    public java.time.Instant v2BackfilledAt(UUID siteId) {
        List<java.time.Instant> rows = jdbc.query(
                "SELECT v2_backfilled_at FROM site WHERE id = ?",
                (rs, n) -> {
                    java.sql.Timestamp ts = rs.getTimestamp("v2_backfilled_at");
                    return ts == null ? null : ts.toInstant();
                }, siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** The site's grid-charging posture (D-8: feeds charge_from_grid_allowed). */
    public boolean netzladenErlaubt(UUID siteId) {
        Boolean b = jdbc.queryForObject(
                "SELECT netzladen_erlaubt FROM site WHERE id = ?", Boolean.class, siteId);
        return Boolean.TRUE.equals(b);
    }

    private static EntityRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new EntityRow(
                rs.getObject("id", UUID.class),
                rs.getString("role"),
                rs.getString("label"),
                rs.getString("brand"),
                rs.getString("model"),
                rs.getString("family"),
                rs.getString("communication"),
                rs.getString("conn"),
                rs.getBigDecimal("capacity_kwp"),
                rs.getObject("device_id", UUID.class),
                rs.getBoolean("control"),
                rs.getString("entity_type"),
                rs.getString("caps"),
                rs.getString("guards"),
                rs.getString("edge_source_id"),
                rs.getString("source_kind"),
                rs.getString("template_ref"),
                (Integer) rs.getObject("template_version"),
                rs.getInt("definition_version"),
                rs.getString("registry_unit_id"));
    }

    /**
     * Die Kennung der ERSTEN Entität dieses Typs (Einheitsmodell Stufe 1), oder
     * {@code null}. Der Anlege-Weg füllt damit die von der Plattform komponierte
     * Wechselrichter-/Netz-Zeile, statt eine zweite anzulegen - die Topologie
     * summiert je Rolle, zwei Zeilen wären Doppelzählung.
     */
    public UUID firstEntityOfType(UUID siteId, String entityType) {
        java.util.List<UUID> rows = jdbc.query(
                "SELECT id FROM measurement_point WHERE site_id = ? AND entity_type = ? "
                        + "ORDER BY created_at, id LIMIT 1",
                (rs, n) -> rs.getObject("id", UUID.class), siteId, entityType);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Die zuletzt komponierte Push-Revision dieser Anlage (das Soll), oder null. */
    public String registryRevision(UUID siteId) {
        RegistryState st = registryState(siteId);
        return st == null ? null : st.revision();
    }
}
