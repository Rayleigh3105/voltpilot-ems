package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die ÜBERNAHME-REGEL, rein geprüft - ohne Datenbank, ohne Broker.
 *
 * <p>Der Live-Fall, den sie behebt (Anlage Pilsting/Herzogau, 20.08.2026,
 * Captain: „beim neu hinzufügen sind die Aliase jetzt weg"): nach dem
 * Identitäts-Riss suchte jedes gemeldete Gerät eine Zeile, fand unter seiner
 * NEUEN Kennung keine - und bekam eine zweite, während der Kundenname auf der
 * verwaisten Zeile daneben strandete.
 */
class ComponentTakeoverTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final UUID WR1 = UUID.fromString("11111111-0000-0000-0000-000000000001");
    private static final UUID WR2 = UUID.fromString("11111111-0000-0000-0000-000000000002");
    private static final UUID METER = UUID.fromString("11111111-0000-0000-0000-000000000003");

    private static final String CONN_1 = "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":1}";
    private static final String CONN_2 = "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":2}";

    private static ComponentTakeover.Existing row(UUID id, String conn, String mastr, String pin) {
        return new ComponentTakeover.Existing(id, "pv-generation", "fronius_sunspec",
                "fronius-eco-27-3-s", "fronius_sunspec", conn, mastr, pin);
    }

    private static ComponentTakeover.Incoming incoming(String conn, String mastr) {
        return new ComponentTakeover.Incoming("pv-generation", "fronius_sunspec",
                "fronius-eco-27-3-s", "fronius_sunspec", conn, mastr);
    }

    @Test
    @DisplayName("Der Herzogau-Fall: die verwaiste Zeile mit demselben Anschluss wird übernommen")
    void theOrphanedRowWithTheSameConnectionIsTakenOver() {
        UUID hit = ComponentTakeover.match(
                List.of(row(WR1, CONN_1, null, "src-alt-1"), row(WR2, CONN_2, null, "src-alt-2")),
                Set.of("src-neu-1", "src-neu-2"),
                incoming(CONN_1, null), MAPPER);

        assertThat(hit).isEqualTo(WR1);
    }

    @Test
    @DisplayName("Die MaStR-Referenz schlägt alles - sie überlebt jeden Kennungs-Riss")
    void theRegistryReferenceWins() {
        // Die Anbindung ist NICHT gespeichert; ohne die MaStR-Sprosse wäre hier
        // nichts wiederzuerkennen.
        UUID hit = ComponentTakeover.match(
                List.of(row(WR1, null, "SEE966831669441", "src-alt-1"),
                        row(WR2, null, "SEE966831669442", "src-alt-2")),
                Set.of("src-neu-1"),
                incoming(CONN_1, "SEE966831669442"), MAPPER);

        assertThat(hit).isEqualTo(WR2);
    }

    @Test
    @DisplayName("Eine LEBENDE Bindung wird nie übernommen")
    void aLivingBindingIsNeverTakenOver() {
        UUID hit = ComponentTakeover.match(
                List.of(row(WR1, CONN_1, null, "src-lebt")),
                Set.of("src-lebt"),
                incoming(CONN_1, null), MAPPER);

        assertThat(hit).isNull();
    }

    @Test
    @DisplayName("Zwei ununterscheidbare Zeilen entscheiden NICHTS")
    void anAmbiguousMatchDecidesNothing() {
        // Beide verwaist, beide ohne Anbindung, beide dieselbe Marke + Modell -
        // genau der Fall, in dem ein Geister-Erzeuger entstünde.
        UUID hit = ComponentTakeover.match(
                List.of(row(WR1, null, null, "src-alt-1"), row(WR2, null, null, "src-alt-2")),
                Set.of("src-neu-1", "src-neu-2"),
                incoming(CONN_1, null), MAPPER);

        assertThat(hit).isNull();
    }

    @Test
    @DisplayName("Eine starke Sprosse mit mehreren Treffern lässt keine schwächere nachrücken")
    void anAmbiguousStrongRungDoesNotFallThroughToAWeakerOne() {
        // Beide Zeilen tragen DIESELBE MaStR-Referenz (ein Pflegefehler). Fiele
        // die Entscheidung danach auf Marke+Modell zurück, würde sie auf einer
        // schlechteren Grundlage doch noch geraten.
        UUID hit = ComponentTakeover.match(
                List.of(row(WR1, null, "SEE1", "src-alt-1"), row(WR2, null, "SEE1", "src-alt-2")),
                Set.of("src-neu-1"),
                incoming(CONN_1, "SEE1"), MAPPER);

        assertThat(hit).isNull();
    }

    @Test
    @DisplayName("Eine ABWEICHENDE gespeicherte Anbindung ist der Beweis: anderes Gerät")
    void aDifferentStoredConnectionIsProofOfADifferentDevice() {
        UUID hit = ComponentTakeover.match(
                List.of(row(WR1, CONN_2, null, "src-alt-1")),
                Set.of("src-neu-1"),
                incoming(CONN_1, null), MAPPER);

        assertThat(hit).isNull();
    }

    @Test
    @DisplayName("Marke + Modell greifen nur auf einer BELEGT verwaisten Zeile ohne Anbindung")
    void brandAndModelOnlyRescueAProvenOrphanWithoutAConnection() {
        assertThat(ComponentTakeover.match(
                List.of(row(WR1, null, null, "src-alt-1")),
                Set.of("src-neu-1"),
                incoming(CONN_1, null), MAPPER))
                .as("verwaist: übernommen").isEqualTo(WR1);

        assertThat(ComponentTakeover.match(
                List.of(row(WR1, null, null, null)),
                Set.of("src-neu-1"),
                incoming(CONN_1, null), MAPPER))
                .as("nie gepinnt: frisch, nicht gestrandet - kein Marke/Modell-Treffer").isNull();
    }

    @Test
    @DisplayName("Eine andere ROLLE ist nie dieselbe Komponente")
    void aDifferentRoleIsNeverTheSameComponent() {
        ComponentTakeover.Existing meter = new ComponentTakeover.Existing(METER, "grid-meter",
                "fronius_sunspec", "fronius-eco-27-3-s", "fronius_sunspec", CONN_1, null,
                "src-alt-1");

        assertThat(ComponentTakeover.match(List.of(meter), Set.of("src-neu-1"),
                incoming(CONN_1, null), MAPPER)).isNull();
    }

    @Test
    @DisplayName("Schweigt die Box, gilt keine gepinnte Zeile als verwaist")
    void withoutAReportNoPinnedRowCountsAsOrphaned() {
        assertThat(ComponentTakeover.match(
                List.of(row(WR1, CONN_1, null, "src-alt-1")),
                Set.of(),
                incoming(CONN_1, null), MAPPER))
                .as("Schweigen beweist nichts").isNull();

        assertThat(ComponentTakeover.match(
                List.of(row(WR1, CONN_1, null, null)),
                Set.of(),
                incoming(CONN_1, null), MAPPER))
                .as("eine Zeile ohne Pin ist immer frei").isEqualTo(WR1);
    }

    @Test
    @DisplayName("Ohne Kandidaten und ohne Rolle wird nichts behauptet")
    void nothingIsClaimedWithoutCandidatesOrRole() {
        assertThat(ComponentTakeover.match(List.of(), Set.of("a"), incoming(CONN_1, null), MAPPER))
                .isNull();
        assertThat(ComponentTakeover.match(List.of(row(WR1, CONN_1, null, null)), Set.of(),
                new ComponentTakeover.Incoming(null, "fronius_sunspec", "fronius-eco-27-3-s",
                        "fronius_sunspec", CONN_1, null),
                MAPPER)).isNull();
        assertThat(ComponentTakeover.match(null, Set.of(), incoming(CONN_1, null), MAPPER))
                .isNull();
    }

    @Test
    @DisplayName("Schreibweisen desselben Sachverhalts sind dieselbe Referenz")
    void spellingVariantsOfTheSameReferenceMatch() {
        UUID hit = ComponentTakeover.match(
                List.of(row(WR1, null, "  see966831669441 ", "src-alt-1")),
                Set.of("src-neu-1"),
                incoming(null, "SEE966831669441"), MAPPER);

        assertThat(hit).isEqualTo(WR1);
    }
}
