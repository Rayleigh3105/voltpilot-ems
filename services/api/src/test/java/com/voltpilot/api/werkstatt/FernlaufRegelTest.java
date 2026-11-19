package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln des Fernlaufs: Vokabulare gegen den Vektor {@code docs/contracts/werkstatt-fernlauf.json}
 * (Zwillinge im Werkstatt-Dienst und im Portal lesen dieselbe Datei), die Vorprüfung aus §4.2 und der Zustand eines
 * Auftrags.
 */
class FernlaufRegelTest {

    private static final Instant JETZT = Instant.parse("2026-11-18T16:58:00Z");

    private static JsonNode vektor() throws Exception {
        return new ObjectMapper().readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "werkstatt-fernlauf.json")));
    }

    private static List<String> liste(JsonNode n, String feld) {
        List<String> out = new ArrayList<>();
        n.path(feld).forEach(x -> out.add(x.isObject() ? x.path("id").asText() : x.asText()));
        return out;
    }

    @Test
    void vokabulareWieImVektor() throws Exception {
        JsonNode v = vektor();
        assertThat(FernlaufRegel.SCHRITTE).containsExactlyElementsOf(liste(v, "schritte"));
        assertThat(new TreeSet<>(FernlaufRegel.SCHRITT_ZUSTAENDE)).containsExactlyElementsOf(
                new TreeSet<>(liste(v, "schritt_zustaende")));
        assertThat(FernlaufRegel.ERGEBNISSE).containsExactlyElementsOf(liste(v, "ergebnisse"));
        assertThat(FernlaufRegel.ZUSTAENDE).containsExactlyElementsOf(liste(v, "zustaende"));
        // Jedes Ergebnis ist ein Zustand; die zwei Zustände ohne Ergebnis sind erteilt und läuft.
        assertThat(FernlaufRegel.ZUSTAENDE).containsAll(FernlaufRegel.ERGEBNISSE);
    }

    /** Eine wartende Box wie edge-cyhchfr, bei der alles passt. */
    private static FernlaufRegel.Eingabe gut() {
        return new FernlaufRegel.Eingabe(false, false, true, "edge-light-2026.11.5", 5L, "edge-light-2026.11.15",
                15L, null, true, true, JETZT.minusSeconds(20), JETZT.minusSeconds(180), JETZT.minusSeconds(30), true,
                JETZT.minusSeconds(8), true, null, true, false);
    }

    private static List<String> codes(FernlaufRegel.Eingabe e) {
        return FernlaufRegel.vorpruefen(e, JETZT).gruende().stream().map(FernlaufRegel.Grund::code).toList();
    }

    @Test
    void allesPasstGibtDenKnopfMitDreiHaken() {
        FernlaufRegel.Urteil u = FernlaufRegel.vorpruefen(gut(), JETZT);
        assertThat(u.moeglich()).isTrue();
        assertThat(u.gruende()).isEmpty();
        assertThat(u.haken()).isEqualTo(new FernlaufRegel.Haken(true, true, true));
    }

    @Test
    void jederGrundHatSeinenCode() {
        FernlaufRegel.Eingabe g = gut();
        assertThat(codes(new FernlaufRegel.Eingabe(true, g.zertifikat(), g.werkstattLight(), g.laeuft(), g.laeuftSeq(),
                g.neueste(), g.neuesteSeq(), null, true, true, g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(),
                true, g.dienstGemeldetAm(), true, null, true, false))).containsExactly("kundenkonto");
        assertThat(codes(new FernlaufRegel.Eingabe(false, true, true, g.laeuft(), g.laeuftSeq(), g.neueste(),
                g.neuesteSeq(), null, true, true, g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(), true,
                g.dienstGemeldetAm(), true, null, true, false))).containsExactly("zertifikat");
        // Nur aufwärts: gleich und neuer gibt keinen Knopf.
        assertThat(codes(new FernlaufRegel.Eingabe(false, false, true, "edge-light-2026.11.15", 15L, g.neueste(), 15L,
                null, true, true, g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(), true, g.dienstGemeldetAm(),
                true, null, true, false))).containsExactly("schon_neueste");
        // Unbekannt ist keine Null: ohne gemeldete Fassung kein Knopf.
        assertThat(codes(new FernlaufRegel.Eingabe(false, false, true, null, null, g.neueste(), 15L, null, true, true,
                g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(), true, g.dienstGemeldetAm(), true, null, true,
                false))).containsExactly("fassung_unbekannt");
        assertThat(codes(new FernlaufRegel.Eingabe(false, false, true, "edge-light-labor", null, g.neueste(), 15L,
                null, true, true, g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(), true, g.dienstGemeldetAm(),
                true, null, true, false))).containsExactly("fassung_fremd");
        // Eine Docker-Box hat keinen Tunnel.
        assertThat(codes(new FernlaufRegel.Eingabe(false, false, false, "edge-2026.11.2", null, g.neueste(), 15L,
                null, true, true, g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(), true, g.dienstGemeldetAm(),
                true, null, true, false))).contains("keine_edge_light");
        assertThat(codes(new FernlaufRegel.Eingabe(false, false, true, g.laeuft(), 5L, null, null,
                "Die Fassung trägt ihren Skriptstand nicht.", true, true, g.rueckmeldungAm(), g.verbundenSeit(),
                g.gefragtUm(), true, g.dienstGemeldetAm(), true, null, true, false))).containsExactly("keine_neueste");
    }

    @Test
    void tunnelUndSchluesselfrageNurMitFrischerRueckmeldung() {
        FernlaufRegel.Eingabe g = gut();
        Instant alt = JETZT.minus(Duration.ofMinutes(4));
        assertThat(codes(mitTunnel(g, true, true, alt, g.verbundenSeit(), g.gefragtUm()))).containsExactly(
                "keine_rueckmeldung");
        assertThat(codes(mitTunnel(g, true, true, g.rueckmeldungAm(), null, g.gefragtUm()))).containsExactly(
                "nicht_verbunden");
        assertThat(codes(mitTunnel(g, true, true, g.rueckmeldungAm(), g.verbundenSeit(), null))).containsExactly(
                "fragt_nicht");
        assertThat(codes(mitTunnel(g, true, true, g.rueckmeldungAm(), g.verbundenSeit(), alt))).containsExactly(
                "fragt_nicht");
        assertThat(codes(mitTunnel(g, false, false, null, null, null))).containsExactly("kein_tunnel");
        assertThat(codes(mitTunnel(g, true, false, g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm())))
                .containsExactly("tunnel_gesperrt");
        FernlaufRegel.Urteil u = FernlaufRegel.vorpruefen(mitTunnel(g, true, true, alt, g.verbundenSeit(),
                g.gefragtUm()), JETZT);
        assertThat(u.haken().tunnelVerbunden()).isFalse();
        assertThat(u.haken().fragtNachSchluesseln()).isFalse();
    }

    private static FernlaufRegel.Eingabe mitTunnel(FernlaufRegel.Eingabe g, boolean zugang, boolean aktiv,
            Instant am, Instant verbunden, Instant gefragt) {
        return new FernlaufRegel.Eingabe(false, false, true, g.laeuft(), g.laeuftSeq(), g.neueste(), g.neuesteSeq(),
                null, zugang, aktiv, am, verbunden, gefragt, true, g.dienstGemeldetAm(), true, null, true, false);
    }

    @Test
    void derDienstMussSichMeldenUndDenFernlaufKennen() {
        FernlaufRegel.Eingabe g = gut();
        assertThat(codes(mitDienst(g, null, true, null))).containsExactly("dienst_stumm");
        assertThat(codes(mitDienst(g, JETZT.minusSeconds(61), true, null))).containsExactly("dienst_stumm");
        assertThat(codes(mitDienst(g, JETZT, null, null))).containsExactly("dienst_alt");
        List<FernlaufRegel.Grund> nicht = FernlaufRegel.vorpruefen(mitDienst(g, JETZT, false,
                "kein Techniker-Zugang (VP_WERKSTATT_TECHNIKER_ADRESSE)"), JETZT).gruende();
        assertThat(nicht).extracting(FernlaufRegel.Grund::code).containsExactly("dienst_nicht_bereit");
        assertThat(nicht.get(0).text()).contains("VP_WERKSTATT_TECHNIKER_ADRESSE");
        assertThat(codes(new FernlaufRegel.Eingabe(false, false, true, g.laeuft(), 5L, g.neueste(), 15L, null, true,
                true, g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(), false, g.dienstGemeldetAm(), true, null,
                false, true))).containsExactly("kein_techniker_zugang", "kein_host_schluessel", "laeuft_schon");
    }

    private static FernlaufRegel.Eingabe mitDienst(FernlaufRegel.Eingabe g, Instant am, Boolean fernlauf,
            String grund) {
        return new FernlaufRegel.Eingabe(false, false, true, g.laeuft(), 5L, g.neueste(), 15L, null, true, true,
                g.rueckmeldungAm(), g.verbundenSeit(), g.gefragtUm(), true, am, fernlauf, grund, true, false);
    }

    @Test
    void zustandEinesAuftrags() {
        Instant erteilt = JETZT.minusSeconds(60);
        Instant fenster = erteilt.plus(FernlaufRegel.FENSTER);
        assertThat(FernlaufRegel.zustand(erteilt, null, fenster, null, JETZT)).isEqualTo("erteilt");
        assertThat(FernlaufRegel.zustand(JETZT.minus(Duration.ofMinutes(11)), null, fenster, null, JETZT))
                .isEqualTo("nicht_abgeholt");
        assertThat(FernlaufRegel.zustand(erteilt, erteilt, fenster, null, JETZT)).isEqualTo("laeuft");
        assertThat(FernlaufRegel.zustand(erteilt, erteilt, JETZT.minusSeconds(1), null, JETZT)).isEqualTo("offen");
        assertThat(FernlaufRegel.zustand(erteilt, erteilt, fenster, "zurueck", JETZT)).isEqualTo("zurueck");
        assertThat(FernlaufRegel.offen("erteilt")).isTrue();
        assertThat(FernlaufRegel.offen("laeuft")).isTrue();
        for (String z : List.of("fertig", "zurueck", "unveraendert", "offen", "nicht_abgeholt")) {
            assertThat(FernlaufRegel.offen(z)).as(z).isFalse();
        }
    }

    @Test
    void laufendeFassungAusDeviceInfo() {
        assertThat(FernlaufRegel.laeuft("vp-edge-core edge-light-2026.11.5")).isEqualTo("edge-light-2026.11.5");
        assertThat(FernlaufRegel.laeuft("edge-light-2026.11.5")).isEqualTo("edge-light-2026.11.5");
        assertThat(FernlaufRegel.laeuft(null)).isNull();
        assertThat(FernlaufRegel.laeuft("vp-edge-core ")).isNull();
        assertThat(FernlaufRegel.laeuft("werkstatt-einloesung 2026-11-mango-3")).isNull();
    }
}
