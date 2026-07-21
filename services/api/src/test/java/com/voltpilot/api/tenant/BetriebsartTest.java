package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The U0 shell-frame derivation (design vp-ems-ui-overhaul §2.1, hardened by
 * the pre-deploy audit HIGH-1): ONLY an explicit override picks a frame. An
 * unset override is {@code null} = unknown, so the portal keeps the pre-U0
 * site-count heuristic and no existing tenant's shell changes on deploy.
 * Pure unit, always runs.
 */
class BetriebsartTest {

    @Test
    void anUnsetOverrideIsUnknownAndNeverDerivedFromTheSegment() {
        // HIGH-1: segment defaults to 'CI' for every admin-provisioned tenant,
        // so deriving from it would flip existing single-plant customers into
        // the operator Portfolio shell. Unknown -> the portal derives from scale.
        assertThat(Betriebsart.effective(null, "CI")).isNull();
        assertThat(Betriebsart.effective(null, "B2C")).isNull();
        assertThat(Betriebsart.effective(null, null)).isNull();
        assertThat(Betriebsart.effective(null, "ENTERPRISE")).isNull();
    }

    @Test
    void explicitOverrideWinsRegardlessOfTheSegment() {
        // A mixed/commercial tenant flipped to the cockpit shell...
        assertThat(Betriebsart.effective("endkunde", "CI")).isEqualTo("endkunde");
        // ...and a household portfolio operator flipped to the fleet shell.
        assertThat(Betriebsart.effective("betreiber", "B2C")).isEqualTo("betreiber");
        assertThat(Betriebsart.effective("endkunde", "B2C")).isEqualTo("endkunde");
        assertThat(Betriebsart.effective("betreiber", "CI")).isEqualTo("betreiber");
    }

    @Test
    void garbageOverrideReadsAsUnset() {
        // The DB CHECK forbids other values; defensively they read as unset.
        assertThat(Betriebsart.effective("", "B2C")).isNull();
        assertThat(Betriebsart.effective("portfolio", "CI")).isNull();
    }
}
