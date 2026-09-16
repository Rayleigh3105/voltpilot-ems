package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository.Ableitung;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository.Meldung;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository.Status;
import com.voltpilot.api.web.dto.DeviceDto;
import java.io.InputStream;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.config.YamlPropertiesFactoryBean;
import org.springframework.core.io.ClassPathResource;

class DataSourceStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private DeviceDataSourceStatusRepository statuses;
    private DataSourceStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        statuses = mock(DeviceDataSourceStatusRepository.class);
        listener = new DataSourceStatusListener("tcp://unused", "", "", devices, statuses);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(DEVICE, SITE,
                "VP-BOX-1", "gateway", null, "claimed", Instant.now(), Instant.now())));
    }

    @Test
    void neuerHerzschlagSchreibtDieFaktenJeQuelle() throws Exception {
        listener.handle(TOPIC, fixture("data-source-status-heartbeat-new.json"));

        verify(devices).markStatusSeen(DEVICE);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Meldung>> rows = ArgumentCaptor.forClass(List.class);
        verify(statuses).replaceForDevice(eq(DEVICE), eq(TENANT),
                eq(Instant.parse("2026-11-03T14:02:15Z")), rows.capture());
        assertThat(rows.getValue()).containsExactly(
                new Meldung("DQ-4", "ok", null, null,
                        Instant.parse("2026-11-03T14:02:12Z"), 6.0, 24.0),
                new Meldung("DQ-5", "stale", "unreachable",
                        Instant.parse("2026-11-03T14:02:10Z"),
                        Instant.parse("2026-11-03T14:01:50Z"), 1.0, 0.0));
    }

    @Test
    void alterHerzschlagErfindetKeinenQuellstatus() throws Exception {
        listener.handle(TOPIC, fixture("data-source-status-heartbeat-old.json"));
        verify(devices).markStatusSeen(DEVICE);
        verifyNoInteractions(statuses);

        Ableitung abgeleitet = DeviceDataSourceStatusRepository.ableiten(null);
        assertThat(abgeleitet.zustand()).isEqualTo(
                DeviceDataSourceStatusRepository.Lieferzustand.MELDET_NOCH_NICHT_JE_QUELLE);
        assertThat(abgeleitet.text()).isEqualTo("Box meldet noch nicht je Quelle");
        assertThat(abgeleitet.grund()).isNull();
    }

    @Test
    void leitetLiefertUndFehlerMitSeitUndBelegtemGrundAb() {
        Status ok = new Status("ok", null, null, Instant.parse("2026-11-03T14:02:12Z"),
                6.0, 24.0, Instant.parse("2026-11-03T14:02:15Z"));
        assertThat(DeviceDataSourceStatusRepository.ableiten(ok).text()).isEqualTo("Liefert Daten");

        Instant seit = Instant.parse("2026-11-03T14:02:10Z");
        Status fehler = new Status("stale", "unreachable", seit, null, 1.0, 0.0,
                Instant.parse("2026-11-03T14:02:15Z"));
        Ableitung abgeleitet = DeviceDataSourceStatusRepository.ableiten(fehler);
        assertThat(abgeleitet.seit()).isEqualTo(seit);
        assertThat(abgeleitet.grund()).isEqualTo("unreachable");
        assertThat(abgeleitet.text())
                .isEqualTo("Liefert keine Daten seit 2026-11-03T14:02:10Z — nicht erreichbar");
    }

    @Test
    void falscheIdentitaetUndUnbekannteFehlerklasseWerdenNichtBehauptet() throws Exception {
        byte[] fixture = fixture("data-source-status-heartbeat-new.json");
        listener.handle(TOPIC.replace(DEVICE.toString(),
                "10000000-0000-0000-0000-000000000009"), fixture);
        verifyNoInteractions(statuses);

        String payload = new String(fixture, java.nio.charset.StandardCharsets.UTF_8)
                .replace("unreachable", "connection_refused");
        listener.handle(TOPIC, payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Meldung>> rows = ArgumentCaptor.forClass(List.class);
        verify(statuses).replaceForDevice(eq(DEVICE), eq(TENANT), any(), rows.capture());
        assertThat(rows.getValue().get(1).errorClass()).isNull();
    }

    @Test
    void ausgelieferteVorgabeIstAn() {
        YamlPropertiesFactoryBean yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        assertThat(yaml.getObject()).isNotNull();
        assertThat(yaml.getObject().getProperty(
                "voltpilot.uems.data-source-status.mqtt-listener-enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_DATA_SOURCE_STATUS_MQTT_LISTENER_ENABLED:true}");
    }

    private static byte[] fixture(String name) throws Exception {
        try (InputStream in = DataSourceStatusListenerTest.class
                .getResourceAsStream("/fixtures/" + name)) {
            assertThat(in).as(name).isNotNull();
            return in.readAllBytes();
        }
    }
}
