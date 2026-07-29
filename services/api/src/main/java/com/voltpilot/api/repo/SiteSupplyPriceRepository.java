package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SupplyPriceDto;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Read/write the {@code site_supply_price} sheet of one Anlage (report
 * vp-nacht-bezug-e7 §3.1, Stufe 2 - the portal-maintenance CRUD).
 *
 * <p>Runs on the RLS-scoped {@code @Primary} {@link JdbcTemplate} (the same
 * {@code voltpilot_app} role the customer site reads/writes use), so a foreign
 * site's sheet is invisible and the {@code WITH CHECK} policy pins every write
 * to the caller's tenant. The optimizer/earnings read this table with the
 * trusted backend role instead - see {@code OptimizerDiagnosticsRepository} /
 * {@code EarningsRepository}.
 *
 * <p>The write is PRESENCE-AWARE (the patch semantics the controller enforces):
 * a column absent from the request keeps its stored value; a column present
 * with an explicit value (incl. {@code null} = "unknown/cleared") is written.
 * That distinction can't be a plain COALESCE upsert (COALESCE(EXCLUDED, stored)
 * would silently keep a value the operator meant to clear), so the SET clause
 * is built from exactly the present columns.
 */
@Repository
public class SiteSupplyPriceRepository {

    /** The writable columns, in a stable order (allowlist - never user input). */
    private static final Set<String> COLUMNS = Set.of(
            "netzentgelt_arbeitspreis_ct",
            "stromsteuer_ct",
            "konzessionsabgabe_ct",
            "umlagen_ct",
            "vertriebsaufschlag_ct",
            "ust_pct",
            "komponenten_stand");

    private final JdbcTemplate jdbc;

    public SiteSupplyPriceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The site's sheet, or {@code SupplyPriceDto.empty()} when no row exists. */
    public SupplyPriceDto find(UUID siteId) {
        List<SupplyPriceDto> found = jdbc.query(
                "SELECT netzentgelt_arbeitspreis_ct, stromsteuer_ct, konzessionsabgabe_ct,"
                        + " umlagen_ct, vertriebsaufschlag_ct, ust_pct, komponenten_stand, updated_at"
                        + " FROM site_supply_price WHERE site_id = ?",
                SiteSupplyPriceRepository::map, siteId);
        return found.isEmpty() ? SupplyPriceDto.empty() : found.get(0);
    }

    /**
     * Upsert exactly the {@code present} columns (keys = the {@link #COLUMNS}
     * allowlist, values may be {@code null} to clear). Absent columns keep
     * their stored value on update and default (NULL, or 19.0 for {@code ust_pct})
     * on a fresh insert. {@code tenantId} stamps the row for RLS; the
     * {@code WITH CHECK} policy still enforces it matches the session tenant.
     */
    public SupplyPriceDto upsert(UUID siteId, UUID tenantId, Map<String, Object> present) {
        Map<String, Object> cols = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : present.entrySet()) {
            if (!COLUMNS.contains(e.getKey())) {
                throw new IllegalArgumentException("unknown supply-price column: " + e.getKey());
            }
            cols.put(e.getKey(), e.getValue());
        }
        if (cols.isEmpty()) {
            // Nothing to write - report the current state (touch nothing).
            return find(siteId);
        }
        List<String> names = List.copyOf(cols.keySet());
        String insertCols = "site_id, tenant_id, "
                + String.join(", ", names);
        String insertPlaceholders = "?, ?, "
                + names.stream().map(n -> "?").collect(Collectors.joining(", "));
        String updateSet = names.stream()
                .map(n -> n + " = EXCLUDED." + n)
                .collect(Collectors.joining(", "));
        Object[] args = new Object[2 + names.size()];
        args[0] = siteId;
        args[1] = tenantId;
        for (int i = 0; i < names.size(); i++) {
            args[2 + i] = cols.get(names.get(i));
        }
        jdbc.update(
                "INSERT INTO site_supply_price (" + insertCols + ") VALUES ("
                        + insertPlaceholders + ") "
                        + "ON CONFLICT (site_id) DO UPDATE SET " + updateSet
                        + ", updated_at = now()",
                args);
        return find(siteId);
    }

    private static SupplyPriceDto map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        java.math.BigDecimal netz = rs.getBigDecimal("netzentgelt_arbeitspreis_ct");
        java.math.BigDecimal strom = rs.getBigDecimal("stromsteuer_ct");
        java.math.BigDecimal konz = rs.getBigDecimal("konzessionsabgabe_ct");
        java.math.BigDecimal uml = rs.getBigDecimal("umlagen_ct");
        java.math.BigDecimal vert = rs.getBigDecimal("vertriebsaufschlag_ct");
        boolean hasComponents = netz != null || strom != null || konz != null
                || uml != null || vert != null;
        java.sql.Date stand = rs.getDate("komponenten_stand");
        java.sql.Timestamp updated = rs.getTimestamp("updated_at");
        return new SupplyPriceDto(
                true,
                hasComponents,
                netz, strom, konz, uml, vert,
                rs.getBigDecimal("ust_pct"),
                stand == null ? null : stand.toLocalDate(),
                updated == null ? null : updated.toInstant());
    }

    /** Delete the sheet (used by tests / cleanup); RLS scopes it to the tenant. */
    public boolean delete(UUID siteId) {
        return jdbc.update("DELETE FROM site_supply_price WHERE site_id = ?", siteId) > 0;
    }
}
