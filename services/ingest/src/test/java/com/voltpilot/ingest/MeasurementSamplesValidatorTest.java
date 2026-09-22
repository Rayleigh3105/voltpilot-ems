package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

class MeasurementSamplesValidatorTest {
    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String ENTITY = "00000000-0000-0000-0000-0000000000c5";
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE
            + "/v2/measurement-samples";
    /** One second after the payloads' observed_at: these tests are about form, not time. */
    private static final Instant EINGANG = Instant.parse("2026-08-25T12:00:01Z");
    private final MeasurementSamplesValidator validator =
            new MeasurementSamplesValidator(new ObjectMapper(), Messzeitregel.E13);

    @Test
    void committedFixturesValidateAsLabelled() throws Exception {
        var event = validator.annehmen(TOPIC, fixture("mqtt-measurement-samples.valid.json"),
                Instant.parse("2026-08-25T12:00:11Z")).weiter();
        assertThat(event.sequence()).isEqualTo(42L);
        assertThat(event.kafkaKey()).isEqualTo(TENANT + ":" + SITE + ":" + DEVICE);
        assertSampleAbgewiesen(fixture("mqtt-measurement-samples.invalid.no-raw.json"),
                Grund.SCHEMA_VERLETZT);
    }

    @Test
    void identityUnknownFieldsAndScalarRawAreStrict() {
        String sample = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\"}";
        String valid = payload(TENANT, sample);
        assertThat(validator.annehmen(TOPIC, valid, EINGANG).weiter().sequence()).isEqualTo(4L);
        assertUmschlagAbgewiesen(payload("10000000-0000-0000-0000-000000000001", sample),
                Grund.KENNUNG_ABWEICHEND);
        assertSampleAbgewiesen(payload(TENANT, "{\"point_key\":\"x\",\"decoded\":1,\"quality\":\"good\"}"),
                Grund.SCHEMA_VERLETZT);
        assertUmschlagAbgewiesen(valid.replace("\"samples\"", "\"unexpected\":true,\"samples\""),
                Grund.SCHEMA_VERLETZT);
        assertUmschlagAbgewiesen(valid + "{}", Grund.SCHEMA_VERLETZT);
    }

    /** UEMS AP-07 IP-2: 2.0 and 2.1 side by side; the provenance fields only under 2.1. */
    @Test
    void acceptsBothVersionsAndBindsTheProvenanceFieldsTo21() {
        String sample = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\"";
        String plain = sample + "}";
        String withEntity = sample + ",\"entity_id\":\"" + ENTITY + "\"}";
        // 2.0 without the new fields: exactly as before.
        assertThat(validator.annehmen(TOPIC, payload("2.0", TENANT, "", plain), EINGANG)
                .weiter().samples().get(0).has("entity_id")).isFalse();
        // 2.1 with both provenance fields.
        var event = validator.annehmen(TOPIC,
                payload("2.1", TENANT, "\"applied_revision\":1,", withEntity), EINGANG).weiter();
        assertThat(event.sequence()).isEqualTo(4L);
        // 2.1 without them (a box that does not name component or revision).
        assertThat(validator.annehmen(TOPIC, payload("2.1", TENANT, "", plain), EINGANG)
                .weiter().sequence()).isEqualTo(4L);
        // The new fields do not exist under 2.0 - at sample level only that sample is refused.
        assertSampleAbgewiesen(payload("2.0", TENANT, "", withEntity), Grund.SCHEMA_VERLETZT);
        assertUmschlagAbgewiesen(payload("2.0", TENANT, "\"applied_revision\":1,", plain),
                Grund.SCHEMA_VERLETZT);
        // A foreign field stays refused in both versions, at envelope and at sample level.
        for (String version : new String[] {"2.0", "2.1"}) {
            assertUmschlagAbgewiesen(payload(version, TENANT, "\"messstelle\":\"MS-06\",", plain),
                    Grund.SCHEMA_VERLETZT);
            assertSampleAbgewiesen(payload(version, TENANT, "", sample + ",\"messstelle\":\"MS-06\"}"),
                    Grund.SCHEMA_VERLETZT);
        }
        // An unknown or non-textual schema_version is never guessed.
        assertUmschlagAbgewiesen(payload("2.2", TENANT, "", plain), Grund.FASSUNG_UNBEKANNT);
        assertUmschlagAbgewiesen(payload("1.0", TENANT, "", plain), Grund.FASSUNG_UNBEKANNT);
        assertUmschlagAbgewiesen(payload("2.1", TENANT, "", plain).replace("\"2.1\"", "2.1"),
                Grund.FASSUNG_UNBEKANNT);
        // The provenance fields keep their shape.
        assertUmschlagAbgewiesen(payload("2.1", TENANT, "\"applied_revision\":-1,", plain), Grund.SCHEMA_VERLETZT);
        assertUmschlagAbgewiesen(payload("2.1", TENANT, "\"applied_revision\":1.5,", plain), Grund.SCHEMA_VERLETZT);
        assertUmschlagAbgewiesen(payload("2.1", TENANT, "\"applied_revision\":\"1\",", plain), Grund.SCHEMA_VERLETZT);
        assertSampleAbgewiesen(payload("2.1", TENANT, "", sample + ",\"entity_id\":\"K-5\"}"), Grund.SCHEMA_VERLETZT);
        assertSampleAbgewiesen(payload("2.1", TENANT, "", sample + ",\"entity_id\":\"1-1-1-1-1\"}"),
                Grund.SCHEMA_VERLETZT);
        assertSampleAbgewiesen(payload("2.1", TENANT, "", sample + ",\"entity_id\":5}"), Grund.SCHEMA_VERLETZT);
    }

