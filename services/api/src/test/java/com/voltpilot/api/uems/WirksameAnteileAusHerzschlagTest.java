package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.web.dto.DeviceDto;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die wirksamen Anteile aus dem Herzschlag (UEMS AP-15 IP-17, Y3, A18): der Block, wie die Box ihn sendet, besteht
 * das Schema; der Status-Zuhörer reicht ihn nach der Identitäts- und Standort-Prüfung weiter; unbekannt ist keine
 * Null. Rein, ohne DB.
 */
class WirksameAnteileAusHerzschlagTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path VERTRAG = Path.of("../../docs/contracts/v2");
    private static final String BLOCK = """
            {"rolle":"steuert_mit","anteile_epoche":1,"anteile_revision":9,
             "anteile_kw":{"einspeisung":90.0,"bezug":77.0}}""";

    @Test
    void derBlockMitAnteilenBestehtDasSchemaAuchOhnePlan() throws Exception {
        JsonNode schema = JSON.readTree(Files.readString(VERTRAG.resolve("mqtt-plan-result.schema.json")));
        ObjectNode block = JSON.createObjectNode();
        block.setAll((ObjectNode) schema.path("$defs").path("herzschlag_block"));
        block.set("$defs", schema.path("$defs"));
        assertThat(UemsSchemaLaeufer.verstoesse(JSON.readTree(BLOCK), block)).isEmpty();
        assertThat(UemsSchemaLaeufer.verstoesse(JSON.readTree("""
                {"plan_id":"4711aaaa-0000-4000-8000-000000004711","waechter":{"einspeisung":"regelt"}}"""), block))
                .as("der Block aus IP-10 bleibt gültig").isEmpty();
        assertThat(UemsSchemaLaeufer.verstoesse(JSON.readTree("{\"rolle\":\"fuehrt\"}"), block))
                .as("ohne Plan und ohne Anteile kein Block").isNotEmpty();
        assertThat(UemsSchemaLaeufer.verstoesse(JSON.readTree("""
                {"anteile_epoche":1,"anteile_revision":9,"anteile_kw":{"einspeisung":90.0}}"""), block))
                .as("eine Richtung fehlt").isNotEmpty();
    }

    @Test
    void wirksamNurMitBeidenRichtungenUndAmEigenenStandort() throws Exception {
        WirksameAnteileAusHerzschlag q = new WirksameAnteileAusHerzschlag();
        UUID site = UUID.randomUUID();
        UUID box = UUID.randomUUID();
        assertThat(q.wirksam(site, box)).isEmpty();
        q.merke(site, box, JSON.readTree(BLOCK));
        assertThat(q.wirksam(site, box)).contains(Map.of(Grenzart.EINSPEISUNG, new BigDecimal("90.0"),
                Grenzart.BEZUG, new BigDecimal("77.0")));
        assertThat(q.wirksam(UUID.randomUUID(), box)).as("anderer Standort").isEmpty();
        q.merke(site, box, JSON.readTree("{\"anteile_kw\":{\"einspeisung\":90.0}}"));
        assertThat(q.wirksam(site, box)).as("eine Richtung fehlt: unbekannt, nicht null").isEmpty();
        q.merke(site, box, JSON.readTree(BLOCK));
        q.merke(site, box, JSON.readTree("{\"plan_id\":\"4711aaaa-0000-4000-8000-000000004711\"}"));
        assertThat(q.wirksam(site, box)).as("Block ohne Anteile").isEmpty();
        q.merke(site, box, JSON.readTree(BLOCK));
        q.merke(site, box, null);
        assertThat(q.wirksam(site, box)).as("Herzschlag ohne Block").isEmpty();
        q.merke(site, box, JSON.readTree("{\"anteile_kw\":{\"einspeisung\":-1,\"bezug\":0}}"));
        assertThat(q.wirksam(site, box)).as("negativ").isEmpty();
    }

    @Test
    void derStatusZuhoererReichtDenBlockWeiter() throws Exception {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID device = UUID.randomUUID();
        DeviceRepository devices = mock(DeviceRepository.class);
        when(devices.findById(device)).thenReturn(java.util.Optional.of(new DeviceDto(device, site, "VP-BOX-1",
                "gateway", null, "claimed", Instant.now(), Instant.now())));
        DataSourceStatusListener listener = new DataSourceStatusListener("tcp://unused", "", "", devices,
                mock(DeviceDataSourceStatusRepository.class), mock(BoxFaehigkeiten.class));
        WirksameAnteileAusHerzschlag q = new WirksameAnteileAusHerzschlag();
        listener.wirksameAnteile(q);
        ObjectNode herzschlag = JSON.createObjectNode();
        herzschlag.put("schema_version", "1.0");
        herzschlag.put("tenant_id", tenant.toString());
        herzschlag.put("site_id", site.toString());
        herzschlag.put("device_id", device.toString());
        herzschlag.put("ts", "2027-10-20T09:00:05Z");
        herzschlag.putArray("supports").add("steuerungsverbund_anteil");
        herzschlag.set("gemeinsame_steuerung", JSON.readTree(BLOCK));
        listener.handle("ems/" + tenant + "/" + site + "/" + device + "/status", JSON.writeValueAsBytes(herzschlag));
        assertThat(q.wirksam(site, device)).isPresent();
        // eine Box, die an einem anderen Standort hängt, als ihr Topic sagt, meldet nichts
        UUID fremd = UUID.randomUUID();
        herzschlag.put("site_id", fremd.toString());
        listener.handle("ems/" + tenant + "/" + fremd + "/" + device + "/status", JSON.writeValueAsBytes(herzschlag));
        assertThat(q.wirksam(fremd, device)).isEmpty();
        assertThat(EdgeSupports.NAMES).contains("steuerungsverbund_anteil");
    }
}
