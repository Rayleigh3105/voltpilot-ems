package com.voltpilot.api.ruhezeit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.time.ZoneId;
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

    /**
     * Kunden-Alarmierung P2, KA-2 A: ohne eigene Ruhezeit gilt Zuhause nur nachts (jede Nacht 22 bis 7 Uhr, auch am
     * Wochenende), im Unternehmen weiter nachts und das ganze Wochenende. Dringendes kommt in beiden durch.
     */
    @Test
    void dieVorgabeZuhauseIstNurNachtsDieImUnternehmenAuchDasWochenende() {
        ZoneId berlin = ZoneId.of("Europe/Berlin");
        RuhezeitRepository.RuhezeitPerson zuhause = RuhezeitService.vorgabe(true);
        RuhezeitRepository.RuhezeitPerson unternehmen = RuhezeitService.vorgabe(false);
        Instant samstagMittag = Instant.parse("2026-11-14T11:00:00Z");
        Instant samstagNacht = Instant.parse("2026-11-14T22:00:00Z");
        Instant freitagNacht = Instant.parse("2026-11-13T21:30:00Z");

        assertThat(RuhezeitFenster.endeFallsAktiv(zuhause.regeln(), berlin, samstagMittag)).isEmpty();
        assertThat(RuhezeitFenster.endeFallsAktiv(zuhause.regeln(), berlin, samstagNacht))
                .contains(Instant.parse("2026-11-15T06:00:00Z"));
        assertThat(RuhezeitFenster.endeFallsAktiv(zuhause.regeln(), berlin, freitagNacht))
                .contains(Instant.parse("2026-11-14T06:00:00Z"));
        assertThat(RuhezeitFenster.endeFallsAktiv(unternehmen.regeln(), berlin, samstagMittag))
                .as("Unternehmen wie bisher: das Wochenende ganz, bis Montag 7 Uhr")
                .contains(Instant.parse("2026-11-16T06:00:00Z"));
        assertThat(zuhause.dringendDurch()).isTrue();
        assertThat(unternehmen.dringendDurch()).isTrue();
    }

    @Test
    void dieVorgabeFolgtDerBetriebsartDesKundenbereichs() {
        when(repo.istZuhause()).thenReturn(true);
        assertThat(service.vorgabeHier()).isSameAs(RuhezeitService.vorgabe(true));
        when(repo.istZuhause()).thenReturn(false);
        assertThat(service.vorgabeHier()).isSameAs(RuhezeitService.vorgabe(false));
    }
}
