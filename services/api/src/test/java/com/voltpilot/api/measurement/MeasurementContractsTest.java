package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService.SelectionPoint;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ErwarteteKadenz;
import com.voltpilot.api.uems.ErwarteteKadenz.Messkanal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

class MeasurementContractsTest {
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String STATUS_TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE
            + "/v2/measurement-config-status";
    private final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();

    @Test
    void publisherPayloadIsTheCommittedValidFixture() throws Exception {
        MeasurementConfigPublisher publisher = new MeasurementConfigPublisher(
                "tcp://unused:1883", "", "", mapper, ErwarteteKadenz.KEINE);
        SelectionPoint point = new SelectionPoint(null, "deye.hybrid_1p.battery.battery", true, 10,
                7, null, null, "2026.09.23.2", "test", null, null, "pending_edge",
                null, null, null, "thermal_bms", 90, 900, "fifteen_minute",
                null, null, null, null);
        State state = new State(DEVICE, SITE, null, 7, "2026.09.23.2", "pending_edge", null,
                null, null, List.of(point), List.of(), null);
        var actual = mapper.readTree(publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), state));
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.json")));
        assertThat(actual).isEqualTo(fixture);
        assertThat(MeasurementConfigPublisher.topic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE
                        + "/v2/measurement-config");
    }

    @Test
    void publisherCarriesConcreteCustomDefinitionToTheEdge() throws Exception {
        MeasurementConfigPublisher publisher = new MeasurementConfigPublisher(
                "tcp://unused:1883", "", "", mapper, ErwarteteKadenz.KEINE);
        var definition = mapper.readTree("{\"label\":\"Test\",\"sourceKind\":\"modbus_input\",\"address\":42,"
                + "\"selector\":\"input:0x002a\",\"valueType\":\"uint16\",\"widthBits\":16,"
                + "\"signed\":false,\"endian\":\"big\",\"scale\":1,\"unit\":\"V\","
                + "\"cadenceS\":30,\"retentionClass\":\"unclassified\",\"readOnly\":true,"
                + "\"requestCostMs\":400}");
        SelectionPoint point = new SelectionPoint(null, "custom.abc", true, 30, 8, null, null,
                "2026.08.25.1", "test", null, null, "pending_edge", null, null, definition,
                "unclassified", 90, 900, "fifteen_minute", "Test", "custom", "custom", "known");
        State state = new State(DEVICE, SITE, null, 8, "2026.08.25.1", "pending_edge", null,
                null, null, List.of(point), List.of(), null);
        var payload = mapper.readTree(publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), state));
        assertThat(payload.at("/selections/0/definition")).isEqualTo(definition);
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.custom.json")));
        assertThat(payload).isEqualTo(fixture);
    }

    /**
     * Schnitt 2: was ein eigener Messwert misst ({@code measures}) bleibt in der Cloud. Die Box
     * bekommt dieselben Bytes wie ohne Angabe — der Vertrag ist geschlossen, und eine ältere Box
     * verwürfe sonst die ganze Auswahl.
     */
    @Test
    void publisherGibtDieAngabeDesEigenenMesswertsNichtAnDieBox() throws Exception {
        MeasurementConfigPublisher publisher = new MeasurementConfigPublisher(
                "tcp://unused:1883", "", "", mapper, ErwarteteKadenz.KEINE);
        String ohne = "{\"label\":\"Test\",\"sourceKind\":\"modbus_input\",\"address\":42,"
                + "\"selector\":\"input:0x002a\",\"valueType\":\"uint16\",\"widthBits\":16,"
                + "\"signed\":false,\"endian\":\"big\",\"scale\":1,\"unit\":\"V\","
                + "\"cadenceS\":30,\"retentionClass\":\"unclassified\",\"readOnly\":true,"
                + "\"requestCostMs\":400";
        var definition = mapper.readTree(ohne + ",\"measures\":{\"quantity\":\"active_power\","
                + "\"direction\":\"import\",\"aggregationKind\":\"gauge\"}}");
        SelectionPoint point = new SelectionPoint(null, "custom.abc", true, 30, 8, null, null,
                "2026.08.25.1", "test", null, null, "pending_edge", null, null, definition,
                "unclassified", 90, 900, "fifteen_minute", "Test", "custom", "custom", "known");
        State state = new State(DEVICE, SITE, null, 8, "2026.08.25.1", "pending_edge", null,
                null, null, List.of(point), List.of(), null);
        var payload = mapper.readTree(publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), state));
        assertThat(payload.at("/selections/0/definition")).isEqualTo(mapper.readTree(ohne + "}"));
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.custom.json")));
        assertThat(payload).isEqualTo(fixture);
        assertThat(definition.has("measures")).as("die gespeicherte Zeile bleibt unberührt").isTrue();
    }

    /**
     * <b>NW-3 Punkt 4 (AP-14 IP-6): die Auswahl, die die AUSGELIEFERTE Box am Simulator des
     * Release-Tags wirklich liest.</b> Der Lauf {@code tools/nw3-box-image/nw3.sh --strecke}
     * stellt genau diese Bytes ueber den echten Broker zu - sie sind darum hier an den ERZEUGER
     * gebunden und nicht von Hand geschrieben.
     *
     * <p><b>Warum ein {@code custom.}-Punkt und kein {@code sunspec.*} aus dem Katalog:</b> der
     * Simulator des Tags ({@code edge/sim/sunspec-sim.js}) ist eine kompakte 64-Register-Karte
     * und KEIN echtes SunSpec-Geraet - er traegt keine SID-Marke, also findet die
     * Modell-Erkennung der Palette nichts und ein modell-relativer Punkt wird zwar ANGENOMMEN,
     * aber nie gelesen. Ein {@code custom.}-Punkt adressiert das Halteregister absolut; er ist
     * derselbe Weg, den die Cloud fuer jeden nicht-katalogisierten Kunden-Punkt geht
     * (vgl. {@link #publisherCarriesConcreteCustomDefinitionToTheEdge()}), und Register 4 ist
     * der dokumentierte Ladezustand der simulierten Anlage (uint16, 0,1 %).
     */
    @Test
    void nw3AuswahlAmSimulatorIstDieFestgenagelteNutzlast() throws Exception {
        MeasurementConfigPublisher publisher = new MeasurementConfigPublisher(
                "tcp://unused:1883", "", "", mapper, ErwarteteKadenz.KEINE);
        var definition = mapper.readTree("{\"label\":\"Ladezustand (Simulator)\","
                + "\"sourceKind\":\"modbus_holding\",\"address\":4,"
                + "\"selector\":\"holding:0x0004\",\"valueType\":\"uint16\",\"widthBits\":16,"
                + "\"signed\":false,\"endian\":\"big\",\"scale\":0.1,\"unit\":\"%\","
                + "\"cadenceS\":10,\"retentionClass\":\"unclassified\",\"readOnly\":true,"
                + "\"requestCostMs\":400}");
        SelectionPoint point = new SelectionPoint(null, "custom.sim.soc", true, 10, 8, null, null,
                "2026.08.26.3", "test", null, null, "pending_edge", null, null, definition,
                "unclassified", 90, 900, "fifteen_minute", "Ladezustand (Simulator)", "custom",
                "custom", "known");
        State state = new State(DEVICE, SITE, null, 8, "2026.08.26.3", "pending_edge", null,
                null, null, List.of(point), List.of(), null);
        var payload = mapper.readTree(publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), state));
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.nw3-simulator.json")));
        assertThat(payload).isEqualTo(fixture);
        // Die Revision liegt UEBER der von Punkt 3 (7): die Box wendet nur eine hoehere an.
        assertThat(fixture.path("revision").asInt()).isGreaterThan(
                mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                        "examples", "mqtt-measurement-config.valid.json"))).path("revision").asInt());
        // Der Katalogstand ist der des Tags - eine Abweichung weist die Box als
        // `unsupported_catalog` KOMPLETT ab (measurement-planner.js buildPlan).
        assertThat(fixture.path("catalog_version").asText()).isEqualTo("2026.08.26.3");
    }

    @Test
    void statusIdentityAndMonotoneRevisionAreEnforced() throws Exception {
        MeasurementSelectionRepository repository = mock(MeasurementSelectionRepository.class);
        when(repository.aktiverDeviceScope(DEVICE)).thenReturn(new DeviceScope(TENANT, SITE, DEVICE));
        when(repository.revision(DEVICE)).thenReturn(8L);
        when(repository.acknowledgedRevision(DEVICE)).thenReturn(6L);
        MeasurementConfigStatusListener listener = new MeasurementConfigStatusListener(
                "tcp://unused:1883", "", "", repository, mapper);

        byte[] valid = fixture("mqtt-measurement-config-status.valid.json");
        assertThat(listener.handle(STATUS_TOPIC, valid)).isTrue();
        verify(repository).applyAcknowledgement(eq(DEVICE), eq(7L),
                eq(Instant.parse("2026-08-25T12:00:00Z")),
                eq(Set.of("deye.hybrid_1p.battery.battery")), eq(Map.of()),
                eq("2026.08.25"));
        assertThat(TenantContext.get()).isNull();

        when(repository.acknowledgedRevision(DEVICE)).thenReturn(8L);
        assertThat(listener.handle(STATUS_TOPIC, valid)).isFalse();
        assertThat(listener.handle(STATUS_TOPIC,
                new String(valid).replace("\"edge_version\"", "\"unexpected\":1,\"edge_version\"")
                        .getBytes())).isFalse();
        assertThat(listener.handle(STATUS_TOPIC.replace(TENANT.toString(),
                "10000000-0000-0000-0000-000000000001"), valid)).isFalse();
        verify(repository, never()).applyAcknowledgement(eq(DEVICE), eq(8L), any(), any(), any(), any());
        // Eine Quittung ohne entity_id nimmt nie den Weg je Komponente (AP-07 IP-18b).
        verify(repository, never()).applyAcknowledgementJeKomponente(any(), anyLong(), any(), any(), any(),
                any(), any());
    }

    /**
     * AP-07 IP-18b Einschalten, Status je Komponente ({@code x-rejection-entity-rule}): die Box lehnt
     * EINE Komponente eines geteilten Punkts ab und liest ihn für die andere - vorher verwarf der
     * Listener eine solche Quittung ganz ({@code entity_id} war kein erlaubtes Feld). Die Fälle,
     * die der Core ablehnt ({@code geteilter_punkt_test.go}), lehnt auch die Cloud ab.
     */
    @Test
    void statusJeKomponenteNimmtDieAblehnungEinerKomponenteAn() throws Exception {
        MeasurementSelectionRepository repository = mock(MeasurementSelectionRepository.class);
        when(repository.aktiverDeviceScope(DEVICE)).thenReturn(new DeviceScope(TENANT, SITE, DEVICE));
        when(repository.revision(DEVICE)).thenReturn(10L);
        when(repository.acknowledgedRevision(DEVICE)).thenReturn(9L);
        MeasurementConfigStatusListener listener = new MeasurementConfigStatusListener(
                "tcp://unused:1883", "", "", repository, mapper);
        UUID b = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
        String geteilt = "deye.hybrid_1p.battery.battery";
        java.util.function.Function<String, byte[]> status = rejected -> ("{\"schema_version\":\"2.0\","
                + "\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE
                + "\",\"revision\":10,\"applied_at\":\"2026-09-23T10:00:00Z\",\"accepted\":[\"" + geteilt
                + "\"],\"rejected\":[" + rejected + "],\"edge_version\":\"edge-test\"}").getBytes();

        assertThat(listener.handle(STATUS_TOPIC, status.apply("{\"point_key\":\"" + geteilt
                + "\",\"reason\":\"binding_unavailable\",\"entity_id\":\"" + b + "\"}"))).isTrue();
        verify(repository).applyAcknowledgementJeKomponente(eq(DEVICE), eq(10L),
                eq(Instant.parse("2026-09-23T10:00:00Z")), eq(Set.of(geteilt)), eq(Map.of()),
                eq(Map.of(new MeasurementSelectionRepository.KomponentenAblehnung(geteilt, b),
                        "binding_unavailable")), eq("edge-test"));
        verify(repository, never()).applyAcknowledgement(any(), anyLong(), any(), any(), any(), any());

        String a = "00000000-0000-0000-0000-0000000000a1";
        for (String kaputt : List.of(
                // ganzer Punkt angenommen UND abgelehnt
                "{\"point_key\":\"" + geteilt + "\",\"reason\":\"binding_unavailable\"}",
                // dieselbe Komponente zweimal, auch in anderer Schreibweise
                "{\"point_key\":\"p.other\",\"reason\":\"binding_unavailable\",\"entity_id\":\"" + a + "\"},"
                        + "{\"point_key\":\"p.other\",\"reason\":\"unknown_point\",\"entity_id\":\""
                        + a.toUpperCase() + "\"}",
                // Komponente neben ganzem Punkt, in beiden Reihenfolgen
                "{\"point_key\":\"p.other\",\"reason\":\"unknown_point\"},"
                        + "{\"point_key\":\"p.other\",\"reason\":\"binding_unavailable\",\"entity_id\":\"" + a + "\"}",
                "{\"point_key\":\"p.other\",\"reason\":\"binding_unavailable\",\"entity_id\":\"" + a + "\"},"
                        + "{\"point_key\":\"p.other\",\"reason\":\"unknown_point\"}",
                // kaputte Komponente
                "{\"point_key\":\"p.other\",\"reason\":\"binding_unavailable\",\"entity_id\":\"nope\"}",
                "{\"point_key\":\"p.other\",\"reason\":\"binding_unavailable\",\"entity_id\":\"1-1-1-1-1\"}",
                "{\"point_key\":\"p.other\",\"reason\":\"binding_unavailable\",\"entity_id\":7}",
                // unbekanntes Wort bleibt unbekannt, auch je Komponente
                "{\"point_key\":\"p.other\",\"reason\":\"erfunden\",\"entity_id\":\"" + a + "\"}")) {
            assertThat(listener.handle(STATUS_TOPIC, status.apply(kaputt))).as(kaputt).isFalse();
        }
        verify(repository).applyAcknowledgementJeKomponente(any(), anyLong(), any(), any(), any(), any(), any());
    }

    @Test
    void statusOfAnAusgebauteBoxIsDiscarded() throws Exception {
        // The box is still RLS-visible for its history (deviceScope), but no longer takes part in
        // operation (aktiverDeviceScope, UEMS AP-07 IP-11): its acknowledgement must not land.
        MeasurementSelectionRepository repository = mock(MeasurementSelectionRepository.class);
        when(repository.deviceScope(DEVICE)).thenReturn(new DeviceScope(TENANT, SITE, DEVICE));
        when(repository.aktiverDeviceScope(DEVICE)).thenReturn(null);
        when(repository.revision(DEVICE)).thenReturn(8L);
        when(repository.acknowledgedRevision(DEVICE)).thenReturn(6L);
        MeasurementConfigStatusListener listener = new MeasurementConfigStatusListener(
                "tcp://unused:1883", "", "", repository, mapper);

        assertThat(listener.handle(STATUS_TOPIC,
                fixture("mqtt-measurement-config-status.valid.json"))).isFalse();
        verify(repository).aktiverDeviceScope(DEVICE);
        verify(repository, never()).applyAcknowledgement(any(), anyLong(), any(), any(), any(), any());
        assertThat(TenantContext.get()).isNull();
    }

    @Test
    void initialStatusBrokerOutageDoesNotWedgeFutureRetries() {
        var listener = new MeasurementConfigStatusListener("tcp://127.0.0.1:1", "", "",
                mock(MeasurementSelectionRepository.class), mapper);
        listener.ensureConnected();
        assertThat(listener.connectedForTest()).isFalse();
        listener.ensureConnected();
        assertThat(listener.connectedForTest()).isFalse();
        listener.close();
    }

    @SuppressWarnings("unchecked")
    @Test
    void publisherBindsAnUnambiguousComponentAndCollapsesTheSameRegisterOfTwo()
            throws Exception {
        MeasurementConfigPublisher publisher = new MeasurementConfigPublisher(
                "tcp://unused:1883", "", "", mapper, ErwarteteKadenz.KEINE);
        UUID left = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
        UUID right = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
        String shared = "deye.hybrid_1p.battery.battery";

        State bound = new State(DEVICE, SITE, null, 9, "2026.08.26.3", "pending_edge", null,
                null, null,
                List.of(selection(left, shared, 10),
                        selection(null, "deye.hybrid_1p.battery.battery-voltage", 30)),
                List.of(), null);
        var payload = mapper.readTree(
                publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), bound));
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.per-component.json")));
        assertThat(payload).isEqualTo(fixture);

        // The edge keys its poll plan on the point key alone and refuses a
        // duplicate, so two components watching ONE register arrive once - with
        // the faster wish and WITHOUT a binding nobody could honour.
        State ambiguous = new State(DEVICE, SITE, null, 10, "2026.08.26.3", "pending_edge",
                null, null, null,
                List.of(selection(left, shared, 30), selection(right, shared, 10)),
                List.of(), null);
        var collapsed = mapper.readTree(
                publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), ambiguous));
        assertThat(collapsed.at("/selections")).hasSize(1);
        assertThat(collapsed.at("/selections/0/cadence_s").asInt()).isEqualTo(10);
        assertThat(collapsed.at("/selections/0/entity_id").isMissingNode()).isTrue();

        // A component row next to the box row for the same key is ambiguous too.
        State mixed = new State(DEVICE, SITE, null, 11, "2026.08.26.3", "pending_edge",
                null, null, null,
                List.of(selection(null, shared, 30), selection(left, shared, 60)),
                List.of(), null);
        var mixedPayload = mapper.readTree(
                publisher.payload(new DeviceScope(TENANT, SITE, DEVICE), mixed));
        assertThat(mixedPayload.at("/selections")).hasSize(1);
        assertThat(mixedPayload.at("/selections/0/entity_id").isMissingNode()).isTrue();
        assertThat(mixedPayload.at("/selections/0/cadence_s").asInt()).isEqualTo(30);
    }

    /**
     * UEMS AP-07 IP-10: die Soll-Kadenz kommt jetzt aus der Quellenbindung — und AM DRAHT ÄNDERT
     * SICH NICHTS. Bewiesen an der festgeschriebenen Beispieldatei:
     *
     * <ul>
     *   <li>trägt die Fassung DIESELBE Zahl wie die Auswahl, ist das Dokument ZEICHENGLEICH mit
     *       ihr — nur die Quelle der Zahl hat gewechselt;</li>
     *   <li>trägt sie eine andere, unterscheidet sich GENAU EIN Wert ({@code cadence_s}): dieselben
     *       Felder, dieselbe Reihenfolge, {@code schema_version} weiter 2.0;</li>
     *   <li>ohne Fassung gilt die Auswahl, Zeichen für Zeichen wie vor IP-10;</li>
     *   <li>eine Zahl außerhalb der Schranken des Drahtvertrags wird übergangen, nie
     *       zurechtgebogen;</li>
     *   <li>eine Zeile ohne Komponente (alte Box-Semantik) fragt nie nach einer Fassung.</li>
     * </ul>
     */
    @Test
    void dieKadenzKommtAusDerFassungUndDerDrahtBleibtDerselbe() throws Exception {
        UUID left = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
        String shared = "deye.hybrid_1p.battery.battery";
        State state = new State(DEVICE, SITE, null, 9, "2026.08.26.3", "pending_edge", null, null, null,
                List.of(selection(left, shared, 10),
                        selection(null, "deye.hybrid_1p.battery.battery-voltage", 30)),
                List.of(), null);
        var fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.per-component.json")));

        // Dieselbe Zahl aus der neuen Wahrheit: das Dokument ist zeichengleich mit der Datei.
        assertThat(mapper.readTree(publisher(Map.of(new Messkanal(left, shared), 10))
                .payload(new DeviceScope(TENANT, SITE, DEVICE), state))).isEqualTo(fixture);

        // Eine andere Zahl: GENAU cadence_s wandert, sonst nichts.
        var abweichend = mapper.readTree(publisher(Map.of(new Messkanal(left, shared), 30))
                .payload(new DeviceScope(TENANT, SITE, DEVICE), state));
        assertThat(abweichend.at("/selections/0/cadence_s").asInt()).isEqualTo(30);
        var erwartet = fixture.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) erwartet.at("/selections/0")).put("cadence_s", 30);
        assertThat(abweichend).isEqualTo(erwartet);
        assertThat(abweichend.at("/schema_version").asText()).isEqualTo("2.0");
        assertThat(feldnamen(abweichend.at("/selections/0")))
                .containsExactlyElementsOf(feldnamen(fixture.at("/selections/0")));

        // Ohne Fassung: die Auswahl, wie vor IP-10.
        assertThat(mapper.readTree(publisher(Map.of())
                .payload(new DeviceScope(TENANT, SITE, DEVICE), state))).isEqualTo(fixture);

        // Außerhalb 1 … 86 400 s: übergangen, nie zurechtgebogen.
        for (int daneben : new int[] {0, -10, 86401}) {
            assertThat(mapper.readTree(publisher(Map.of(new Messkanal(left, shared), daneben))
                    .payload(new DeviceScope(TENANT, SITE, DEVICE), state))).isEqualTo(fixture);
        }

        // Eine Zeile ohne Komponente fragt nie nach einer Fassung.
        State ohneKomponente = new State(DEVICE, SITE, null, 9, "2026.08.26.3", "pending_edge", null, null,
                null, List.of(selection(null, shared, 10)), List.of(), null);
        MeasurementConfigPublisher zaehlend = new MeasurementConfigPublisher("tcp://unused:1883", "", "",
                mapper, (kanaele, zeitpunkt) -> {
                    assertThat(kanaele).isEmpty();
                    return Map.of();
                });
        assertThat(mapper.readTree(zaehlend.payload(new DeviceScope(TENANT, SITE, DEVICE), ohneKomponente))
                .at("/selections/0/cadence_s").asInt()).isEqualTo(10);
    }

    private MeasurementConfigPublisher publisher(Map<Messkanal, Integer> fassungen) {
        return new MeasurementConfigPublisher("tcp://unused:1883", "", "", mapper,
                (kanaele, zeitpunkt) -> fassungen);
    }

    private static List<String> feldnamen(com.fasterxml.jackson.databind.JsonNode n) {
        List<String> namen = new java.util.ArrayList<>();
        n.fieldNames().forEachRemaining(namen::add);
        return namen;
    }

    private static SelectionPoint selection(UUID entityId, String pointKey, Integer cadenceS) {
        return new SelectionPoint(entityId, pointKey, true, cadenceS, 9, null, null,
                "2026.08.26.3", "test", null, null, "pending_edge", null, null, null,
                "thermal_bms", 90, 900, "fifteen_minute", null, null, null, null);
    }

    @Test
    void pendingDesiredRevisionIsRepublishedByReconciliation() {
        JdbcTemplate admin = mock(JdbcTemplate.class);
        MeasurementSelectionService service = mock(MeasurementSelectionService.class);
        MeasurementConfigPublisher publisher = mock(MeasurementConfigPublisher.class);
        DeviceScope scope = new DeviceScope(TENANT, SITE, DEVICE);
        State state = new State(DEVICE, SITE, null, 9, "2026.08.25.1", "pending_edge", null,
                null, null, List.of(), List.of(), null);
        when(admin.query(anyString(), any(RowMapper.class))).thenReturn(List.of(scope));
        when(service.forPublishing(DEVICE)).thenReturn(state);
        new MeasurementConfigReconciler(admin, service, publisher).reconcile();
        verify(publisher).publish(scope, state);
        assertThat(TenantContext.get()).isNull();
    }

    @Test
    void rollupHardeningIsReplayAwareAndQualityCorrect() throws Exception {
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V20260849000000__measurement_pipeline_review_hardening.sql"));
        assertThat(sql).contains("quality = 'good'")
                .contains("now()-INTERVAL '90 days'")
                .doesNotContain("now()-INTERVAL '2 days'");
    }

    private static byte[] fixture(String name) throws Exception {
        return Files.readAllBytes(Path.of("..", "..", "docs", "contracts", "v2", "examples", name));
    }
}
