package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeResult;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Test-Schalten eines I/O-Modul-Ausgangs: der Vertrags-Transport reist mit,
 * und das Ergebnis nennt den ZURÜCKGELESENEN Zustand, nie den Befehl.
 */
class IoModuleSwitchServiceTest {

    @Test
    void theSwitchOpCarriesTheIoModuleTransportAndOldCallersKeepModbus() {
        ProbePublisher.SwitchOp io = new ProbePublisher.SwitchOp("switch_test", "ausgang",
                "192.168.3.50", 502, 1, "coil", 4, 5, 1, 0, 120, null, "ebyte_modbus_tcp");
        ProbePublisher.SwitchOp selbstbau = new ProbePublisher.SwitchOp("switch_test", "schalten",
                "10.0.7.19", 502, 2, "coil", 0, 5, 1, 0, 30, 0);
        assertThat(io.effectiveTransport()).isEqualTo("ebyte_modbus_tcp");
        assertThat(selbstbau.effectiveTransport()).isEqualTo("modbus_tcp");
    }

    @Test
    void aConfirmedSwitchOnNamesTheAutomaticOff() {
        ProbeResult r = new ProbeResult("r1", null, null, List.of(new ProbeResult.OpResult(
                "ausgang", true, null, null, null, null, null, null,
                new ProbeResult.Switched(1, 120, 1, null))));
        IoModuleSwitchService.Outcome o = IoModuleSwitchService.outcome(5, true, r);
        assertThat(o.ok()).isTrue();
        assertThat(o.state()).isTrue();
        assertThat(o.offAfterSeconds()).isEqualTo(120);
        assertThat(o.message()).contains("DO5").contains("120 Sekunden");
    }

    @Test
    void aDeviceThatDidNotFollowIsReportedHonestly() {
        ProbeResult r = new ProbeResult("r1", null, null, List.of(new ProbeResult.OpResult(
                "ausgang", true, null, null, null, null, null, null,
                new ProbeResult.Switched(1, 120, 0, null))));
        IoModuleSwitchService.Outcome o = IoModuleSwitchService.outcome(2, true, r);
        assertThat(o.state()).isFalse();
        assertThat(o.message()).contains("meldet den Ausgang als AUS");
    }

    @Test
    void aRefusalOrTimeoutCarriesTheBoxReason() {
        ProbeResult refused = new ProbeResult("r1", null, null, List.of(new ProbeResult.OpResult(
                "ausgang", false, null, null, null, "invalid_request",
                "Ausgang DO3 gehört zum Verbraucher „Heizstab“ - bitte dort per Handeingriff schalten.")));
        assertThat(IoModuleSwitchService.outcome(3, true, refused).message()).contains("Heizstab");
        ProbeResult timeout = new ProbeResult("r2", "timeout",
                "Die Anlage hat nicht rechtzeitig geantwortet.", List.of());
        IoModuleSwitchService.Outcome t = IoModuleSwitchService.outcome(3, true, timeout);
        assertThat(t.ok()).isFalse();
        assertThat(t.state()).isNull();
    }
}
