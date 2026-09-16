package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der GERÄTE-PICKER - rein, ohne Docker, ohne Spring.
 *
 * <p>Festgenagelt wird die Ehrlichkeits-Seite: es entsteht keine neue Wahrheit
 * (alles kommt aus dem, was die Box meldet bzw. das Portal verwaltet), ein
 * Gerät ohne Schreibweg wird GENANNT statt verschwiegen, und eine fehlende
 * Familie führt nie zu einer erfundenen Bedeutung.
 */
class RegisterWriteTargetsTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-0000000000d1");

    private final DeviceRepository devices = mock(DeviceRepository.class);
    private final EntityObservedRepository observed = mock(EntityObservedRepository.class);
    private final EntityRegistryRepository registry = mock(EntityRegistryRepository.class);
    private final RegisterWriteTargets targets =
            new RegisterWriteTargets(devices, observed, registry, new ObjectMapper());

    private void device() {
        when(devices.findAll()).thenReturn(List.of(new DeviceDto(DEVICE, SITE,
                "edge-herzogau-01", "inverter", null, "active", Instant.now(), Instant.now())));
    }

    private static EntityObservedRepository.ObservedRow local(String role, String communication,
            String family, String connection, String brand, String model) {
        return new EntityObservedRepository.ObservedRow(DEVICE, "local:src-1", "local", null,
                null, null, null, "rev-1", null, Instant.now(), role, brand, model,
                new EntityObservedRepository.EdgeLink(communication, family, connection,
                        null, null, null));
    }

    private static EntityRegistryRepository.EntityRow entity(UUID id, String label,
            String communication, String connection, String family) {
        return new EntityRegistryRepository.EntityRow(id, "consumer", label, null, null, family,
                communication, connection, null, DEVICE, false, "modbus-generic", null, null,
                null, "custom", null, null, 1, null);
    }

    @Test
    void thePrimaryInverterIsOfferedWithWhatTheBoxReported() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of(local("inverter", "solarman_v5",
                "hybrid_3p", "{\"ip\":\"192.168.0.28\",\"port\":8899,\"mb_slave_id\":1}",
                "deye", "SUN-30K-SG01HP3")));
        when(registry.entitiesForSite(SITE)).thenReturn(List.of());

        List<RegisterWriteTargets.Target> out = targets.forSite(SITE);

        assertThat(out).hasSize(1);
        RegisterWriteTargets.Target t = out.get(0);
        assertThat(t.lane()).isEqualTo(RegisterWriteTargets.LANE_PRIMARY);
        assertThat(t.family()).isEqualTo("hybrid_3p");
        assertThat(t.host()).isEqualTo("192.168.0.28");
        assertThat(t.port()).isEqualTo(8899);
        // ⚠ Die Unit-ID heißt je Transport anders - beide Schreibweisen zählen.
        assertThat(t.unitId()).isEqualTo(1);
        assertThat(t.writable()).isTrue();
        assertThat(t.reason()).isNull();
        assertThat(targets.primaryFamily(SITE, DEVICE)).isEqualTo("hybrid_3p");
    }

    /**
     * ⚠ EINE BOX, DIE IHRE EINRICHTUNG NICHT MELDET, VERSCHWINDET NICHT. Die
     * primäre Lane nennt ohnehin keinen Endpunkt - die Box nimmt IHREN
     * Wechselrichter -, also bleibt das Ziel wählbar; ohne Familie ist dort nur
     * jedes Register ehrlich ohne Namen.
     */
    @Test
    void aSilentBoxStillOffersItsPrimaryTargetButClaimsNoFamily() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of());
        when(registry.entitiesForSite(SITE)).thenReturn(List.of());

        List<RegisterWriteTargets.Target> out = targets.forSite(SITE);

        assertThat(out).hasSize(1);
        assertThat(out.get(0).lane()).isEqualTo(RegisterWriteTargets.LANE_PRIMARY);
        assertThat(out.get(0).writable()).isTrue();
        assertThat(out.get(0).family()).isNull();
        assertThat(out.get(0).label()).contains("edge-herzogau-01");
        assertThat(targets.primaryFamily(SITE, DEVICE)).isNull();
    }

    /**
     * ⚠ EIN GERÄT OHNE SCHREIBWEG WIRD GENANNT, NICHT VERSCHWIEGEN - mit dem
     * Grund. Es wegzulassen erzeugte die Frage „warum fehlt meine Wallbox?" und
     * beantwortete sie nirgends.
     */
    @Test
    void aDeviceWithoutAWritePathIsNamedWithItsReason() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of(local("inverter", "fronius_solar_api",
                null, "{\"ip\":\"192.168.0.30\"}", "fronius", "Symo")));
        UUID wallbox = UUID.randomUUID();
        UUID onTheLogger = UUID.randomUUID();
        UUID noIp = UUID.randomUUID();
        when(registry.entitiesForSite(SITE)).thenReturn(List.of(
                entity(wallbox, "Wallbox Hof", "goe_http_api", "{\"ip\":\"192.168.0.50\"}", null),
                entity(onTheLogger, "Deye-Speicher", "solarman_v5",
                        "{\"ip\":\"192.168.0.28\"}", "hybrid_3p"),
                entity(noIp, "Lüftung", "modbus_baukasten", "{\"port\":502}", null)));

        List<RegisterWriteTargets.Target> out = targets.forSite(SITE);

        // Die drei Komponenten, der primäre Wechselrichter - und die go-e
        // erscheint NUR einmal (sie ist schon Komponente, nicht zusätzlich als
        // freie Adresse).
        assertThat(out).hasSize(4);
        assertThat(out).allSatisfy(t -> {
            if (!t.writable()) {
                assertThat(t.reason()).as("jede Verweigerung nennt ihren Grund").isNotBlank();
            }
        });
        // ⚠ DREI echte Verweigerungen - die Solarman-Komponente ist seit E4
        // KEINE mehr, sondern eine Abbildung auf die primäre Lane.
        assertThat(out.stream().filter(t -> !t.writable())).hasSize(3);
        assertThat(reason(out, wallbox)).contains("Web-Schnittstelle");
        assertThat(reason(out, noIp)).contains("keine IP-Adresse");
        RegisterWriteTargets.Target alias = out.stream()
                .filter(t -> onTheLogger.equals(t.entityId())).findFirst().orElseThrow();
        assertThat(alias.writable()).isTrue();
        assertThat(alias.reason()).isNull();
        assertThat(alias.primaryAlias()).isTrue();
        assertThat(alias.lane()).isEqualTo(RegisterWriteTargets.LANE_PRIMARY);
        assertThat(alias.entityId()).as("die Komponente bleibt der Besitzer des Vorgangs")
                .isEqualTo(onTheLogger);
    }

    /**
     * ⚠ DER CAPTAIN-BEFUND ALS TEST (Geräteseiten Stufe 2, E4): eine Komponente
     * am Solarman-Logger wird ABGEBILDET, nicht abgelehnt.
     *
     * <p>Der frühere Satz („bitte den primären Wechselrichter als Ziel wählen")
     * erschien ausgerechnet auf der Seite genau dieses Wechselrichters. Die
     * Transport-Tatsache bleibt wahr - der Auftrag reist auf der primären Lane -,
     * nur muss sie kein Mensch mehr kennen.
     */
    @Test
    void aComponentOnTheLoggerIsMappedToThePrimaryLaneInsteadOfBeingRefused() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of(local("inverter", "solarman_v5",
                "hybrid_3p", "{\"ip\":\"192.168.0.28\",\"port\":8899}", "deye", "SUN-30K")));
        UUID speicher = UUID.randomUUID();
        when(registry.entitiesForSite(SITE)).thenReturn(List.of(
                entity(speicher, "Speicher", "solarman_v5",
                        "{\"ip\":\"192.168.0.28\",\"port\":8899}", "hybrid_3p")));

        List<RegisterWriteTargets.Target> out = targets.forSite(SITE);

        assertThat(out).hasSize(2);
        assertThat(out).noneMatch(t -> t.reason() != null && t.reason().contains("Solarman"));
        assertThat(out).allMatch(RegisterWriteTargets.Target::writable);
        // Das Alias steht NEBEN dem Wechselrichter-Ziel, nicht an seiner Stelle:
        // ein Mensch, der „Speicher" sucht, findet ihn weiterhin.
        assertThat(out.stream().filter(t -> !t.primaryAlias())).hasSize(1);
        assertThat(out.stream().filter(RegisterWriteTargets.Target::primaryAlias)).hasSize(1);
    }

    /**
     * ⚠ EINE GEMELDETE QUELLE AN EINEM EIGENEN LOGGER IST KEIN ALIAS: die
     * primäre Lane meint den Wechselrichter, den die BOX eingerichtet hat - ein
     * Alias schickte den Auftrag an ein ANDERES Gerät. Der Satz nennt deshalb
     * den Weg, nicht einen Transport.
     */
    @Test
    void aReportedSourceOnItsOwnLoggerNamesTheWayInsteadOfATransport() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of(
                local("inverter", "fronius_sunspec", "sunspec_live",
                        "{\"ip\":\"192.168.0.40\"}", "fronius_sunspec", "eco-27"),
                local("pv-generation", "solarman_v5", "hybrid_3p",
                        "{\"ip\":\"192.168.0.28\",\"port\":8899}", "deye", "SUN-12K")));
        when(registry.entitiesForSite(SITE)).thenReturn(List.of());

        RegisterWriteTargets.Target source = targets.forSite(SITE).stream()
                .filter(t -> RegisterWriteTargets.LANE_LAN.equals(t.lane()))
                .findFirst().orElseThrow();

        assertThat(source.writable()).isFalse();
        assertThat(source.primaryAlias()).isFalse();
        assertThat(source.reason()).contains("als Komponente");
        assertThat(source.reason()).doesNotContain("Lane");
    }

    /** Eine komponierte Zeile ohne jede Anbindung ist kein Gerät im LAN. */
    @Test
    void aComposedRowWithoutAConnectionIsNotOffered() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of());
        when(registry.entitiesForSite(SITE)).thenReturn(List.of(
                entity(UUID.randomUUID(), "Hausverbrauch", null, null, null)));

        assertThat(targets.forSite(SITE)).hasSize(1); // nur die primäre Lane
    }

    /**
     * ⚠ EINE FREIE LAN-ADRESSE HAT PER KONSTRUKTION KEINE FAMILIE: niemand hat
     * dieses Gerät je eingerichtet, also ist dort jedes Register unbekannt.
     */
    @Test
    void theFreeLanLaneNeverCarriesAFamily() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of(local("inverter", "solarman_v5",
                "hybrid_3p", "{\"ip\":\"192.168.0.28\"}", "deye", "SUN-30K")));
        when(registry.entitiesForSite(SITE)).thenReturn(List.of());

        assertThat(targets.familyFor(SITE, DEVICE, RegisterWriteTargets.LANE_LAN, null)).isNull();
        assertThat(targets.familyFor(SITE, DEVICE, RegisterWriteTargets.LANE_PRIMARY, null))
                .isEqualTo("hybrid_3p");
    }

    private static String reason(List<RegisterWriteTargets.Target> out, UUID entityId) {
        return out.stream().filter(t -> entityId.equals(t.entityId()))
                .map(RegisterWriteTargets.Target::reason).findFirst().orElseThrow();
    }

    /**
     * ⚠ EINE VON DER BOX GEMELDETE QUELLE IST (NOCH) KEINE ENTITÄT - sie hat
     * keine Kennung, über die die Box sie auflösen könnte. Ihr Weg ist die
     * FREIE Lane, mit dem gemeldeten Endpunkt vorbefüllt; eine Familie wird
     * dort NICHT behauptet.
     */
    @Test
    void aReportedSourceIsOfferedOnTheFreeLaneWithItsEndpoint() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of(
                local("inverter", "solarman_v5", "hybrid_3p",
                        "{\"ip\":\"192.168.0.28\"}", "deye", "SUN-30K"),
                local("pv-generation", "fronius_sunspec", "sunspec_live",
                        "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":2}",
                        "fronius_sunspec", "eco-27")));
        when(registry.entitiesForSite(SITE)).thenReturn(List.of());

        List<RegisterWriteTargets.Target> out = targets.forSite(SITE);

        RegisterWriteTargets.Target source = out.stream()
                .filter(t -> RegisterWriteTargets.LANE_LAN.equals(t.lane()))
                .findFirst().orElseThrow();
        assertThat(source.host()).isEqualTo("192.168.210.40");
        assertThat(source.port()).isEqualTo(502);
        assertThat(source.unitId()).isEqualTo(2);
        assertThat(source.writable()).isTrue();
        assertThat(source.family()).as("eine freie Adresse behauptet keine Familie").isNull();
    }

    /**
     * ⚠ EIN GERÄT, DAS SCHON KOMPONENTE IST, ERSCHEINT NICHT ZWEIMAL - einmal
     * als Komponente und einmal als „freie Adresse" desselben Endpunkts wäre
     * dieselbe Sache unter zwei Namen.
     */
    @Test
    void aSourceThatIsAlreadyAComponentIsNotOfferedTwice() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of(
                local("pv-generation", "fronius_sunspec", "sunspec_live",
                        "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":2}",
                        "fronius_sunspec", "eco-27")));
        when(registry.entitiesForSite(SITE)).thenReturn(List.of(
                entity(UUID.randomUUID(), "Fronius 1", "fronius_sunspec",
                        "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":2}",
                        "sunspec_live")));

        List<RegisterWriteTargets.Target> out = targets.forSite(SITE);

        assertThat(out).hasSize(2); // primäre Lane + die EINE Komponente
        assertThat(out).noneMatch(t -> RegisterWriteTargets.LANE_LAN.equals(t.lane()));
    }

    @Test
    void sameEndpointOnAnotherBoxRemainsAnIndependentTarget() {
        device();
        UUID other = UUID.randomUUID();
        String connection = "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":2}";
        when(registry.entitiesForSite(SITE)).thenReturn(List.of(
                entity(UUID.randomUUID(), "Fronius 1", "fronius_sunspec", connection, "sunspec_live")));
        when(observed.forSite(SITE)).thenReturn(List.of(new EntityObservedRepository.ObservedRow(
                other, "local:src-2", "local", null, null, null, null, "rev-1", null, Instant.now(),
                "pv-generation", "fronius_sunspec", "eco-27",
                new EntityObservedRepository.EdgeLink("fronius_sunspec", "sunspec_live", connection,
                        null, null, null))));
        assertThat(targets.forSite(SITE)).anySatisfy(t -> {
            assertThat(t.lane()).isEqualTo(RegisterWriteTargets.LANE_LAN);
            assertThat(t.deviceId()).isEqualTo(other);
        });
    }

    /**
     * Die Bedeutung darf nicht am Herzschlag hängen: auf einer
     * portal-verwalteten Anlage steht die Familie in der gespeicherten
     * Definition des Wechselrichters.
     */
    @Test
    void theFamilyAlsoComesFromTheStoredDefinitionWhenTheBoxIsSilent() {
        device();
        when(observed.forSite(SITE)).thenReturn(List.of());
        when(registry.entitiesForSite(SITE)).thenReturn(List.of(
                entity(UUID.randomUUID(), "Deye", "solarman_v5",
                        "{\"ip\":\"192.168.0.28\"}", "hybrid_3p")));

        assertThat(targets.primaryFamily(SITE, DEVICE)).isEqualTo("hybrid_3p");
    }
}
