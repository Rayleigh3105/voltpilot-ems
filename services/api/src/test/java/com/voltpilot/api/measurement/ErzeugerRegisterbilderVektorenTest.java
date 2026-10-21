package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeuger.ErzeugerRegisterbild;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService.SelectionPoint;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.ErwarteteKadenz;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Rein, ohne Docker: der Publisher sagt für jeden Fall von {@code docs/contracts/v2/erzeuger-registerbilder-vectors.json}
 * genau das Erwartete — {@code erzeuger_registerbilder} nur an einem Plan mit Erzeuger-Punkten, nur an eine Box mit
 * der Fähigkeit {@code erzeuger_registerbild}, ohne Abfrage für jeden anderen Plan (UEMS EZ-6).
 */
class ErzeugerRegisterbilderVektorenTest {

    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2",
            "erzeuger-registerbilder-vectors.json");
    private static JsonNode vektoren;

    @BeforeAll
    static void lade() throws Exception {
        vektoren = MAPPER.readTree(Files.readString(VEKTOREN));
    }

    /** Eine Quelle, die statt der Datenbank die Fassungen des Falls liefert und jede Abfrage zählt. */
    private static ErzeugerRegisterbilder quelle(JsonNode fall, AtomicInteger abfragen) {
        return new ErzeugerRegisterbilder(mock(JdbcTemplate.class)) {
            @Override
            List<Fassung> laden(UUID siteId, Set<UUID> komponenten) {
                abfragen.incrementAndGet();
                List<Fassung> out = new ArrayList<>();
                for (JsonNode f : fall.path("fassungen")) {
                    UUID entity = UUID.fromString(f.path("entity_id").asText());
                    if (komponenten.contains(entity)) {
                        out.add(new Fassung(entity, f.path("basisadresse").asInt(), f.path("funktionscode").asInt(),
                                f.path("wortfolge").asText(), f.path("te_anzahl").asInt(), f.path("anlagenart").asText(),
                                f.path("steuerung_kennung").isNull() ? null : f.path("steuerung_kennung").asLong(),
                                f.path("veraltet_netzpunkt_s").asInt()));
                    }
                }
                return out;
            }
        };
    }

    private static List<MeasurementPlan.Entry> plan(JsonNode fall) {
        List<MeasurementPlan.Entry> out = new ArrayList<>();
        for (JsonNode p : fall.path("plan")) {
            out.add(new MeasurementPlan.Entry(p.hasNonNull("entity_id") ? UUID.fromString(p.path("entity_id").asText())
                    : null, p.path("point_key").asText(), p.path("cadence_s").asInt(), null, "x", 90, null, null));
        }
        return out;
    }

    private static State state(JsonNode fall, long revision) {
        List<SelectionPoint> punkte = new ArrayList<>();
        for (JsonNode p : fall.path("plan")) {
            punkte.add(new SelectionPoint(p.hasNonNull("entity_id") ? UUID.fromString(p.path("entity_id").asText())
                    : null, p.path("point_key").asText(), true, p.path("cadence_s").asInt(), revision, null, null,
                    "2026.09.23.3", "test", null, null, "pending_edge", null, null, null, "thermal_bms", 90, 900,
                    "fifteen_minute", null, null, null, null));
        }
        return new State(UUID.fromString("00000000-0000-0000-0000-000000000003"),
                UUID.fromString("00000000-0000-0000-0000-000000000002"), null, revision, "2026.09.23.3",
                "pending_edge", null, null, null, punkte, List.of(), null);
    }

    private static MeasurementConfigPublisher publisher(ErzeugerRegisterbilder quelle, boolean faehig) {
        MeasurementConfigPublisher p = new MeasurementConfigPublisher("tcp://unused:1883", "", "", MAPPER,
                ErwarteteKadenz.KEINE);
        BoxFaehigkeiten faehigkeiten = mock(BoxFaehigkeiten.class);
        when(faehigkeiten.kann(any(), eq(ErzeugerRegisterbild.FAEHIGKEIT))).thenReturn(faehig);
        // Eine neue Box meldet auch den Plan je Komponente — so bleiben die entity_id zweier Steuerungen getrennt.
        when(faehigkeiten.kann(any(), eq(MeasurementConfigPublisher.FAEHIGKEIT_JE_KOMPONENTE))).thenReturn(true);
        p.setFaehigkeiten(faehigkeiten);
        if (quelle != null) p.setErzeugerRegisterbilder(quelle);
        return p;
    }

    private static final DeviceScope SCOPE = new DeviceScope(UUID.fromString("00000000-0000-0000-0000-000000000001"),
            UUID.fromString("00000000-0000-0000-0000-000000000002"),
            UUID.fromString("00000000-0000-0000-0000-000000000003"));

    @Test
    void jederFallDerQuelleSagtDieErwartetenBilder() throws Exception {
        assertThat(vektoren.path("faelle")).hasSizeGreaterThanOrEqualTo(7);
        for (JsonNode fall : vektoren.path("faelle")) {
            AtomicInteger abfragen = new AtomicInteger();
            var bilder = quelle(fall, abfragen).fuer(SCOPE.siteId(), plan(fall));
            String name = fall.path("name").asText();
            assertThat(abfragen.get() > 0).as(name + ": datenbank_gefragt")
                    .isEqualTo(fall.path("datenbank_gefragt").asBoolean());
            JsonNode erwartet = fall.path("erwartet");
            if (!erwartet.isNull()) {
                // Verglichen wird die Drahtform, so wie der Publisher sie schreibt.
                assertThat(MAPPER.readTree(MAPPER.writeValueAsBytes(bilder))).as(name).isEqualTo(erwartet);
            } else if (fall.path("box_faehig").asBoolean()) {
                assertThat(bilder).as(name).isEmpty();
            }
            // Ohne Fähigkeit liefert die Quelle ihre Bilder trotzdem — weglassen ist Sache des Publishers.
        }
    }

    @Test
    void derPublisherSendetDasFeldNurMitFaehigkeitUndSonstByteGleich() throws Exception {
        for (JsonNode fall : vektoren.path("faelle")) {
            String name = fall.path("name").asText();
            AtomicInteger abfragen = new AtomicInteger();
            boolean faehig = fall.path("box_faehig").asBoolean();
            byte[] mit = publisher(quelle(fall, abfragen), faehig).payload(SCOPE, state(fall, 12));
            byte[] ohne = publisher(null, faehig).payload(SCOPE, state(fall, 12));
            JsonNode erwartet = fall.path("erwartet");
            if (erwartet.isNull()) {
                assertThat(mit).as(name + ": Byte für Byte wie ohne Erzeuger-Quelle").isEqualTo(ohne);
            } else {
                assertThat(MAPPER.readTree(mit).path("erzeuger_registerbilder")).as(name).isEqualTo(erwartet);
                assertThat(MAPPER.readTree(ohne).has("erzeuger_registerbilder")).isFalse();
            }
        }
    }

    @Test
    void dasGoreDokumentIstGenauDasDerVektorDatei() throws Exception {
        JsonNode gore = null;
        for (JsonNode fall : vektoren.path("faelle")) {
            if ("gore-pv-drei-wechselrichter".equals(fall.path("name").asText())) gore = fall;
        }
        assertThat(gore).isNotNull();
        byte[] dokument = publisher(quelle(gore, new AtomicInteger()), true).payload(SCOPE, state(gore, 12));
        assertThat(MAPPER.readTree(dokument)).isEqualTo(vektoren.path("dokument"));
    }

    @Test
    void dasSchemaKenntDasFeldUndSeineRegel() throws Exception {
        JsonNode schema = MAPPER.readTree(Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                "mqtt-measurement-config.schema.json")));
        assertThat(schema.path("properties").has("erzeuger_registerbilder")).isTrue();
        JsonNode bild = schema.path("$defs").path("erzeuger_registerbild");
        assertThat(bild.path("additionalProperties").asBoolean(true)).isFalse();
        List<String> felder = new ArrayList<>();
        bild.path("properties").fieldNames().forEachRemaining(felder::add);
        // Jedes Feld, das der Publisher schreiben kann, steht im geschlossenen Schema.
        assertThat(felder).containsExactlyInAnyOrder("entity_id", "basisadresse", "funktionscode", "wortfolge",
                "te_anzahl", "anlagenart", "steuerung_kennung", "veraltet_netzpunkt_s");
        assertThat(schema.path("x-erzeuger-registerbilder-rule").asText()).contains("erzeuger_registerbild");
    }
}
