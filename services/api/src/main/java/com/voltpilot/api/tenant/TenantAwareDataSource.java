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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 * Without a zugriff (jobs, admin routes) both stay unset. The policy {@code site_scope}
 * (IP-5) reads them.
 *
 * <p><b>Eine Verbindung je Anfrage (Lasttest Rang 13).</b> Innerhalb einer HTTP-Anfrage
 * ({@link AnfrageVerbindung}, geöffnet vom {@link TenantFilter}) bekommt jeder Aufruf einen
 * Griff auf DIESELBE Verbindung: gesetzt wird beim ersten Griff und danach nur, wenn sich
 * Mandant oder Zugriff geändert haben; zurückgesetzt einmal am Ende der Anfrage. Außerhalb
 * einer Anfrage (Läufer, MQTT-Hörer) und für eine zweite, gleichzeitige Verbindung derselben
 * Anfrage gilt das Setzen beim Ausleihen und Zurücksetzen bei der Rückgabe wie zuvor.
 *
 * <p><b>Zurücksetzen ohne Ausnahme.</b> Eine Verbindung mit offener (auch abgebrochener)
 * Transaktion wird erst zurückgerollt - wie Hikari es bei der Rückgabe ohnehin täte -, dann
 * zurückgesetzt. Scheitert das trotzdem, wird die physische Verbindung abgebrochen und von
 * Hikari verworfen statt mit Mandant in den Pool zu gehen.
 */
public class TenantAwareDataSource extends DelegatingDataSource {

    private static final Logger log = LoggerFactory.getLogger(TenantAwareDataSource.class);

    public TenantAwareDataSource(DataSource target) {
        super(target);
    }

    @Override
    public Connection getConnection() throws SQLException {
        Sitzung soll = Sitzung.aktuell();
        AnfrageVerbindung.Bindung bindung = AnfrageZeitgrenze.istAktiv() ? AnfrageVerbindung.aktuelle() : null;
        if (bindung != null) {
            Connection gebunden = bindung.ausleihen(this, soll);
            if (gebunden != null) {
                return gebunden;
            }
        }
        return einzeln(super.getConnection(), soll);
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return einzeln(super.getConnection(username, password), Sitzung.aktuell());
    }

    /** Eine Verbindung des Ziel-Pools, noch ohne Variablen - für die Bindung einer Anfrage. */
    Connection zielVerbindung() throws SQLException {
        return super.getConnection();
    }

    /** Die einzeln geliehene Verbindung: setzen, und beim close() zurücksetzen. */
    private static Connection einzeln(Connection connection, Sitzung soll) throws SQLException {
        try {
            soll.anwenden(connection);
        } catch (SQLException | RuntimeException e) {
            zuruecksetzenUndSchliessen(connection);
            throw e;
        }
        return (Connection) Proxy.newProxyInstance(
                TenantAwareDataSource.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                new ResettingHandler(connection));
    }

    /**
     * Setzt die drei Variablen zurück und gibt die Verbindung an den Pool. Eine offene Transaktion wird vorher
     * zurückgerollt (sonst liefe das Zurücksetzen in eine abgebrochene Transaktion und ginge mit ihr verloren).
     * Scheitert es, wird die physische Verbindung abgebrochen: Hikari verwirft sie beim close(). Wirft nie.
     */
    static void zuruecksetzenUndSchliessen(Connection connection) {
        if (connection == null) {
            return;
        }
        try {
            if (!connection.isClosed()) {
                if (!connection.getAutoCommit()) {
                    connection.rollback();
                    connection.setAutoCommit(true);
                }
                Sitzung.LEER.anwenden(connection);
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("Sitzungs-Variablen nicht zurückgesetzt, Verbindung wird verworfen: {}", e.getMessage());
            try {
                connection.abort(Runnable::run);
            } catch (SQLException | RuntimeException abbruch) {
                log.warn("Verbindung nicht abgebrochen: {}", abbruch.getMessage());
            }
        } finally {
            try {
                connection.close();
            } catch (SQLException | RuntimeException e) {
                // Eine abgebrochene Verbindung meldet sich beim close() als kaputt; Hikari verwirft sie.
                log.debug("Verbindung beim Schließen verworfen: {}", e.getMessage());
            }
        }
    }

    /** Die drei Variablen, wie sie auf einer Verbindung stehen sollen; {@code null} = nicht gesetzt. */
    record Sitzung(String tenant, String zugriff, String standortIds) {

        static final Sitzung LEER = new Sitzung(null, null, null);

        static Sitzung aktuell() {
            return aus(TenantContext.get(), ZugriffContext.get());
        }

        static Sitzung aus(UUID tenantId, ZugriffContext.Zugriff zugriff) {
            boolean ownTenant = tenantId != null && zugriff != null && tenantId.equals(zugriff.kundenbereich());
            return new Sitzung(tenantId == null ? null : tenantId.toString(),
                    ownTenant ? zugriff.modus().code() : null,
                    ownTenant ? zugriff.standortIdsWert() : null);
        }

        /**
         * set_config(name, value, is_local=false) sets the value for the session; a NULL value resets it to
         * unset. Bound parameters keep it injection-safe.
         */
        void anwenden(Connection connection) throws SQLException {
            try (PreparedStatement ps = connection.prepareStatement("SELECT set_config('app.tenant_id', ?, false), "
                    + "set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
                ps.setString(1, tenant);
                ps.setString(2, zugriff);
                ps.setString(3, standortIds);
                ps.execute();
            }
        }
    }

    /** Proxy that resets the session variables before the connection returns to the pool. */
    private record ResettingHandler(Connection delegate) implements InvocationHandler {
        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            if ("close".equals(method.getName())) {
                zuruecksetzenUndSchliessen(delegate);
                return null;
            }
            try {
                return method.invoke(delegate, args);
            } catch (java.lang.reflect.InvocationTargetException ex) {
                throw ex.getCause();
            }
        }
    }
}
