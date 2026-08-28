package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.command.CommandLogWriter;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.BudgetRow;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.ChargePointRow;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Der Parser des additiven {@code chargers}-Herzschlag-Blocks (Lastmanagement
 * Stufe 3) - ein REINER Test, er läuft ohne Docker (die Reise durch die echte
 * Datenbank steht in {@code ChargerApiTest}).
 *
 * <p>Was er schützt: aus jedem Feld hier wird ein Kundensatz über eine
 * Kundenanlage. Ein unbekanntes Wort darf keiner werden, und ein fehlender
 * Messwert darf nie als 0 erscheinen - ein Ladepunkt, der nichts meldet, lädt
 * nicht nachweislich nichts.
 */
class ChargerStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private DeviceChargerStatusRepository store;
    private ChargerComponentComposer composer;
    private CommandLogWriter commandLog;
    private ChargerStatusListener listener;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        devices = mock(DeviceRepository.class);
        store = mock(DeviceChargerStatusRepository.class);
        composer = mock(ChargerComponentComposer.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(DEVICE, SITE,
                "edge-ladepark", "inverter", null, "active", Instant.now(), Instant.now())));
        ObjectProvider<ChargerComponentComposer> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(composer);
        commandLog = mock(CommandLogWriter.class);
        ObjectProvider<CommandLogWriter> logProvider = mock(ObjectProvider.class);
        when(logProvider.getIfAvailable()).thenReturn(commandLog);
        listener = new ChargerStatusListener("tcp://localhost:1883", "", "", devices, store,
                provider, logProvider);
    }

    /** Ein Herzschlag hinein, die geschriebenen Zeilen heraus. */
    private Captured ingest(String block) {
        listener.handle(TOPIC, envelope(block).getBytes(StandardCharsets.UTF_8));
        ArgumentCaptor<BudgetRow> budget = ArgumentCaptor.forClass(BudgetRow.class);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<ChargePointRow>> chargers = ArgumentCaptor.forClass(List.class);
        verify(store).replaceForDevice(eq(DEVICE), eq(TENANT), eq(SITE), any(), budget.capture(),
                chargers.capture());
        return new Captured(budget.getValue(), chargers.getValue());
    }

    private record Captured(BudgetRow budget, List<ChargePointRow> chargers) {}

    private static String envelope(String block) {
        return "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"online\":true," + block + "}";
    }

    /** Das Beispiel-Szenario der abgenommenen Mockups, als Block. */
    private static String mockupBlock() {
        return "\"chargers\":{"
                + "\"reported_at\":\"2026-08-20T11:24:00Z\","
                + "\"enabled\":true,\"control_enabled\":true,"
                + "\"grid_limit_kw\":277,\"margin_pct\":10,\"min_power_kw\":30,"
                + "\"budget_kw\":82.3,\"allocated_kw\":82,\"measured_kw\":79,"
                + "\"site_load_kw\":167,\"site_grid_kw\":246,"
                + "\"budget_mode\":\"gemessen\",\"budget_note\":\"Das Budget folgt der Messung.\","
                + "\"eff_limit_kw\":277,\"safe_default_kw\":15,\"safe_default_holds\":true,"
                + "\"safe_worst_case_kw\":270,\"max_house_load_kw\":180,\"connector_count\":6,"
                + "\"chargers\":[{\"id\":\"saeule-1\",\"label\":\"Hof Nord\",\"connected\":true,"
                + "\"vendor\":\"Midapower\",\"model\":\"DC-240\",\"ready\":true,"
                + "\"last_seen\":\"2026-08-20T11:23:55Z\",\"connectors\":["
                + "{\"id\":1,\"status\":\"Charging\",\"charging\":true,\"allocated_kw\":41,"
                + "\"reason\":\"laedt\",\"reason_text\":\"lädt\",\"power_kw\":40,\"soc_pct\":62,"
                + "\"command_status\":\"Accepted\",\"readback\":\"ok\","
                + "\"session_since\":\"2026-08-20T10:41:00Z\"},"
                + "{\"id\":2,\"status\":\"Preparing\",\"charging\":false,\"allocated_kw\":0,"
                + "\"reason\":\"wartet_budget\",\"reason_text\":\"wartet - Budget vergeben\","
                + "\"next_turn\":\"2026-08-20T11:26:00Z\"}]}]}";
    }

    @Test
    void theWholeBlockIsStoredWithTheBoxOwnWords() {
        Captured c = ingest(mockupBlock());
        assertThat(c.budget().budgetKw()).isEqualTo(82.3);
        assertThat(c.budget().connectorCount()).isEqualTo(6);
        assertThat(c.budget().safeDefaultHolds()).isTrue();
        // ⚠ Der deutsche Satz wird DURCHGEREICHT, nie neu formuliert.
        assertThat(c.budget().budgetNote()).isEqualTo("Das Budget folgt der Messung.");
        assertThat(c.chargers()).hasSize(1);
        ChargePointRow p = c.chargers().get(0);
        assertThat(p.chargePointId()).isEqualTo("saeule-1");
        assertThat(p.label()).isEqualTo("Hof Nord");
        assertThat(p.vendor()).isEqualTo("Midapower");
        assertThat(p.connectors()).hasSize(2);
        assertThat(p.connectors().get(0).powerKw()).isEqualTo(40);
        assertThat(p.connectors().get(0).socPct()).isEqualTo(62);
        assertThat(p.connectors().get(0).sessionSince())
                .isEqualTo(Instant.parse("2026-08-20T10:41:00Z"));
        // Der Wartende trägt seinen Grund UND seinen geschätzten Termin.
        assertThat(p.connectors().get(1).reasonText()).isEqualTo("wartet - Budget vergeben");
        assertThat(p.connectors().get(1).nextTurn())
                .isEqualTo(Instant.parse("2026-08-20T11:26:00Z"));
        // Und die Säule wird zur Komponente - ohne einen Klick.
        verify(composer).ensureComposed(SITE, DEVICE);
    }

    /**
     * Cockpit Phase 1 / E2: die Sitzungsbilanz und das ALTER der Leistung
     * werden aufgenommen - beides Tatsachen, die nur die Box bilden kann.
     */
    @Test
    void theSessionBalanceAndTheAgeOfTheMeasurementAreIngested() {
        Captured c = ingest("\"chargers\":{\"chargers\":[{\"id\":\"saeule-1\","
                + "\"connectors\":[{\"id\":1,\"status\":\"Charging\",\"charging\":true,"
                + "\"power_kw\":11.04,\"energy_kwh\":1234.5,\"session_kwh\":8.25,"
                + "\"metered_at\":\"2026-08-28T11:59:55Z\","
                + "\"session_since\":\"2026-08-28T11:00:00Z\"}]}]}");
        var con = c.chargers().get(0).connectors().get(0);
        assertThat(con.sessionKwh()).isEqualTo(8.25);
        assertThat(con.meteredAt()).isEqualTo(Instant.parse("2026-08-28T11:59:55Z"));
        // Das kumulative Register bleibt daneben stehen - zwei verschiedene
        // Groessen, nie eine, die die andere ersetzt.
        assertThat(con.energyKwh()).isEqualTo(1234.5);
    }

    /**
     * Ein AELTERER Edge-Stand sendet die zwei Felder nicht - dann bleiben sie
     * null ("nicht gemeldet"), nie 0 bzw. "gerade eben". Genau davon haengt ab,
     * dass eine Flaeche ein stehengebliebenes Kilowatt nicht als aktuell
     * ausgibt.
     */
    @Test
    void anOlderEdgeSendsNeitherAndBothStayNull() {
        Captured c = ingest("\"chargers\":{\"chargers\":[{\"id\":\"saeule-1\","
                + "\"connectors\":[{\"id\":1,\"status\":\"Charging\",\"charging\":true,"
                + "\"power_kw\":11.04,\"energy_kwh\":1234.5}]}]}");
        var con = c.chargers().get(0).connectors().get(0);
        assertThat(con.sessionKwh()).isNull();
        assertThat(con.meteredAt()).isNull();
        assertThat(con.powerKw()).isEqualTo(11.04);
    }

    /**
     * Cockpit Phase 1 / C1: WO eine Säule laut BOX hängt wird aufgenommen - und
     * ein Wort ausserhalb des Vokabulars VERWORFEN statt gespeichert.
     *
     * <p>⚠ Verworfen heisst hier {@code null} = „nicht gemeldet", NIE „haus":
     * „haus" ist eine Aussage über die Bilanz der Anlage, und sie aus einem
     * Wort abzuleiten, das wir nicht verstehen, wäre genau die Erfindung, gegen
     * die das geschlossene Vokabular gebaut ist.
     */
    @Test
    void theReportedConnectionIsIngestedAndAnUnknownWordIsDropped() {
        Captured c = ingest("\"chargers\":{\"chargers\":[{\"id\":\"haus-1\",\"connection\":\"haus\"},"
                + "{\"id\":\"eigen-1\",\"connection\":\"eigen\"},"
                + "{\"id\":\"kaputt-1\",\"connection\":\"garage\"},"
                + "{\"id\":\"alt-1\"}]}");
        assertThat(c.chargers()).hasSize(4);
        assertThat(c.chargers().get(0).connection()).isEqualTo("haus");
        assertThat(c.chargers().get(1).connection()).isEqualTo("eigen");
        assertThat(c.chargers().get(2).connection()).isNull();
        // Eine ÄLTERE Box meldet es gar nicht - das ist weder „haus" noch
        // „eigen": erst eine Meldung belegt, dass die Unterscheidung dort
        // angekommen ist.
        assertThat(c.chargers().get(3).connection()).isNull();
    }

    @Test
    void aMissingMeasurementStaysNullAndIsNeverZero() {
        Captured c = ingest("\"chargers\":{\"chargers\":[{\"id\":\"saeule-still\","
                + "\"connectors\":[{\"id\":1,\"status\":\"Available\"}]}]}");
        var con = c.chargers().get(0).connectors().get(0);
        assertThat(con.powerKw()).isNull();
        assertThat(con.energyKwh()).isNull();
        assertThat(con.socPct()).isNull();
        assertThat(con.allocatedKw()).isNull();
        assertThat(con.sessionSince()).isNull();
        assertThat(c.budget().measuredKw()).isNull();
        assertThat(c.budget().siteGridKw()).isNull();
        // Ein nicht gemeldetes Urteil ist auch keins: dreiwertig, nicht false.
        assertThat(c.budget().safeDefaultHolds()).isNull();
    }

    @Test
    void aWordOutsideTheOcppVocabularyIsDroppedNotStored() {
        Captured c = ingest("\"chargers\":{\"chargers\":[{\"id\":\"saeule-1\",\"connectors\":["
                + "{\"id\":1,\"status\":\"Ladend\",\"readback\":\"vielleicht\"},"
                + "{\"id\":2,\"status\":\"Faulted\",\"readback\":\"abweichend\"}]}]}");
        var unknown = c.chargers().get(0).connectors().get(0);
        var known = c.chargers().get(0).connectors().get(1);
        // Verworfen, nicht gespeichert: der Stecker behält "kein Zustand
        // gemeldet" statt einen erfundenen zu bekommen.
        assertThat(unknown.status()).isNull();
        assertThat(unknown.readback()).isNull();
        assertThat(known.status()).isEqualTo("Faulted");
        assertThat(known.readback()).isEqualTo("abweichend");
    }

    @Test
    void aHeartbeatWithoutTheBlockChangesNothing() {
        listener.handle(TOPIC, envelope("\"soc_pct\":42").getBytes(StandardCharsets.UTF_8));
        verify(store, never()).replaceForDevice(any(), any(), any(), any(), any(), any());
        verify(composer, never()).ensureComposed(any(), any());
    }

    @Test
    void aSpoofedIdentityNeverReachesTheStore() {
        UUID other = UUID.fromString("00000000-0000-0000-0000-0000000000ff");
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + other + "\",\"chargers\":{\"chargers\":[{\"id\":\"x\"}]}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        verify(store, never()).replaceForDevice(any(), any(), any(), any(), any(), any());
    }

    @Test
    void anUnknownDeviceIsSkipped() {
        when(devices.findById(DEVICE)).thenReturn(Optional.empty());
        listener.handle(TOPIC, envelope(mockupBlock()).getBytes(StandardCharsets.UTF_8));
        verify(store, never()).replaceForDevice(any(), any(), any(), any(), any(), any());
    }

    @Test
    void theBlockIsBoundedSoAMisconfiguredPlantCannotInflateIt() {
        StringBuilder b = new StringBuilder("\"chargers\":{\"chargers\":[");
        for (int i = 0; i < 40; i++) {
            if (i > 0) {
                b.append(',');
            }
            b.append("{\"id\":\"s").append(i).append("\",\"connectors\":[");
            for (int c = 0; c < 20; c++) {
                if (c > 0) {
                    b.append(',');
                }
                b.append("{\"id\":").append(c).append("}");
            }
            b.append("]}");
        }
        b.append("]}");
        Captured c = ingest(b.toString());
        assertThat(c.chargers()).hasSize(16);
        assertThat(c.chargers().get(0).connectors()).hasSize(8);
    }

    /**
     * Der Kommando-Verlauf bekommt eine Periode je SÄULE - aber nur für eine,
     * die eine Komponente trägt: der Schlüssel dieser Tabelle ist eine
     * Komponenten-Id, und eine erfundene wäre eine zweite Identität.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theCommandLogGetsOnePeriodPerBoundStation() {
        UUID entityId = UUID.fromString("00000000-0000-0000-0000-0000000000aa");
        when(store.entityIdsByChargePoint(DEVICE)).thenReturn(java.util.Map.of("saeule-1", entityId));
        ingest(mockupBlock());
        ArgumentCaptor<List<CommandLogWriter.ChargerFacts>> facts =
                ArgumentCaptor.forClass(List.class);
        verify(commandLog).ingestChargers(eq(SITE), eq(DEVICE), facts.capture(), any());
        assertThat(facts.getValue()).hasSize(1);
        CommandLogWriter.ChargerFacts f = facts.getValue().get(0);
        assertThat(f.entityId()).isEqualTo(entityId);
        assertThat(f.charging()).isTrue();
        // Die Grenze der SÄULE ist die Summe ihrer Stecker (41 + 0).
        assertThat(f.allocatedKw()).isEqualTo(41.0);
        assertThat(f.reason()).isEqualTo("laedt");
        assertThat(f.confirmed()).isTrue();
    }

    /** Ohne Komponente wird die Säule im Verlauf AUSGELASSEN, nie geraten. */
    @Test
    @SuppressWarnings("unchecked")
    void anUnboundStationIsLeftOutOfTheCommandLog() {
        ingest(mockupBlock());
        ArgumentCaptor<List<CommandLogWriter.ChargerFacts>> facts =
                ArgumentCaptor.forClass(List.class);
        verify(commandLog).ingestChargers(eq(SITE), eq(DEVICE), facts.capture(), any());
        assertThat(facts.getValue()).isEmpty();
    }

    /** Eine Säule ohne Kennung ist keine Säule - sie wird ausgelassen, nie geraten. */
    @Test
    void anEntryWithoutAChargePointIdIsSkipped() {
        Captured c = ingest("\"chargers\":{\"chargers\":[{\"label\":\"namenlos\"},"
                + "{\"id\":\"saeule-1\"}]}");
        assertThat(c.chargers()).hasSize(1);
        assertThat(c.chargers().get(0).chargePointId()).isEqualTo("saeule-1");
    }

    /**
     * Stufe 4: die QUELLEN-Bahn wird aufbewahrt - MIT der Regel, dass ein Wort
     * ausserhalb des Vokabulars VERWORFEN und nicht gespeichert wird.
     */
    @Test
    void theSourceLaneIsStoredAndAnUnknownWordIsDiscarded() {
        Captured c = ingest("\"chargers\":{\"reported_at\":\"2026-08-20T13:24:00Z\","
                + "\"enabled\":true,\"surplus_policy\":\"nur_sonne\","
                + "\"storage_priority\":\"auto_vor_speicher\",\"surplus_active\":true,"
                + "\"surplus_kw\":65,\"surplus_mode\":\"gemessen\","
                + "\"surplus_note\":\"Ihre Priorität: Nur Sonnenstrom.\","
                + "\"surplus_total_kw\":85,\"surplus_battery_kw\":20,"
                + "\"source_allocated_kw\":60,\"connector_count\":1,"
                + "\"chargers\":[{\"id\":\"saeule-1\",\"connected\":true,\"connectors\":["
                + "{\"id\":1,\"charging\":true,\"allocated_kw\":65,\"boost\":true}]}]}");
        assertThat(c.budget().surplusPolicy()).isEqualTo("nur_sonne");
        assertThat(c.budget().storagePriority()).isEqualTo("auto_vor_speicher");
        assertThat(c.budget().surplusActive()).isTrue();
        assertThat(c.budget().surplusKw()).isEqualTo(65);
        assertThat(c.budget().surplusTotalKw()).isEqualTo(85);
        assertThat(c.budget().surplusBatteryKw()).isEqualTo(20);
        assertThat(c.budget().sourceAllocatedKw()).isEqualTo(60);
        // ⚠ Der deutsche Satz wird DURCHGEREICHT, nie neu formuliert.
        assertThat(c.budget().surplusNote()).isEqualTo("Ihre Priorität: Nur Sonnenstrom.");
        // Und eine laufende Übersteuerung ist sichtbar - eine volle Ladung, die
        // niemand angefordert hat, wäre ein stiller Bruch der Kunden-Priorität.
        assertThat(c.chargers().get(0).connectors().get(0).boost()).isTrue();
    }

    /**
     * Der Anbinde-Assistent braucht den ECHTEN Endpunkt, unter dem eine Saeule
     * die Box anwaehlt - die Adresse kennt das Portal seit D5, Port und Pfad
     * fehlten.
     */
    @Test
    void theOcppEndpointIsStored() {
        Captured c = ingest("\"chargers\":{\"reported_at\":\"2026-08-21T09:15:00Z\","
                + "\"enabled\":true,\"ocpp_port\":8887,\"url_path\":\"/ocpp\","
                + "\"chargers\":[{\"id\":\"saeule-1\",\"connected\":true}]}");
        assertThat(c.budget().ocppPort()).isEqualTo(8887);
        assertThat(c.budget().ocppUrlPath()).isEqualTo("/ocpp");
    }

    /**
     * ⚠ DREIWERTIG: null heisst „eine aeltere Box meldet es nicht" ODER „der
     * Server lauscht gerade nicht" - nie Port 0. Die Box laesst beides weg,
     * solange sie nicht lauscht, und die Flaeche faellt dann auf ihren
     * ehrlichen Vorgabe-Satz zurueck.
     */
    @Test
    void aBoxThatIsNotListeningReportsNoEndpointAtAll() {
        Captured silent = ingest("\"chargers\":{\"reported_at\":\"2026-08-21T09:15:00Z\","
                + "\"enabled\":true,"
                + "\"chargers\":[{\"id\":\"saeule-1\",\"connected\":true}]}");
        assertThat(silent.budget().ocppPort()).isNull();
        assertThat(silent.budget().ocppUrlPath()).isNull();
    }

    /**
     * Ein Port, den keine Saeule anwaehlen kann, wird VERWORFEN statt
     * gespeichert - eine Adresse, auf der niemand antwortet, ist die
     * schlechtere Auskunft als gar keine.
     */
    @ParameterizedTest
    @ValueSource(ints = {0, -1, 70000})
    void anImpossibleOcppPortIsDiscarded(int port) {
        Captured bad = ingest("\"chargers\":{\"reported_at\":\"2026-08-21T09:15:00Z\","
                + "\"enabled\":true,\"ocpp_port\":" + port + ","
                + "\"chargers\":[{\"id\":\"saeule-1\",\"connected\":true}]}");
        assertThat(bad.budget().ocppPort()).isNull();
    }

    /** Ein Wort ausserhalb des Vokabulars wird VERWORFEN, nie gespeichert. */
    @Test
    void anUnknownSourceWordIsDiscardedInsteadOfStored() {
        Captured garbage = ingest("\"chargers\":{\"reported_at\":\"2026-08-20T13:24:00Z\","
                + "\"enabled\":true,\"surplus_policy\":\"hoffentlich\","
                + "\"storage_priority\":\"irgendwas\",\"surplus_mode\":\"traumhaft\","
                + "\"chargers\":[{\"id\":\"saeule-1\",\"connected\":true}]}");
        assertThat(garbage.budget().surplusPolicy()).isNull();
        assertThat(garbage.budget().storagePriority()).isNull();
        assertThat(garbage.budget().surplusMode()).isNull();
    }

    /**
     * Eine ÄLTERE Box sendet den Block gar nicht - dann wird nichts behauptet,
     * und die Anlage sieht aus wie vor Stufe 4.
     */
    @Test
    void anOlderBoxReportsNoSourceLaneAtAll() {
        Captured c = ingest(mockupBlock());
        assertThat(c.budget().surplusPolicy()).isNull();
        assertThat(c.budget().surplusActive()).isFalse();
        assertThat(c.budget().surplusKw()).as("kein Messwert ist NIE eine 0").isNull();
        assertThat(c.chargers().get(0).connectors().get(0).boost()).isFalse();
    }
}
