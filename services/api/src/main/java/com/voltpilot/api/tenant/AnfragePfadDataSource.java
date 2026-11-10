package com.voltpilot.api.tenant;

import java.sql.Connection;
import java.sql.SQLException;
import javax.sql.DataSource;
import org.springframework.jdbc.datasource.AbstractDataSource;

/**
 * Waehlt je geborgter Verbindung zwischen zwei physischen Pools derselben Rolle/Datenbank:
 * dem Anfrage-Pool (Statement- und Socket-Zeitgrenze aus {@code spring.datasource.hikari}),
 * solange {@link AnfrageZeitgrenze#istAktiv()}, sonst dem Hintergrund-Pool (ohne Zeitgrenze,
 * {@code spring.background-datasource.hikari}).
 *
 * <p>Eine Zeitgrenze sitzt serverseitig (Postgres-GUC {@code statement_timeout}, per
 * {@code connection-init-sql} je physischer Verbindung gesetzt - eine Sitzungsgroesse, die
 * fuer die Lebenszeit der Verbindung gilt) und eine clientseitig am TCP-Socket
 * ({@code socketTimeout}, nur beim Verbindungsaufbau wirksam, pgjdbc kann sie danach nicht mehr
 * aendern). Beides laesst sich darum nicht nachtraeglich je Anfrage umschalten - nur die Wahl
 * DES POOLS selbst ist der Hebel, den dieser Verteiler zieht. {@link TenantAwareDataSource}
 * umschliesst dieses Ergebnis unveraendert mit der RLS-Sitzungsstempelung.
 */
public class AnfragePfadDataSource extends AbstractDataSource {

    private final DataSource anfragePool;
    private final DataSource hintergrundPool;

    public AnfragePfadDataSource(DataSource anfragePool, DataSource hintergrundPool) {
        this.anfragePool = anfragePool;
        this.hintergrundPool = hintergrundPool;
    }

    private DataSource aktuellerPool() {
        return AnfrageZeitgrenze.istAktiv() ? anfragePool : hintergrundPool;
    }

    @Override
    public Connection getConnection() throws SQLException {
        return aktuellerPool().getConnection();
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return aktuellerPool().getConnection(username, password);
    }
}
