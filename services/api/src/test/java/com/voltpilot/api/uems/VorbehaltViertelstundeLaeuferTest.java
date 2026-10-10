package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Die Last des Viertelstunden-Takts (IP-13 Folge): ohne Gemeinsame Steuerung bleibt es bei der EINEN Frage nach den
 * Kundenbereichen — kein Kundenbereich wird betreten, der Dienst nie gerufen (Bestand unberührt, I6/R22).
 */
class VorbehaltViertelstundeLaeuferTest {

    @Test
    void ohneVerbundGenauEineAbfrageUndKeinDienst() {
        JdbcTemplate admin = mock(JdbcTemplate.class);
        when(admin.queryForList(anyString(), eq(UUID.class))).thenReturn(List.of());
        VorbehaltDienst dienst = mock(VorbehaltDienst.class);
        UemsLaeuferMelder melder = mock(UemsLaeuferMelder.class);
        VorbehaltViertelstundeLaeufer l = new VorbehaltViertelstundeLaeufer(admin, dienst);
        l.melder(melder);

        assertThat(l.lauf(Instant.parse("2027-10-20T08:25:00Z"))).isZero();
        l.takt();

        verify(admin, org.mockito.Mockito.times(2))
                .queryForList("SELECT DISTINCT tenant_id FROM steuerungsverbund ORDER BY tenant_id", UUID.class);
        verifyNoMoreInteractions(admin);
        verifyNoInteractions(dienst);
        verify(melder).gelaufen(UemsLaeuferMelder.VORBEHALT_VIERTELSTUNDE);
    }
}
