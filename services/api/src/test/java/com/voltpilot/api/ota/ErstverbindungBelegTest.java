package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Die Zeile der Werkstatt-Seite „Beim ersten Verbinden“ / „Beim Kunden“ (Erstverbindung S3), rein. */
class ErstverbindungBelegTest {

    private static final Instant ZUGEWIESEN = Instant.parse("2026-11-16T09:42:40Z");
    private static final Instant BESTAETIGT = Instant.parse("2026-11-16T09:46:00Z");
    private static final String NEU = "edge-light-2026.11.13";

    private static BoxUpdateSicht.Sicht sicht(String phase, String release, Instant fertig) {
        return new BoxUpdateSicht.Sicht(phase, release, ZUGEWIESEN, fertig, false);
    }

    @Test
    @DisplayName("vor dem Verbinden: holt sich die heutige neueste Fassung selbst")
    void vorher() {
        assertThat(ErstverbindungBeleg.of(null, null, null, null, NEU))
                .isEqualTo(new ErstverbindungBeleg.Beleg(ErstverbindungBeleg.VORHER, NEU, null, null));
    }

    @Test
    @DisplayName("beim Kunden: läuft, fertig mit Zeit, schon aktuell")
    void beimKunden() {
        assertThat(ErstverbindungBeleg.of(sicht(BoxUpdateSicht.STARTET_NEU, NEU, null), null, null, null, null))
                .isEqualTo(new ErstverbindungBeleg.Beleg(ErstverbindungBeleg.LAEUFT, NEU, ZUGEWIESEN, null));
        assertThat(ErstverbindungBeleg.of(sicht(BoxUpdateSicht.FERTIG, NEU, BESTAETIGT), null, null, null, null))
                .isEqualTo(new ErstverbindungBeleg.Beleg(ErstverbindungBeleg.FERTIG, NEU, BESTAETIGT, null));
        assertThat(ErstverbindungBeleg.of(sicht(BoxUpdateSicht.KEINS, NEU, null), Erstverbindung.EREIGNIS_AKTUELL,
                NEU, null, null)).isEqualTo(new ErstverbindungBeleg.Beleg(ErstverbindungBeleg.AKTUELL, NEU, null, null));
    }

    @Test
    @DisplayName("nicht: mit dem Grund der Box, der Automatik oder der Sperre")
    void nicht() {
        String lader = "zu wenig freier Speicher zum Entpacken";
        assertThat(ErstverbindungBeleg.of(sicht(BoxUpdateSicht.SPAETER, NEU, null), null, null, lader, null))
                .isEqualTo(new ErstverbindungBeleg.Beleg(ErstverbindungBeleg.NICHT, NEU, ZUGEWIESEN, lader));
        assertThat(ErstverbindungBeleg.of(new BoxUpdateSicht.Sicht(BoxUpdateSicht.SPAETER, null, ZUGEWIESEN, null, false),
                Erstverbindung.EREIGNIS_AUFGEGEBEN, Erstverbindung.GRUND_FENSTER, null, null).grund())
                .isEqualTo(Erstverbindung.GRUND_FENSTER);
        assertThat(ErstverbindungBeleg.of(sicht(BoxUpdateSicht.KEINS, null, null), Erstverbindung.EREIGNIS_GESPERRT,
                BoxArt.GRUND_LIGHT_STUFE_1, null, null))
                .isEqualTo(new ErstverbindungBeleg.Beleg(ErstverbindungBeleg.NICHT, null, null, BoxArt.GRUND_LIGHT_STUFE_1));
    }

    @Test
    @DisplayName("verbunden, aber nicht von der Automatik: keine Zeile")
    void nichtVonDerAutomatik() {
        assertThat(ErstverbindungBeleg.of(sicht(BoxUpdateSicht.KEINS, null, null), null, null, null, NEU)).isNull();
    }
}