    /** measurements.raw stays 1.0 with the 2.0 sample fields; a point that occurs once travels without entity_id. */
    @Test
    void a21EnvelopeProducesTheUnchangedRawEvent() {
        String sample = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\"";
        var from20 = validator.annehmen(TOPIC, payload("2.0", TENANT, "", sample + "}"), EINGANG).weiter();
        var from21 = validator.annehmen(TOPIC, payload("2.1", TENANT, "\"applied_revision\":1,",
                sample + ",\"entity_id\":\"" + ENTITY + "\"}"), EINGANG).weiter();
        assertThat(from21.schema_version()).isEqualTo("1.0");
        assertThat(from21.samples()).isEqualTo(from20.samples());
        assertThat(from21.samples().get(0).has("entity_id")).isFalse();
    }

    /**
     * IP-18b (Cloud-Vorpaket): derselbe point_key für zwei GENANNTE Komponenten ist zulässig und
     * behält seine Komponente im Ereignis; doppelt ist (point_key, entity_id). Ohne Komponente
     * bleibt die Eindeutigkeit des point_key, und ein einfacher Punkt reist unverändert ohne.
     */
    @Test
    void aPointSharedByTwoNamedComponentsKeepsBothAndOnlyThereTheComponent() {
        String e1 = "00000000-0000-0000-0000-0000000000c6";
        String punkt = "{\"point_key\":\"custom.wirkenergie-bezug\",\"raw\":50,\"quality\":\"good\"";
        String einzeln = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\","
                + "\"entity_id\":\"" + ENTITY + "\"}";
        var geteilt = validator.annehmen(TOPIC, payload("2.1", TENANT, "", String.join(",",
                punkt + ",\"entity_id\":\"" + ENTITY + "\"}", punkt + ",\"entity_id\":\"" + e1 + "\"}",
                einzeln)), EINGANG);
        assertThat(geteilt.ablehnungen()).isEmpty();
        assertThat(geteilt.weiter().schema_version()).isEqualTo("1.0");
        assertThat(geteilt.weiter().samples()).hasSize(3);
        assertThat(geteilt.weiter().samples().get(0).get("entity_id").asText()).isEqualTo(ENTITY);
        assertThat(geteilt.weiter().samples().get(1).get("entity_id").asText()).isEqualTo(e1);
        assertThat(geteilt.weiter().samples().get(2).has("entity_id")).isFalse();

        // Dieselbe Komponente zweimal: doppelt wie heute, beide Vorkommen verworfen.
        var gleich = validator.annehmen(TOPIC, payload("2.1", TENANT, "", String.join(",",
                punkt + ",\"entity_id\":\"" + ENTITY + "\"}",
                punkt + ",\"entity_id\":\"" + ENTITY.toUpperCase() + "\"}", einzeln)), EINGANG);
        assertThat(gleich.weiter().samples()).hasSize(1);
        assertThat(gleich.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.REGEL_VERLETZT, 2, null));

