package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerService;
import com.voltpilot.api.verbraucher.Steuerart;
import com.voltpilot.api.verbraucher.SteuerartDokument;
import com.voltpilot.api.verbraucher.SteuerartSatz;
import com.voltpilot.api.verbraucher.SteuerartWunsch;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.util.Comparator;
import org.junit.jupiter.api.Test;

/**
 * Der OCPP-Ladepunkt, wie die API ihn anlegt - festgehalten in
 * {@code docs/contracts/v2/ladepunkt-profil-vectors.json} (Audit W-02).
 *
 * <p>Die Tests zu „Günstig" und „Ziel" im Optimierer waren grün, weil sie ein
 * Profil {@code continuous} mit Nennleistung ANNAHMEN, das die API nie anlegte
 * (sie legte {@code on_off} ohne Nennleistung an). Seither lesen der Optimierer
 * und der Box-Prüfstand ihr Profil und ihr Dokument aus diesen Vektoren, und
 * dieser Test hält die Vektoren an die API: Regelart aus dem Katalog,
 * Dokument aus {@link SteuerartDokument}, Box-Anforderung aus
 * {@link EntityRegistryService#flexRequirementsFor}. Den echten Schreibpfad
 * (Profil + gespeicherte Policy) pinnt {@code SteuerartApiTest}.
 *
 * <p>Rein: kein Docker, kein Spring, keine DB.
 */
class LadepunktProfilVectorsTest {

    private static final Path VECTORS = Path.of("../../docs/contracts/v2/ladepunkt-profil-vectors.json");

    private final ObjectMapper mapper = new ObjectMapper();
    private final EntityTypeCatalog catalog = new EntityTypeCatalog(mapper);

    @Test
    void dieRegelartEinesLadepunktsIstEineGrenzeUndNieDerRueckfallEinAus() throws Exception {
        JsonNode v = vectors();
        EntityTypeCatalog.EntityType type = catalog.find(v.path("entity_type").asText());
        // Nur limit_kw im Katalog: die Box trägt einen geplanten setpoint_kw
        // genau dann als Grenze (consumerCommandsFor). Ein Ein/Aus verwirft sie
        // an der Säule - also darf es gar nicht wählbar sein.
        assertThat(ConsumerService.allowedControlKinds(type)).containsExactly("continuous");
        for (JsonNode fall : v.path("faelle")) {
            assertThat(ConsumerService.defaultControlKind(type))
                    .as(fall.path("name").asText())
                    .isEqualTo(fall.path("profil").path("control_kind").asText());
        }
    }

    @Test
    void jedeAndereVerbraucherartBehaeltIhreRegelarten() {
        // Die neue Regel greift nur bei einem Verbraucher, der AUSSCHLIESSLICH
        // begrenzt werden kann - eine Schaltlast mit limit_kw bleibt Ein/Aus.
        assertThat(ConsumerService.allowedControlKinds(catalog.find("generic-load")))
                .containsExactly("on_off");
        assertThat(ConsumerService.defaultControlKind(catalog.find("generic-load"))).isEqualTo("on_off");
        assertThat(ConsumerService.allowedControlKinds(catalog.find("wallbox")))
                .containsExactly("on_off", "stepped", "continuous");
        assertThat(ConsumerService.allowedControlKinds(catalog.find("heat-pump-sgready")))
                .containsExactly("on_off");
    }

