package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.uems.RuheRegel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Der WIRKLICH zusammengesetzte Registry-Push ({@link EntityRegistryService#composePush}) trägt
 * genau die Pausen-Felder des Blocks {@code push} von {@code docs/contracts/v2/override-vectors.json}
 * (UEMS AP-01 IP-4, R0) — dieselben Bytes, die der Go-Core in {@code ruhe_vectors_test.go} parst.
 * Ohne Pause und mit einer Pause von Hand ist der Push byte-gleich zum Stand davor.
 */
class EntityRegistryRuhePushTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "override-vectors.json");
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    @SuppressWarnings("unchecked")
    private static EntityRegistryService service(DeviceOverrideRepository overrides) {
        EntityRegistryRepository repo = mock(EntityRegistryRepository.class);
        when(repo.consumerCycleLimits(any())).thenReturn(Map.of());
        when(repo.activeConsumerPolicies(any())).thenReturn(Map.of());
        when(repo.chargePointIdsByEntity(any())).thenReturn(Map.of());
        when(repo.roleAssignments(any())).thenReturn(Map.of());
        return new EntityRegistryService(repo, mock(ObjectProvider.class), MAPPER, mock(EntityTypeCatalog.class),
                mock(AssetRepository.class), mock(FlowClaimRepository.class), overrides,
                new LeadDeviceService(repo),
                mock(BerichtsBelege.class));
    }

    private static DeviceOverrideRepository mitPause(String herkunft, Instant endsAt) {
        DeviceOverrideRepository overrides = mock(DeviceOverrideRepository.class);
        when(overrides.activePause(SITE)).thenReturn(herkunft == null && endsAt == null
                ? Optional.empty()
                : Optional.of(new DeviceOverrideRepository.Row(7L, SITE, DeviceOverrideRepository.KIND_PAUSE, null,
                        null, endsAt, null, "test", Instant.parse("2026-11-30T09:00:00Z"), herkunft)));
        return overrides;
    }

    private static JsonNode push(DeviceOverrideRepository overrides, Instant jetzt) throws Exception {
        return MAPPER.readTree(service(overrides).composePush(TENANT, SITE, DEVICE, jetzt, List.of()));
    }

    @TestFactory
    Stream<DynamicTest> derPushTraegtGenauDieFelderDerVektoren() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        JsonNode faelle = MAPPER.readTree(Files.readString(VECTORS)).path("push");
        assertThat(faelle.size()).isPositive();
        faelle.forEach(f -> tests.add(DynamicTest.dynamicTest(f.path("name").asText(), () -> {
            JsonNode pause = f.path("input").path("pause");
            Instant jetzt = Instant.parse(f.path("input").path("jetzt").asText());
            DeviceOverrideRepository overrides = pause.isNull()
                    ? mitPause(null, null)
                    : mitPause(pause.path("herkunft").isNull() ? null : pause.path("herkunft").asText(),
                            pause.path("ends_at").isNull() ? null : Instant.parse(pause.path("ends_at").asText()));
            JsonNode ist = push(overrides, jetzt);
            JsonNode felder = f.path("expected").path("felder");
            for (String feld : List.of(RuheRegel.FELD_ENDE, RuheRegel.FELD_WIDERRUF)) {
                assertThat(ist.has(feld)).as(feld + " vorhanden").isEqualTo(felder.has(feld));
                if (felder.has(feld)) {
                    JsonNode soll = felder.get(feld);
                    if (soll.isTextual()) {
                        assertThat(Instant.parse(ist.get(feld).asText())).as(feld)
                                .isEqualTo(Instant.parse(soll.asText()));
                    } else {
                        assertThat(ist.get(feld)).as(feld).isEqualTo(soll);
                    }
                }
            }
        })));
        return tests.stream();
    }

    /**
     * Bestandsschutz am Push: eine Pause von Hand erzeugt exakt die Bytes des Stands davor — das
     * Ende als {@code Instant.toString()}, kein zweites Feld — und ohne Pause fehlen beide Felder.
     */
    @Test
    void ohnePauseUndMitHandpauseBleibtDerPushByteGleich() throws Exception {
        Instant jetzt = Instant.parse("2026-12-01T08:00:00Z");
        Instant ende = Instant.parse("2026-12-01T10:15:30.123Z");
        byte[] ohne = service(mitPause(null, null)).composePush(TENANT, SITE, DEVICE, jetzt, List.of());
        byte[] mitHand = service(mitPause(null, ende)).composePush(TENANT, SITE, DEVICE, jetzt, List.of());

        String erwartet = new String(ohne, java.nio.charset.StandardCharsets.UTF_8).replace(
                "\"published_at\":\"" + jetzt + "\"",
                "\"published_at\":\"" + jetzt + "\",\"automation_paused_until\":\"" + ende + "\"");
        assertThat(new String(mitHand, java.nio.charset.StandardCharsets.UTF_8)).isEqualTo(erwartet);
        assertThat(MAPPER.readTree(ohne).has(RuheRegel.FELD_ENDE)).isFalse();
        assertThat(MAPPER.readTree(ohne).has(RuheRegel.FELD_WIDERRUF)).isFalse();
    }
}
