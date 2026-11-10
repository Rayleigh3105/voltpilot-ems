package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.sql.Connection;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** {@link AnfragePfadDataSource} nur als Verteiler - die Zeitgrenzen selbst sitzen in den zwei
 * echten Hikari-Pools (siehe {@code DataSourceConfig}), nicht hier. */
class AnfragePfadDataSourceTest {

    private final DataSource anfragePool = mock(DataSource.class);
    private final DataSource hintergrundPool = mock(DataSource.class);
    private final AnfragePfadDataSource verteiler = new AnfragePfadDataSource(anfragePool, hintergrundPool);

    @AfterEach
    void aufraeumen() {
        AnfrageZeitgrenze.ende();
    }

    @Test
    void ohneAnfrageZeitgrenzeKommtDieVerbindungAusDemHintergrundPool() throws Exception {
        Connection erwartet = mock(Connection.class);
        when(hintergrundPool.getConnection()).thenReturn(erwartet);

        assertThat(verteiler.getConnection()).isSameAs(erwartet);
        verifyNoInteractions(anfragePool);
    }

    @Test
    void mitAktiverAnfrageZeitgrenzeKommtDieVerbindungAusDemAnfragePool() throws Exception {
        Connection erwartet = mock(Connection.class);
        when(anfragePool.getConnection()).thenReturn(erwartet);
        AnfrageZeitgrenze.start();

        assertThat(verteiler.getConnection()).isSameAs(erwartet);
        verifyNoInteractions(hintergrundPool);
    }

    @Test
    void ausnahmeRoutetTrotzAktiverAnfrageZeitgrenzeInDenHintergrundPool() throws Exception {
        Connection erwartet = mock(Connection.class);
        when(hintergrundPool.getConnection()).thenReturn(erwartet);
        AnfrageZeitgrenze.start();
        AnfrageZeitgrenze.ausnahme();

        assertThat(verteiler.getConnection()).isSameAs(erwartet);
        verifyNoInteractions(anfragePool);
    }
}
