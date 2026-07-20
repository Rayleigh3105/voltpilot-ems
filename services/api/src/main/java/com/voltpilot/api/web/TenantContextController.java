package com.voltpilot.api.web;

import com.voltpilot.api.tenant.Betriebsart;
import com.voltpilot.api.web.dto.TenantContextDto;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * {@code GET /api/v1/tenant-context} - the tenant half of the portal's login
 * bootstrap (U0, design vp-ems-ui-overhaul §2). The portal reads role context
 * from the JWT; this endpoint adds what the token does not carry: the tenant's
 * name/segment and the EFFECTIVE Betriebsart that picks the navigation shell.
 *
 * <p>Tenancy is the V2 RLS policy on the {@code tenant} table (scoped by its
 * own primary key), read through the RLS-scoped app datasource: a customer gets
 * exactly their own tenant row; a Portal-Admin gets the tenant selected via the
 * {@code X-Tenant-Id} switcher; an admin WITHOUT a selected tenant is
 * default-deny (zero rows) -> 404, which the portal treats as "no context".
 */
@RestController
@RequestMapping("/api/v1/tenant-context")
public class TenantContextController {

    private final JdbcTemplate jdbc;

    public TenantContextController(JdbcTemplate jdbcTemplate) {
        this.jdbc = jdbcTemplate;
    }

    @GetMapping
    public TenantContextDto get() {
        // No WHERE clause on purpose: RLS narrows the table to the caller's
        // one tenant row (or none), exactly like every customer repository.
        List<TenantContextDto> rows = jdbc.query(
                "SELECT id, name, segment, betriebsart FROM tenant",
                (rs, i) -> {
                    String segment = rs.getString("segment");
                    return new TenantContextDto(
                            rs.getObject("id", UUID.class),
                            rs.getString("name"),
                            segment,
                            Betriebsart.effective(rs.getString("betriebsart"), segment));
                });
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No tenant context");
        }
        return rows.get(0);
    }
}
