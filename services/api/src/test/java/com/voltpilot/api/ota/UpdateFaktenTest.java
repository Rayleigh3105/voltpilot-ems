package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die drei Fakten einer Anfrage, rein und ohne Docker (Geräte &amp; Updates G2):
 * angefragt (Portal), angenommen (Box), bestätigt (Box) - nie vermischt.
 */
class UpdateFaktenTest {

    private static final Instant NOW = Instant.parse("2026-11-05T10:00:00Z");
    private static final Instant ANGEFRAGT = NOW.minus(Duration.ofMinutes(40));
    private static final String ZIEL = "edge-2026.11.0";
    private static final UpdateFakten.Anfrage ANFRAGE =
            new UpdateFakten.Anfrage(ZIEL, 59, ANGEFRAGT, "sub-admin");

    private static UpdateFakten.Meldung meldung(String ziel, String urteil, Instant urteilSeit,
            String laeuft, Instant laeuftSeit, String zustand, String grund, Instant lebenszeichen) {
        return new UpdateFakten.Meldung(ziel, urteil, urteilSeit, laeuft, laeuftSeit, zustand, grund,
                lebenszeichen);
    }

    @Test
    @DisplayName("ohne Anfrage gibt es nichts anzunehmen oder zu bestätigen")
    void ohneAnfrage() {
        assertThat(UpdateFakten.of(null, meldung(null, null, null, "edge-2026.10.7", null, "idle",
                null, NOW), NOW)).isNull();
    }

    @Test
    @DisplayName("angefragt trägt Release, Zeitpunkt und Person")
    void angefragt() {
        var f = UpdateFakten.of(ANFRAGE, null, NOW);
        assertThat(f.angefragt().release()).isEqualTo(ZIEL);
        assertThat(f.angefragt().releaseSeq()).isEqualTo(59);
        assertThat(f.angefragt().am()).isEqualTo(ANGEFRAGT);
        assertThat(f.angefragt().von()).isEqualTo("sub-admin");
    }

