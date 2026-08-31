package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Die EINE Soll/Ist-Ableitung des Einheitsmodells - rein, ohne Docker.
 *
 * <p>Sie wird von der Kunden-Flaeche UND der Flotten-Sicht der Stufe 6 geteilt
 * ({@code AdminComponentFleetController}); ein zweiter Rechenweg waere genau die
 * Doppeldeutigkeit, gegen die das ganze Einheitsmodell gebaut ist. Deshalb
 * gehoert jede neue Antwort hierher, nicht in einen der zwei Aufrufer.
 *
 * <p>Zwei Befunde des Scouts {@code vp-portal-box-spiegel-s2} haben sie
 * erweitert: <b>L10</b> - eine Anlage mit mehreren Geraeten und ohne
 * hinterlegtes steuerndes Geraet bekommt GAR KEINEN Push - und <b>L1</b> - die
 * Box hat die Fassung gesehen und bewusst nichts angewandt. Beide ersetzen nur
 * die Urteile, die dadurch unehrlich wuerden.
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
        assertThat(ComponentService.syncStatus("r8", null, null, true)).isEqualTo("no_gateway_device");
        assertThat(ComponentService.syncStatus("r8", "r7", null, true)).isEqualTo("no_gateway_device");
    }

    @Test
    void whatRunsKeepsRunningEvenWithoutAReceiverForTheNextChange() {
        assertThat(ComponentService.syncStatus("r7", "r7", null, true)).isEqualTo("in_sync");
    }

    @Test
    void theNarrowFormsNeverInventTheReasonTheyCannotKnow() {
        // Der Flotten-Blick der Stufe 6 kennt das Empfaenger-Wissen nicht; er
        // muss deshalb bei „unbekannt" bleiben statt einen Grund zu behaupten.
        assertThat(ComponentService.syncStatus("r8", null))
                .isEqualTo(ComponentService.syncStatus("r8", null, null, false));
        // Den HALT kennt er dagegen (er steht als Spalte auf der Zeile), also
        // reicht ihm die drei-Argument-Form.
        assertThat(ComponentService.syncStatus("r8", "r7", "r8"))
                .isEqualTo(ComponentService.syncStatus("r8", "r7", "r8", false));
    }

    @Test
    void silenceIsUnknownAndAHoldDoesNotMakeAMissingSollJudgeable() {
        assertThat(ComponentService.syncStatus("r2", null, null)).isEqualTo("unreported");
        assertThat(ComponentService.syncStatus("r2", "  ", null)).isEqualTo("unreported");
        assertThat(ComponentService.syncStatus(null, "r2", null)).isEqualTo("unreported");
        // Auch ein GEMELDETER Halt macht ein fehlendes Soll nicht bewertbar.
        assertThat(ComponentService.syncStatus(null, "r1", "r2")).isEqualTo("unreported");
    }

    @Test
    void appliedEqualsComposedWinsOverEveryOtherAnswer() {
        assertThat(ComponentService.syncStatus("r2", "r2", null)).isEqualTo("in_sync");
        // Ein (alter) Halt daneben aendert daran nichts: was laeuft, gewinnt.
        assertThat(ComponentService.syncStatus("r2", "r2", "r1")).isEqualTo("in_sync");
    }

    /**
     * Befund L1: ohne diesen Zustand las sich der bewusste Halt der Box fuer
     * immer als „Aenderung unterwegs zur Box" - eine Behauptung ueber einen
     * Push, den die Box laengst beantwortet hat.
     */
    @Test
    void aDeliberateHoldOfThePendingRevisionReadsHeld() {
        assertThat(ComponentService.syncStatus("r3", "r1", "r3")).isEqualTo("held");
        // Auch ohne je etwas angewandt zu haben: die Box HAT gesprochen, also
        // ist „unbekannt" die falsche Antwort.
        assertThat(ComponentService.syncStatus("r3", null, "r3")).isEqualTo("held");
    }

    /**
     * ⚠ Der Halt gilt der Fassung, die er NENNT. Liegt inzwischen eine neuere
     * an, hat die Box sie noch gar nicht gesehen - dann ist „unterwegs" die
     * wahre Antwort, und einen alten Halt weiterzuschreiben waere die
     * Beruhigung, die dieses Haus nicht ausspricht.
     */
    @Test
    void aStaleHoldDoesNotCalmANewerRevision() {
        assertThat(ComponentService.syncStatus("r4", "r1", "r3")).isEqualTo("pending");
        assertThat(ComponentService.syncStatus("r4", "r1", null)).isEqualTo("pending");
    }

    /**
     * Die zwei neuen Antworten koennen faktisch nicht zugleich wahr sein: ohne
     * Empfaenger geht kein Push hinaus, den die Box halten koennte. Trifft
     * beides doch zusammen, gewinnt was das GERAET gesagt hat gegen das, was
     * wir aus den Stammdaten abgeleitet haben.
     */
    @Test
    void aReportedHoldBeatsTheInferredMissingReceiver() {
        assertThat(ComponentService.syncStatus("r9", "r1", "r9", true)).isEqualTo("held");
    }

    // --- Befund L8: die RUECKGABE der Autoritaet -----------------------------

    /**
     * Der behobene Befund: nach {@code revert-to-device} bleibt die alte
     * {@code device_component_apply}-Zeile stehen, waehrend jeder folgende Push
     * die Soll-Revision hochzaehlt - das Portal sagte dauerhaft „Aenderung
     * unterwegs zur Box" ueber eine Anlage, die es gar nicht mehr steuert.
     * Meldet die Box ihre Rueckgabe, ist jede Revisions-Aussage hinfaellig.
     */
    @Test
    void aReportedReturnOfAuthorityEndsEverySollIstClaim() {
        // Die Lage nach dem Revert: neues Soll, alte angewandte Revision.
        assertThat(ComponentService.syncStatus("r9", "r1", null, "box", false))
                .isEqualTo("box_managed");
        // Auch wenn die alte Zeile zufaellig gleich aussieht - „laeuft" waere
        // eine Aussage ueber ein Soll, dem diese Box nicht mehr folgt.
        assertThat(ComponentService.syncStatus("r9", "r9", null, "box", false))
                .isEqualTo("box_managed");
        // Und ohne Soll erst recht: die Box hat den Grund selbst genannt.
        assertThat(ComponentService.syncStatus(null, null, null, "box", false))
                .isEqualTo("box_managed");
        // Sie schlaegt auch den abgeleiteten fehlenden Empfaenger - was das
        // GERAET sagt gewinnt gegen das, was wir aus Stammdaten ableiten.
        assertThat(ComponentService.syncStatus("r9", null, null, "box", true))
                .isEqualTo("box_managed");
    }

    /**
     * ⚠ {@code null} heisst „die Box hat sich dazu nicht geaeussert" (eine
     * aeltere Box meldet den Block gar nicht) und darf NIE als „box" gelesen
     * werden - genau die sichere Richtung von {@code ComponentAuthority.of},
     * die hier falsch waere. Ebenso: solange die Box noch {@code portal}
     * meldet, ist ihre angewandte Revision die Wahrheit.
     */
    @Test
    void withoutAReportedReturnEveryVerdictIsByteForByteAsBefore() {
        assertThat(ComponentService.syncStatus("r9", "r1", null, null, false))
                .isEqualTo("pending");
        assertThat(ComponentService.syncStatus("r9", "r9", null, null, false))
                .isEqualTo("in_sync");
        assertThat(ComponentService.syncStatus("r9", null, null, null, true))
                .isEqualTo("no_gateway_device");
        // Eine Box, die den Push noch nicht gesehen hat, faehrt weiter den
        // Portal-Stand - und dass sie das sagt, ist die Wahrheit.
        assertThat(ComponentService.syncStatus("r9", "r9", null, "portal", false))
                .isEqualTo("in_sync");
        assertThat(ComponentService.syncStatus("r9", "r1", null, "portal", false))
                .isEqualTo("pending");
        // Ein Wort, das wir nicht kennen, ist keine Aussage.
        assertThat(ComponentService.syncStatus("r9", "r1", null, "irgendwas", false))
                .isEqualTo("pending");
    }

    /** Die schmaleren Formen behaupten die Autoritaet nie. */
    @Test
    void theNarrowerFormsNeverClaimAnAuthority() {
        assertThat(ComponentService.syncStatus("r9", "r1")).isEqualTo("pending");
        assertThat(ComponentService.syncStatus("r9", "r1", null)).isEqualTo("pending");
        assertThat(ComponentService.syncStatus("r9", "r1", null, false)).isEqualTo("pending");
    }
}
