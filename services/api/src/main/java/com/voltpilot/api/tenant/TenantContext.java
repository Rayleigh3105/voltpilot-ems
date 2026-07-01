package com.voltpilot.api.tenant;

import java.util.UUID;

/**
 * Holds the current request's tenant for the duration of request processing.
 *
 * <p>{@link TenantFilter} populates it from the JWT {@code tenant_id} claim and
 * clears it afterwards; {@link TenantAwareDataSource} reads it when a JDBC
 * connection is borrowed and applies it as the {@code app.tenant_id} Postgres
 * session variable that drives Row-Level-Security.
 */
public final class TenantContext {

    private static final ThreadLocal<UUID> CURRENT = new ThreadLocal<>();

    private TenantContext() {
    }

    public static void set(UUID tenantId) {
        CURRENT.set(tenantId);
    }

    public static UUID get() {
        return CURRENT.get();
    }

    public static void clear() {
        CURRENT.remove();
    }
}
