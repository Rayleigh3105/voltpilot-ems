package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Der D6-Uplink - rein, ohne Docker.
 *
 * <p>Er beweist die Kernaussage von D6: ein Schreibvorgang, den jemand VOR ORT
 * am Gerät gemacht hat, wird im Cloud-Journal sichtbar - und zwar als dieselben
 * zwei Zeilen wie ein Portal-Vorgang, verbunden über die {@code request_id}.
 * Dazu die Ehrlichkeitsregeln: ein Herzschlag ohne Block schreibt nichts, ein
 * unbekanntes Ergebnis-Wort wird verworfen, eine gefälschte Identität ignoriert.
 */
class RegisterWriteUplinkListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private RegisterWriteEventRepository journal;
    private RegisterWriteUplinkListener listener;

    @BeforeEach
    void setUp() {
        journal = mock(RegisterWriteEventRepository.class);
        DeviceRepository devices = mock(DeviceRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(DEVICE, SITE,
                "edge-herzogau-01", "inverter", null, "active", Instant.now(), Instant.now())));
        listener = new RegisterWriteUplinkListener("tcp://localhost:1883", "", "",
                journal, devices);
    }

    private void ingest(String entries) {
        listener.handle(TOPIC, ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\""
                + ",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE + "\""
                + ",\"register_writes\":{\"reported_at\":\"2026-08-19T14:05:00Z\""
                + ",\"entries\":[" + entries + "]}}").getBytes(StandardCharsets.UTF_8));
    }

    private static String entry(String requestId, String result, String extra) {
        return "{\"request_id\":\"" + requestId + "\",\"at\":\"2026-08-19T14:02:49Z\""
                + ",\"register\":\"0x00e7\",\"requested\":7000,\"result\":\"" + result + "\""
                + ",\"source\":\"wartungszugang\"" + extra + "}";
    }

    @Test
    void aWriteMadeAtTheDeviceBecomesTwoJournalRowsWithProvableOrigin() {
        ingest(entry("aabbccdd11223344", "applied",
                ",\"before\":3300,\"after\":7000,\"message\":\"Der Wechselrichter hat 70,0 kW übernommen.\""));

        ArgumentCaptor<RegisterWriteEventRepository.Request> req =
                ArgumentCaptor.forClass(RegisterWriteEventRepository.Request.class);
        verify(journal).recordRequest(req.capture());
        assertThat(req.getValue().source()).isEqualTo(RegisterWriteEventRepository.SOURCE_DEVICE);
        assertThat(req.getValue().origin()).isEqualTo(RegisterWriteEventRepository.ORIGIN_DEVICE);
        assertThat(req.getValue().actorRole()).isEqualTo("wartungszugang");
        assertThat(req.getValue().address()).isEqualTo(231);
        // Was die Box AUFGEZEICHNET hat, ist hier die verbatim Eingabe - sie hat
        // kein Formular.
        assertThat(req.getValue().addressInput()).isEqualTo("0x00e7");
        assertThat(req.getValue().valueInput()).isEqualTo("7000");
        assertThat(req.getValue().registerClass()).isEqualTo("netz_compliance");
        assertThat(req.getValue().deviceRef()).isEqualTo("edge-herzogau-01");
        assertThat(req.getValue().targetLabel()).contains("Vor Ort");

        ArgumentCaptor<RegisterWriteEventRepository.Receipt> receipt =
                ArgumentCaptor.forClass(RegisterWriteEventRepository.Receipt.class);
        verify(journal).recordOutcome(receipt.capture());
        assertThat(receipt.getValue().requestId()).isEqualTo("aabbccdd11223344");
        assertThat(receipt.getValue().adopted()).isTrue();
        assertThat(receipt.getValue().outcome())
                .isEqualTo(RegisterWriteResult.OUTCOME_ADOPTED);
        assertThat(receipt.getValue().beforeRaw()).isEqualTo(3300);
    }

    @Test
    void aPortalTriggeredEntryKeepsItsOwnSource() {
        // Sie ist längst in der Cloud - der Uplink meldet sie trotzdem, und der
        // eindeutige Index macht daraus ein No-op. Falsch wäre nur, sie als
        // Vor-Ort-Vorgang zu etikettieren.
        ingest("{\"request_id\":\"aabbccdd11223345\",\"at\":\"2026-08-19T14:02:49Z\""
                + ",\"register\":\"0x00e7\",\"requested\":7000,\"result\":\"applied\""
                + ",\"before\":3300,\"after\":7000,\"source\":\"portal:sub-1\"}");

        ArgumentCaptor<RegisterWriteEventRepository.Request> req =
                ArgumentCaptor.forClass(RegisterWriteEventRepository.Request.class);
        verify(journal).recordRequest(req.capture());
        assertThat(req.getValue().source()).isEqualTo(RegisterWriteEventRepository.SOURCE_PORTAL);
    }

    @Test
    void aWriteThatWasAcceptedButNotAdoptedIsSaidSo() {
        ingest(entry("aabbccdd11223346", "mismatch", ",\"before\":3300,\"after\":3300"));

        ArgumentCaptor<RegisterWriteEventRepository.Receipt> receipt =
                ArgumentCaptor.forClass(RegisterWriteEventRepository.Receipt.class);
        verify(journal).recordOutcome(receipt.capture());
        assertThat(receipt.getValue().adopted()).isFalse();
        assertThat(receipt.getValue().outcome())
                .isEqualTo(RegisterWriteResult.OUTCOME_NOT_ADOPTED);
    }

    @Test
    void anUnconfirmedWriteClaimsNothingAboutAdoption() {
        // Der Rahmen ging hinaus, die Rücklesung fehlt - „unbestätigt" ist die
        // ehrliche Antwort, nie „nicht übernommen".
        ingest(entry("aabbccdd11223347", "mismatch", ",\"before\":3300"));

        ArgumentCaptor<RegisterWriteEventRepository.Receipt> receipt =
                ArgumentCaptor.forClass(RegisterWriteEventRepository.Receipt.class);
        verify(journal).recordOutcome(receipt.capture());
        assertThat(receipt.getValue().adopted()).isNull();
        assertThat(receipt.getValue().afterRaw()).isNull();
    }

    @Test
    void aHeartbeatWithoutTheBlockWritesNothing() {
        listener.handle(TOPIC, ("{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\""
                + ",\"device_id\":\"" + DEVICE + "\",\"online\":true}")
                .getBytes(StandardCharsets.UTF_8));

        verify(journal, never()).recordRequest(any());
        verify(journal, never()).recordOutcome(any());
    }

    @Test
    void anIncompleteOrUnknownEntryIsDroppedRatherThanHalfClaimed() {
        // Unbekanntes Ergebnis-Wort, fehlende Kennung, unlesbares Register,
        // fehlender Zeitstempel - jedes für sich verwirft den Eintrag.
        ingest(entry("aabbccdd11223348", "irgendwas", ""));
        ingest("{\"at\":\"2026-08-19T14:02:49Z\",\"register\":\"0x00e7\""
                + ",\"requested\":7000,\"result\":\"applied\"}");
        ingest("{\"request_id\":\"aabbccdd11223349\",\"at\":\"2026-08-19T14:02:49Z\""
                + ",\"register\":\"E7\",\"requested\":7000,\"result\":\"applied\"}");
        ingest("{\"request_id\":\"aabbccdd1122334a\",\"register\":\"0x00e7\""
                + ",\"requested\":7000,\"result\":\"applied\"}");

        verify(journal, never()).recordRequest(any());
        verify(journal, never()).recordOutcome(any());
    }

    @Test
    void aSpoofedIdentityIsIgnoredOutright() {
        UUID stranger = UUID.fromString("00000000-0000-0000-0000-0000000000ff");
        listener.handle(TOPIC, ("{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\""
                + ",\"device_id\":\"" + stranger + "\""
                + ",\"register_writes\":{\"entries\":["
                + entry("aabbccdd1122334b", "applied", ",\"before\":3300,\"after\":7000")
                + "]}}").getBytes(StandardCharsets.UTF_8));

        verify(journal, never()).recordRequest(any());
    }
}
