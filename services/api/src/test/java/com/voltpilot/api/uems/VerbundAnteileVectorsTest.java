package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Tabelle;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.EnumMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Das Anteils-Dokument auf dem Draht (UEMS AP-15 IP-7, Vertrag {@code mqtt-verbund-anteile.md}) gegen
 * {@code verbund-anteile-mqtt-vectors.json}: was die Cloud veröffentlicht ({@link VerbundAnteileDokument#nutzlast}),
 * liest die Box mit ihrer Identität aus dem TOPIC und prüft es mit {@link SteuerungsverbundAnteile#dokumentPruefen}
 * (IP-2, NW-1); die Quittung prüft {@link VerbundAnteileResultListener#pruefe}. Rein, ohne DB.
 */
class VerbundAnteileVectorsTest {

    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2",
            "verbund-anteile-mqtt-vectors.json");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Instant JETZT = Instant.parse("2027-10-20T09:00:00Z");

    private static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    @Test
    void jedesVeroeffentlichteDokumentBestehtDiePruefungDerBoxWieErwartet() throws Exception {
        JsonNode v = vektoren();
        UUID t = UUID.fromString(v.path("kennungen").path("tenant").asText());
        UUID s = UUID.fromString(v.path("kennungen").path("site").asText());
        int n = 0;
        for (JsonNode f : v.path("dokumente")) {
            UUID box = UUID.fromString(f.path("box").asText());
            byte[] nutzlast = VerbundAnteileDokument.nutzlast(MAPPER, t, s, box, f.path("epoche").asLong(),
                    f.path("revision").asLong(), Schritt.aus(f.path("schritt").asText()), tabelle(f), JETZT);
            VerbundAnteileDokument.Gelesen g = VerbundAnteileDokument.lesen(MAPPER,
                    VerbundAnteileDokument.topic(t, s, box), nutzlast);
            assertThat(g).as(f.path("name").asText()).isNotNull();
            SteuerungsverbundAnteile.Stand stand = f.path("stand").isNull() ? null : new SteuerungsverbundAnteile.Stand(
                    f.path("stand").path("epoche").asLong(), f.path("stand").path("revision").asLong());
            SteuerungsverbundAnteile.Pruefung p = SteuerungsverbundAnteile.dokumentPruefen(g.identitaet(), stand,
                    g.dokument());
            assertThat(p.urteil().code()).as(f.path("name").asText())
                    .isEqualTo(f.path("erwartet").path("urteil").asText());
            assertThat(p.grund() == null ? null : p.grund().code()).as(f.path("name").asText())
                    .isEqualTo(f.path("erwartet").path("grund").isNull() ? null
                            : f.path("erwartet").path("grund").asText());
            // Y1: die GANZE Tabelle und verteilbar reisen mit, die Nutzlast nennt die Box des Topics
            JsonNode draht = MAPPER.readTree(nutzlast);
            assertThat(draht.path("device_id").asText()).isEqualTo(box.toString());
            assertThat(draht.path("anteile").path("einspeisung").size()).isEqualTo(f.path("anteile")
                    .path("einspeisung").size());
            assertThat(draht.has("plan_id")).as("reist nie im Plan").isFalse();
            n++;
        }
        assertThat(n).isEqualTo(7);
    }

    @Test
    void topicUndNutzlastNennenDieselbeBox() throws Exception {
        JsonNode v = vektoren();
        JsonNode muster = v.path("dokumente").get(0);
        for (JsonNode f : v.path("identitaet")) {
            JsonNode topic = f.path("topic");
            UUID t = UUID.fromString(topic.path("tenant").asText());
            ObjectNode draht = (ObjectNode) MAPPER.readTree(VerbundAnteileDokument.nutzlast(MAPPER, t,
                    UUID.fromString(topic.path("site").asText()), UUID.fromString(topic.path("box").asText()),
                    1, 8, Schritt.UEBERGANG, tabelle(muster), JETZT));
            f.path("nutzlast").fields().forEachRemaining(e -> draht.put(e.getKey(), e.getValue().asText()));
            VerbundAnteileDokument.Gelesen g = VerbundAnteileDokument.lesen(MAPPER,
                    "ems/" + t + "/" + topic.path("site").asText() + "/" + topic.path("box").asText()
                            + "/v2/verbund-anteile", MAPPER.writeValueAsBytes(draht));
            if (!f.path("erwartet").path("gelesen").asBoolean()) {
                assertThat(g).as(f.path("name").asText()).isNull();
                continue;
            }
            SteuerungsverbundAnteile.Pruefung p = SteuerungsverbundAnteile.dokumentPruefen(g.identitaet(), null,
                    g.dokument());
            assertThat(p.grund().code()).as(f.path("name").asText())
                    .isEqualTo(f.path("erwartet").path("grund").asText());
        }
    }

    @Test
    void quittungenMitGeschlossenemGrundUndIdentitaet() throws Exception {
        JsonNode v = vektoren();
        String t = v.path("kennungen").path("tenant").asText();
        String s = v.path("kennungen").path("site").asText();
        VerbundAnteileResultListener listener = new VerbundAnteileResultListener("tcp://nie:1883", "", "", null,
                MAPPER);
        int n = 0;
        for (JsonNode f : v.path("quittungen")) {
            String topic = "ems/" + t + "/" + s + "/" + f.path("topic_box").asText() + "/v2/verbund-anteile-result";
            VerbundAnteileResultListener.Gepruefte g = listener.pruefe(topic,
                    MAPPER.writeValueAsString(f.path("nutzlast")).getBytes(StandardCharsets.UTF_8));
            JsonNode e = f.path("erwartet");
            if (!e.path("gueltig").asBoolean()) {
                assertThat(g).as(f.path("name").asText()).isNull();
                continue;
            }
            assertThat(g).as(f.path("name").asText()).isNotNull();
            assertThat(g.angenommen()).isEqualTo(e.path("angenommen").asBoolean());
            assertThat(g.grund() == null ? null : g.grund().code())
                    .isEqualTo(e.path("grund").isNull() ? null : e.path("grund").asText());
            assertThat(g.stand()).isEqualTo(new SteuerungsverbundZweischritt.Stand(e.path("stand").path("epoche")
                    .asLong(), e.path("stand").path("revision").asLong()));
            assertThat(g.wirksam()).isEqualTo(e.path("wirksam").isNull() ? null : new SteuerungsverbundZweischritt
                    .Stand(e.path("wirksam").path("epoche").asLong(), e.path("wirksam").path("revision").asLong()));
            n++;
        }
        assertThat(n).isEqualTo(5);
    }

    private static Tabelle tabelle(JsonNode f) {
        Map<Grenzart, Map<String, BigDecimal>> a = new EnumMap<>(Grenzart.class);
        Map<Grenzart, BigDecimal> verteilbar = new EnumMap<>(Grenzart.class);
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            Map<String, BigDecimal> je = new TreeMap<>();
            f.path("anteile").path(r.code()).fields().forEachRemaining(e -> je.put(e.getKey(), e.getValue()
                    .decimalValue()));
            a.put(r, je);
            verteilbar.put(r, f.path("verteilbar").path(r.code()).decimalValue());
        }
        return new Tabelle(a, verteilbar);
    }
}
