package com.voltpilot.api.ruhezeit;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

/**
 * {@code PUT /api/v1/ruhezeit} und {@code POST /api/v1/ruhezeit/probe} (Alerting Scheibe 3, §6.4): ein Körper ohne
 * {@code zeitzone} bekam bislang keinen sauberen 400, sondern eine rohe {@code NullPointerException} aus
 * {@code List.contains(null)} (Befund {@code PruefumgebungAhrenbergTest#einsichtAendertNichts}, leerer Körper
 * {@code {}}). Rein - ohne Spring-Kontext, ohne Datenbank.
 */
class RuhezeitServiceTest {

    private final RuhezeitRepository repo = mock(RuhezeitRepository.class);
    private final RuhezeitService service = new RuhezeitService(repo);

    @Test
    void setzenOhneZeitzoneBekommtEinenSauberenBadRequestStattEinerNullPointerException() {
        assertThatThrownBy(() -> service.setzen("sub-test", "{}", null, true))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("unbekannte Zeitzone");

        verifyNoInteractions(repo);
    }

    @Test
    void probeOhneZeitzoneBekommtEinenSauberenBadRequestStattEinerNullPointerException() {
        assertThatThrownBy(() -> service.probeAktivBis("{}", null, Instant.parse("2026-10-16T12:00:00Z")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("unbekannte Zeitzone");
    }
}
