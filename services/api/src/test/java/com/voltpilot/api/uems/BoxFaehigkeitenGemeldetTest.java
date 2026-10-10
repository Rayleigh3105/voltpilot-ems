package com.voltpilot.api.uems;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.EdgeVersionRepository;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/**
 * AP-07 IP-18b Revisions-Anstoß: {@link BoxFaehigkeiten#record} meldet einen Wechsel der gemeldeten Menge genau
 * dann, wenn die Meldung angenommen ist - auch bei der ersten Meldung einer Box (gespeichert: NULL).
 */
class BoxFaehigkeitenGemeldetTest {
    private static final UUID BOX = UUID.fromString("00000000-0000-0000-0000-0000000000b0");
    private static final Instant AT = Instant.parse("2026-09-23T10:00:00Z");

    @SuppressWarnings("unchecked")
    private static BoxFaehigkeiten mit(JdbcTemplate jdbc, List<String> gespeichert, int geschrieben,
            ApplicationEventPublisher ereignisse) {
        when(jdbc.query(anyString(), any(RowMapper.class), eq(BOX))).thenReturn(Arrays.asList(gespeichert));
        when(jdbc.update(anyString(), any(), any(), any(), any())).thenReturn(geschrieben);
        BoxFaehigkeiten f = new BoxFaehigkeiten(jdbc, mock(EdgeVersionRepository.class));
        f.setEreignisse(ereignisse);
        return f;
    }

    @Test
    void dieErsteMeldungIstEinWechsel() {
        ApplicationEventPublisher ereignisse = mock(ApplicationEventPublisher.class);
        mit(mock(JdbcTemplate.class), null, 1, ereignisse).record(BOX, AT, List.of("data_sources"));
        verify(ereignisse).publishEvent(new BoxFaehigkeiten.Gemeldet(BOX, null, List.of("data_sources")));
    }

    @Test
    void gleicheMengeOderAbgewieseneMeldungMeldetNichts() {
        ApplicationEventPublisher ereignisse = mock(ApplicationEventPublisher.class);
        mit(mock(JdbcTemplate.class), List.of("events", "data_sources"), 1, ereignisse)
                .record(BOX, AT, List.of("data_sources", "events"));
        mit(mock(JdbcTemplate.class), List.of("data_sources"), 0, ereignisse)
                .record(BOX, AT, List.of("data_sources", "events"));
        verify(ereignisse, never()).publishEvent(any(Object.class));
    }
}
