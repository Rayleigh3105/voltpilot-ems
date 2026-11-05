package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.BoxVerlaufRepository.Zeile;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Die Übersetzung des Verlaufs je Box, rein (Geräte &amp; Updates G3). */
class BoxVerlaufTest {

    private static final Instant AM = Instant.parse("2026-11-05T15:50:00Z");
    private static final UUID LAUF = UUID.randomUUID();

    private static Zeile portal(String event, String detail) {
        return new Zeile(AM, "portal", event, detail, null, null, null, "sub-admin", LAUF);
    }

    private static Zeile box(String art, String wert, String vorher, String ziel, String grund) {
        return new Zeile(AM, "box", art, wert, vorher, ziel, grund, null, null);
    }

    @Test
    @DisplayName("Portal: angefragt (mit Release und Person), zurückgezogen, erneut gesendet, entfernt")
    void portal() {
        var a = BoxVerlauf.of(portal("target_assigned", "edge-light-2026.11.4"));
        assertThat(a).isEqualTo(new BoxVerlauf.Eintrag(AM, "portal", BoxVerlauf.ANGEFRAGT,
                "edge-light-2026.11.4", null, null, "sub-admin", LAUF));
        assertThat(BoxVerlauf.of(portal("target_reverted", null)).art()).isEqualTo(BoxVerlauf.ZURUECKGEZOGEN);
        assertThat(BoxVerlauf.of(portal("target_republished", "edge-2026.10.7")))
                .extracting(BoxVerlauf.Eintrag::art, BoxVerlauf.Eintrag::release)
                .containsExactly(BoxVerlauf.ERNEUT_GESENDET, "edge-2026.10.7");
        assertThat(BoxVerlauf.of(portal("target_cleared_on_unclaim", null)).art())
                .isEqualTo(BoxVerlauf.ENTFERNT);
        assertThat(BoxVerlauf.of(portal("device_state", "laedt")))
                .as("der abgeleitete Zustand ist kein Fakt der Box").isNull();
    }

    @Test
    @DisplayName("Box: neuer Stand (erste Meldung ohne vorher), Prüfurteile, Fehlschlag und Rücknahme")
    void box() {
        var erste = BoxVerlauf.of(box("stand", "edge-light-2026.11.0", null, null, null));
        assertThat(erste.art()).isEqualTo(BoxVerlauf.STAND);
        assertThat(erste.release()).isEqualTo("edge-light-2026.11.0");
        assertThat(erste.vorher()).as("erste Meldung").isNull();
        assertThat(BoxVerlauf.of(box("stand", "edge-2026.10.7-c39b18d9c2a4", "edge-2026.10.5", null, null))
                .vorher()).isEqualTo("edge-2026.10.5");

        assertThat(BoxVerlauf.of(box("urteil", "ok", null, "edge-2026.10.7", null)))
                .extracting(BoxVerlauf.Eintrag::art, BoxVerlauf.Eintrag::release)
                .containsExactly(BoxVerlauf.ANGENOMMEN, "edge-2026.10.7");
        var abgelehnt = BoxVerlauf.of(box("urteil", "rejected", null, "edge-light-2026.11.4",
                "Das Vertrauens-Set oder seine Signatur fehlt."));
        assertThat(abgelehnt.art()).isEqualTo(BoxVerlauf.ABGELEHNT);
        assertThat(abgelehnt.grund()).contains("Vertrauens-Set");
        assertThat(BoxVerlauf.of(box("urteil", "deferred", null, "edge-2026.10.7", "gilt nicht")).art())
                .isEqualTo(BoxVerlauf.ZURUECKGESTELLT);

        assertThat(BoxVerlauf.of(box("zustand", "failed", null, "edge-2026.11.0", "Pull scheiterte")).art())
                .isEqualTo(BoxVerlauf.FEHLGESCHLAGEN);
        assertThat(BoxVerlauf.of(box("zustand", "rolled_back", null, "edge-2026.11.0", "Selbsttest rot")))
                .extracting(BoxVerlauf.Eintrag::art, BoxVerlauf.Eintrag::release, BoxVerlauf.Eintrag::grund)
                .containsExactly(BoxVerlauf.ZURUECKGENOMMEN, "edge-2026.11.0", "Selbsttest rot");
    }

    @Test
    @DisplayName("ein unbekanntes Wort wird ausgelassen, nie geraten")
    void unbekannt() {
        assertThat(BoxVerlauf.of(box("urteil", "vielleicht", null, "x", null))).isNull();
        assertThat(BoxVerlauf.of(box("zustand", "applying", null, "x", null))).isNull();
        assertThat(BoxVerlauf.of(box("neu", "x", null, null, null))).isNull();
        assertThat(BoxVerlauf.of(new Zeile(AM, "fremd", "stand", "x", null, null, null, null, null))).isNull();
    }
}
