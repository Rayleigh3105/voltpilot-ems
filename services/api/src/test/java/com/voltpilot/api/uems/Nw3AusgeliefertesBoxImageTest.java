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
 * <p>Der Punkt der Regel: es ist NICHT so, dass nur alte Boxen den Satz sehen. Beide Fähigkeiten
 * tragen {@code ab_release: null} — <em>kein</em> ausgeliefertes Release trägt sie. Darum sagt
 * die Fläche den Satz auch für die NEUESTE ausgelieferte Box, und ob ihr Release im Register
 * steht, ändert daran nichts. Das ist der Zustand der Flotte, kein Fehlerbild (X2).
 */
class Nw3AusgeliefertesBoxImageTest {

    private static final Path TABELLE =
            Path.of("..", "..", "docs", "contracts", "v2", "edge-capabilities.json");

    /** Der Stand, den die Box im NW-3-Lauf auf ihrem Herzschlag meldete. */
    private static final String GEMELDETER_STAND = "edge-2026.09.4-95166378dc1c";

    /** Das Release-Tag, aus dem dieser Stand gebaut ist. */
    private static final String RELEASE = "edge-2026.09.4";

    private static final String SATZ = "Software " + GEMELDETER_STAND
            + " · Update nötig für: Rückmeldung je Datenquelle, Zuständigkeit ab Zeitpunkt";

    @Test
    void dieAusgelieferteBoxOhneReleaseImRegisterBrauchtBeideUpdates() throws Exception {
        // Ein Stand, der zu keinem Release des Registers gehört, beweist keine Fähigkeit
        // (Regel 3 des Vertrags). Das ist die Lage jeder Box, deren Release die Cloud
        // (noch) nicht kennt.
        FaehigkeitenErgebnis e = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND, null, null), tabelle(), List.of());

        assertThat(e.text()).isEqualTo(SATZ);
        assertThat(e.faehigkeiten()).extracting(FaehigkeitStatus::vorhanden).containsOnly(false);
    }

    @Test
    void auchMitDemReleaseImRegisterBrauchtSieBeideUpdates() throws Exception {
        // Und selbst wenn das Register das Release kennt und die Box es meldet: `ab_release`
        // ist bei beiden Fähigkeiten null, also trägt sie keines — der Satz bleibt derselbe.
        FaehigkeitenErgebnis e = DatenquelleRegeln.faehigkeiten(
                new Stand(GEMELDETER_STAND, RELEASE, null), tabelle(), List.of(RELEASE));

        assertThat(e.text()).isEqualTo("Software " + RELEASE
                + " · Update nötig für: Rückmeldung je Datenquelle, Zuständigkeit ab Zeitpunkt");
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

    private static List<TabellenEintrag> tabelle() throws Exception {
        JsonNode arr = new ObjectMapper().readTree(Files.readString(TABELLE)).path("faehigkeiten");
        List<TabellenEintrag> out = new ArrayList<>();
        arr.forEach(e -> out.add(new TabellenEintrag(e.path("code").asText(), e.path("name").asText(),
                e.hasNonNull("ab_release") ? e.get("ab_release").asText() : null)));
        return out;
    }
}
