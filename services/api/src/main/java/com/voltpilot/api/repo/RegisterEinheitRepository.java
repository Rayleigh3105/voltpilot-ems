package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.EinheitFlaecheDto;
import com.voltpilot.api.web.dto.MastrApplyRequest;
import com.voltpilot.api.web.dto.RegisterEinheitDto;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * A site's registered units (S1/S2, vp-mastr-mehrere-einheiten-konzept
 * Abschnitt 5.1): RLS-scoped exactly like {@link AssetRepository} - no tenant
 * predicate in the SQL, the session's {@code app.tenant_id} does the scoping.
 * {@code asset} stays the aggregate the rest of the system reads (Abschnitt
 * 5.2); this repository is additive underneath it.
 */
@Repository
public class RegisterEinheitRepository {

    private static final String COLUMNS = "id, art, registry, registry_unit_id, bezeichnung, "
            + "inbetriebnahme, leistung_kwp, speicher_kwh, speicher_kw, bestaetigt_am, r_abgerufen_am, "
            + "(r_inbetriebnahme IS DISTINCT FROM inbetriebnahme OR r_leistung_kwp IS DISTINCT FROM leistung_kwp) "
            + "AS abweichung";

    private final JdbcTemplate jdbc;

    public RegisterEinheitRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Every registered unit of a site, each with its roof faces (Abschnitt 5.1, the Sonnenrose's data). */
    public List<RegisterEinheitDto> findForSite(UUID siteId) {
        Map<UUID, List<EinheitFlaecheDto>> flaechenByEinheit = jdbc.query(
                "SELECT ef.einheit_id, ef.richtung_grad, ef.neigung_grad, ef.anteil_kwp, ef.module, ef.quelle "
                        + "FROM einheit_flaeche ef JOIN register_einheit re ON re.id = ef.einheit_id "
                        + "WHERE re.site_id = ? ORDER BY ef.richtung_grad",
                rs -> {
                    Map<UUID, List<EinheitFlaecheDto>> result = new LinkedHashMap<>();
                    while (rs.next()) {
                        UUID einheitId = rs.getObject("einheit_id", UUID.class);
                        result.computeIfAbsent(einheitId, k -> new ArrayList<>()).add(new EinheitFlaecheDto(
                                rs.getBigDecimal("richtung_grad"), rs.getBigDecimal("neigung_grad"),
                                rs.getBigDecimal("anteil_kwp"), rs.getObject("module", Integer.class),
                                rs.getString("quelle")));
                    }
                    return result;
                },
                siteId);
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM register_einheit WHERE site_id = ? ORDER BY inbetriebnahme, created_at",
                (rs, rowNum) -> map(rs, flaechenByEinheit), siteId);
    }

    /**
     * Persist the customer-CONFIRMED selection of a Lokations-Suche preview
     * (Abschnitt 5.3 point 4): one upsert per unit, idempotent on {@code
     * (site_id, registry_unit_id)} - a re-apply (re-confirm) updates both
     * layers and bumps {@code revision}, it never creates a duplicate. A PV
     * unit with a known orientation gets exactly one {@code einheit_flaeche}
     * row (Abschnitt 5.4: anything without a known kWp AND orientation stays
     * without a Fläche, never a guessed one); re-applying replaces it rather
     * than accumulating rows.
     */
    public void applyUnits(UUID tenantId, UUID siteId, List<MastrApplyRequest.PvApply> pv,
            List<MastrApplyRequest.StorageApply> storage, String registry, Instant fetchedAt, String bestaetigtVon) {
        if (pv != null) {
            for (MastrApplyRequest.PvApply p : pv) {
                UUID einheitId = upsertPv(tenantId, siteId, p, registry, fetchedAt, bestaetigtVon);
                jdbc.update("DELETE FROM einheit_flaeche WHERE einheit_id = ?", einheitId);
                if (p.azimuthDeg() != null && p.capacityKwp() != null && p.capacityKwp().signum() > 0) {
                    jdbc.update(
                            "INSERT INTO einheit_flaeche (tenant_id, einheit_id, richtung_grad, neigung_grad, "
                                    + "anteil_kwp, module, quelle) VALUES (?, ?, ?, ?, ?, ?, 'kunde')",
                            tenantId, einheitId, p.azimuthDeg(), p.tiltDeg(), p.capacityKwp(), p.moduleCount());
                }
            }
            // Mehrere Einheiten: die Summen-Zeile bleibt die Zahl, mit der
            // Prognose/Optimierer/Erlöse HEUTE rechnen (Abschnitt 5.2) - ohne
            // diese Synchronisierung zeigte die Sonnenrose mehr kWp, als dem
            // Kunden tatsächlich gerechnet wird. Richtung/Neigung bleiben
            // einspurig (eine Fläche) bis S4 - bewusste, dokumentierte Lücke.
            syncAssetPvSum(tenantId, siteId);
        }
        if (storage != null) {
            for (MastrApplyRequest.StorageApply s : storage) {
                upsertSpeicher(tenantId, siteId, s, registry, fetchedAt, bestaetigtVon);
            }
        }
    }