    @Test
    void dasDokumentUndDieBoxAnforderungFolgenDerApi() throws Exception {
        JsonNode v = vectors();
        for (JsonNode fall : v.path("faelle")) {
            String name = fall.path("name").asText();
            JsonNode profil = fall.path("profil");
            BigDecimal rated = profil.path("rated_power_kw").isNumber()
                    ? profil.path("rated_power_kw").decimalValue() : null;
            // Der Nachweiskanal des Profils entscheidet, ob ein kWh-Ziel überhaupt
            // wählbar ist (D3) - ohne ihn sperrte die API jedes Ziel an einer Säule.
            SteuerartSatz.Kontext k = new SteuerartSatz.Kontext(v.path("entity_type").asText(),
                    rated, null, profil.path("confirmation_channel").asText(null), "dynamisch", true,
                    null);
            SteuerartWunsch w = wunsch(fall.path("wunsch"));
            assertThat(SteuerartSatz.pruefe(k, w)).as(name).isEmpty();
            // Die Quelle „Günstig" fährt nicht die Box-Bahn: sie bleibt im
            // Dokument (SteuerartService.schreibeBahn gibt dort false).
            ObjectNode doc = SteuerartDokument.dokument(v.path("entity_id").asText(),
                    v.path("timezone").asText(), w, k, false);
            assertThat(gleich(doc, fall.path("dokument")))
                    .as("%s: Dokument der API%n%s", name, doc)
                    .isTrue();

            ArrayNode flex = EntityRegistryService.flexRequirementsFor(doc, rated, mapper);
            JsonNode erwartet = fall.path("flex_requirements");
            if (erwartet.isNull()) {
                assertThat(flex).as("%s: nichts ist zur Box schiebbar", name).isNull();
            } else {
                assertThat(flex).as("%s", name).isNotNull();
                assertThat(gleich(flex, erwartet)).as("%s: Box-Anforderung%n%s", name, flex).isTrue();
            }
        }
    }

    @Test
    void mitNennleistungIstDasZielEineLeistungUndGehtAlsSetpointZurBox() throws Exception {
        JsonNode fall = fall("guenstig-mit-ziel");
        JsonNode ziel = fall.path("dokument").path("requirements").get(1);
        assertThat(ziel.path("target").path("kind").asText()).isEqualTo("kw");
        assertThat(fall.path("flex_requirements").get(0).path("command").asText()).isEqualTo("setpoint_kw");
        // Ohne Nennleistung bleibt es ehrlich ein Ein/Aus, das nichts zur Box
        // schiebt - der Optimierer lässt die Säule dann mit Grund aus.
        JsonNode ohne = fall("ziel-ohne-nennleistung");
        assertThat(ohne.path("profil").path("rated_power_kw").isNull()).isTrue();
        assertThat(ohne.path("dokument").path("requirements").get(1).path("target").path("kind").asText())
                .isEqualTo("on_off");
    }

    private JsonNode vectors() throws Exception {
        return mapper.readTree(VECTORS.toFile());
    }

    private JsonNode fall(String name) throws Exception {
        for (JsonNode f : vectors().path("faelle")) {
            if (name.equals(f.path("name").asText())) {
                return f;
            }
        }
        throw new AssertionError("kein Fall " + name);
    }

    private static SteuerartWunsch wunsch(JsonNode w) {
        JsonNode f = w.path("zielFenster");
        Steuerart.Fenster fenster = f.isObject()
                ? new Steuerart.Fenster(f.path("tage").asText(), f.path("von").asText(), f.path("bis").asText())
                : null;
        return new SteuerartWunsch(w.path("quelle").asText(), null, dec(w, "preisgrenzeCtKwh"), null, null,
                null, w.hasNonNull("ziel") ? w.path("ziel").asText() : null, fenster, dec(w, "zielEnergieKwh"),
                null, null, null, null);
    }

    private static BigDecimal dec(JsonNode n, String field) {
        return n.path(field).isNumber() ? n.path(field).decimalValue() : null;
    }

    /** Gleich bis auf die Zahl-Form: 11, 11.0 und 11.000 sind dieselbe Nennleistung. */
    static boolean gleich(JsonNode a, JsonNode b) {
        Comparator<JsonNode> zahl = (x, y) -> x.isNumber() && y.isNumber()
                ? Double.compare(x.asDouble(), y.asDouble())
                : (x.equals(y) ? 0 : 1);
        return a.equals(zahl, b);
    }
}