    @Test
    @DisplayName("eine Box, die sich nie gemeldet hat oder offline ist, WARTET - nie abgelehnt")
    void stummeBoxWartet() {
        assertThat(UpdateFakten.of(ANFRAGE, null, NOW).angenommen().stand())
                .isEqualTo(UpdateFakten.WARTET);
        var offline = meldung("edge-2026.10.7", "ok", null, "edge-2026.10.7", null, "idle", null,
                NOW.minus(Duration.ofHours(3)));
        var f = UpdateFakten.of(ANFRAGE, offline, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.WARTET);
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.OFFEN);
    }

    @Test
    @DisplayName("erreichbar, aber noch das alte Ziel: angefragt, noch nicht angenommen")
    void nochNichtAngenommen() {
        var m = meldung("edge-2026.10.7", "ok", NOW.minus(Duration.ofDays(8)), "edge-2026.10.7",
                null, "idle", null, NOW.minus(Duration.ofSeconds(8)));
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.OFFEN);
        assertThat(f.angenommen().am()).as("das Urteil gehört zum ALTEN Ziel").isNull();
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.OFFEN);
    }

    @Test
    @DisplayName("Prüfurteil ok zum angefragten Ziel: angenommen mit Zeitpunkt; dann der Zwischenschritt")
    void angenommenUndZwischenschritt() {
        Instant angenommen = NOW.minus(Duration.ofMinutes(24));
        var laedt = meldung(ZIEL, "ok", angenommen, "edge-2026.10.7", null, "downloading", null, NOW);
        var f = UpdateFakten.of(ANFRAGE, laedt, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.JA);
        assertThat(f.angenommen().am()).isEqualTo(angenommen);
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.LAEUFT);
        assertThat(f.bestaetigt().schritt()).isEqualTo(UpdateFakten.SCHRITT_LAEDT);

        var wendetAn = meldung(ZIEL, "ok", angenommen, "edge-2026.10.7", null, "applying",
                "Node-RED wird getauscht.", NOW);
        assertThat(UpdateFakten.of(ANFRAGE, wendetAn, NOW).bestaetigt())
                .extracting(UpdateFakten.Bestaetigt::schritt, UpdateFakten.Bestaetigt::grund)
                .containsExactly(UpdateFakten.SCHRITT_WENDET_AN, "Node-RED wird getauscht.");
        var selbsttest = meldung(ZIEL, "ok", angenommen, ZIEL + "-c39b18d9c2a4", NOW, "self_test",
                null, NOW);
        assertThat(UpdateFakten.of(ANFRAGE, selbsttest, NOW).bestaetigt().schritt())
                .as("im Selbsttest läuft die neue Fassung schon - bestätigt ist sie noch nicht")
                .isEqualTo(UpdateFakten.SCHRITT_SELBSTTEST);
    }

    @Test
    @DisplayName("bestätigt: die Box fährt das Ziel (Präfix-Regel), mit dem Zeitpunkt des Wechsels")
    void bestaetigt() {
        Instant gewechselt = NOW.minus(Duration.ofMinutes(9));
        var m = meldung(ZIEL, "ok", NOW.minus(Duration.ofMinutes(24)), ZIEL + "-c39b18d9c2a4",
                gewechselt, "succeeded", null, NOW);
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.JA);
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.JA);
        assertThat(f.bestaetigt().am()).isEqualTo(gewechselt);
    }

    @Test
    @DisplayName("fährt die Box das Ziel schon (ohne eigenes Urteil), gilt es als angenommen und bestätigt")
    void schonAktuell() {
        var m = meldung(null, null, null, ZIEL, null, "idle", null, NOW);
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.JA);
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.JA);
        assertThat(f.bestaetigt().am()).as("seit wann, weiß niemand").isNull();
    }

    @Test
    @DisplayName("abgelehnt (Vertrauens-Set fehlt): der zweite Schritt ist rot, der dritte bleibt leer")
    void abgelehnt() {
        Instant am = NOW.minus(Duration.ofMinutes(39));
        var m = meldung(ZIEL, "rejected", am, "edge-light-2026.11.0", null, "failed",
                "Das Vertrauens-Set oder seine Signatur fehlt.", NOW);
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.ABGELEHNT);
        assertThat(f.angenommen().am()).isEqualTo(am);
        assertThat(f.angenommen().grund()).isEqualTo("Das Vertrauens-Set oder seine Signatur fehlt.");
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.OFFEN);
    }

    @Test
    @DisplayName("zurückgestellt: die Box hält die Anfrage mit eigenem Grund zurück")
    void zurueckgestellt() {
        var m = meldung(ZIEL, "deferred", NOW, "edge-2026.10.7", null, "deferred", null, NOW);
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.ZURUECKGESTELLT);
        assertThat(f.angenommen().grund()).isNotBlank();
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.OFFEN);
    }

    @Test
    @DisplayName("zurückgenommen: angewandt, Selbsttest rot, wieder auf dem alten Stand")
    void zurueckgenommen() {
        Instant zurueck = NOW.minus(Duration.ofMinutes(3));
        var m = meldung(ZIEL, "ok", NOW.minus(Duration.ofMinutes(30)), "edge-2026.10.7", zurueck,
                "rolled_back", "Selbsttest nicht grün: Node-RED startete nicht.", NOW);
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.JA);
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.ZURUECKGENOMMEN);
        assertThat(f.bestaetigt().am()).isEqualTo(zurueck);
        assertThat(f.bestaetigt().grund()).contains("Selbsttest");
    }

    @Test
    @DisplayName("fehlgeschlagen nach der Annahme")
    void fehlgeschlagen() {
        var m = meldung(ZIEL, "ok", NOW, "edge-2026.10.7", null, "failed", null, NOW);
        assertThat(UpdateFakten.of(ANFRAGE, m, NOW).bestaetigt().stand())
                .isEqualTo(UpdateFakten.FEHLGESCHLAGEN);
    }

    @Test
    @DisplayName("ein Fehlschlag zum FRÜHEREN Ziel gilt für die neue Anfrage nicht")
    void altesZielZaehltNicht() {
        var m = meldung("edge-2026.10.5", "ok", NOW, "edge-2026.10.4", null, "failed", null, NOW);
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).isEqualTo(UpdateFakten.OFFEN);
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.OFFEN);
    }

    @Test
    @DisplayName("im Update verstummt: Anwenden gemeldet, seit 20 Minuten kein Lebenszeichen")
    void verstummt() {
        var m = meldung(ZIEL, "ok", NOW.minus(Duration.ofHours(1)), "edge-2026.10.7", null,
                "applying", null, NOW.minus(Duration.ofMinutes(45)));
        var f = UpdateFakten.of(ANFRAGE, m, NOW);
        assertThat(f.angenommen().stand()).as("die Annahme bleibt ein Fakt").isEqualTo(UpdateFakten.JA);
        assertThat(f.bestaetigt().stand()).isEqualTo(UpdateFakten.VERSTUMMT);
    }
}
