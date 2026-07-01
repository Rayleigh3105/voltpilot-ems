package com.voltpilot.api.tenant;

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
        applyTenant(connection, TenantContext.get());
        return proxy(connection);
    }

    private static void applyTenant(Connection connection, UUID tenantId) throws SQLException {
        // set_config(name, value, is_local=false) sets the value for the session;
        // a NULL value resets it to unset. Bound parameter keeps it injection-safe.
        try (PreparedStatement ps = connection.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenantId == null ? null : tenantId.toString());
            ps.execute();
        }
    }

    /** Proxy that resets app.tenant_id before the connection returns to the pool. */
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
                    applyTenant(delegate, null);
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
