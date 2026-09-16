package com.voltpilot.api.repo;

import com.voltpilot.api.tenant.Betriebsart;
import com.voltpilot.api.web.dto.TenantDto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Tenant CRUD for the platform-admin API.
 *
 * <p>Unlike the customer repositories (which use the tenant-scoped
 * {@code voltpilot_app} datasource and rely on RLS), this repository uses the
 * dedicated {@code adminJdbcTemplate} bound to the {@code voltpilot_admin}
 * BYPASSRLS role - so a Portal-Admin can list and create tenants across the
 * whole platform. This is the ONLY cross-tenant data path and it is reached only
 * from {@code @PreAuthorize("hasRole('platform-admin')")} endpoints.
 */
@Repository
public class TenantRepository {

    private final JdbcTemplate jdbc;

    public TenantRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public List<TenantDto> findAll() {
        return jdbc.query(
                "SELECT id, name, segment, plan, betriebsart, created_at FROM tenant "
                        + "ORDER BY created_at",
                TenantRepository::map);
    }

    /**
     * Create a tenant - and, in the SAME statement (one transaction), its one
     * UEMS {@code unternehmen} plus that company's "angelegt" log entry (AP-00
     * E2, AP-02 §4.1: exactly one company per Kundenbereich, created
     * automatically with it). This is the same row the migration
     * V20260911100000 backfilled for every tenant that existed before it: name =
     * tenant name brought onto the naming rule, zone Europe/Berlin, no person
     * ({@code created_by}/{@code akteur_sub} NULL). The log names the actor
     * "VoltPilot" - not "(Bestandsübernahme)": a new Kundenbereich takes over no
     * existing stock. The app role has no INSERT on {@code unternehmen} at all;
     * this admin connection (BYPASSRLS) is the only way one comes into being.
     */
    public TenantDto create(String name, String segment) {
        return jdbc.queryForObject(
                "WITH t AS ("
                        + " INSERT INTO tenant (name, segment) VALUES (?, ?)"
                        + " RETURNING id, name, segment, plan, betriebsart, created_at),"
                        + " u AS ("
                        + " INSERT INTO unternehmen (tenant_id, name, zeitzone)"
                        + " SELECT t.id, COALESCE(NULLIF(btrim(left(btrim(t.name), 120)), ''),"
                        + " 'Unternehmen'), 'Europe/Berlin' FROM t"
                        + " RETURNING id, tenant_id, name, zeitzone, created_at),"
                        + " p AS ("
                        + " INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt,"
                        + " neu, gilt_ab, rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art)"
                        + " SELECT u.tenant_id, 'unternehmen', u.id, 'angelegt', NULL,"
                        + " jsonb_build_object('name', u.name, 'zeitzone', u.zeitzone),"
                        + " (u.created_at AT TIME ZONE u.zeitzone)::date, false, NULL, 'VoltPilot',"
                        + " 'voltpilot_betrieb', 'voltpilot'"
                        + " FROM u)"
                        + " SELECT id, name, segment, plan, betriebsart, created_at FROM t",
                TenantRepository::map, name, segment);
    }

    /**
     * Update a tenant's master data. Null when the tenant does not exist.
     * {@code betriebsart} is the full-representation U0 override: 'endkunde' /
     * 'betreiber' set it, null clears it back to the segment-derived automatic.
     */
    public TenantDto update(UUID tenantId, String name, String segment, String betriebsart) {
        List<TenantDto> updated = jdbc.query(
                "UPDATE tenant SET name = ?, segment = ?, betriebsart = ? WHERE id = ? "
                        + "RETURNING id, name, segment, plan, betriebsart, created_at",
                TenantRepository::map, name, segment, betriebsart, tenantId);
        return updated.isEmpty() ? null : updated.get(0);
    }

    /** The tenant by id, or null. */
    public TenantDto findById(UUID tenantId) {
        List<TenantDto> found = jdbc.query(
                "SELECT id, name, segment, plan, betriebsart, created_at FROM tenant WHERE id = ?",
                TenantRepository::map, tenantId);
        return found.isEmpty() ? null : found.get(0);
    }

