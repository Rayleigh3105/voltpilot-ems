package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * L10 (Scout {@code vp-portal-box-spiegel-s2} §4): eine Anlage mit mehreren
 * Geraeten und ohne hinterlegtes steuerndes Geraet bekommt GAR KEINEN Push -
 * und sagte das dem Kunden bis hierher nicht („Stand auf dem Gerät unbekannt").
 */
class ComponentSyncStatusTest {

    @Test
    void theThreeKnownJudgementsAreUnchanged() {
        assertThat(ComponentService.syncStatus("r7", "r7")).isEqualTo("in_sync");
        assertThat(ComponentService.syncStatus("r8", "r7")).isEqualTo("pending");
        assertThat(ComponentService.syncStatus("r8", null)).isEqualTo("unreported");
        assertThat(ComponentService.syncStatus(null, "r7")).isEqualTo("unreported");
        assertThat(ComponentService.syncStatus("r8", "  ")).isEqualTo("unreported");
    }

    @Test
    void aSiteWithoutAReceiverSaysSoInsteadOfClaimingItIsUnknownOrOnItsWay() {
        assertThat(ComponentService.syncStatus("r8", null, true)).isEqualTo("no_gateway_device");
        assertThat(ComponentService.syncStatus("r8", "r7", true)).isEqualTo("no_gateway_device");
    }

    @Test
    void whatRunsKeepsRunningEvenWithoutAReceiverForTheNextChange() {
        assertThat(ComponentService.syncStatus("r7", "r7", true)).isEqualTo("in_sync");
    }

    @Test
    void theTwoArgumentFormNeverInventsTheReason() {
        // Der Flotten-Blick der Stufe 6 kennt das Empfaenger-Wissen nicht; er
        // muss deshalb bei „unbekannt" bleiben statt einen Grund zu behaupten.
        assertThat(ComponentService.syncStatus("r8", null))
                .isEqualTo(ComponentService.syncStatus("r8", null, false));
    }
}
