package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die VERDRAHTUNG der drei Schweigen-Gründe im Dienst - rein, ohne Docker und
 * ohne Spring.
 *
 * <p>{@link RegisterWriteSilenceTest} beweist die SÄTZE, dieser Test beweist,
 * dass der Dienst den RICHTIGEN von ihnen wählt: die Lebendigkeit des Geräts von
 * JETZT und eine inzwischen eingetroffene verspätete Quittung fließen erst NACH
 * dem Timeout ein. Genau diese Wahl war der Kern des Produktionsvorfalls vom
 * 20.08.2026 - vorher trug jeder Ausgang denselben Satz, und „das Gerät hat nie
 * geantwortet" war von „das Gerät hat zu spät geantwortet" nicht zu
 * unterscheiden.
 */
class RegisterWriteReasonWiringTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-0000000000d1");

    private final DeviceRepository devices = mock(DeviceRepository.class);
    private final RegisterKnowledge knowledge = new RegisterKnowledge(new ObjectMapper());
    private final RegisterWriteTargets targets = mock(RegisterWriteTargets.class);
    private final RegisterWriteEventRepository journal = mock(RegisterWriteEventRepository.class);
    private final RegisterWritePublisher publisher = mock(RegisterWritePublisher.class);
    /** Der ECHTE Warteraum - die Verspätung ist genau seine Aussage. */
    private final RegisterWriteRegistry registry = new RegisterWriteRegistry();

    @SuppressWarnings("unchecked")
    private final ObjectProvider<RegisterWritePublisher> provider = mock(ObjectProvider.class);

    private RegisterWriteService service() {
        when(provider.getIfAvailable()).thenReturn(publisher);
        // Kurze Fristen: bewiesen wird die WAHL des Grundes, nicht die Geduld.
        return new RegisterWriteService(devices, knowledge, targets, registry, journal, provider,
                Duration.ofMillis(120), Duration.ofMillis(120), true);
    }

    private void deviceLastSeen(Instant lastSeen) {
        when(devices.findAll()).thenReturn(List.of(new DeviceDto(DEVICE, SITE, "edge-abcdefj",
                "inverter", "Deye SUN-30K", "online", lastSeen, Instant.now())));
    }

    private static RegisterWriteService.Command preview() {
        return new RegisterWriteService.Command(DEVICE, "primary", null, null, null, null,
                "holding", "0x00E7", null, null, null, null);
    }

    private static RegisterWriteService.Actor actor() {
        return new RegisterWriteService.Actor("sub-1", "demo", false);
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    /** (a) Der Auftrag ging nie hinaus - und die Anlage wird NICHT beschuldigt. */
    @Test
    void aFailedPublishIsBlamedOnVoltpilotAndLeavesNoJournalRow() throws Exception {
        TenantContext.set(TENANT);
        deviceLastSeen(Instant.now());
        doThrow(new IllegalStateException("broker weg")).when(publisher)
                .publish(any(), any(), any(), any(), any(), any(), any());

        assertThatThrownBy(() -> service().preview(SITE, preview(), actor()))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> {
                    ResponseStatusException r = (ResponseStatusException) e;
                    assertThat(r.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(r.getReason()).isEqualTo(RegisterWriteSilence.NOT_PUBLISHED);
                    assertThat(r.getReason()).contains("liegt an VoltPilot");
                });
        // Keine Anforderungs-Zeile über einen Auftrag, den es nie gab.
        verifyNoInteractions(journal);
    }

    /** (b) Das Gerät meldet sich nicht - das wird gesagt, samt Dauer. */
    @Test
    void aSilentStaleDeviceIsNamedInsteadOfAGenericTimeout() {
        TenantContext.set(TENANT);
        deviceLastSeen(Instant.now().minus(Duration.ofMinutes(20)));

        RegisterWriteService.Outcome out = service().preview(SITE, preview(), actor());
        assertThat(out.errorCode()).isEqualTo("timeout");
        assertThat(out.outcome()).isEqualTo(RegisterWriteResult.OUTCOME_UNKNOWN);
        assertThat(out.message()).contains("meldet sich seit 20 Minuten nicht mehr");
        // ⚠ Eine Vorschau ändert nichts und wird deshalb NICHT protokolliert.
        assertThat(out.mode()).isEqualTo(RegisterWriteResult.MODE_READ);
    }

    /**
     * (c) Der Fall des Vorfalls: das Gerät ANTWORTET, nur zu spät. Der nächste
     * Anlauf sagt das - und beschuldigt die Anlage ausdrücklich nicht.
     */
    @Test
    void aRememberedLateAnswerBecomesTheReasonOfTheNextAttempt() {
        TenantContext.set(TENANT);
        deviceLastSeen(Instant.now());
        // Ein vorheriger Anlauf hat aufgegeben; seine Quittung kam danach.
        registry.register("aaaa1111bbbb7777", DEVICE);
        registry.forget("aaaa1111bbbb7777");
        registry.complete(DEVICE, "aaaa1111bbbb7777", RegisterWriteResult.silent(
                "aaaa1111bbbb7777", RegisterWriteResult.MODE_READ, "egal"));

        RegisterWriteService.Outcome out = service().preview(SITE, preview(), actor());
        assertThat(out.message())
                .contains("zu spät")
                .contains("erneut versuchen")
                .doesNotContain("meldet sich seit");
    }

    /**
     * Ohne jeden Beleg für eine Verspätung wird auch keine behauptet - ein
     * verbundenes, aber stummes Gerät bekommt seinen eigenen Satz.
     */
    @Test
    void aLiveDeviceWithoutEvidenceGetsTheConnectedButSilentSentence() {
        TenantContext.set(TENANT);
        deviceLastSeen(Instant.now());

        RegisterWriteService.Outcome out = service().preview(SITE, preview(), actor());
        assertThat(out.message())
                .contains("Das Gerät ist verbunden")
                .doesNotContain("zu spät");
    }
}