        // Ein Vorkommen ohne Komponente: die heutige Regel gilt für den ganzen Punkt.
        var gemischt = validator.annehmen(TOPIC, payload("2.1", TENANT, "", String.join(",",
                punkt + "}", punkt + ",\"entity_id\":\"" + e1 + "\"}", einzeln)), EINGANG);
        assertThat(gemischt.weiter().samples()).hasSize(1);
        assertThat(gemischt.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.REGEL_VERLETZT, 2, null));

        // Drei Vorkommen, eines doppelt: nur das Paar fällt, die dritte Komponente bleibt.
        var dreifach = validator.annehmen(TOPIC, payload("2.1", TENANT, "", String.join(",",
                punkt + ",\"entity_id\":\"" + ENTITY + "\"}", punkt + ",\"entity_id\":\"" + ENTITY + "\"}",
                punkt + ",\"entity_id\":\"" + e1 + "\"}")), EINGANG);
        assertThat(dreifach.weiter().samples()).hasSize(1);
        assertThat(dreifach.weiter().samples().get(0).get("entity_id").asText()).isEqualTo(e1);

        // 2.0 kennt keine Komponente: der doppelte Punkt bleibt doppelt.
        var alt = validator.annehmen(TOPIC, payload(TENANT, String.join(",", punkt + "}", punkt + "}")),
                EINGANG);
        assertThat(alt.weiter()).isNull();
        assertThat(alt.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.REGEL_VERLETZT, 2, null));
    }

    /** IP-5: one bad sample drops only itself; a bundle per reason; a duplicate key is never guessed. */
    @Test
    void aBadSampleDropsOnlyItselfAndIsCountedPerReason() {
        String good = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\"}";
        String word = "{\"point_key\":\"goe.api_v2.amp\",\"raw\":16,\"quality\":\"gut\"}";
        String noRaw1 = "{\"point_key\":\"goe.api_v2.car\",\"quality\":\"good\"}";
        String noRaw2 = "{\"point_key\":\"goe.api_v2.frc\",\"quality\":\"good\"}";
        var annahme = validator.annehmen(TOPIC,
                payload(TENANT, String.join(",", good, word, noRaw1, noRaw2)), EINGANG);
        assertThat(annahme.weiter().samples()).hasSize(1);
        assertThat(annahme.weiter().samples().get(0).get("point_key").asText()).isEqualTo("goe.api_v2.alw");
        assertThat(annahme.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.WORT_UNBEKANNT, 1, null),
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.SCHEMA_VERLETZT, 2, null));
        assertThat(annahme.absender().sequenz()).isEqualTo(4L);
        assertThat(annahme.absender().strom()).isEqualTo("measurement-samples");

        String twice = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":true,\"quality\":\"good\"}";
        var doppelt = validator.annehmen(TOPIC, payload(TENANT, String.join(",", good, twice,
                "{\"point_key\":\"goe.api_v2.amp\",\"raw\":16,\"quality\":\"good\"}")), EINGANG);
        assertThat(doppelt.weiter().samples()).hasSize(1);
        assertThat(doppelt.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.REGEL_VERLETZT, 2, null));
    }

    private void assertUmschlagAbgewiesen(String payload, Grund grund) {
        assertThatThrownBy(() -> validator.annehmen(TOPIC, payload, EINGANG))
                .as(payload).isInstanceOfSatisfying(UmschlagAbgewiesen.class,
                        e -> assertThat(e.grund()).isEqualTo(grund));
    }

    /** The only sample is refused: nothing is forwarded, and the refusal is counted. */
    private void assertSampleAbgewiesen(String payload, Grund grund) {
        var annahme = validator.annehmen(TOPIC, payload, EINGANG);
        assertThat(annahme.weiter()).as(payload).isNull();
        assertThat(annahme.ablehnungen()).as(payload)
                .isEqualTo(List.of(new Ablehnungen.Ablehnung(Ereignisart.REJECTED, grund, 1, null)));
    }

    private static String payload(String tenant, String sample) {
        return payload("2.0", tenant, "", sample);
    }

    private static String payload(String version, String tenant, String extra, String sample) {
        return "{\"schema_version\":\"" + version + "\",\"tenant_id\":\"" + tenant
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE
                + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":4,"
                + "\"observed_at\":\"2026-08-25T12:00:00Z\"," + extra + "\"samples\":[" + sample + "]}";
    }

    private static String fixture(String name) throws Exception {
        return Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "examples", name));
    }
}
