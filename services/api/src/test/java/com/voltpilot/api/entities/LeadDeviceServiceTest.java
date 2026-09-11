package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository.BatteryAsset;
import com.voltpilot.api.entities.LeadDeviceService.FuehrendeBox;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung.Grund;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * {@link LeadDeviceService} gegen die Vektoren: jeder Fall von
 * {@code docs/contracts/v2/lead-device-vectors.json} geht durch den DIENST (Repository gemockt, je
 * Kennzeichen eine feste Geräte-UUID) und ergibt dieselbe Box und denselben Grund — die vier Fälle
 * gespeichert · Speicher-Box · einzige Box · keine (keine Wahl · keine Box · Wahl außerhalb der
 * Anlage), dazu A9 und A12. Dass die Aufrufer dieselbe Box wie die alte Weiche bekommen, beweist
 * {@link LeadDeviceBestandVerhaltensgleichTest}.
 */
class LeadDeviceServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2",
            "lead-device-vectors.json");

    /** Die feste Geräte-UUID eines Box-Kennzeichens der Vektoren. */
    private static UUID geraet(String kennzeichen) {
        return kennzeichen == null ? null
                : UUID.nameUUIDFromBytes(kennzeichen.getBytes(StandardCharsets.UTF_8));
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static BatteryAsset speicherAn(UUID geraet) {
        return new BatteryAsset(geraet, BigDecimal.TEN, BigDecimal.TEN, BigDecimal.valueOf(10),
                BigDecimal.valueOf(90));
    }

    private static FuehrendeBox fuehrendeBox(List<UUID> boxen, BatteryAsset speicher,
            UUID gespeichert) {
        EntityRegistryRepository repo = mock(EntityRegistryRepository.class);
        when(repo.siteDeviceIds(SITE)).thenReturn(boxen);
        when(repo.batteryAsset(SITE)).thenReturn(speicher);
        when(repo.storedLeadDeviceId(SITE)).thenReturn(gespeichert);
        return new LeadDeviceService(repo).fuehrendeBox(SITE);
    }

    @TestFactory
    List<DynamicTest> jederVektorFallGehtDurchDenDienst() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : MAPPER.readTree(Files.readString(VECTORS)).path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                List<UUID> boxen = new ArrayList<>();
                in.path("boxen").forEach(b -> boxen.add(geraet(b.asText())));
                String speicher = text(in.get("speicher_box"));
                FuehrendeBox ist = fuehrendeBox(boxen,
                        speicher == null ? null : speicherAn(geraet(speicher)),
                        geraet(text(in.get("gespeichert"))));
                assertThat(ist.box()).isEqualTo(geraet(text(c.path("expected").get("box"))));
                assertThat(ist.grund().code()).isEqualTo(c.path("expected").path("grund").asText());
                assertThat(ist.bestimmt()).isEqualTo(ist.grund().bestimmt());
            }));
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(4);
        return tests;
    }

    // Die vier Fälle und die zwei Abnahmefälle noch einmal ausgeschrieben, damit ein roter Lauf
    // sie beim Namen nennt.

    private static final UUID HALLE_1 = geraet("E-1");
    private static final UUID ZUSATZ = geraet("E-A9");

    @Test
    void gespeichertDieAusdruecklicheWahlFuehrt() {
        FuehrendeBox ist = fuehrendeBox(List.of(HALLE_1, ZUSATZ), null, ZUSATZ);
        assertThat(ist.box()).isEqualTo(ZUSATZ);
        assertThat(ist.grund()).isEqualTo(Grund.GESPEICHERT);
    }

    @Test
    void a12BestandskundeMitEinerBoxUndSpeicherBleibtBeiSeinerBox() {
        FuehrendeBox ist = fuehrendeBox(List.of(HALLE_1), speicherAn(HALLE_1), null);
        assertThat(ist.box()).isEqualTo(HALLE_1);
        assertThat(ist.grund()).isEqualTo(Grund.SPEICHER);
    }

    @Test
    void a9EineZweiteBoxAendertDieFuehrungNicht() {
        FuehrendeBox ist = fuehrendeBox(List.of(HALLE_1, ZUSATZ), speicherAn(HALLE_1), null);
        assertThat(ist.box()).isEqualTo(HALLE_1);
        assertThat(ist.grund()).isEqualTo(Grund.SPEICHER);
    }

    @Test
    void einzigeBoxOhneSpeicherFuehrt() {
        // Ein Speicher OHNE hinterlegtes Gerät zählt wie keiner (der Speicher-Auto-Link fehlt).
        FuehrendeBox ist = fuehrendeBox(List.of(HALLE_1), speicherAn(null), null);
        assertThat(ist.box()).isEqualTo(HALLE_1);
        assertThat(ist.grund()).isEqualTo(Grund.EINZIGE);
    }

    @Test
    void keineBoxFuehrtMitBenanntemGrundStattNull() {
        assertThat(fuehrendeBox(List.of(HALLE_1, ZUSATZ), null, null))
                .isEqualTo(new FuehrendeBox(null, Grund.KEINE_WAHL));
        assertThat(fuehrendeBox(List.of(), null, null))
                .isEqualTo(new FuehrendeBox(null, Grund.KEINE_BOX));
        // Eine gespeicherte Box, die nicht (mehr) in der Anlage angemeldet ist: keine Box führt,
        // auch nicht die Box des Speichers - nie still ausweichen.
        assertThat(fuehrendeBox(List.of(HALLE_1), speicherAn(HALLE_1), ZUSATZ))
                .isEqualTo(new FuehrendeBox(null, Grund.GESPEICHERT_NICHT_IN_ANLAGE));
    }
}
