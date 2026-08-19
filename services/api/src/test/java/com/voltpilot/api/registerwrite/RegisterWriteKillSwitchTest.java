package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der plattformweite NOT-AUS {@code voltpilot.register-write.enabled} - rein,
 * ohne Docker und ohne Spring.
 *
 * <p>Er existierte seit Stufe 1, war aber von KEINEM Test berührt und hing als
 * {@code @ConditionalOnProperty} an der Route: abgeschaltet verschwanden die
 * Routen und antworteten mit einem nackten 404. Stufe 3 macht ihn zum echten
 * Hebel, weil das GERÄTE-Flag seit dem Kunden-Release per Vorgabe AN steht
 * (D2) - er ist damit der einzige plattformweite Schalter, den es noch gibt.
 *
 * <p>Vier Aussagen hält dieser Test fest:
 * <ol>
 *   <li>abgeschaltet refüsieren BEIDE schreibenden Schritte mit <b>503</b> und
 *       einem deutschen Grund, der die PLATTFORM nennt und nicht die Anlage;</li>
 *   <li>die Prüfung ist die ERSTE Anweisung - kein Ziel wird aufgelöst, keine
 *       Runde zum Broker gedreht, keine Journal-Zeile geschrieben (bewiesen
 *       daran, dass KEIN Mitspieler auch nur berührt wird);</li>
 *   <li>der VERLAUF bleibt trotzdem lesbar - das Schreiben abzuschalten darf
 *       die Papier-Spur nie verstecken;</li>
 *   <li>eingeschaltet ist der Weg zeichengleich offen (er läuft weiter, bis er
 *       am fehlenden Veröffentlicher scheitert - also NACH dem Tor).</li>
 * </ol>
 */
class RegisterWriteKillSwitchTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000a1");

    private final DeviceRepository devices = mock(DeviceRepository.class);
    private final RegisterKnowledge knowledge = mock(RegisterKnowledge.class);
    private final RegisterWriteTargets targets = mock(RegisterWriteTargets.class);
    private final RegisterWriteRegistry registry = mock(RegisterWriteRegistry.class);
    private final RegisterWriteEventRepository journal = mock(RegisterWriteEventRepository.class);
    @SuppressWarnings("unchecked")
    private final ObjectProvider<RegisterWritePublisher> publisher = mock(ObjectProvider.class);

    private RegisterWriteService service(boolean enabled) {
        return new RegisterWriteService(devices, knowledge, targets, registry, journal, publisher,
                Duration.ofSeconds(20), Duration.ofSeconds(45), enabled);
    }

    private static RegisterWriteService.Command command() {
        return new RegisterWriteService.Command(null, "primary", null, null, null, null,
                "holding", "0x00E7", "7000", 3300, null, "Freigabe des Netzbetreibers");
    }

    private static RegisterWriteService.Actor actor() {
        return new RegisterWriteService.Actor("sub-1", "demo", false);
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void theSwitchRefusesBothWritingStepsWithAGermanReasonAndTouchesNothing() {
        TenantContext.set(TENANT);
        RegisterWriteService off = service(false);

        for (Runnable step : List.<Runnable>of(
                () -> off.preview(SITE, command(), actor()),
                () -> off.write(SITE, command(), actor()))) {
            assertThatThrownBy(step::run)
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        // 503, NIE 404: ein 404 ist auf diesem Pfad die Antwort
                        // des Mandanten-Zauns auf eine FREMDE Anlage. Die zwei
                        // Zustände dürfen nie gleich aussehen.
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                        assertThat(e.getReason()).contains("Plattform");
                        assertThat(e.getReason()).contains("nicht an Ihrer Anlage");
                    });
        }

        // Das Tor steht VOR allem anderen: nichts wird aufgelöst, nichts
        // veröffentlicht, nichts protokolliert.
        verifyNoInteractions(devices, knowledge, targets, registry, journal, publisher);
    }

    @Test
    void theJournalStaysReadableWhileWritingIsOff() {
        RegisterWriteService off = service(false);
        when(journal.recent(SITE, null, 50)).thenReturn(List.of());

        assertThat(off.history(SITE, null, 50)).isEmpty();
    }

    @Test
    void switchedOnTheGateIsPassedAndTheRefusalComesFromFurtherDown() {
        TenantContext.set(TENANT);
        // Kein Veröffentlicher verdrahtet - die Ablehnung KOMMT dann, aber aus
        // dem Transport, nicht aus dem Tor. Genau so ist bewiesen, dass das Tor
        // eingeschaltet nichts verweigert.
        when(publisher.getIfAvailable()).thenReturn(null);
        when(devices.findAll()).thenReturn(List.of());

        assertThatThrownBy(() -> service(true).preview(SITE, command(), actor()))
                .isInstanceOfSatisfying(ResponseStatusException.class, e ->
                        assertThat(e.getReason()).doesNotContain("Plattform"));
    }
}
