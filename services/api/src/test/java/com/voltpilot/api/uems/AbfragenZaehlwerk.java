package com.voltpilot.api.uems;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.datasource.DelegatingDataSource;

/**
 * Zählt, WELCHE Anweisungen die App-Verbindung schickt und wie oft eine Verbindung geholt wird - der Beleg für „eine
 * Abfrage, keine N+1“ (AP-04 IP-4, Prüfung r4 S15). Er hängt AUSSERHALB von {@code TenantAwareDataSource}: dessen
 * {@code set_config('app.tenant_id', …)} läuft auf der rohen Verbindung und wird nicht gezählt. Die Verwaltungsrolle
 * ({@code adminDataSource}) zählt er nicht.
 *
 * <p>Einbinden mit {@code @Import(AbfragenZaehlwerk.class)}; gezählt wird nur innerhalb von {@link #zaehle}.
 */
@TestConfiguration
public class AbfragenZaehlwerk {

    /** Was ein Weg geschickt hat: die Anweisungen in ihrer Reihenfolge und wie viele Verbindungen er holte. */
    public record Gezaehlt(List<String> abfragen, int verbindungen) {}

    private static final List<String> ABFRAGEN = Collections.synchronizedList(new ArrayList<>());
    private static final AtomicInteger VERBINDUNGEN = new AtomicInteger();
    private static volatile boolean zaehlen;

    @Bean
    static BeanPostProcessor abfragenZaehler() {
        return new BeanPostProcessor() {
            @Override
            public Object postProcessAfterInitialization(Object bean, String name) {
                return "dataSource".equals(name) && bean instanceof DataSource ds ? new ZaehlendeDataSource(ds) : bean;
            }
        };
    }

    /** Zählt, was {@code was} schickt - nie zwei Zählungen zugleich. */
    public static synchronized Gezaehlt zaehle(Runnable was) {
        ABFRAGEN.clear();
        VERBINDUNGEN.set(0);
        zaehlen = true;
        try {
            was.run();
        } finally {
            zaehlen = false;
        }
        return new Gezaehlt(List.copyOf(ABFRAGEN), VERBINDUNGEN.get());
    }

    static class ZaehlendeDataSource extends DelegatingDataSource {

        ZaehlendeDataSource(DataSource ziel) {
            super(ziel);
        }

        @Override
        public Connection getConnection() throws SQLException {
            return verbindung(super.getConnection());
        }

        @Override
        public Connection getConnection(String benutzer, String kennwort) throws SQLException {
            return verbindung(super.getConnection(benutzer, kennwort));
        }
    }

    private static Connection verbindung(Connection c) {
        if (zaehlen) {
            VERBINDUNGEN.incrementAndGet();
        }
        return (Connection) Proxy.newProxyInstance(AbfragenZaehlwerk.class.getClassLoader(),
                new Class<?>[] {Connection.class}, new Handler(c, true));
    }

    /** Zählt beim Vorbereiten (PreparedStatement) bzw. beim Ausführen (Statement) genau einmal. */
    private record Handler(Object ziel, boolean verbindung) implements InvocationHandler {

        @Override
        public Object invoke(Object proxy, Method methode, Object[] args) throws Throwable {
            String name = methode.getName();
            String sql = args != null && args.length > 0 && args[0] instanceof String s ? s : null;
            if (zaehlen && sql != null && (verbindung ? name.startsWith("prepare") : name.startsWith("execute"))) {
                ABFRAGEN.add(sql);
            }
            Object ergebnis;
            try {
                ergebnis = methode.invoke(ziel, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
            return verbindung && ergebnis instanceof Statement st && "createStatement".equals(name)
                    ? Proxy.newProxyInstance(AbfragenZaehlwerk.class.getClassLoader(),
                            new Class<?>[] {Statement.class}, new Handler(st, false))
                    : ergebnis;
        }
    }
}