    /**
     * Syncs the site's aggregate PV nameplate to Σ known register_einheit
     * powers (Abschnitt 5.2) - called only after a batch that touched at
     * least one PV unit, so a storage-only apply never zeroes an existing
     * sum. An unconfirmed suggestion ({@code leistung_kwp IS NULL}) is
     * excluded by {@code SUM}'s own null-skipping, matching "fehlt sie,
     * rechnet die Anlage wie heute" for every OTHER unit's contribution.
     */
    private void syncAssetPvSum(UUID tenantId, UUID siteId) {
        jdbc.update(
                "INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) "
                        + "SELECT ?, ?, 'pv', COALESCE(SUM(leistung_kwp), 0) FROM register_einheit "
                        + "WHERE site_id = ? AND art = 'pv' "
                        + "ON CONFLICT (site_id, type) WHERE is_primary DO UPDATE SET "
                        + "pv_capacity_kwp = EXCLUDED.pv_capacity_kwp",
                tenantId, siteId, siteId);
    }

    private UUID upsertPv(UUID tenantId, UUID siteId, MastrApplyRequest.PvApply p, String registry,
            Instant fetchedAt, String bestaetigtVon) {
        return jdbc.queryForObject(
                "INSERT INTO register_einheit (tenant_id, site_id, art, registry, registry_unit_id, "
                        + "r_inbetriebnahme, r_leistung_kwp, r_module, r_abgerufen_am, "
                        + "inbetriebnahme, leistung_kwp, bestaetigt_am, bestaetigt_von) "
                        + "VALUES (?, ?, 'pv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (site_id, registry_unit_id) DO UPDATE SET "
                        + "r_inbetriebnahme = EXCLUDED.r_inbetriebnahme, r_leistung_kwp = EXCLUDED.r_leistung_kwp, "
                        + "r_module = EXCLUDED.r_module, r_abgerufen_am = EXCLUDED.r_abgerufen_am, "
                        + "inbetriebnahme = EXCLUDED.inbetriebnahme, leistung_kwp = EXCLUDED.leistung_kwp, "
                        + "bestaetigt_am = EXCLUDED.bestaetigt_am, bestaetigt_von = EXCLUDED.bestaetigt_von, "
                        + "revision = register_einheit.revision + 1 "
                        + "RETURNING id",
                UUID.class,
                tenantId, siteId, registry, p.mastrNummer(), p.commissionedOn(), p.capacityKwp(),
                p.moduleCount(), Timestamp.from(fetchedAt), p.commissionedOn(), p.capacityKwp(),
                Timestamp.from(fetchedAt), bestaetigtVon);
    }

    private void upsertSpeicher(UUID tenantId, UUID siteId, MastrApplyRequest.StorageApply s, String registry,
            Instant fetchedAt, String bestaetigtVon) {
        jdbc.update(
                "INSERT INTO register_einheit (tenant_id, site_id, art, registry, registry_unit_id, "
                        + "r_inbetriebnahme, r_speicher_kwh, r_speicher_kw, r_abgerufen_am, "
                        + "inbetriebnahme, speicher_kwh, speicher_kw, bestaetigt_am, bestaetigt_von) "
                        + "VALUES (?, ?, 'speicher', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (site_id, registry_unit_id) DO UPDATE SET "
                        + "r_inbetriebnahme = EXCLUDED.r_inbetriebnahme, r_speicher_kwh = EXCLUDED.r_speicher_kwh, "
                        + "r_speicher_kw = EXCLUDED.r_speicher_kw, r_abgerufen_am = EXCLUDED.r_abgerufen_am, "
                        + "inbetriebnahme = EXCLUDED.inbetriebnahme, speicher_kwh = EXCLUDED.speicher_kwh, "
                        + "speicher_kw = EXCLUDED.speicher_kw, bestaetigt_am = EXCLUDED.bestaetigt_am, "
                        + "bestaetigt_von = EXCLUDED.bestaetigt_von, revision = register_einheit.revision + 1",
                tenantId, siteId, registry, s.mastrNummer(), s.commissionedOn(), s.capacityKwh(),
                s.maxDischargeKw(), Timestamp.from(fetchedAt), s.commissionedOn(), s.capacityKwh(),
                s.maxDischargeKw(), Timestamp.from(fetchedAt), bestaetigtVon);
    }

