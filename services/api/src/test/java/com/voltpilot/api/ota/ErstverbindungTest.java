package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Regel „neueste Software beim ersten Verbinden", rein (Konzept
 * vp-erstverbindung-update, Abschnitt 10.1).
 */
class ErstverbindungTest {

    private static final Instant JETZT = Instant.parse("2026-11-16T09:42:00Z");
    private static final Instant ERSTE_MELDUNG = JETZT.minus(Duration.ofMinutes(1));

    private static final String PROGRAMME_FEHLEN =
            "Release 'edge-light-2026.11.14' ist noch nicht verteilbar: die Programme fuer linux/mipsle "
                    + "liegen noch nicht vollstaendig im Portal.";

    /** Das Register wie am 16.11.2026: Edge Light 2026.11.10 bis 2026.11.13, dazu Docker. */
    private static final List<NeuesteFassung.Release> REGISTER = List.of(
            light(61, "edge-light-2026.11.10"),
            light(62, "edge-light-2026.11.11"),
            new NeuesteFassung.Release(63, "edge-2026.11.2", BoxArt.DOCKER, true, null),
            light(64, "edge-light-2026.11.12"),
            light(65, "edge-light-2026.11.13"));

    private static NeuesteFassung.Release light(long seq, String version) {
        return new NeuesteFassung.Release(seq, version, BoxArt.LIGHT, true, null);
    }

    /** edge-cyhchfr: Mango aus der Werkstatt, 2026.11.10, Vertrauen gekreuzt, Loader kennt Updates. */
    private static Erstverbindung.Box mango() {
        return new Erstverbindung.Box(BoxArt.LIGHT, true, "update", "edge-light-2026.11.10-9b37439a02c1",
                ERSTE_MELDUNG, false, false, false);
    }

    private static Erstverbindung.Urteil urteil(Erstverbindung.Box box) {
        return Erstverbindung.of(box, REGISTER, Erstverbindung.Schalter.AN, JETZT);
    }

