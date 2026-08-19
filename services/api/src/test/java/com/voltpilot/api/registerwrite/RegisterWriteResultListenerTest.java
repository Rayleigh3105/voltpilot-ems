package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Der Quittungs-Zuhörer - rein, ohne Docker (die Reise durch echtes EMQX + DB
 * steht in {@code RegisterWriteApiTest}).
 *
 * <p>Er trägt drei Aussagen, die diese Stufe ausmachen: eine Quittung wird
 * PERSISTIERT, auch wenn niemand mehr wartet (ein Schreibvorgang darf nie
 * spurlos sein); ein Probelauf wird NICHT protokolliert (ein Protokoll der
 * Lesungen begräbt die Schreibvorgänge); und ein Wort außerhalb der
 * geschlossenen Fehlermenge wird VERWORFEN, statt vor einen Kunden zu geraten.
 *
 * <p>Die beiden Ergebnis-Fixtures des Kontrakts werden PER PFAD gelesen - der
 * echte Parser liest genau die Bytes, die auch die Box erzeugt.
 */
class RegisterWriteResultListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC =
            "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/register-write-result";

    private DeviceRepository devices;
    private RegisterWriteEventRepository journal;
    private RegisterWriteRegistry registry;
    private RegisterWriteResultListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        journal = mock(RegisterWriteEventRepository.class);
        registry = new RegisterWriteRegistry();
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(DEVICE, SITE,
                "demo-inverter-01", "inverter", null, "active", Instant.now(), Instant.now())));
        listener = new RegisterWriteResultListener("tcp://localhost:1883", "", "", registry,
                journal, devices);
    }

    private static String fixture(String name) throws Exception {
        Path p = Path.of("..", "..", "docs", "contracts", "examples", name).normalize();
        assertThat(Files.exists(p)).as("Kontrakt-Fixture " + p).isTrue();
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    @Test
    void theContractsSuccessFixtureIsParsedAsSpecifiedAndJournalled() throws Exception {
        CompletableFuture<RegisterWriteResult> waiting =
                registry.register("9f2c41ab77d05e14", DEVICE);

        listener.handle(TOPIC, fixture("mqtt-register-write.valid.result.json")
                .getBytes(StandardCharsets.UTF_8));

        RegisterWriteResult r = waiting.getNow(null);
        assertThat(r).isNotNull();
        assertThat(r.ok()).isTrue();
        assertThat(r.beforeRaw()).isEqualTo(3300);
        assertThat(r.afterRaw()).isEqualTo(7000);
        assertThat(r.adopted()).isTrue();
        assertThat(r.outcome()).isEqualTo(RegisterWriteResult.OUTCOME_ADOPTED);
        assertThat(r.targetLabel()).contains("192.168.0.28");

        ArgumentCaptor<RegisterWriteEventRepository.Receipt> row =
                ArgumentCaptor.forClass(RegisterWriteEventRepository.Receipt.class);
        verify(journal).recordOutcome(row.capture());
        assertThat(row.getValue().event())
                .isEqualTo(RegisterWriteEventRepository.EVENT_RECEIPT);
        assertThat(row.getValue().adopted()).isTrue();
        assertThat(row.getValue().beforeRaw()).isEqualTo(3300);
        assertThat(row.getValue().reason()).contains("übernommen");
    }

    @Test
    void aReceiptIsJournalledEvenWhenNobodyIsWaitingAnymore() throws Exception {
        // Der wartende Aufruf hat längst „Zustand unbekannt" gesagt. Trifft die
        // Quittung Sekunden später doch ein, ist das Journal der Ort, an dem sie
        // sichtbar wird - sonst wäre ein Schreibvorgang spurlos.
        listener.handle(TOPIC, fixture("mqtt-register-write.valid.result.json")
                .getBytes(StandardCharsets.UTF_8));

        verify(journal).recordOutcome(ArgumentCaptor
                .forClass(RegisterWriteEventRepository.Receipt.class).capture());
    }

    @Test
    void aPreviewIsDeliveredButNeverJournalled() throws Exception {
        CompletableFuture<RegisterWriteResult> waiting =
                registry.register("9f2c41ab77d05e15", DEVICE);

        listener.handle(TOPIC, fixture("mqtt-register-write.valid.result-refused.json")
                .getBytes(StandardCharsets.UTF_8));

        RegisterWriteResult r = waiting.getNow(null);
        assertThat(r).isNotNull();
        assertThat(r.mode()).isEqualTo(RegisterWriteResult.MODE_READ);
        assertThat(r.errorCode()).isEqualTo("refused_control_owned");
        assertThat(r.outcome()).isEqualTo(RegisterWriteResult.OUTCOME_REFUSED);
        assertThat(r.beforeRaw()).as("ein Fehlschlag trägt nie einen erfundenen Wert").isNull();
        verify(journal, never()).recordOutcome(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void anInventedErrorWordNeverReachesACustomer() {
        CompletableFuture<RegisterWriteResult> waiting = registry.register("aabbccdd11223344",
                DEVICE);

        listener.handle(TOPIC, result("aabbccdd11223344", "schreiben", false,
                ",\"error_code\":\"ich_hatte_keine_lust\",\"message\":\"…\"")
                .getBytes(StandardCharsets.UTF_8));

        RegisterWriteResult r = waiting.getNow(null);
        assertThat(r).isNotNull();
        assertThat(r.errorCode()).as("was wir nicht verstehen, darf kein Satz werden").isNull();
        // Ohne bekannte Klasse bleibt es ein ehrlicher Fehler, keine Ablehnung.
        assertThat(r.outcome()).isEqualTo(RegisterWriteResult.OUTCOME_ERROR);
    }

    @Test
    void aSpoofedIdentityIsIgnoredOutright() {
        CompletableFuture<RegisterWriteResult> waiting = registry.register("aabbccdd11223345",
                DEVICE);
        UUID stranger = UUID.fromString("00000000-0000-0000-0000-0000000000ff");

        // Das Topic gehört DEVICE, die Nutzlast behauptet ein anderes Gerät.
        listener.handle(TOPIC, ("{\"schema_version\":\"1.0\",\"type\":\"register_write_result\""
                + ",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\""
                + ",\"device_id\":\"" + stranger + "\",\"request_id\":\"aabbccdd11223345\""
                + ",\"answered_at\":\"2026-08-19T14:02:49Z\",\"mode\":\"schreiben\",\"ok\":true}")
                .getBytes(StandardCharsets.UTF_8));

        assertThat(waiting.getNow(null)).isNull();
        verify(journal, never()).recordOutcome(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void anUnknownModeMakesTheWholeReceiptUnusable() {
        CompletableFuture<RegisterWriteResult> waiting = registry.register("aabbccdd11223346",
                DEVICE);

        listener.handle(TOPIC, result("aabbccdd11223346", "loeschen", true, "")
                .getBytes(StandardCharsets.UTF_8));

        assertThat(waiting.getNow(null)).isNull();
        verify(journal, never()).recordOutcome(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void anAcceptedButUnadoptedWriteIsItsOwnHonestOutcome() {
        CompletableFuture<RegisterWriteResult> waiting = registry.register("aabbccdd11223347",
                DEVICE);

        // Die belegte FC6-Klasse: der Rahmen ging hinaus, das Register steht
        // weiterhin auf dem alten Wert.
        listener.handle(TOPIC, result("aabbccdd11223347", "schreiben", true,
                ",\"before_raw\":3300,\"after_raw\":3300,\"wrote\":true,\"adopted\":false")
                .getBytes(StandardCharsets.UTF_8));

        RegisterWriteResult r = waiting.getNow(null);
        assertThat(r).isNotNull();
        assertThat(r.outcome()).isEqualTo(RegisterWriteResult.OUTCOME_NOT_ADOPTED);
        assertThat(r.wrote()).isTrue();
    }

    private static String result(String requestId, String mode, boolean ok, String extra) {
        return "{\"schema_version\":\"1.0\",\"type\":\"register_write_result\""
                + ",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\""
                + ",\"device_id\":\"" + DEVICE + "\",\"request_id\":\"" + requestId + "\""
                + ",\"answered_at\":\"2026-08-19T14:02:49Z\",\"mode\":\"" + mode + "\""
                + ",\"ok\":" + ok + extra + "}";
    }
}