    /**
     * S2 Hintergrund-Abgleich (E5): record a unit found at the same Lokation
     * as a NOT-YET-CONFIRMED suggestion ({@code bestaetigt_am} stays NULL, so
     * nothing computes from it) - once per unit, ever: a unit already known
     * at this site (confirmed or previously suggested) is left untouched.
     */
    public boolean suggestUnit(UUID tenantId, UUID siteId, String art, String registry, String registryUnitId,
            BigDecimal rLeistungKwp, java.time.LocalDate rInbetriebnahme, Instant fetchedAt) {
        int inserted = jdbc.update(
                "INSERT INTO register_einheit (tenant_id, site_id, art, registry, registry_unit_id, "
                        + "r_leistung_kwp, r_inbetriebnahme, r_abgerufen_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (site_id, registry_unit_id) DO NOTHING",
                tenantId, siteId, art, registry, registryUnitId, rLeistungKwp, rInbetriebnahme,
                Timestamp.from(fetchedAt));
        return inserted > 0;
    }

/** One confirmed, numbered unit due for a fresh register read (the Hintergrund-Abgleich's work queue). */
    public record FaelligeEinheit(UUID siteId, String registryUnitId, String art) {
    }

    /**
     * Confirmed, numbered units of THIS tenant (RLS-scoped, like every other
     * read here) whose register layer has not been re-read in a while - the
     * Hintergrund-Abgleich's per-tenant work queue (called inside the
     * runner's {@code TenantContext}-scoped loop, exactly like {@code
     * VorgabenLaeufer}'s per-tenant queries - never via the admin pool).
     */
    public List<FaelligeEinheit> findStaleConfirmed(Instant olderThan, int limit) {
        return jdbc.query(
                "SELECT site_id, registry_unit_id, art FROM register_einheit "
                        + "WHERE bestaetigt_am IS NOT NULL AND registry_unit_id IS NOT NULL "
                        + "AND (r_abgerufen_am IS NULL OR r_abgerufen_am < ?) "
                        + "ORDER BY r_abgerufen_am NULLS FIRST LIMIT ?",
                (rs, n) -> new FaelligeEinheit(rs.getObject("site_id", UUID.class),
                        rs.getString("registry_unit_id"), rs.getString("art")),
                Timestamp.from(olderThan), limit);
    }

    /** Every registry_unit_id already known at a site (confirmed or still-unconfirmed suggestion). */
    public List<String> knownUnitNumbers(UUID siteId) {
        return jdbc.queryForList(
                "SELECT registry_unit_id FROM register_einheit WHERE site_id = ? AND registry_unit_id IS NOT NULL",
                String.class, siteId);
    }

    /**
     * A fresh register read: writes ONLY the {@code r_*} layer, never the
     * confirmed one (Abschnitt 5.1/4.5 - a later abruf never overwrites a
     * confirmation; a deviation becomes a hint via {@code abweichung}, read
     * back by {@link #findForSite}).
     */
    public void updateRegisterLayer(UUID siteId, String registryUnitId, BigDecimal rLeistungKwp,
            java.time.LocalDate rInbetriebnahme, Integer rModule, Instant fetchedAt) {
        jdbc.update(
                "UPDATE register_einheit SET r_leistung_kwp = ?, r_inbetriebnahme = ?, r_module = ?, "
                        + "r_abgerufen_am = ? WHERE site_id = ? AND registry_unit_id = ?",
                rLeistungKwp, rInbetriebnahme, rModule, Timestamp.from(fetchedAt), siteId, registryUnitId);
    }

    private static RegisterEinheitDto map(ResultSet rs, Map<UUID, List<EinheitFlaecheDto>> flaechenByEinheit)
            throws SQLException {
        Timestamp bestaetigt = rs.getTimestamp("bestaetigt_am");
        Timestamp abgerufen = rs.getTimestamp("r_abgerufen_am");
        java.sql.Date inbetrieb = rs.getDate("inbetriebnahme");
        UUID id = rs.getObject("id", UUID.class);
        return new RegisterEinheitDto(
                id,
                rs.getString("art"),
                rs.getString("registry"),
                rs.getString("registry_unit_id"),
                rs.getString("bezeichnung"),
                inbetrieb != null ? inbetrieb.toLocalDate() : null,
                rs.getBigDecimal("leistung_kwp"),
                rs.getBigDecimal("speicher_kwh"),
                rs.getBigDecimal("speicher_kw"),
                bestaetigt != null ? bestaetigt.toInstant() : null,
                abgerufen != null ? abgerufen.toInstant() : null,
                rs.getBoolean("abweichung"),
                flaechenByEinheit.getOrDefault(id, List.of()));
    }
}