    @Test
    @DisplayName("neu verbunden: die allerneueste zuweisbare Fassung der eigenen Linie")
    void neuVerbundenBekommtDieNeueste() {
        assertThat(urteil(mango())).isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.ZUWEISEN, 65L,
                "edge-light-2026.11.13", null));
        var docker = new Erstverbindung.Box(BoxArt.DOCKER, false, null, "edge-2026.10.7",
                ERSTE_MELDUNG, false, false, false);
        assertThat(urteil(docker).releaseSeq()).as("Docker-Box: neueste Docker-Fassung").isEqualTo(63L);
    }

    @Test
    @DisplayName("E2 = B: keine Box muss die Fassung vorher bestätigt haben, ein unbekannter Stand bekommt sie auch")
    void ohneBestaetigungUndUnbekannterStand() {
        var fremd = new Erstverbindung.Box(BoxArt.LIGHT, true, "update", "edge-light-dev-1",
                ERSTE_MELDUNG, false, false, false);
        assertThat(urteil(fremd).art()).isEqualTo(Erstverbindung.Art.ZUWEISEN);
    }

    @Test
    @DisplayName("nicht neu: vor der Regel, Zuweisung gehabt, schon entschieden, nach dem Nachlauf")
    void nichtNeu() {
        var b = mango();
        assertThat(urteil(new Erstverbindung.Box(b.boxArt(), true, "update", b.laeuft(), null, false, false,
                false)).art()).as("Bestandsbox ohne erste Meldung").isEqualTo(Erstverbindung.Art.NICHTS);
        assertThat(urteil(new Erstverbindung.Box(b.boxArt(), true, "update", b.laeuft(), ERSTE_MELDUNG, true,
                false, false)).art()).as("hatte eine Zuweisung (von Hand, Box-Tausch)")
                .isEqualTo(Erstverbindung.Art.NICHTS);
        assertThat(urteil(new Erstverbindung.Box(b.boxArt(), true, "update", b.laeuft(), ERSTE_MELDUNG, false,
                true, false)).art()).as("schon entschieden").isEqualTo(Erstverbindung.Art.NICHTS);
        assertThat(Erstverbindung.of(mango(), REGISTER, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Erstverbindung.NACHLAUF).plusSeconds(1)).art())
                .isEqualTo(Erstverbindung.Art.NICHTS);
    }

    @Test
    @DisplayName("Stufe 1 (Vertrauen oder Loader) bekommt nichts, mit dem Satz der Sperre")
    void stufe1() {
        var ohneVertrauen = new Erstverbindung.Box(BoxArt.LIGHT, false, null, "edge-light-2026.11.10",
                ERSTE_MELDUNG, false, false, false);
        assertThat(urteil(ohneVertrauen)).isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.GESPERRT,
                null, null, BoxArt.GRUND_LIGHT_STUFE_1));
        var flash = new Erstverbindung.Box(BoxArt.LIGHT, true, "flash", "edge-light-2026.11.10",
                ERSTE_MELDUNG, false, false, false);
        assertThat(urteil(flash).grund()).isEqualTo(BoxArt.GRUND_LIGHT_STUFE_1_LOADER);
    }

    @Test
    @DisplayName("falsche Linie: eine Box bekommt nie ein Release der anderen Linie, auch wenn es neuer ist")
    void falscheLinie() {
        var nurLight = List.of(light(70, "edge-light-2026.12.1"));
        var docker = new Erstverbindung.Box(BoxArt.DOCKER, false, null, "edge-2026.10.7",
                ERSTE_MELDUNG, false, false, false);
        assertThat(Erstverbindung.of(docker, nurLight, Erstverbindung.Schalter.AN, JETZT))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.GESPERRT, null, null,
                        NeuesteFassung.GRUND_KEINE_FASSUNG));
        assertThat(urteil(mango()).release()).as("die neuere Docker-Fassung zählt für Edge Light nicht")
                .startsWith(BoxArt.LIGHT_STAMP_PREFIX);
    }

    @Test
    @DisplayName("schon aktuell: läuft die neueste oder eine neuere Fassung - nichts fällig")
    void schonAktuell() {
        var aktuell = new Erstverbindung.Box(BoxArt.LIGHT, true, "update", "edge-light-2026.11.13-1a2b3c4d5e6f",
                ERSTE_MELDUNG, false, false, false);
        assertThat(urteil(aktuell)).isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AKTUELL, 65L,
                "edge-light-2026.11.13", null));
        var neuer = List.of(light(61, "edge-light-2026.11.10"),
                new NeuesteFassung.Release(66, "edge-light-2026.11.14", BoxArt.LIGHT, false, null));
        var aufNeuer = new Erstverbindung.Box(BoxArt.LIGHT, true, "update", "edge-light-2026.11.14",
                ERSTE_MELDUNG, false, false, false);
        assertThat(Erstverbindung.of(aufNeuer, neuer, Erstverbindung.Schalter.AN, JETZT).art())
                .as("auf einer neueren (hier unsignierten) Fassung").isEqualTo(Erstverbindung.Art.AKTUELL);
    }

    @Test
    @DisplayName("N4: ein unsigniertes Release ist nie die neueste Fassung")
    void unsigniertZaehltNicht() {
        var mitUnsigniert = new java.util.ArrayList<>(REGISTER);
        mitUnsigniert.add(new NeuesteFassung.Release(66, "edge-light-2026.11.14", BoxArt.LIGHT, false, null));
        assertThat(Erstverbindung.of(mango(), mitUnsigniert, Erstverbindung.Schalter.AN, JETZT).release())
                .isEqualTo("edge-light-2026.11.13");
    }

    @Test
    @DisplayName("neuestes noch nicht zuweisbar: warten statt der vorigen Fassung, nach einer Stunde aufgeben")
    void neuestesNochNichtZuweisbar() {
        var mitUpload = new java.util.ArrayList<>(REGISTER);
        mitUpload.add(new NeuesteFassung.Release(66, "edge-light-2026.11.14", BoxArt.LIGHT, true,
                PROGRAMME_FEHLEN));
        assertThat(Erstverbindung.of(mango(), mitUpload, Erstverbindung.Schalter.AN, JETZT))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.WARTEN, null, null, PROGRAMME_FEHLEN));
        Instant nachEinerStunde = ERSTE_MELDUNG.plus(Erstverbindung.FENSTER).plusSeconds(30);
        assertThat(Erstverbindung.of(mango(), mitUpload, Erstverbindung.Schalter.AN, nachEinerStunde))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUFGEBEN, null, null, PROGRAMME_FEHLEN));
        assertThat(Erstverbindung.of(mango(), REGISTER, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Erstverbindung.FENSTER)).art())
                .as("genau eine Stunde zählt noch").isEqualTo(Erstverbindung.Art.ZUWEISEN);
    }

    @Test
    @DisplayName("Box-Art noch unbekannt: warten, nach einer Stunde aufgeben")
    void artUnbekannt() {
        var unbekannt = new Erstverbindung.Box(null, false, null, null, ERSTE_MELDUNG, false, false, false);
        assertThat(urteil(unbekannt).art()).isEqualTo(Erstverbindung.Art.WARTEN);
        assertThat(Erstverbindung.of(unbekannt, REGISTER, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Duration.ofMinutes(61))).grund()).isEqualTo(Erstverbindung.GRUND_ART_UNBEKANNT);
    }

    @Test
    @DisplayName("Takt verpasst: nach einer Stunde wird nicht mehr zugewiesen, sondern mit Grund aufgegeben")
    void fensterVerpasst() {
        assertThat(Erstverbindung.of(mango(), REGISTER, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Duration.ofMinutes(90))))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUFGEBEN, null, null,
                        Erstverbindung.GRUND_FENSTER));
    }

    @Test
    @DisplayName("Schalter: global oder je Linie aus")
    void schalter() {
        var lightAus = new Erstverbindung.Schalter(true, true, false);
        assertThat(Erstverbindung.of(mango(), REGISTER, lightAus, JETZT))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUS, null, null,
                        "Die Automatik ist für Edge Light abgeschaltet."));
        var docker = new Erstverbindung.Box(BoxArt.DOCKER, false, null, "edge-2026.10.7",
                ERSTE_MELDUNG, false, false, false);
        assertThat(Erstverbindung.of(docker, REGISTER, lightAus, JETZT).art())
                .as("die andere Linie läuft weiter").isEqualTo(Erstverbindung.Art.ZUWEISEN);
        var allesAus = new Erstverbindung.Schalter(false, true, true);
        assertThat(Erstverbindung.of(docker, REGISTER, allesAus, JETZT).grund())
                .isEqualTo("Die Automatik ist abgeschaltet.");
    }

    @Test
    @DisplayName("beendeter Kundenbereich bekommt nichts")
    void beendet() {
        var b = mango();
        var beendet = new Erstverbindung.Box(b.boxArt(), true, "update", b.laeuft(), ERSTE_MELDUNG, false,
                false, true);
        assertThat(urteil(beendet)).isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.GESPERRT, null,
                null, UpdateEignung.GRUND_BEENDET));
    }
}
