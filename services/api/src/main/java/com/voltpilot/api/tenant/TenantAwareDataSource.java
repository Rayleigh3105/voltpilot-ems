package com.voltpilot.api.tenant;

import com.voltpilot.api.zugriff.ZugriffContext;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.jdbc.datasource.DelegatingDataSource;

/**
 * Wraps the pooled {@link DataSource} so every borrowed connection carries the
 * caller's tenant as the Postgres {@code app.tenant_id} session variable, which
 * the Row-Level-Security policies (migration V2) read via {@code current_setting}.
 *
 * <p>The variable is set with {@code set_config(...)} (bound parameter - no SQL
 * injection) on borrow and RESET when the connection is returned to the pool, so
 * a recycled connection never leaks the previous request's tenant. When no
 * tenant is in scope (unauthenticated calls, health checks) the variable is
 * cleared, which makes RLS default-deny.
 *
 * <p><b>Zugriff (UEMS AP-03 IP-4).</b> The same statement sets {@code app.zugriff}
 * ({@code unternehmen} | {@code standorte}) and {@code app.standort_ids} (a Postgres
 * array literal) from {@link ZugriffContext}, and the same reset clears all three.
 * They are applied only when the zugriff belongs to the tenant in scope; a listener
 * that briefly switches {@code TenantContext} inside a request gets them cleared.
 * Without a zugriff (jobs, admin routes) both stay unset. No policy reads them yet
 * ({@code site_scope} is IP-5).
 */
public class TenantAwareDataSource extends DelegatingDataSource {

    public TenantAwareDataSource(DataSource target) {
        super(target);
    }

    @Override
    public Connection getConnection() throws SQLException {
        return prepare(super.getConnection());
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return prepare(super.getConnection(username, password));
    }

    private Connection prepare(Connection connection) throws SQLException {
        applySession(connection, TenantContext.get(), ZugriffContext.get());
        return proxy(connection);
    }

    private static void applySession(Connection connection, UUID tenantId, ZugriffContext.Zugriff zugriff)
            throws SQLException {
        boolean ownTenant = tenantId != null && zugriff != null && tenantId.equals(zugriff.kundenbereich());
        // set_config(name, value, is_local=false) sets the value for the session;
        // a NULL value resets it to unset. Bound parameters keep it injection-safe.
        try (PreparedStatement ps = connection.prepareStatement("SELECT set_config('app.tenant_id', ?, false), "
                + "set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
            ps.setString(1, tenantId == null ? null : tenantId.toString());
            ps.setString(2, ownTenant ? zugriff.modus().code() : null);
            ps.setString(3, ownTenant ? zugriff.standortIdsWert() : null);
            ps.execute();
        }
    }

    /** Proxy that resets the session variables before the connection returns to the pool. */
    private static Connection proxy(Connection connection) {
        return (Connection) Proxy.newProxyInstance(
                TenantAwareDataSource.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                new ResettingHandler(connection));
    }

    private record ResettingHandler(Connection delegate) implements InvocationHandler {
        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            if ("close".equals(method.getName()) && !delegate.isClosed()) {
                try {
                    applySession(delegate, null, null);
                } catch (SQLException ignored) {
                    // Best-effort reset; closing the connection still proceeds.
                }
            }
            try {
                return method.invoke(delegate, args);
            } catch (java.lang.reflect.InvocationTargetException ex) {
                throw ex.getCause();
            }
        }
    }
}
