package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The U0 shell-frame derivation (design vp-ems-ui-overhaul §2.1): the explicit
 * override wins; without one the existing {@code tenant.segment} derives the
 * default - B2C (self-registered households) -> endkunde, CI (admin-provisioned
 * commercial) -> betreiber. Pure unit, always runs.
 */
class BetriebsartTest {

    @Test
    void derivesFromSegmentWhenNoOverrideIsSet() {
        assertThat(Betriebsart.effective(null, "B2C")).isEqualTo("endkunde");
        assertThat(Betriebsart.effective(null, "CI")).isEqualTo("betreiber");
    }

    @Test
    void explicitOverrideWinsOverTheSegment() {
        // A mixed/commercial tenant flipped to the cockpit shell...
        assertThat(Betriebsart.effective("endkunde", "CI")).isEqualTo("endkunde");
        // ...and a household portfolio operator flipped to the fleet shell.
        assertThat(Betriebsart.effective("betreiber", "B2C")).isEqualTo("betreiber");
        // A redundant override is honored, not special-cased.
        assertThat(Betriebsart.effective("endkunde", "B2C")).isEqualTo("endkunde");
        assertThat(Betriebsart.effective("betreiber", "CI")).isEqualTo("betreiber");
    }

    @Test
    void garbageOverrideFallsBackToTheDerivation() {
        // The DB CHECK forbids other values; defensively they read as unset.
        assertThat(Betriebsart.effective("", "B2C")).isEqualTo("endkunde");
        assertThat(Betriebsart.effective("portfolio", "CI")).isEqualTo("betreiber");
    }

    @Test
    void unknownSegmentDefaultsToBetreiber() {
        // segment is NOT NULL + CHECK (CI|B2C); anything unexpected reads as
        // the commercial default, never the private cockpit.
        assertThat(Betriebsart.effective(null, "ENTERPRISE")).isEqualTo("betreiber");
        assertThat(Betriebsart.effective(null, null)).isEqualTo("betreiber");
    }
}
