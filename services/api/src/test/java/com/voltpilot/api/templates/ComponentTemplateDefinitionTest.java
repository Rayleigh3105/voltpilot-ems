package com.voltpilot.api.templates;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die REINEN Regeln einer geprüften Vorlage - ohne Docker, ohne Spring, ohne
 * DB (das {@code SelfBuildDefinitionTest}-Muster).
 */
class ComponentTemplateDefinitionTest {

    private static final ObjectMapper M = new ObjectMapper();

    @Test
    @DisplayName("eine vollständige Vorlage wird angenommen und ihre Bytes reisen unverändert")
    void aCompleteTemplateIsAccepted() {
        ComponentTemplateDefinition.Result r = ComponentTemplateDefinition.validate(full());

        assertThat(r.errors()).isEmpty();
        assertThat(r.ok()).isTrue();
        assertThat(r.transportSchemaJson()).contains("\"key\":\"ip\"");
        assertThat(r.channelsJson()).contains("\"slug\":\"leistung\"");
        assertThat(r.writesJson()).contains("\"safe_value\"");
    }

    @Test
    @DisplayName("ABSENT heißt „hier nicht erklärt“ - und wird nie zu einer leeren Liste")
    void absentListsStayAbsent() {
        ComponentTemplateDefinition.Result r = ComponentTemplateDefinition.validate(
                input(json(SCHEMA), null, null, "not_certified"));

        assertThat(r.ok()).isTrue();
        assertThat(r.channelsJson()).isNull();
        assertThat(r.writesJson()).isNull();
    }

    @Test
    @DisplayName("eine LEERE Liste wird abgelehnt statt still zu NULL gemacht")
    void anEmptyListIsRefusedNotSilentlyNulled() {
        ComponentTemplateDefinition.Result channels = ComponentTemplateDefinition.validate(
                input(json(SCHEMA), json("[]"), null, "not_certified"));
        assertThat(channels.errors()).anyMatch(e -> e.contains("liefert keine Messwerte"));
        assertThat(channels.errors()).anyMatch(e -> e.contains("Feld weg"));

        ComponentTemplateDefinition.Result writes = ComponentTemplateDefinition.validate(
                input(json(SCHEMA), null, json("[]"), "certified"));
        assertThat(writes.errors()).anyMatch(e -> e.contains("kann nichts schalten"));
    }

    @Test
    @DisplayName("eine Schreib-Fähigkeit ohne Sicherheitswert wird beim Namen genannt")
    void aWriteWithoutItsSafeValueIsNamed() {
        String withoutSafe = """
                [{"key":"schalter","label":"Heizstab","kind":"on_off",
                  "register":{"fc":6,"address":40},"on_value":1,"off_value":0}]""";
        ComponentTemplateDefinition.Result r = ComponentTemplateDefinition.validate(
                input(json(SCHEMA), null, json(withoutSafe), "certified"));

        assertThat(r.errors()).anyMatch(e -> e.contains("Sicherheitswert fehlt"));
        assertThat(r.errors()).anyMatch(e -> e.contains("Stille oder"));
    }

    @Test
    @DisplayName("ein Schalter braucht Ein- UND Aus-Wert, ein Sollwert seine Klemme")
    void everyWriteKindCarriesWhatItNeeds() {
        String noConstants = """
                [{"key":"schalter","label":"Heizstab","kind":"on_off",
                  "register":{"fc":6,"address":40},"safe_value":0}]""";
        assertThat(ComponentTemplateDefinition.validate(
                        input(json(SCHEMA), null, json(noConstants), "certified")).errors())
                .anyMatch(e -> e.contains("Ein- UND den Aus-Wert"));

        String badClamp = """
                [{"key":"soll","label":"Sollwert","kind":"setpoint",
                  "register":{"fc":16,"address":40},"min":10,"max":5,"safe_value":0}]""";
        assertThat(ComponentTemplateDefinition.validate(
                        input(json(SCHEMA), null, json(badClamp), "certified")).errors())
                .anyMatch(e -> e.contains("kleinste Wert muss unter dem größten"));
    }

    @Test
    @DisplayName("ein Schreibweg ohne Prüfung ist ein Widerspruch und wird abgelehnt")
    void writesRequireACertifiedStatus() {
        ComponentTemplateDefinition.Result r = ComponentTemplateDefinition.validate(
                input(json(SCHEMA), null, json(WRITES), "in_certification"));

        assertThat(r.errors()).anyMatch(e -> e.contains("Prüf-Zustand „certified“"));
    }

    @Test
    @DisplayName("„builtin“ ist als Prüf-Zustand nicht wählbar - das Wort gehört dem Seeder")
    void builtinIsNotAnAdminStatus() {
        assertThat(ComponentTemplateDefinition.CERT_STATUSES).doesNotContain("builtin");
        assertThat(ComponentTemplateDefinition.validate(
                        input(json(SCHEMA), null, null, "builtin")).errors())
                .anyMatch(e -> e.contains("Prüf-Zustand"));
    }

