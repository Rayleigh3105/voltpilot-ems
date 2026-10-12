package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.DatenquelleRegeln.FaehigkeitStatus;
import com.voltpilot.api.uems.DatenquelleRegeln.FaehigkeitenErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.Stand;
import com.voltpilot.api.uems.DatenquelleRegeln.TabellenEintrag;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * NW-3 Punkt 7 (AP-14 IP-6, Regel X2): was die Cloud auf UEMS-Flächen über die Box sagt, die im
 * Lauf {@code tools/nw3-box-image/nw3.sh} wirklich lief.
 *
 * <p><b>Warum diese Klasse neben dem Werkzeug steht.</b> Der Lauf fährt die echte Box-Software
 * des ausgelieferten Standes, aber keinen api-Prozess; den Satz bildet im Produktivcode
 * {@link DatenquelleRegeln#faehigkeiten}. Diese Klasse schließt die Naht: sie nimmt den Stand,
 * den die Box im Lauf SELBST gemeldet hat, und lässt die Cloud-Regel darüber urteilen. Der
 * Stand steht hier als Konstante, damit der Test ohne Docker läuft; er ist derselbe, den das
 * Protokoll unter {@code was_sich_am_paar_pruefen_laesst.stand_den_die_box_selbst_meldet} führt,
 * und er entsteht aus dem Versionsstempel der CI ({@code <tag>-<12 Zeichen der SHA>},
 * {@code .forgejo/workflows/edge-images.yaml}).
 *
 * <p>Der Punkt der Regel: es ist NICHT so, dass nur alte Boxen den Satz sehen. Die Fähigkeit der
 * Tabelle trägt {@code ab_release: null} — <em>kein</em> ausgeliefertes Release trägt sie. Darum sagt
 * die Fläche den Satz auch für die NEUESTE ausgelieferte Box, und ob ihr Release im Register
 * steht, ändert daran nichts. Das ist der Zustand der Flotte, kein Fehlerbild (X2). „Zuständigkeit
 * ab Zeitpunkt“ nennt der Satz seit B06 nicht mehr: der Cloud-Zeitgeber erbringt sie für jede Box.
 */
class Nw3AusgeliefertesBoxImageTest {

    private static final Path TABELLE =
            Path.of("..", "..", "docs", "contracts", "v2", "edge-capabilities.json");

    /** Der Stand, den die Box im NW-3-Lauf auf ihrem Herzschlag meldete. */
    private static final String GEMELDETER_STAND = "edge-2026.09.4-95166378dc1c";

    /** Das Release-Tag, aus dem dieser Stand gebaut ist. */
    private static final String RELEASE = "edge-2026.09.4";

    private static final String SATZ = "Software " + GEMELDETER_STAND
            + " · Update nötig für: Rückmeldung je Datenquelle";

    /**
     * Der Stand, den die Box im NW-3-Lauf des jüngeren Tags meldete
     * ({@code docs/rollout/nw3-protokoll-edge-2026.09.5.json}).
     */
    private static final String GEMELDETER_STAND_095 = "edge-2026.09.5-1b6b7917527b";

    private static final String RELEASE_095 = "edge-2026.09.5";

    /**
     * Der Stand, den die Box im NW-3-Lauf des Tags vom 29.09.2026 meldete
     * ({@code docs/rollout/nw3-protokoll-edge-2026.09.6.json}).
     */
    private static final String GEMELDETER_STAND_096 = "edge-2026.09.6-becfa44e48ed";

    private static final String RELEASE_096 = "edge-2026.09.6";

    /**
     * Der Stand, den die Box im NW-3-Lauf des Tags vom 10.10.2026 meldete
     * ({@code docs/rollout/nw3-protokoll-edge-2026.10.0.json}).
     */
    private static final String GEMELDETER_STAND_100 = "edge-2026.10.0-99944c8960ad";

    private static final String RELEASE_100 = "edge-2026.10.0";

    @Test
    void dieAusgelieferteBoxOhneReleaseImRegisterBrauchtDasUpdateJeDatenquelle() throws Exception {
        // Ein Stand, der zu keinem Release des Registers gehört, beweist keine Fähigkeit
        // (Regel 3 des Vertrags). Das ist die Lage jeder Box, deren Release die Cloud
        // (noch) nicht kennt.
        FaehigkeitenErgebnis e = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND, null, null), tabelle(), List.of());

        assertThat(e.text()).isEqualTo(SATZ);
        assertThat(e.faehigkeiten()).extracting(FaehigkeitStatus::vorhanden).containsOnly(false);
    }

    @Test
    void auchMitDemReleaseImRegisterBrauchtSieDasUpdateJeDatenquelle() throws Exception {
        // Und selbst wenn das Register das Release kennt und die Box es meldet: `ab_release`
        // ist bei `data_sources` null, also trägt sie es nicht — der Satz bleibt derselbe.
        FaehigkeitenErgebnis e = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND, RELEASE, null), tabelle(), List.of(RELEASE));

        assertThat(e.text()).isEqualTo("Software " + RELEASE
                + " · Update nötig für: Rückmeldung je Datenquelle");
        assertThat(e.faehigkeiten()).extracting(FaehigkeitStatus::vorhanden).containsOnly(false);
    }

    @Test
    void dieBoxMeldetKeinSupportsDennDasPaketDafuerIstNichtGebaut() throws Exception {
        // AP-06 IP-18 (`supports[]` im Herzschlag) ist nicht gebaut; der Lauf hat im
        // Herzschlag des ausgelieferten Standes auch keinen solchen Block gesehen. Eine
        // LEERE Meldung entzieht nichts und fügt nichts hinzu — sie lässt die Tabelle
        // entscheiden, und die sagt für diesen Stand dasselbe.
        FaehigkeitenErgebnis e = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND, null, List.of()), tabelle(), List.of());

        assertThat(e.text()).isEqualTo(SATZ);
    }

    @Test
    void auchDasJuengereReleaseTraegtDieFaehigkeitNicht() throws Exception {
        // edge-2026.09.5 (24.09.2026): ohne und mit Release im Register sagt die Fläche
        // denselben Satz wie für 09.4.
        FaehigkeitenErgebnis ohne = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND_095, null, null), tabelle(), List.of());
        FaehigkeitenErgebnis mit = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND_095, RELEASE_095, null), tabelle(), List.of(RELEASE_095));

        assertThat(ohne.text()).isEqualTo("Software " + GEMELDETER_STAND_095
                + " · Update nötig für: Rückmeldung je Datenquelle");
        assertThat(mit.text()).isEqualTo("Software " + RELEASE_095
                + " · Update nötig für: Rückmeldung je Datenquelle");
        assertThat(mit.faehigkeiten()).extracting(FaehigkeitStatus::vorhanden).containsOnly(false);
    }

    @Test
    void auchDasReleaseVomRueckmeldewegTraegtDieFaehigkeitNicht() throws Exception {
        // edge-2026.09.6 (29.09.2026, Korrektur des Rückmeldewegs) ist die neueste ausgelieferte
        // Box: ohne und mit Release im Register sagt die Fläche denselben Satz wie für 09.4/09.5.
        FaehigkeitenErgebnis ohne = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND_096, null, null), tabelle(), List.of());
        FaehigkeitenErgebnis mit = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND_096, RELEASE_096, null), tabelle(), List.of(RELEASE_096));

        assertThat(ohne.text()).isEqualTo("Software " + GEMELDETER_STAND_096
                + " · Update nötig für: Rückmeldung je Datenquelle");
        assertThat(mit.text()).isEqualTo("Software " + RELEASE_096
                + " · Update nötig für: Rückmeldung je Datenquelle");
        assertThat(mit.faehigkeiten()).extracting(FaehigkeitStatus::vorhanden).containsOnly(false);
    }

    @Test
    void auchDasErsteReleaseMitDemUemsStandTraegtDieFaehigkeitNichtUeberDieTabelle() throws Exception {
        // edge-2026.10.0 (10.10.2026, erster Tag nach dem Schritt uems -> main, mit den
        // Deye-Paketen P3/P4) ist die neueste ausgelieferte Box. Die Tabelle trägt weiter
        // ab_release = null: ohne supports[] sagt die Fläche denselben Satz wie für 09.4 bis 09.6.
        FaehigkeitenErgebnis ohne = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND_100, null, null), tabelle(), List.of());
        FaehigkeitenErgebnis mit = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND_100, RELEASE_100, null), tabelle(), List.of(RELEASE_100));

        assertThat(ohne.text()).isEqualTo("Software " + GEMELDETER_STAND_100
                + " · Update nötig für: Rückmeldung je Datenquelle");
        assertThat(mit.text()).isEqualTo("Software " + RELEASE_100
                + " · Update nötig für: Rückmeldung je Datenquelle");
        assertThat(mit.faehigkeiten()).extracting(FaehigkeitStatus::vorhanden).containsOnly(false);
    }

    @Test
    void dasReleaseMitDemUemsStandMeldetSupportsUndBrauchtDarumKeinUpdate() throws Exception {
        // Anders als 09.4 bis 09.6 trägt der Herzschlag von edge-2026.10.0 den Block
        // `supports[]` (Beleg: Punkt 1a des Protokolls, acht Namen, darunter `data_sources`).
        // Punkt 7 des Werkzeugs liest diesen Block nicht; die Fläche liest ihn, und mit der
        // gemeldeten Liste fehlt der Box nichts - der Satz „Update nötig“ fällt weg.
        List<String> gemeldet = List.of("data_sources", "measurement_sample_provenance", "events",
                "automation_paused_until_revoked", "plan_quittung", "steuerungsverbund_anteil",
                "sprungprobe", "measurement_config_per_component");
        FaehigkeitenErgebnis e = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND_100, null, gemeldet), tabelle(), List.of());

        assertThat(e.faehigkeiten()).extracting(FaehigkeitStatus::vorhanden).containsOnly(true);
        assertThat(e.text()).startsWith("Software " + GEMELDETER_STAND_100 + " · ")
                .doesNotContain("Update nötig");
    }

    private static List<TabellenEintrag> tabelle() throws Exception {
        JsonNode arr = new ObjectMapper().readTree(Files.readString(TABELLE)).path("faehigkeiten");
        List<TabellenEintrag> out = new ArrayList<>();
        arr.forEach(e -> out.add(new TabellenEintrag(e.path("code").asText(), e.path("name").asText(),
                e.hasNonNull("ab_release") ? e.get("ab_release").asText() : null)));
        return out;
    }
}
