package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die RE-PIN-BRÜCKE, rein geprüft - ohne Datenbank, ohne Broker.
 *
 * <p>Der Live-Fall, den sie heilt (Anlage Pilsting/Herzogau, Update
 * edge-2026.08.5 -&gt; .10): zwei Fronius Eco hinter EINER IP, unterschieden
 * allein durch die Unit-Id, deren Quellen-Kennungen sich beim Update änderten.
 */
class ComponentRebindTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String CONN_UNIT_1 =
            "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":1}";
    private static final String CONN_UNIT_2 =
            "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":2}";

    private static final UUID WR1 = UUID.fromString("11111111-0000-0000-0000-000000000001");
    private static final UUID WR2 = UUID.fromString("11111111-0000-0000-0000-000000000002");

    private static ComponentRebind.PinnedComponent pinned(UUID id, String src, String conn,
            String label) {
        return new ComponentRebind.PinnedComponent(id, src, "pv-generation", "fronius_sunspec",
                conn, label);
    }

    private static ComponentRebind.ReportedDevice reported(String src, String conn, String label) {
        return new ComponentRebind.ReportedDevice(src, "pv-generation", "fronius_sunspec", conn,
                label);
    }

    @Test
    @DisplayName("Der Herzogau-Fall: beide Fronius finden ihre Komponente wieder")
    void theTwoFroniusUnitsAreReboundToTheirOwnComponent() {
        List<ComponentRebind.Rebind> plan = ComponentRebind.decide(
                List.of(pinned(WR1, "src-a7k3mq2p", CONN_UNIT_1, "Fronius WR1"),
                        pinned(WR2, "src-zt9wb4hd", CONN_UNIT_2, "Fronius WR2")),
                List.of(reported("src-tdaejmjs", CONN_UNIT_1, "WR1"),
                        reported("src-67w4nbhh", CONN_UNIT_2, "WR2")),
                MAPPER);

        assertThat(plan).hasSize(2);
        assertThat(plan).extracting(ComponentRebind.Rebind::pointId,
                        ComponentRebind.Rebind::toSourceId)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple(WR1, "src-tdaejmjs"),
                        org.assertj.core.groups.Tuple.tuple(WR2, "src-67w4nbhh"));
    }

    @Test
    @DisplayName("Eine LEBENDE Bindung wird nie angefasst")
    void aLivingPinIsNeverTouched() {
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-a7k3mq2p", CONN_UNIT_1, "Fronius WR1")),
                List.of(reported("src-a7k3mq2p", CONN_UNIT_1, "WR1"),
                        reported("src-neu00000", CONN_UNIT_2, "WR2")),
                MAPPER)).isEmpty();
    }

    @Test
    @DisplayName("Mehrdeutigkeit wird NICHT geraten - der manuelle Weg bleibt")
    void anAmbiguousMatchIsNeverGuessed() {
        // Zwei verwaiste Komponenten und zwei freie Geräte mit DEMSELBEN
        // Fingerabdruck: welche zu welchem gehört, ist nicht entscheidbar.
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-alt1", CONN_UNIT_1, "Fronius WR1"),
                        pinned(WR2, "src-alt2", CONN_UNIT_1, "Fronius WR2")),
                List.of(reported("src-neu1", CONN_UNIT_1, "A"),
                        reported("src-neu2", CONN_UNIT_1, "B")),
                MAPPER)).isEmpty();

        // Auch eine verwaiste Komponente und ZWEI passende Geräte bleiben liegen.
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-alt1", CONN_UNIT_1, "Fronius WR1")),
                List.of(reported("src-neu1", CONN_UNIT_1, "A"),
                        reported("src-neu2", CONN_UNIT_1, "B")),
                MAPPER)).isEmpty();
    }

    @Test
    @DisplayName("Ein ANDERES Gerät wird nie untergeschoben")
    void aDifferentDeviceIsNeverSubstituted() {
        // Freie Geräte gibt es - aber keines mit diesem Fingerabdruck.
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-alt1", CONN_UNIT_1, "Fronius WR1")),
                List.of(reported("src-neu1", "{\"ip\":\"192.168.210.99\",\"port\":502,"
                                + "\"unit_id\":1}", "fremd"),
                        reported("src-neu2", CONN_UNIT_2, "andere Einheit")),
                MAPPER)).isEmpty();
    }

    @Test
    @DisplayName("Eine andere ROLLE erbt keinen Pin")
    void aDifferentRoleNeverInheritsAPin() {
        ComponentRebind.ReportedDevice asMeter = new ComponentRebind.ReportedDevice(
                "src-neu1", "grid-meter", "fronius_sunspec", CONN_UNIT_1, "Zähler");
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-alt1", CONN_UNIT_1, "Fronius WR1")),
                List.of(asMeter), MAPPER)).isEmpty();
    }

    @Test
    @DisplayName("Ohne gespeicherte Anbindung wird nichts behauptet")
    void withoutAStoredConnectionNothingIsClaimed() {
        ComponentRebind.PinnedComponent bare = new ComponentRebind.PinnedComponent(
                WR1, "src-alt1", "pv-generation", null, null, "Fronius WR1");
        assertThat(ComponentRebind.decide(List.of(bare),
                List.of(reported("src-neu1", CONN_UNIT_1, "WR1")), MAPPER)).isEmpty();
    }

    @Test
    @DisplayName("Die Lese-Kadenz gehört nicht zum Gerät")
    void theReadCadenceIsNotPartOfTheDevice() {
        // Die Übernahme legt interval_s IN die gespeicherte Verbindung; die Box
        // meldet es nie dort. Ohne die Ausnahme scheiterte jeder Vergleich an
        // genau dieser selbst geschriebenen Kopie.
        String stored = "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":1,\"interval_s\":30}";
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-alt1", stored, "Fronius WR1")),
                List.of(reported("src-neu1", CONN_UNIT_1, "WR1")), MAPPER))
                .extracting(ComponentRebind.Rebind::toSourceId).containsExactly("src-neu1");
    }

    @Test
    @DisplayName("Schreibweisen desselben Sachverhalts sind derselbe Fingerabdruck")
    void equivalentSpellingsAreTheSameFingerprint() {
        String a = "{\"port\":502.0,\"ip\":\"192.168.210.40\",\"unit_id\":1,"
                + "\"insecure_tls\":false,\"serial\":\"\"}";
        assertThat(ComponentRebind.fingerprint("pv-generation", "fronius_sunspec", a, MAPPER))
                .isEqualTo(ComponentRebind.fingerprint("pv-generation", "fronius_sunspec",
                        CONN_UNIT_1, MAPPER));
    }

    @Test
    @DisplayName("Eine leere oder unlesbare Verbindung erkennt kein Gerät wieder")
    void anEmptyOrUnreadableConnectionIdentifiesNothing() {
        assertThat(ComponentRebind.fingerprint("pv-generation", "fronius_sunspec", "{}", MAPPER))
                .isNull();
        assertThat(ComponentRebind.fingerprint("pv-generation", "fronius_sunspec", "kaputt",
                MAPPER)).isNull();
        assertThat(ComponentRebind.fingerprint("pv-generation", "fronius_sunspec", "[]", MAPPER))
                .isNull();
        assertThat(ComponentRebind.fingerprint(null, "fronius_sunspec", CONN_UNIT_1, MAPPER))
                .isNull();
    }

    @Test
    @DisplayName("Erstbindung: eine im Portal angelegte Komponente findet ihre gemeldete Quelle")
    void aPortalCreatedComponentIsBoundToItsReportedSource() {
        String m31 = "{\"ip\":\"192.168.3.50\",\"port\":502,\"unit_id\":1,\"interval_s\":5}";
        String reportedM31 = "{\"ip\":\"192.168.3.50\",\"port\":502,\"unit_id\":1}";
        List<ComponentRebind.Rebind> plan = ComponentRebind.decide(
                List.of(new ComponentRebind.PinnedComponent(WR1, null, "consumer",
                        "ebyte_modbus_tcp", m31, "I/O-Modul")),
                List.of(new ComponentRebind.ReportedDevice("src-jnn9hwp6", "consumer",
                        "ebyte_modbus_tcp", reportedM31, "I/O-Modul")),
                MAPPER);
        assertThat(plan).singleElement().satisfies(r -> {
            assertThat(r.pointId()).isEqualTo(WR1);
            assertThat(r.fromSourceId()).isNull();
            assertThat(r.toSourceId()).isEqualTo("src-jnn9hwp6");
        });
    }

    @Test
    @DisplayName("Erstbindung rät nie: zwei unbekannte Komponenten auf ein Gerät bleiben offen")
    void aFirstBindingIsNeverGuessedEither() {
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, null, CONN_UNIT_1, "Fronius A"),
                        pinned(WR2, null, CONN_UNIT_1, "Fronius B")),
                List.of(reported("src-neu00001", CONN_UNIT_1, "WR")),
                MAPPER)).isEmpty();
        // Eine Quelle, die schon eine Komponente trägt, wird keiner zweiten gegeben.
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-lebt0001", CONN_UNIT_1, "Fronius A"),
                        pinned(WR2, null, CONN_UNIT_1, "Fronius B")),
                List.of(reported("src-lebt0001", CONN_UNIT_1, "WR")),
                MAPPER)).isEmpty();
    }

    @Test
    @DisplayName("Ohne Meldung und ohne Pin passiert nichts")
    void nothingHappensWithoutBothSides() {
        assertThat(ComponentRebind.decide(List.of(),
                List.of(reported("src-neu1", CONN_UNIT_1, "WR1")), MAPPER)).isEmpty();
        assertThat(ComponentRebind.decide(
                List.of(pinned(WR1, "src-alt1", CONN_UNIT_1, "Fronius WR1")), List.of(), MAPPER))
                .isEmpty();
    }
}