    @Test
    @DisplayName("ohne Verbindungsfeld kann niemand die Adresse eintragen")
    void aTemplateWithoutTransportFieldsIsRefused() {
        assertThat(ComponentTemplateDefinition.validate(
                        input(null, null, null, "not_certified")).errors())
                .anyMatch(e -> e.contains("mindestens ein Verbindungsfeld"));
        assertThat(ComponentTemplateDefinition.validate(
                        input(json("[]"), null, null, "not_certified")).errors())
                .anyMatch(e -> e.contains("mindestens ein Verbindungsfeld"));
    }

    @Test
    @DisplayName("eine Auswahl ohne Optionen und ein doppelter Feldname werden benannt")
    void transportFieldsAreChecked() {
        String bad = """
                [{"key":"ip","label":"IP","type":"text"},
                 {"key":"ip","label":"Nochmal","type":"text"},
                 {"key":"art","label":"Art","type":"select"},
                 {"key":"1x","label":"Krumm","type":"text"}]""";
        var errors = ComponentTemplateDefinition.validate(
                input(json(bad), null, null, "not_certified")).errors();

        assertThat(errors).anyMatch(e -> e.contains("gibt es schon"));
        assertThat(errors).anyMatch(e -> e.contains("mindestens eine Option"));
        assertThat(errors).anyMatch(e -> e.contains("unerlaubte Zeichen"));
    }

    @Test
    @DisplayName("die Nennleistung ist nie 0 - eine unbekannte bleibt weg")
    void ratedKwIsNeverZero() {
        ComponentTemplateDefinition.Input in = new ComponentTemplateDefinition.Input(
                "acme", "ACME", "relais", "Relais", null, null, "modbus_tcp", null,
                json(SCHEMA), null, null, BigDecimal.ZERO, 0, "not_certified", null, null);

        assertThat(ComponentTemplateDefinition.validate(in).errors())
                .anyMatch(e -> e.contains("größer als 0"));
    }

    @Test
    @DisplayName("mehrere Mängel kommen ZUSAMMEN, nicht einer nach dem anderen")
    void everyProblemIsCollected() {
        ComponentTemplateDefinition.Input in = new ComponentTemplateDefinition.Input(
                "", "", "", "", null, null, "carrier-pigeon", null,
                null, null, null, null, 9, "quatsch", null, null);

        assertThat(ComponentTemplateDefinition.validate(in).errors()).hasSizeGreaterThan(5);
    }

    @Test
    @DisplayName("der Schlüssel wird ABGELEITET, nie getippt")
    void theRefIsDerived() {
        assertThat(ComponentTemplateDefinition.refFor("ACME", "Relais_16"))
                .isEqualTo("certified:acme:relais_16");
        assertThat(BuiltinComponentTemplates.REF_PATTERN
                .matcher(ComponentTemplateDefinition.refFor("acme", "relais")).matches()).isTrue();
    }

    @Test
    @DisplayName("Messwert-Kennwörter bleiben eindeutig und die Einheit muss bekannt sein")
    void channelsAreChecked() {
        String bad = """
                [{"slug":"a","label":"Erster","unit":"kW","register":{"kind":"holding","address":1}},
                 {"slug":"a","label":"Zweiter","register":{"kind":"holding","address":2}},
                 {"label":"Dritter","unit":"Furlong","register":{"kind":"holding","address":3}},
                 {"label":"Vierter","register":{"kind":"holding","address":70000}}]""";
        var errors = ComponentTemplateDefinition.validate(
                input(json(SCHEMA), json(bad), null, "not_certified")).errors();

        assertThat(errors).anyMatch(e -> e.contains("gibt es schon"));
        assertThat(errors).anyMatch(e -> e.contains("Einheit"));
        assertThat(errors).anyMatch(e -> e.contains("0 und 65535"));
    }

    // ---- Hilfen -----------------------------------------------------------

    private static final String SCHEMA = """
            [{"key":"ip","label":"IP-Adresse","type":"text","required":true},
             {"key":"port","label":"Port","type":"number","default":502}]""";

    private static final String CHANNELS = """
            [{"slug":"leistung","label":"Leistung","unit":"kW",
              "register":{"kind":"holding","address":40,"data_type":"s32","word_order":"big"},
              "scale":0.1,"offset":0}]""";

    private static final String WRITES = """
            [{"key":"schalter","label":"Heizstab schalten","kind":"on_off",
              "register":{"fc":6,"address":50,"data_type":"u16"},
              "on_value":1,"off_value":0,"safe_value":0,
              "watchdog":{"register":51,"value":1,"interval_s":30}}]""";

    private static ComponentTemplateDefinition.Input full() {
        return input(json(SCHEMA), json(CHANNELS), json(WRITES), "certified");
    }

    private static ComponentTemplateDefinition.Input input(JsonNode schema, JsonNode channels,
            JsonNode writes, String status) {
        return new ComponentTemplateDefinition.Input("acme", "ACME Elektronik", "relais_16",
                "ACME Relais 16", "modbus_generic", "Generisches Modbus", "modbus_tcp",
                "Modbus TCP", schema, channels, writes, new BigDecimal("3.5"), 1, status,
                "Am Prüfstand gemessen", null);
    }

    private static JsonNode json(String raw) {
        try {
            return M.readTree(raw);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
