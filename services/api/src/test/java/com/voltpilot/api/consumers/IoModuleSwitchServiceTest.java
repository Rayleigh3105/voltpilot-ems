package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeResult;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Ein/Aus eines I/O-Modul-Ausgangs: der Vertrags-Transport reist mit, und das
 * Ergebnis nennt den ZURÜCKGELESENEN Zustand, nie den Befehl.
 */
class IoModuleSwitchServiceTest {

    @Test
    void theSetOpIsAnIoModuleCoilWithoutTestValuesAndOldCallersKeepModbus() {
        ProbePublisher.SwitchOp io = ProbePublisher.SwitchOp.ioSet("192.168.3.50", 502, 1, 5, true);
        assertThat(io.op()).isEqualTo("switch_set");
        assertThat(io.effectiveTransport()).isEqualTo("ebyte_modbus_tcp");
        assertThat(io.address()).isEqualTo(4);
        assertThat(io.setValue()).isEqualTo(1);
        assertThat(io.ttlSeconds()).isNull();
        ProbePublisher.SwitchOp selbstbau = new ProbePublisher.SwitchOp("switch_test", "schalten",
                "10.0.7.19", 502, 2, "coil", 0, 5, 1, 0, 30, 0);
        assertThat(selbstbau.effectiveTransport()).isEqualTo("modbus_tcp");
        assertThat(selbstbau.setValue()).isNull();
    }

    @Test
    void aConfirmedSwitchNamesTheReadBackState() {
        ProbeResult r = new ProbeResult("r1", null, null, List.of(new ProbeResult.OpResult(
                "ausgang", true, null, null, null, null, null, null,
                new ProbeResult.Switched(1, null, 1, null))));
        IoModuleSwitchService.Outcome o = IoModuleSwitchService.outcome(5, true, r);
        assertThat(o.ok()).isTrue();
        assertThat(o.state()).isTrue();
        assertThat(o.message()).isEqualTo("Ausgang DO5 ist eingeschaltet.");
    }

    @Test
    void aDeviceThatDidNotFollowIsReportedHonestly() {
        ProbeResult r = new ProbeResult("r1", null, null, List.of(new ProbeResult.OpResult(
                "ausgang", true, null, null, null, null, null, null,
                new ProbeResult.Switched(1, null, 0, null))));
        IoModuleSwitchService.Outcome o = IoModuleSwitchService.outcome(2, true, r);
        assertThat(o.state()).isFalse();
        assertThat(o.message()).contains("meldet den Ausgang als AUS");
    }

    @Test
    void aRefusalOrTimeoutCarriesTheReasonAndNeverPromisesAnAutoOff() {
        ProbeResult refused = new ProbeResult("r1", null, null, List.of(new ProbeResult.OpResult(
                "ausgang", false, null, null, null, "invalid_request",
                "Ausgang DO3 gehört zum Verbraucher „Heizstab“ - bitte dort per Handeingriff schalten.")));
        assertThat(IoModuleSwitchService.outcome(3, true, refused).message()).contains("Heizstab");
        ProbeResult timeout = new ProbeResult("r2", "timeout",
                "Die Anlage hat nicht rechtzeitig geantwortet. Falls das Gerät doch "
                        + "geschaltet hat, fällt es von selbst wieder zurück.", List.of());
        IoModuleSwitchService.Outcome t = IoModuleSwitchService.outcome(3, true, timeout);
        assertThat(t.ok()).isFalse();
        assertThat(t.state()).isNull();
        assertThat(t.message()).doesNotContain("von selbst");
    }
}
