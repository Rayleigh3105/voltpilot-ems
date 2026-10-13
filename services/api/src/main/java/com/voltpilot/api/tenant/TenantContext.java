package com.voltpilot.api.tenant;

import java.util.UUID;
import org.slf4j.MDC;

/**
 * Holds the current request's tenant for the duration of request processing.
 *
 * <p>{@link TenantFilter} populates it from the JWT {@code tenant_id} claim and
 * clears it afterwards; {@link TenantAwareDataSource} reads it when a JDBC
 * connection is borrowed and applies it as the {@code app.tenant_id} Postgres
 * session variable that drives Row-Level-Security.
 *
 * <p><b>Log-Kennung.</b> Derselbe Wert steht, solange er hier steht, als {@code tenant_id} im MDC
 * (docs/k8s-readiness.md, Abschnitt "Logs"). Gespiegelt wird an dieser einen Stelle, weil nicht nur
 * der {@link TenantFilter} sie beschreibt, sondern auch jeder Läufer und jeder MQTT-Listener: eine
 * Log-Zeile nennt so genau den Mandanten, unter dem die Datenbank in diesem Augenblick gelesen wird -
 * die interne Kennung, nie ein Name.
 */
public final class TenantContext {

    /** MDC-Schlüssel der internen Mandanten-Kennung. */
    public static final String LOG_KENNUNG = "tenant_id";

    private static final ThreadLocal<UUID> CURRENT = new ThreadLocal<>();

    private TenantContext() {
    }

    public static void set(UUID tenantId) {
        CURRENT.set(tenantId);
        if (tenantId == null) {
            MDC.remove(LOG_KENNUNG);
        } else {
            MDC.put(LOG_KENNUNG, tenantId.toString());
        }
    }

    public static UUID get() {
        return CURRENT.get();
    }

    public static void clear() {
        CURRENT.remove();
        MDC.remove(LOG_KENNUNG);
    }
}
