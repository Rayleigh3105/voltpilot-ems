package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.consumers.ConsumerRequirementLedger.EnergyConfirmation;
import org.junit.jupiter.api.Test;

/**
 * The D3 confirmation-level mapping (Bestätigungshierarchie §9.4) the ledger
 * writer derives from the consumer's confirmation channel - the pure half of
 * the Stufe-2-vs-3 distinction the Shelly driver feeds: a metering Shelly
 * (1PM/Plug-S class) is bound with the power_kw channel and lands at
 * INTEGRATED (Stufe 2, runtime exact + energy integrated from real
 * telemetry); a bare relay is bound with relay_state and lands at ASSUMED
 * (Stufe 3, runtime confirmed, energy "angenommen" = Nennleistung x Zeit,
 * labeled so); an unbound consumer has no channel and lands at NONE (never a
 * claimed fulfilment).
 */
class ConsumerRequirementLedgerWriterTest {

    @Test
    void confirmationChannelMapsOntoTheD3Hierarchy() {
        // Stufe 1: a real energy counter measures.
        assertThat(ConsumerRequirementLedgerWriter.levelFor("energy_kwh"))
                .isEqualTo(EnergyConfirmation.MEASURED);
        // Stufe 2: power telemetry integrates (the metering Shelly / go-e).
        assertThat(ConsumerRequirementLedgerWriter.levelFor("power_kw"))
                .isEqualTo(EnergyConfirmation.INTEGRATED);
        // Stufe 3: a relay/state readback only confirms runtime - the energy
        // is honestly "angenommen" (the non-metering Shelly).
        assertThat(ConsumerRequirementLedgerWriter.levelFor("relay_state"))
                .isEqualTo(EnergyConfirmation.ASSUMED);
        // Stufe 4: no channel confirms nothing - never "erfüllt".
        assertThat(ConsumerRequirementLedgerWriter.levelFor(null))
                .isEqualTo(EnergyConfirmation.NONE);
        assertThat(ConsumerRequirementLedgerWriter.levelFor("  "))
                .isEqualTo(EnergyConfirmation.NONE);
    }
}
