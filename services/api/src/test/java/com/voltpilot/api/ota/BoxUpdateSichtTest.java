package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Was Kunde und Installateur über das Update ihrer Box sehen (Erstverbindung S2), rein. */
class BoxUpdateSichtTest {

    private static final Instant JETZT = Instant.parse("2026-11-16T09:44:00Z");
    private static final Instant ERSTE_MELDUNG = Instant.parse("2026-11-16T09:42:00Z");
    private static final Instant ZUGEWIESEN = Instant.parse("2026-11-16T09:42:40Z");
    private static final String ALT = "edge-light-2026.11.10-9b37439a02c1";
    private static final String NEU = "edge-light-2026.11.13";
    private static final BoxUpdateSicht.Ziel AUTOMATIK = new BoxUpdateSicht.Ziel(NEU, Erstverbindung.URHEBER,
            ZUGEWIESEN);

    private static RolloutStates.Reported box(String laeuft, String state, String verdict) {
        return new RolloutStates.Reported(laeuft, laeuft, NEU, state, verdict, null, null, JETZT, JETZT);
    }

    private static BoxUpdateSicht.Sicht sicht(BoxUpdateSicht.Ziel ziel, RolloutStates.Reported gemeldet) {
        return BoxUpdateSicht.of(ziel, null, null, ERSTE_MELDUNG, gemeldet, null, JETZT);
    }

    @Test
    @DisplayName("gerade gemeldet, die Automatik hat noch nicht entschieden: prüft")
    void prueft() {
        assertThat(BoxUpdateSicht.of(null, null, null, ERSTE_MELDUNG, box(ALT, "idle", null), null, JETZT))
                .isEqualTo(new BoxUpdateSicht.Sicht(BoxUpdateSicht.PRUEFT, null, ERSTE_MELDUNG, null, false));
    }

    @Test
    @DisplayName("das Update der Automatik: lädt, startet neu, prüft, fertig")
    void phasen() {
        assertThat(sicht(AUTOMATIK, box(ALT, "idle", "ok")).phase()).isEqualTo(BoxUpdateSicht.LAEDT);
        assertThat(sicht(AUTOMATIK, box(ALT, "downloading", "ok"))).isEqualTo(
                new BoxUpdateSicht.Sicht(BoxUpdateSicht.LAEDT, NEU, ZUGEWIESEN, null, true));
        assertThat(sicht(AUTOMATIK, box(ALT, "applying", "ok")).phase()).isEqualTo(BoxUpdateSicht.STARTET_NEU);
        var stumm = new RolloutStates.Reported(ALT, ALT, NEU, "applying", "ok", null, null,
                JETZT.minusSeconds(90), JETZT.minusSeconds(90));
        assertThat(sicht(AUTOMATIK, stumm).phase()).as("im Neustart still").isEqualTo(BoxUpdateSicht.STARTET_NEU);
        assertThat(sicht(AUTOMATIK, box(NEU + "-1a2b3c4d5e6f", "self_test", "ok")).phase())
                .isEqualTo(BoxUpdateSicht.PRUEFT_BOX);
        Instant bestaetigt = JETZT.minusSeconds(20);
        var fertig = BoxUpdateSicht.of(AUTOMATIK, null, null, ERSTE_MELDUNG,
                box(NEU + "-1a2b3c4d5e6f", "idle", "ok"), bestaetigt, JETZT);
        assertThat(fertig).isEqualTo(new BoxUpdateSicht.Sicht(BoxUpdateSicht.FERTIG, NEU, ZUGEWIESEN,
                bestaetigt, false));
    }

