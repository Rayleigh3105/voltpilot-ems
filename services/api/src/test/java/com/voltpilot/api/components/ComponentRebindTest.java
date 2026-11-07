package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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

    /** Was die Cloud für den Heizstab des Captains speichert (Anlage „Zuhause“, Shelly Pro 3). */
    private static final String HEIZSTAB_GESPEICHERT = "{\"ip\":\"192.168.178.43\",\"port\":80,"
            + "\"channels\":[0,1,2],\"output_kw\":[1.5,1.5,1.5],\"stages\":[1,2,3],"
            + "\"anschluss\":\"stern_mit_n\",\"rotation\":\"daily\",\"interval_s\":5}";

    /** Was die Box dazu in `local_setup` meldet (sources.json der VoltPilotGATE, 02.11.2026). */
    private static final String HEIZSTAB_GEMELDET =
            "{\"ip\":\"192.168.178.43\",\"port\":80,\"channels\":[0,1,2]}";

    private static final UUID STAB = UUID.fromString("768a7939-567c-47fd-99ce-8e6df74ab857");

    @Test
    @DisplayName("Heizstab: die wartende Komponente findet ihre Shelly-Ausgangsmenge wieder")
    void aWaitingHeatingRodIsReboundToItsOutputSet() {
        // Der Fall „Zuhause“: der Pin zeigt ins Leere, die Box meldet denselben Shelly
        // unter einer Kennung, die keine Komponente trägt. Bis zum 04.11.2026 blieb das
        // so - `anschluss`/`rotation` stehen nur in der Cloud-Kopie, also passte der
        // Fingerabdruck nie, und der Kunde sah „nicht mehr verbunden“.
        List<ComponentRebind.Rebind> plan = ComponentRebind.decide(
                List.of(new ComponentRebind.PinnedComponent(STAB, "src-weg00001", "consumer",
                        "shelly_http", HEIZSTAB_GESPEICHERT, "Heizstab")),
                List.of(new ComponentRebind.ReportedDevice("src-7q7pdrwh", "consumer",
                        "shelly_http", HEIZSTAB_GEMELDET, "Heizstab")),
                MAPPER);
        assertThat(plan).singleElement().satisfies(r -> {
            assertThat(r.pointId()).isEqualTo(STAB);
            assertThat(r.fromSourceId()).isEqualTo("src-weg00001");
            assertThat(r.toSourceId()).isEqualTo("src-7q7pdrwh");
        });
    }

    @Test
    @DisplayName("Heizstab: die Erstbindung gelingt ohne Klick")
    void aNewHeatingRodIsBoundToItsReportedSource() {
        assertThat(ComponentRebind.decide(
                List.of(new ComponentRebind.PinnedComponent(STAB, null, "consumer",
                        "shelly_http", HEIZSTAB_GESPEICHERT, "Heizstab")),
                List.of(new ComponentRebind.ReportedDevice("src-7q7pdrwh", "consumer",
                        "shelly_http", HEIZSTAB_GEMELDET, "Heizstab")),
                MAPPER))
                .extracting(ComponentRebind.Rebind::toSourceId).containsExactly("src-7q7pdrwh");
    }

    @Test
    @DisplayName("Die Ausgangsmenge gehört zum Gerät: andere Menge, einzelner Ausgang = anderes Gerät")
    void theOutputSetIsPartOfTheDevice() {
        String stab = ComponentRebind.fingerprint("consumer", "shelly_http",
                HEIZSTAB_GESPEICHERT, MAPPER);
        assertThat(stab).isEqualTo(ComponentRebind.fingerprint("consumer", "shelly_http",
                HEIZSTAB_GEMELDET, MAPPER));
        // Zwei Phasen sind ein anderes Gerät als drei (die Box: set:0,1 ≠ set:0,1,2).
        assertThat(stab).isNotEqualTo(ComponentRebind.fingerprint("consumer", "shelly_http",
                "{\"ip\":\"192.168.178.43\",\"port\":80,\"channels\":[0,1]}", MAPPER));
        // Die Reihenfolge ist die Phasenfolge.
        assertThat(stab).isNotEqualTo(ComponentRebind.fingerprint("consumer", "shelly_http",
                "{\"ip\":\"192.168.178.43\",\"port\":80,\"channels\":[2,1,0]}", MAPPER));
        // Ein einzelner Ausgang desselben Shelly ist nie der Stab.
        assertThat(stab).isNotEqualTo(ComponentRebind.fingerprint("consumer", "shelly_http",
                "{\"ip\":\"192.168.178.43\",\"port\":80,\"channel\":0}", MAPPER));
        assertThat(ComponentRebind.decide(
                List.of(new ComponentRebind.PinnedComponent(STAB, "src-weg00001", "consumer",
                        "shelly_http", HEIZSTAB_GESPEICHERT, "Heizstab")),
                List.of(new ComponentRebind.ReportedDevice("src-ausgang0", "consumer",
                        "shelly_http", "{\"ip\":\"192.168.178.43\",\"port\":80}", "Relais")),
                MAPPER)).isEmpty();
    }

    /**
     * Was die Cloud für einen im Portal übernommenen KACO Powador TL3 speichert: das
     * Vorlagen-Formular (`builtin:kaco:powador-*-tl3`) samt Lese-Kadenz.
     */
    private static String kacoGespeichert(String ip) {
        return "{\"ip\":\"" + ip + "\",\"port\":502,\"unit_id\":1,\"model_type\":\"auto\","
                + "\"invert_grid_sign\":false,\"curtail_write_fc\":0,\"interval_s\":5}";
    }

    /**
     * Was die Box dazu in `local_setup` meldet: dieselbe Verbindung, normalisiert - mit der
     * Registerfamilie, die sie selbst einträgt (`sources.json` von edge-tgjn9gd, 07.11.2026).
     */
    private static String kacoGemeldet(String ip) {
        return "{\"ip\":\"" + ip + "\",\"port\":502,\"unit_id\":1,\"profile\":\"sunspec_live\","
                + "\"model_type\":\"auto\"}";
    }

    private static final UUID KACO_1 = UUID.fromString("2126f452-ac6e-4ec3-8446-a52fbeb8834e");
    private static final UUID KACO_2 = UUID.fromString("33d64aa8-7e1d-484f-92bc-b0cce2cb97d3");
    private static final UUID KACO_3 = UUID.fromString("ecc6ad92-0373-47a4-8cc2-20781426e2eb");

    @Test
    @DisplayName("Schramm: drei im Portal übernommene KACO finden ihre gemeldeten Quellen")
    void threePortalCreatedKacoAreBoundToTheirReportedSources() {
        // Der Live-Fall „Zuhause“ (07.11.2026): drei Powador TL3 über „Geräte suchen“ übernommen, die
        // Box liest alle drei - und meldete sie daneben als „KACO gefunden · noch nicht übernommen“,
        // weil ihre Verbindung ein `profile` trägt, das die Cloud-Kopie nie hat.
        List<ComponentRebind.Rebind> plan = ComponentRebind.decide(
                List.of(kaco(KACO_1, kacoGespeichert("192.168.1.147"), "Kaco 1"),
                        kaco(KACO_2, kacoGespeichert("192.168.1.113"), "Kaco 2"),
                        kaco(KACO_3, kacoGespeichert("192.168.1.156"), "Kaco 3")),
                List.of(kacoQuelle("src-wqng3qfp", kacoGemeldet("192.168.1.147"), "Kaco 1"),
                        kacoQuelle("src-sgw8hrpt", kacoGemeldet("192.168.1.113"), "Kaco 2"),
                        kacoQuelle("src-5ahgajrq", kacoGemeldet("192.168.1.156"), "Kaco 3")),
                MAPPER);

        assertThat(plan).extracting(ComponentRebind.Rebind::pointId,
                        ComponentRebind.Rebind::fromSourceId, ComponentRebind.Rebind::toSourceId)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple(KACO_1, null, "src-wqng3qfp"),
                        org.assertj.core.groups.Tuple.tuple(KACO_2, null, "src-sgw8hrpt"),
                        org.assertj.core.groups.Tuple.tuple(KACO_3, null, "src-5ahgajrq"));
    }

    @Test
    @DisplayName("Die Registerfamilie gehört nicht zum Gerät, Adresse und Unit-Id schon")
    void theRegisterFamilyIsNotPartOfTheDevice() {
        String gespeichert = ComponentRebind.fingerprint("pv-generation", "sunspec_tcp",
                kacoGespeichert("192.168.1.147"), MAPPER);
        assertThat(gespeichert).isEqualTo(ComponentRebind.fingerprint("pv-generation",
                "sunspec_tcp", kacoGemeldet("192.168.1.147"), MAPPER));
        // Ein anderer Wechselrichter bleibt ein anderer - Adresse oder Unit-Id entscheiden.
        assertThat(gespeichert).isNotEqualTo(ComponentRebind.fingerprint("pv-generation",
                "sunspec_tcp", kacoGemeldet("192.168.1.113"), MAPPER));
        assertThat(gespeichert).isNotEqualTo(ComponentRebind.fingerprint("pv-generation",
                "sunspec_tcp", kacoGemeldet("192.168.1.147").replace("\"unit_id\":1",
                        "\"unit_id\":2"), MAPPER));
        // Ein ausdrücklich gewählter Modelltyp bleibt Teil des Vergleichs.
        assertThat(gespeichert).isNotEqualTo(ComponentRebind.fingerprint("pv-generation",
                "sunspec_tcp", kacoGemeldet("192.168.1.147").replace("auto", "float"), MAPPER));
    }

    /**
     * Das Gegenstück zum Wächter unten, aus der Richtung der Box: ein Feld, das die Box beim
     * Normalisieren SELBST aus der Registerfamilie einträgt, steht in keiner Cloud-Kopie einer im
     * Portal angelegten Komponente. Verglichen, ließe es jede Erstbindung dieses Transports still
     * scheitern (Schramm, 07.11.2026: `profile`).
     */
    @Test
    @DisplayName("Was die Box aus der Registerfamilie selbst einträgt, wird ignoriert")
    void everyFieldTheBoxDerivesFromTheRegisterFamilyIsIgnored() throws Exception {
        String go = Files.readString(Path.of("../../edge-app/core/internal/inverter/inverter.go"));
        int start = go.indexOf("type Connection struct");
        String struct = go.substring(start, go.indexOf("\n}\n", start));
        java.util.Map<String, String> jsonByField = new java.util.HashMap<>();
        Matcher field = Pattern.compile("(?m)^\\s*([A-Z][A-Za-z0-9]*)\\s+\\S+\\s+`json:\"([a-z_0-9]+)")
                .matcher(struct);
        while (field.find()) {
            jsonByField.put(field.group(1), field.group(2));
        }
        Set<String> derived = new LinkedHashSet<>();
        Matcher assign = Pattern.compile("conn\\.([A-Z][A-Za-z0-9]*) = registerFamily").matcher(go);
        while (assign.find()) {
            derived.add(jsonByField.get(assign.group(1)));
        }
        assertThat(derived).as("die Box trägt die Registerfamilie mindestens als profile ein")
                .contains("profile").doesNotContainNull();

        String ohne = ComponentRebind.fingerprint("pv-generation", "x", "{\"ip\":\"10.0.0.1\"}", MAPPER);
        for (String key : derived) {
            assertThat(ComponentRebind.fingerprint("pv-generation", "x",
                    "{\"ip\":\"10.0.0.1\",\"" + key + "\":\"sunspec_live\"}", MAPPER))
                    .as("Feld \"%s\" trägt die Box selbst ein - es darf den Fingerabdruck nicht ändern", key)
                    .isEqualTo(ohne);
        }
    }

    private static ComponentRebind.PinnedComponent kaco(UUID id, String conn, String label) {
        return new ComponentRebind.PinnedComponent(id, null, "pv-generation", "sunspec_tcp", conn,
                label);
    }

    private static ComponentRebind.ReportedDevice kacoQuelle(String src, String conn, String label) {
        return new ComponentRebind.ReportedDevice(src, "pv-generation", "sunspec_tcp", conn, label);
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

    /**
     * Das MUSTER hinter dem Heizstab-Fall: jedes Verbindungsfeld, das die Cloud speichern kann, ist
     * entweder ein Feld, das die Box in ihrer Quellen-Verbindung auch meldet (dann zählt es zum
     * Fingerabdruck), oder ein reines Cloud-Feld (dann muss es ignoriert werden) - nie keins von
     * beidem. Ein neues Schema-Feld, das die Box nicht trägt, ließ sonst jede Erstbindung und jeden
     * Re-Pin still scheitern, und die gemeldete Quelle stand als „Neues Gerät gefunden" neben der
     * eigenen Komponente (Heizstab „Zuhause", 04.11.2026).
     */
    @Test
    @DisplayName("Jedes Verbindungsfeld ist entweder auf der Box zu Hause oder wird ignoriert")
    void everyConnectionFieldIsEitherReportedByTheBoxOrIgnored() throws Exception {
        Set<String> boxFields = new LinkedHashSet<>();
        String go = Files.readString(Path.of("../../edge-app/core/internal/inverter/inverter.go"));
        int start = go.indexOf("type Connection struct");
        assertThat(start).as("inverter.Connection im Go-Code").isGreaterThan(0);
        String struct = go.substring(start, go.indexOf("\n}\n", start));
        Matcher tag = Pattern.compile("json:\"([a-z_0-9]+)").matcher(struct);
        while (tag.find()) {
            boxFields.add(tag.group(1));
        }
        assertThat(boxFields).as("die Box kennt mindestens Adresse und Ausgangsmenge")
                .contains("ip", "port", "channels");

        // Was die Cloud speichern kann: jedes Feld der Vorlagen ...
        Set<String> cloudFields = new LinkedHashSet<>();
        JsonNode templates = MAPPER.readTree(Files.readString(
                Path.of("src/main/resources/componenttemplates/builtin.json"))).path("templates");
        for (JsonNode t : templates) {
            for (JsonNode f : t.path("transport_schema")) {
                cloudFields.add(f.path("key").asText());
            }
        }
        // ... und die Felder der Heizstab-Ausgangsmenge (HeizstabAusgaenge), die kein Schema führt.
        cloudFields.addAll(List.of("channels", "channel", "output_kw", "stages", "rotation",
                "anschluss", "on_timer_s", "interval_s"));

        String ohne = ComponentRebind.fingerprint("consumer", "x", "{\"ip\":\"10.0.0.1\"}", MAPPER);
        for (String key : cloudFields) {
            String mit = ComponentRebind.fingerprint("consumer", "x",
                    "{\"ip\":\"10.0.0.1\",\"" + key + "\":\"1\"}", MAPPER);
            boolean ignoriert = ohne.equals(mit);
            assertThat(ignoriert).as("Feld \"%s\": %s", key, boxFields.contains(key)
                    ? "die Box meldet es, also muss der Fingerabdruck es vergleichen"
                    : "die Box meldet es nie, also muss der Fingerabdruck es ignorieren")
                    .isEqualTo(!boxFields.contains(key) && !"ip".equals(key));
        }
    }
}