    /**
     * Delete a tenant row. Used only to compensate a failed self-registration
     * (the tenant was just created and owns no data yet); child rows would make
     * this fail by FK, which is the safety we want. The ONE exception is the
     * {@code unternehmen} {@link #create} made with it (FK ON DELETE RESTRICT):
     * it goes first, in the same transaction - so a tenant that has grown any
     * other data still refuses. Its log entry stays (append-only, no FK - the
     * offboarding rule).
     */
    public void deleteById(UUID tenantId) {
        jdbc.execute((java.sql.Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                deleteByTenant(con, "unternehmen", tenantId);
                deleteByTenant(con, "tenant", tenantId, "id");
                con.commit();
                return null;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof java.sql.SQLException sql ? sql
                        : new java.sql.SQLException("tenant compensation failed", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    /** A device row of the tenant, as needed for the MQTT retained-topic cleanup. */
    public record TenantDevice(UUID id, UUID siteId, String externalRef) {
    }

    public List<TenantDevice> devicesOfTenant(UUID tenantId) {
        return jdbc.query(
                "SELECT id, site_id, external_ref FROM device WHERE tenant_id = ?",
                (rs, i) -> new TenantDevice(
                        rs.getObject("id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getString("external_ref")),
                tenantId);
    }

    /** What the database cascade of {@link #offboard} removed. */
    public record OffboardCounts(int sites, int devices, long telemetryRows) {
    }

    /**
     * Offboard a tenant: remove every series row of the tenant (the hypertables
     * carry no FKs; {@code messreihe_ereignis} holds a RESTRICT one to the
     * tenant, so it must go first) and then the tenant row itself, whose FKs cascade
     * site/device/asset - all in ONE database transaction, so a failure leaves
     * the tenant fully intact. Keycloak cleanup is separate and best-effort
     * (see the controller): the directory is another system and must not be
     * able to roll back the data deletion the operator confirmed.
     */
    public OffboardCounts offboard(UUID tenantId) {
        return jdbc.execute((java.sql.Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                for (String table : new String[] {
                        "ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
                        "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
                        "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
                        "ocpp_configuration_unknown_key", "ocpp_station_capability", "ocpp_action",
                        "ocpp_action_audit", "ocpp_action_intent"}) {
                    deleteByTenant(con, table, tenantId);
                }
                long telemetryRows = deleteByTenant(con, "telemetry", tenantId);
                for (String table : new String[] {
                        "telemetry_rollup_15m", "telemetry_rollup_1h", "telemetry_rollup_1d",
                        "weather_forecast", "schedule", "forecast",
                        "forecast_model_state", "forecast_accuracy", "plan_accuracy"}) {
                    deleteByTenant(con, table, tenantId);
                }
                // The event table (V20260911260000) is never deleted - not by unclaim,
                // purge or site deletion; it carries no FK to anything deletable. The
                // offboarding is its ONE deletion path (tenant FK RESTRICT; the admin
                // role holds DELETE only for this).
                // Older migration fixtures intentionally run this code before the Ablesungs migration.
                try (var probe = con.prepareStatement("SELECT to_regprocedure('uems_ablesungen_entfernen(uuid)') IS NOT NULL");
                        var vorhanden = probe.executeQuery()) {
                    vorhanden.next();
                    if (vorhanden.getBoolean(1)) {
                        try (var ps = con.prepareStatement("SELECT uems_ablesungen_entfernen(?)")) {
                            ps.setObject(1, tenantId);
                            ps.executeQuery().close();
                        }
                    }
                }
                deleteByTenant(con, "messreihe_ereignis", tenantId);
                // The quarter-hour storage class (AP-07 IP-12) and its work list carry no FK
                // either (hypertable + operational queue); offboarding is the ONE way out, like
                // every other series table above. The run-state row is not tenant-bound and stays.
                deleteByTenant(con, "messreihe_viertelstunde", tenantId);
                deleteByTenant(con, "messreihe_viertelstunde_arbeit", tenantId);
                // The day class, its work list and the correction proposals (AP-07 IP-13) go the
                // same way: hypertable + operational queues + a proposal list that holds the
                // tenant by RESTRICT. Offboarding is the ONE way out. The run-state row is not
                // tenant-bound and stays.
                deleteByTenant(con, "messreihe_tag", tenantId);
                deleteByTenant(con, "messreihe_tag_arbeit", tenantId);
                deleteByTenant(con, "messreihe_korrektur_vorschlag", tenantId);
                // Corrections and substitute values (AP-08 IP-12) are receipts: append-only, never
                // deleted, the tenant held by RESTRICT. Offboarding is the ONE way out - the
                // correction first, it holds its substitute value by FK.
                deleteByTenant(con, "messreihe_korrektur", tenantId);
                deleteByTenant(con, "messreihe_ersatzwert", tenantId);
                // The quarter-hour versions with substitute values and the run's per-value state
                // (AP-08 IP-13): append-only versions + a work state, the tenant held by RESTRICT.
                deleteByTenant(con, "messreihe_viertelstunde_version", tenantId);
                deleteByTenant(con, "messreihe_ersatzwert_wirkung", tenantId);
                // The correction cascade (AP-08 IP-17): append-only day/month/year and computed versions plus
                // the per-cause work state, the tenant held by RESTRICT - the same one way out.
                deleteByTenant(con, "messreihe_periode_version", tenantId);
                deleteByTenant(con, "messreihe_kaskade_wirkung", tenantId);
                // Month and year values and their work list (AP-08 IP-5): hypertable + queue,
                // no FK — the same one way out.
                deleteByTenant(con, "messreihe_periode", tenantId);
                deleteByTenant(con, "messreihe_periode_arbeit", tenantId);
                // The gap detector's state and work list (AP-07 IP-9): an operational queue, no
                // FK — the same one way out. Its gaps live in messreihe_ereignis (above); the
                // run-state row is not tenant-bound and stays.
                deleteByTenant(con, "messreihe_luecke_stand", tenantId);
                // The inputs of computed period values and the run's backfill state (AP-10 IP-10): a
                // hypertable + a work state, no FK - the same one way out. The computed rows themselves
                // live in the classes above (track `berechnet`).
                deleteByTenant(con, "bilanzwert_eingang", tenantId);
                deleteByTenant(con, "messreihe_berechnet_stand", tenantId);
                // The measurement pipeline (device_measurement_*, AP-07 IP-11): since
                // V20260913150000 its FKs to device and site RESTRICT, so the tenant's cascade
                // below would be refused. The admin role holds no DELETE on the selection
                // history - one narrow SECURITY DEFINER function, executable only by it.
                try (var ps = con.prepareStatement("SELECT uems_messwerte_des_kundenbereichs_entfernen(?)")) {
                    ps.setObject(1, tenantId);
                    ps.executeQuery().close();
                }
                int sites = count(con, "SELECT count(*) FROM site WHERE tenant_id = ?", tenantId);
                int devices = count(con, "SELECT count(*) FROM device WHERE tenant_id = ?", tenantId);
                // The UEMS master data (V20260911100000, V20260911110000,
                // V20260911140000, V20260911150000, V20260911200000, V20260911210000,
                // V20260911230000, V20260911250000, V20260911280000, V20260911290000)
                // references tenant/site/standort/ort with ON DELETE RESTRICT - never a
                // cascade. (The Bestandsübernahme's suggestion rows follow their site by
                // CASCADE but hold the tenant by RESTRICT; a Standort assignment outlives
                // its deleted site, W5.)
                // Offboarding is the ONE way a company ends, so it removes them
                // explicitly, children first: a Messstelle's source bindings (V20260911250000)
                // before the Messstelle and the Geraete they read from; a Messstelle's Ort and
                // Stellung intervals before the Messstelle, the Orte and the sites (tenant
                // cascade) they point at; a Messstelle before the Orte; floor areas and parent
                // intervals before the buildings/areas they point at, those before the
                // Standort; a Geraet's Einstellungs-Fassungen (V20260911280000), component periods and
                // cards before the Geraet, the Geraete before the Datenquelle they
                // answer through; the Zustaendigkeiten before their Datenquelle; the
                // Kurzzeichen occupancy and counter of the Orte (no FK to the Orte, only
                // to the tenant) with them. The
                // append-only logs ort_aenderung, messstelle_aenderung and
                // data_source_aenderung carry no FK and stay (the component_change_event
                // pattern). The components go with the
                // tenant cascade below, but their data_source_id is RESTRICT too: they
                // let go of their source first.
                try (java.sql.PreparedStatement st = con.prepareStatement(
                        "UPDATE measurement_point SET data_source_id = NULL "
                                + "WHERE tenant_id = ? AND data_source_id IS NOT NULL")) {
                    st.setObject(1, tenantId);
                    st.executeUpdate();
                }
                // The Zugriffe (V20260915030000, AP-03 IP-2) go before the Standort they name and the
                // Benutzer they belong to; the protocol names its Zugriff (RESTRICT), so it goes first.
                // The Stichtag (V20260916060000) holds only the tenant (RESTRICT) and goes with them.
                // Ahead of them all: the Unterstuetzung's companions (V20260916070000, AP-03 IP-8) - a Hinweis
                // names its Zugriff and its Anfrage, an Anfrage names its Zugriff and its Standorte, all
                // RESTRICT.
                for (String table : new String[] {"unterstuetzung_hinweis", "unterstuetzung_anfrage_standort",
                    "unterstuetzung_anfrage", "zugriff_protokoll", "zugriff", "benutzer", "zugriff_bestand"}) {
                    deleteByTenant(con, table, tenantId);
                }
                // The Berichte (V20260915050000) go before the Standort or Unternehmen their Geltung
                // names. A Berichtsstand, the sources of a Stand, the Anstoesse, the Abrufe and the
                // protocol are append-only for EVERY role - not even the admin role holds DELETE - so one
                // narrow SECURITY DEFINER function, executable only by it, removes them. Then the draft
                // before its Bericht; the Kennung counter holds only the tenant (RESTRICT). The Kennzahl
                // Abwahl (V20260915113000) holds only the tenant too and goes with the Berichte.
                try (var ps = con.prepareStatement("SELECT uems_berichte_des_kundenbereichs_entfernen(?)")) {
                    ps.setObject(1, tenantId);
                    ps.executeQuery().close();
                }
                for (String table : new String[] {"bericht_kennzahl_abwahl", "bericht_entwurf", "bericht",
                    "bericht_kennung_seq"}) {
                    deleteByTenant(con, table, tenantId);
                }
                // The Kennzahlen (V20260915003000) go before everything they read or apply to
                // (Bezugsgroessen, Messstellen, Orte, Prozesse, Kostenstellen, Standort, Unternehmen).
                // Their values are append-only for EVERY role - not even the admin role holds DELETE -
                // so one narrow SECURITY DEFINER function, executable only by it, removes them. Then an
                // input binding before its Fassung, a Fassung and the Kennzeichen occupancy before the
                // Kennzahl; the protocol holds only the tenant (RESTRICT).
                try (var ps = con.prepareStatement("SELECT uems_kennzahlwerte_des_kundenbereichs_entfernen(?)")) {
                    ps.setObject(1, tenantId);
                    ps.executeQuery().close();
                }
                for (String table : new String[] {
                        "kennzahl_eingang", "kennzahl_fassung", "kennzahl_kennzeichen_verlauf", "kennzahl",
                        "kennzahl_aenderung"}) {
                    deleteByTenant(con, table, tenantId);
                }
                // The Bezugsgroessen (V20260913104500) go first: a value's Fassungen and
                // the Kennzeichen occupancy before their Bezugsgroesse, the Bezugsgroesse
                // before the Messstelle, Ort, Standort or Unternehmen it applies to. Its
                // protocol has no FK to the Bezugsgroesse but holds the tenant (RESTRICT),
                // so - unlike the older journals - it goes with the company. The Stammdaten
                // with validity (V20260914151500) are values too: before their Bezugsgroesse.
                // Kostenstelle and Prozess (V20260913160000) follow everything that points at
                // them (Bezugsgroessen, Verteilungs-Terme, the Messstelle's Prozess intervals and
                // Kostenstellen-Anteile, V20260913230000); sub-processes go before their parent
                // (the self reference is RESTRICT, checked row by row). The imports of
                // Bezugsdaten (V20260914173000) go before everything: a row before its
                // import (RESTRICT), an import before the template version it names. The correction processes of
                // Bezugsgroessen values (V20260915010000) point at their Bezugsgroesse: before it (RESTRICT).
                for (String table : new String[] {
                        "bezugsdaten_import_zeile", "bezugsdaten_import", "bezugsdaten_vorlage_bezug",
                        "bezugsdaten_vorlage",
                        "bezugsgroesse_berichtigung",
                        "bezugsgroesse_wert", "bezugsgroesse_stammdatum", "bezugsgroesse_kennzeichen_verlauf",
                        "bezugsgroesse",
                        "bezugsgroesse_aenderung",
                        "messstelle_formel_term", "messstelle_formel_fassung",
                        "messstelle_prozess", "messstelle_verteilung"}) {
                    deleteByTenant(con, table, tenantId);
                }
                try (java.sql.PreparedStatement st = con.prepareStatement(
                        "DELETE FROM prozess WHERE tenant_id = ? AND eltern_id IS NOT NULL")) {
                    st.setObject(1, tenantId);
                    st.executeUpdate();
                }
                for (String table : new String[] {
                        "prozess", "kostenstelle",
                        "quelle_kadenz", "messstelle_quelle", "quelle_einstellung",
                        "geraet_komponente", "geraet_teil", "geraet", "geraet_kennzeichen_seq",
                        "device_data_source_status", "data_source_assignment", "data_source",
                        "data_source_kennzeichen_seq",
                        "messstelle_ort", "messstelle_stellung",
                        "messstelle_groesse", "messstelle_kennzeichen", "messstelle",
                        "messstelle_kennzeichen_seq",
                        "flaeche_gueltigkeit", "ort_zuordnung", "ort",
                        // The Netzanschluss (V20260913235000): its bindings and Kennzeichen
                        // occupancy before it, it before its Standort; counter and protocol hold
                        // only the tenant (RESTRICT).
                        "netzanschluss_vorschlag_entscheidung", "anlage_netzanschluss", "netzanschluss_kennzeichen", "netzanschluss",
                        "netzanschluss_kennzeichen_seq", "netzanschluss_aenderung",
                        // The Funktionen (V20260914190000): a Teilnahme before its Funktion
                        // (RESTRICT), the Funktion before its Standort.
                        "funktion_teilnahme", "funktion",
                        "standort_vorschlag", "anlage_standort", "standort", "ort_kurzzeichen",
                        "ort_kurzzeichen_seq",
                        "unternehmen"}) {
                    deleteByTenant(con, table, tenantId);
                }
                deleteByTenant(con, "tenant", tenantId, "id");
                con.commit();
                return new OffboardCounts(sites, devices, telemetryRows);
            } catch (Exception e) {
                con.rollback();
                throw e instanceof java.sql.SQLException sql ? sql
                        : new java.sql.SQLException("tenant offboarding failed", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    private static long deleteByTenant(java.sql.Connection con, String table, UUID tenantId)
            throws java.sql.SQLException {
        return deleteByTenant(con, table, tenantId, "tenant_id");
    }

    private static long deleteByTenant(java.sql.Connection con, String table, UUID tenantId,
            String column) throws java.sql.SQLException {
        try (java.sql.PreparedStatement st = con.prepareStatement(
                "DELETE FROM " + table + " WHERE " + column + " = ?")) {
            st.setObject(1, tenantId);
            return st.executeUpdate();
        }
    }

    private static int count(java.sql.Connection con, String sql, UUID tenantId)
            throws java.sql.SQLException {
        try (java.sql.PreparedStatement st = con.prepareStatement(sql)) {
            st.setObject(1, tenantId);
            try (java.sql.ResultSet rs = st.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    public boolean existsById(UUID tenantId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM tenant WHERE id = ?", Integer.class, tenantId);
        return count != null && count > 0;
    }

    private static TenantDto map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        OffsetDateTime created = rs.getObject("created_at", OffsetDateTime.class);
        String segment = rs.getString("segment");
        String betriebsart = rs.getString("betriebsart");
        return new TenantDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                segment,
                rs.getString("plan"),
                betriebsart,
                Betriebsart.effective(betriebsart, segment),
                created != null ? created.toInstant() : null);
    }
}