    @Test
    @DisplayName("zurückgenommen, fehlgeschlagen, abgelehnt, zurückgestellt, gesperrt, aufgegeben: kommt später")
    void spaeter() {
        for (var r : java.util.List.of(box(ALT, "rolled_back", "ok"), box(ALT, "failed", "ok"),
                box(ALT, "idle", "rejected"), box(ALT, "idle", "deferred"))) {
            assertThat(sicht(AUTOMATIK, r).phase()).isEqualTo(BoxUpdateSicht.SPAETER);
        }
        var gesperrt = new RolloutStates.Reported(ALT, ALT, NEU, "idle", "ok", "Neutral-Zeit", "neutral_time",
                JETZT, JETZT);
        assertThat(sicht(AUTOMATIK, gesperrt).phase()).isEqualTo(BoxUpdateSicht.SPAETER);
        assertThat(BoxUpdateSicht.of(null, Erstverbindung.EREIGNIS_AUFGEGEBEN, null, ERSTE_MELDUNG,
                box(ALT, "idle", null), null, JETZT).phase()).isEqualTo(BoxUpdateSicht.SPAETER);
    }

    @Test
    @DisplayName("kein Update fällig: schon aktuell (mit Fassung), Stufe 1, Schalter aus, Bestandsbox, Nachlauf vorbei")
    void keins() {
        assertThat(BoxUpdateSicht.of(null, Erstverbindung.EREIGNIS_AKTUELL, NEU, ERSTE_MELDUNG,
                box(NEU, "idle", null), null, JETZT))
                .isEqualTo(new BoxUpdateSicht.Sicht(BoxUpdateSicht.KEINS, NEU, null, null, false));
        for (String e : java.util.List.of(Erstverbindung.EREIGNIS_GESPERRT, Erstverbindung.EREIGNIS_AUS)) {
            assertThat(BoxUpdateSicht.of(null, e, "Grund aus dem Betrieb", ERSTE_MELDUNG, box(ALT, "idle", null),
                    null, JETZT)).as("kein Grund für den Kunden")
                    .isEqualTo(new BoxUpdateSicht.Sicht(BoxUpdateSicht.KEINS, null, null, null, false));
        }
        assertThat(BoxUpdateSicht.of(null, null, null, null, box(ALT, "idle", null), null, JETZT).phase())
                .as("Bestandsbox").isEqualTo(BoxUpdateSicht.KEINS);
        assertThat(BoxUpdateSicht.of(null, null, null, ERSTE_MELDUNG, box(ALT, "idle", null), null,
                ERSTE_MELDUNG.plus(Erstverbindung.NACHLAUF).plusSeconds(1)).phase()).isEqualTo(BoxUpdateSicht.KEINS);
    }

    @Test
    @DisplayName("ein Update von Hand ist keine Station - aber die Gerätesuche wartet auf es")
    void vonHand() {
        var hand = new BoxUpdateSicht.Ziel(NEU, "7a1f-admin", ZUGEWIESEN);
        var s = BoxUpdateSicht.of(hand, null, null, null, box(ALT, "applying", "ok"), null, JETZT);
        assertThat(s.phase()).isEqualTo(BoxUpdateSicht.KEINS);
        assertThat(s.updateLaeuft()).isTrue();
    }

    @Test
    @DisplayName("updateLaeuft: lädt, wendet an, prüft; noch nicht reagiert nur bis zur Obergrenze; nie bei Sperre oder Ende")
    void updateLaeuft() {
        assertThat(sicht(AUTOMATIK, box(ALT, "idle", null)).updateLaeuft()).as("gerade zugewiesen").isTrue();
        assertThat(BoxUpdateSicht.of(AUTOMATIK, null, null, ERSTE_MELDUNG, box(ALT, "idle", null), null,
                ZUGEWIESEN.plus(BoxUpdateSicht.OBERGRENZE).plus(Duration.ofSeconds(1))).updateLaeuft())
                .as("nach der Obergrenze ohne Reaktion").isFalse();
        assertThat(sicht(AUTOMATIK, box(ALT, "self_test", "ok")).updateLaeuft()).isTrue();
        assertThat(sicht(AUTOMATIK, box(ALT, "rolled_back", "ok")).updateLaeuft()).isFalse();
        assertThat(sicht(AUTOMATIK, box(NEU, "idle", "ok")).updateLaeuft()).as("fertig").isFalse();
        assertThat(sicht(null, box(ALT, "idle", null)).updateLaeuft()).as("ohne Zuweisung").isFalse();
    }
}
