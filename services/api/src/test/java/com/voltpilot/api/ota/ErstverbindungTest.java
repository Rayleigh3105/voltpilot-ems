package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Regel „neueste Software beim ersten Verbinden", rein (Konzept
 * vp-erstverbindung-update, Abschnitt 10.1). Welche Fassung die neueste ist,
 * sagt {@link RolloutService#neuesteFassung} (geteilt mit der Werkstatt); hier
 * kommt ihr Ergebnis als {@link Erstverbindung.Neueste} herein.
 */
class ErstverbindungTest {

    private static final Instant JETZT = Instant.parse("2026-11-16T09:42:00Z");
    private static final Instant ERSTE_MELDUNG = JETZT.minus(Duration.ofMinutes(1));

    private static final String PROGRAMME_FEHLEN =
            "Release 'edge-light-2026.11.14' ist noch nicht verteilbar: die Programme fuer linux/mipsle "
                    + "liegen noch nicht vollstaendig im Portal.";

    private static final Erstverbindung.Neueste L113 = new Erstverbindung.Neueste(65, "edge-light-2026.11.13", null);
    private static final Erstverbindung.Neueste L114_LAEDT =
            new Erstverbindung.Neueste(66, "edge-light-2026.11.14", PROGRAMME_FEHLEN);
    private static final Erstverbindung.Neueste D112 = new Erstverbindung.Neueste(63, "edge-2026.11.2", null);

    private static Erstverbindung.Box box(String art, boolean vertrauen, String loader, Long istSeq, String ist) {
        return new Erstverbindung.Box(art, vertrauen, loader, istSeq, ist, ERSTE_MELDUNG, false, false, false, false);
    }

    /** edge-cyhchfr: Mango aus der Werkstatt, 2026.11.10, Vertrauen gekreuzt, Loader kennt Updates. */
    private static Erstverbindung.Box mango() {
        return box(BoxArt.LIGHT, true, "update", 61L, "edge-light-2026.11.10");
    }

    private static Erstverbindung.Urteil urteil(Erstverbindung.Box b, Erstverbindung.Neueste n) {
        return Erstverbindung.of(b, n, Erstverbindung.Schalter.AN, JETZT);
    }

    @Test
    @DisplayName("neu verbunden: die neueste zuweisbare Fassung der eigenen Linie")
    void neuVerbundenBekommtDieNeueste() {
        assertThat(urteil(mango(), L113)).isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.ZUWEISEN, 65L,
                "edge-light-2026.11.13", null));
        assertThat(urteil(box(BoxArt.DOCKER, false, null, 58L, "edge-2026.10.7"), D112).releaseSeq())
                .as("Docker-Box: neueste Docker-Fassung").isEqualTo(63L);
    }

    @Test
    @DisplayName("E2 = B: keine Box muss die Fassung vorher bestätigt haben, ein unbekannter Stand bekommt sie auch")
    void unbekannterStand() {
        assertThat(urteil(box(BoxArt.LIGHT, true, "update", null, null), L113).art())
                .isEqualTo(Erstverbindung.Art.ZUWEISEN);
    }

    @Test
    @DisplayName("nicht neu: vor der Regel, Zuweisung gehabt (von Hand, Box-Tausch), schon entschieden, nach dem Nachlauf")
    void nichtNeu() {
        var b = mango();
        assertThat(urteil(new Erstverbindung.Box(b.boxArt(), true, "update", 61L, b.istRelease(), null, false, false,
                false, false), L113).art()).as("Bestandsbox ohne erste Meldung").isEqualTo(Erstverbindung.Art.NICHTS);
        assertThat(urteil(new Erstverbindung.Box(b.boxArt(), true, "update", 61L, b.istRelease(), ERSTE_MELDUNG, true,
                false, false, false), L113).art()).as("hatte eine Zuweisung").isEqualTo(Erstverbindung.Art.NICHTS);
        assertThat(urteil(new Erstverbindung.Box(b.boxArt(), true, "update", 61L, b.istRelease(), ERSTE_MELDUNG, false,
                true, false, false), L113).art()).as("schon entschieden").isEqualTo(Erstverbindung.Art.NICHTS);
        assertThat(Erstverbindung.of(mango(), L113, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Erstverbindung.NACHLAUF).plusSeconds(1)).art()).isEqualTo(Erstverbindung.Art.NICHTS);
    }

    @Test
    @DisplayName("Stufe 1 (Vertrauen oder Loader) bekommt nichts, mit dem Satz der Sperre")
    void stufe1() {
        assertThat(urteil(box(BoxArt.LIGHT, false, null, 61L, "edge-light-2026.11.10"), L113))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.GESPERRT, null, null, BoxArt.GRUND_LIGHT_STUFE_1));
        assertThat(urteil(box(BoxArt.LIGHT, true, "flash", 61L, "edge-light-2026.11.10"), L113).grund())
                .isEqualTo(BoxArt.GRUND_LIGHT_STUFE_1_LOADER);
    }

    @Test
    @DisplayName("keine signierte Fassung der Linie: nichts, mit Grund")
    void keineFassung() {
        assertThat(urteil(box(BoxArt.DOCKER, false, null, 58L, "edge-2026.10.7"), null))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.GESPERRT, null, null,
                        Erstverbindung.GRUND_KEINE_FASSUNG));
    }

    @Test
    @DisplayName("schon aktuell: läuft die neueste oder eine neuere Fassung - nichts fällig")
    void schonAktuell() {
        assertThat(urteil(box(BoxArt.LIGHT, true, "update", 65L, "edge-light-2026.11.13"), L113))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AKTUELL, 65L, "edge-light-2026.11.13", null));
        assertThat(urteil(box(BoxArt.LIGHT, true, "update", 66L, "edge-light-2026.11.14"), L113).art())
                .as("auf einer neueren (etwa unsignierten) Fassung").isEqualTo(Erstverbindung.Art.AKTUELL);
    }

    @Test
    @DisplayName("neueste noch nicht zuweisbar: warten statt der vorigen Fassung, nach einer Stunde aufgeben")
    void neuesteNochNichtZuweisbar() {
        assertThat(urteil(mango(), L114_LAEDT))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.WARTEN, null, null, PROGRAMME_FEHLEN));
        assertThat(Erstverbindung.of(mango(), L114_LAEDT, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Erstverbindung.FENSTER).plusSeconds(30)))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUFGEBEN, null, null, PROGRAMME_FEHLEN));
        assertThat(Erstverbindung.of(mango(), L113, Erstverbindung.Schalter.AN, ERSTE_MELDUNG.plus(Erstverbindung.FENSTER))
                .art()).as("genau eine Stunde zählt noch").isEqualTo(Erstverbindung.Art.ZUWEISEN);
    }

    @Test
    @DisplayName("Box-Art noch unbekannt: warten, nach einer Stunde aufgeben")
    void artUnbekannt() {
        var unbekannt = box(null, false, null, null, null);
        assertThat(urteil(unbekannt, null).art()).isEqualTo(Erstverbindung.Art.WARTEN);
        assertThat(Erstverbindung.of(unbekannt, null, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Duration.ofMinutes(61))).grund()).isEqualTo(Erstverbindung.GRUND_ART_UNBEKANNT);
    }

    @Test
    @DisplayName("Takt verpasst: nach einer Stunde wird nicht mehr zugewiesen, sondern mit Grund aufgegeben")
    void fensterVerpasst() {
        assertThat(Erstverbindung.of(mango(), L113, Erstverbindung.Schalter.AN, ERSTE_MELDUNG.plus(Duration.ofMinutes(90))))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUFGEBEN, null, null, Erstverbindung.GRUND_FENSTER));
    }

    @Test
    @DisplayName("Schalter: global oder je Linie aus")
    void schalter() {
        var lightAus = new Erstverbindung.Schalter(true, true, false, true);
        assertThat(Erstverbindung.of(mango(), L113, lightAus, JETZT))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUS, null, null,
                        "Die Automatik ist für Edge Light abgeschaltet."));
        var docker = box(BoxArt.DOCKER, false, null, 58L, "edge-2026.10.7");
        assertThat(Erstverbindung.of(docker, D112, lightAus, JETZT).art())
                .as("die andere Linie läuft weiter").isEqualTo(Erstverbindung.Art.ZUWEISEN);
        assertThat(Erstverbindung.of(docker, D112, new Erstverbindung.Schalter(false, true, true, true), JETZT).grund())
                .isEqualTo("Die Automatik ist abgeschaltet.");
        var industrie = box(BoxArt.INDUSTRIE, true, "update", null, null);
        assertThat(Erstverbindung.of(industrie, null, new Erstverbindung.Schalter(true, true, true, false), JETZT))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUS, null, null,
                        "Die Automatik ist für Edge Industrie abgeschaltet."));
        assertThat(Erstverbindung.of(mango(), L113, new Erstverbindung.Schalter(true, true, true, false), JETZT).art())
                .as("Edge Industrie aus lässt Edge Light laufen").isEqualTo(Erstverbindung.Art.ZUWEISEN);
    }

    @Test
    @DisplayName("S3 §4.6: während eines offenen Fernlaufs wartet die Regel - kein Wettlauf mit dem Tunnel-Update")
    void fernlaufOffenWartet() {
        // Offen: sonst wäre die Box ZUWEISEN-fällig, aber der Fernlauf durch den Tunnel blockiert.
        var m = mango();
        var offen = new Erstverbindung.Box(m.boxArt(), m.vertrauenGekreuzt(), m.loader(), m.istSeq(), m.istRelease(),
                m.ersteMeldung(), m.hatteZuweisung(), m.entschieden(), m.beendet(), true);
        assertThat(urteil(offen, L113)).isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.WARTEN, null, null,
                Erstverbindung.GRUND_FERNLAUF));

        // Auch eine Box, die ohnehin schon die neueste meldet, wartet: ihre Meldung könnte mitten im
        // Tausch des Fernlaufs stehen, kein voreiliges „aktuell".
        var offenAktuell = new Erstverbindung.Box(BoxArt.LIGHT, true, "update", 65L, "edge-light-2026.11.13",
                ERSTE_MELDUNG, false, false, false, true);
        assertThat(urteil(offenAktuell, L113).art()).isEqualTo(Erstverbindung.Art.WARTEN);

        // Nach dem Fenster verstreicht trotzdem „aufgeben" statt endlosem Warten.
        assertThat(Erstverbindung.of(offen, L113, Erstverbindung.Schalter.AN,
                ERSTE_MELDUNG.plus(Duration.ofMinutes(90))))
                .isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.AUFGEBEN, null, null,
                        Erstverbindung.GRUND_FERNLAUF));

        // Fertig (nicht mehr offen), die Box meldet jetzt die neueste: nichts fällig - wie heute.
        assertThat(urteil(box(BoxArt.LIGHT, true, "update", 65L, "edge-light-2026.11.13"), L113).art())
                .as("Fernlauf fertig, Box läuft die neueste").isEqualTo(Erstverbindung.Art.AKTUELL);

        // Zurückgenommen (nicht mehr offen), die Box meldet weiter die alte Fassung: der normale Weg übernimmt.
        assertThat(urteil(mango(), L113).art()).as("Fernlauf zurückgenommen, Box läuft weiter die alte")
                .isEqualTo(Erstverbindung.Art.ZUWEISEN);
    }

    @Test
    @DisplayName("beendeter Kundenbereich bekommt nichts")
    void beendet() {
        var b = new Erstverbindung.Box(BoxArt.LIGHT, true, "update", 61L, "edge-light-2026.11.10", ERSTE_MELDUNG,
                false, false, true, false);
        assertThat(urteil(b, L113)).isEqualTo(new Erstverbindung.Urteil(Erstverbindung.Art.GESPERRT, null, null,
                UpdateEignung.GRUND_BEENDET));
    }
}
