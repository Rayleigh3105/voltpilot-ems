package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Ableitung „was ist aus der Freigabe geworden" - rein, ohne Docker.
 *
 * <p>Was hier festgenagelt wird, ist vor allem die EHRLICHKEIT: eine Freigabe,
 * die niemand abgeholt hat, muss das sagen; „abgeholt" wird nur BELEGT
 * behauptet; und über eine Freigabe, die es nicht gibt, wird gar nichts
 * behauptet.
 */
class ApplyApprovalTest {

    private static final Instant T0 = Instant.parse("2026-08-05T09:00:00Z");

    @Test
    @DisplayName("ohne Freigabe wird nichts behauptet")
    void noApprovalNoStatement() {
        assertThat(ApplyApproval.derive(null, T0, "deferred", "edge-2026.07.9", T0)).isNull();
        assertThat(ApplyApproval.derive("edge-2026.08.1", null, "deferred", null, T0)).isNull();
        assertThat(ApplyApproval.derive("  ", T0, null, null, T0)).isNull();
    }

    @Test
    @DisplayName("frisch erteilt: sie wartet auf den nächsten Takt des Geräts")
    void freshlyIssued() {
        ApplyApproval.Verdict v = ApplyApproval.derive("edge-2026.08.1", T0, "deferred",
                "edge-2026.07.9", T0.plusSeconds(30));
        assertThat(v.state()).isEqualTo(ApplyApproval.ERTEILT);
        assertThat(v.reason()).contains("Takt");
    }

    @Test
    @DisplayName("abgeholt wird nur BELEGT behauptet - nie geglaubt")
    void onlyProvenPickup() {
        // (a) Das Gerät meldet, dass es gerade anwendet.
        assertThat(ApplyApproval.derive("edge-2026.08.1", T0, "applying", "edge-2026.07.9",
                T0.plusSeconds(60)).state()).isEqualTo(ApplyApproval.ABGEHOLT);
        // (b) Oder es läuft nachweislich auf dem freigegebenen Stand - inklusive
        //     der Build-Suffix-Form, die `releaseIsRunning` kennt.
        assertThat(ApplyApproval.derive("edge-2026.08.1", T0, "idle", "edge-2026.08.1-a1b2c3",
                T0.plusSeconds(60)).state()).isEqualTo(ApplyApproval.ABGEHOLT);
        // (c) Ein Rückrollen ist ebenfalls eine ABGEHOLTE Freigabe: sie hat
        //     gewirkt, das Ergebnis ist nur ein anderes. Was daraus wird, sagt
        //     der GERÄTE-Zustand (`zurueckgerollt`), nicht dieser Block.
        assertThat(ApplyApproval.derive("edge-2026.08.1", T0, "rolling_back", null,
                T0.plusSeconds(60)).state()).isEqualTo(ApplyApproval.ABGEHOLT);
        // (d) Ein anderes laufendes Release ist KEIN Beleg.
        assertThat(ApplyApproval.derive("edge-2026.08.1", T0, "idle", "edge-2026.07.9",
                T0.plusSeconds(60)).state()).isEqualTo(ApplyApproval.ERTEILT);
    }

    @Test
    @DisplayName("verfallen: das Fenster ist zu und nichts ist passiert - das MUSS sichtbar sein")
    void expiredUnconsumed() {
        ApplyApproval.Verdict v = ApplyApproval.derive("edge-2026.08.1", T0, "deferred",
                "edge-2026.07.9", T0.plus(ApplyApproval.WINDOW).plusSeconds(1));
        assertThat(v.state()).isEqualTo(ApplyApproval.VERFALLEN);
        // Der Grund NENNT die häufigste Ursache und den Weg weiter - eine rote
        // Zeile ohne Grund wäre nur ein Alarm.
        assertThat(v.reason()).contains("offline").contains("erneut");
    }

    @Test
    @DisplayName("eine abgeholte Freigabe bleibt abgeholt, auch nach Ablauf des Fensters")
    void pickedUpBeatsExpiry() {
        assertThat(ApplyApproval.derive("edge-2026.08.1", T0, "idle", "edge-2026.08.1",
                T0.plus(ApplyApproval.WINDOW).plusSeconds(600)).state())
                .isEqualTo(ApplyApproval.ABGEHOLT);
    }

    @Test
    @DisplayName("das Fenster ist genau 15 Minuten und schließt EXKLUSIV")
    void windowBoundary() {
        assertThat(ApplyApproval.WINDOW.toMinutes()).isEqualTo(15);
        // Eine Sekunde vor Ablauf gilt sie noch …
        assertThat(ApplyApproval.isOpen(T0, T0.plus(ApplyApproval.WINDOW).minusSeconds(1)))
                .isTrue();
        // … exakt auf der Grenze nicht mehr (dieselbe Regel wie auf dem Gerät:
        // im Zweifel gilt sie NICHT).
        assertThat(ApplyApproval.isOpen(T0, T0.plus(ApplyApproval.WINDOW))).isFalse();
        assertThat(ApplyApproval.isOpen(null, T0)).isFalse();
    }
}
