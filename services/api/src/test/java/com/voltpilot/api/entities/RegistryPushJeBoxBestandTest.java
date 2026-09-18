package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.entities.EntityRegistryRepository.BatteryAsset;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryRepository.RoleAssignment;
import com.voltpilot.api.entities.EntityRegistryService.PushOutcome;
import com.voltpilot.api.entities.EntityRegistryService.PushOutcome.BoxZustellung;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ZustaendigkeitRepository.Zeitraum;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Bestandsschutz und „alles oder nichts“ des Registry-Pushs je Box (UEMS AP-06 IP-6, W7) — mit fester
 * Uhr, also Byte für Byte.
 *
 * <p>Die Referenz jedes Vergleichs ist der Registry-Push VOR IP-6, wörtlich kopiert ({@link #alterPush}):
 * die führende Box, EIN Push mit ALLEN Entitäten der Anlage. Eine Anlage mit genau einer Box sendet
 * diese Bytes weiter — ohne Datenquelle, mit Datenquellen, box- und portal-verwaltet, mit
 * Rollen-Zuordnung und Ladepunkt; eine Anlage mit zwei Boxen ohne Datenquelle ebenso. Und bricht das
 * Bauen beim zweiten Push ab, ist nichts aufgezeichnet und nichts zugestellt.
 */
class RegistryPushJeBoxBestandTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID E1 = UUID.fromString("00000000-0000-0000-0000-0000000000e1");
    private static final UUID LESE = UUID.fromString("00000000-0000-0000-0000-0000000000e2");
    private static final UUID K1 = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID K3 = UUID.fromString("00000000-0000-0000-0000-0000000000a3");
    private static final UUID K4 = UUID.fromString("00000000-0000-0000-0000-0000000000a4");
    private static final UUID WALLBOX = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID K96 = UUID.fromString("00000000-0000-0000-0000-000000000096");
    private static final UUID DQ1 = UUID.fromString("00000000-0000-0000-0000-00000000d001");
    private static final UUID DQ2 = UUID.fromString("00000000-0000-0000-0000-00000000d002");
    private static final UUID DQ3 = UUID.fromString("00000000-0000-0000-0000-00000000d003");
    private static final UUID DQ5 = UUID.fromString("00000000-0000-0000-0000-00000000d005");
    private static final UUID DQ96 = UUID.fromString("00000000-0000-0000-0000-00000000d096");
    private static final Instant NOW = Instant.parse("2026-09-15T10:00:00Z");
    private static final Instant SEIT = Instant.parse("2024-03-11T23:00:00Z");

    private record Welt(EntityRegistryRepository repo, EntityRegistryPublisher pub, EntityRegistryService service) {}

    @BeforeEach
    void mandant() {
        TenantContext.set(TENANT);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ Bestandsschutz: eine Box

    @Test
    void eineBoxOhneDatenquelleSendetDieBytesVonVorher() {
        Welt w = welt(halle1(), List.of(E1), E1, Map.of(), List.of(), null);
        PushOutcome outcome = w.service().pushRegistryBestEffort(SITE);

        Map<UUID, byte[]> pushes = zugestellt(w, 1);
        assertThat(pushes).containsOnlyKeys(E1);
        assertThat(pushes.get(E1)).isEqualTo(alterPush(w));
        assertThat(outcome).isEqualTo(new PushOutcome(true, true, null, E1));
        verify(w.repo()).upsertRegistryState(SITE, TENANT, E1, NOW.toString());
        verify(w.repo(), never()).upsertRegistryStates(any(), any(), anyList(), anyString());
        verify(w.repo(), never()).zustaendigkeitenDerQuellen(any());
    }

    @Test
    void eineBoxMitDatenquellenSendetDieBytesVonVorher() {
        Welt w = welt(halle1(), List.of(E1), E1, halle1Quellen(), halle1Zustaendigkeiten(E1), null);
        PushOutcome outcome = w.service().pushRegistryBestEffort(SITE);

        Map<UUID, byte[]> pushes = zugestellt(w, 1);
        assertThat(pushes).containsOnlyKeys(E1);
        assertThat(pushes.get(E1)).isEqualTo(alterPush(w));
        assertThat(outcome.published()).isTrue();
        assertThat(outcome.deviceId()).isEqualTo(E1);
        assertThat(outcome.boxen()).containsExactly(new BoxZustellung(E1, true));
        verify(w.repo()).upsertRegistryStates(SITE, TENANT, List.of(E1), NOW.toString());
        verify(w.repo(), never()).upsertRegistryState(any(), any(), any(), any());
    }

    /** Portal-verwaltet, mit gespeicherter Rollen-Zuordnung und Ladepunkt: beide Wege senden die alten Bytes. */
    @Test
    void portalVerwaltetMitRollenUndLadepunktBleibtByteGleich() {
        List<EntityRow> rows = new ArrayList<>(halle1());
        rows.add(row(WALLBOX, "wallbox", null, null));
        Map<UUID, UUID> quellen = new LinkedHashMap<>(halle1Quellen());
        quellen.put(WALLBOX, DQ5);
        List<Zeitraum> z = new ArrayList<>(halle1Zustaendigkeiten(E1));
        z.add(zeitraum(DQ5, E1, SEIT, null));
        for (boolean mitQuellen : List.of(false, true)) {
            Welt w = welt(rows, List.of(E1), E1, mitQuellen ? quellen : Map.of(), mitQuellen ? z : List.of(),
                    "portal");
            when(w.repo().roleAssignments(SITE)).thenReturn(
                    Map.of(K3, List.of(new RoleAssignment("power_kw", "grid", true))));
            when(w.repo().chargePointIdsByEntity(SITE)).thenReturn(Map.of(WALLBOX, "AHR-LP-01"));

            w.service().pushRegistryBestEffort(SITE);
            byte[] push = zugestellt(w, 1).get(E1);
            assertThat(push).as("mit Quellen: " + mitQuellen).isEqualTo(alterPush(w));
            assertThat(new String(push)).contains("\"component_authority\":\"portal\"", "AHR-LP-01", "role_assignment");
        }
    }

    // ================================================================ Bestandsschutz: zwei Boxen

    /** Zwei Boxen, keine Datenquelle, beide mit Soll: weiter EIN Push an die führende Box, dieselben Bytes. */
    @Test
    void zweiBoxenOhneDatenquelleBleibenBeimEinenPush() {
        List<EntityRow> rows = new ArrayList<>(halle1());
        rows.add(row(K96, "modbus-generic", LESE, "{\"ip\":\"192.168.10.50\",\"port\":502,\"unit_id\":1}"));
        Welt w = welt(rows, List.of(E1, LESE), E1, Map.of(), List.of(), null);
        when(w.repo().boxenMitSoll(SITE)).thenReturn(List.of(E1, LESE));

        w.service().pushRegistryBestEffort(SITE);
        Map<UUID, byte[]> pushes = zugestellt(w, 1);
        assertThat(pushes).containsOnlyKeys(E1);
        assertThat(pushes.get(E1)).isEqualTo(alterPush(w));
    }

    // ================================================================ Push je Box

    @Test
    void zweiBoxenMitDatenquellenJedeBoxGenauIhre() throws Exception {
        List<EntityRow> rows = new ArrayList<>(halle1());
        EntityRow kantine = row(K96, "modbus-generic", LESE, "{\"ip\":\"192.168.10.50\",\"port\":502,\"unit_id\":1}");
        rows.add(kantine);
        Welt w = zweiBoxen(rows);

        PushOutcome outcome = w.service().pushRegistryBestEffort(SITE);
        Map<UUID, byte[]> pushes = zugestellt(w, 2);
        assertThat(pushes.keySet()).containsExactly(E1, LESE);
        assertThat(pushes.get(E1)).isEqualTo(w.service().composePush(TENANT, SITE, E1, NOW, halle1(), null));
        assertThat(pushes.get(LESE)).isEqualTo(w.service().composePush(TENANT, SITE, LESE, NOW, List.of(kantine), null));
        assertThat(outcome.published()).isTrue();
        assertThat(outcome.teilweiseZugestellt()).isFalse();
        assertThat(outcome.boxen()).containsExactly(new BoxZustellung(E1, true), new BoxZustellung(LESE, true));
        verify(w.repo()).upsertRegistryStates(SITE, TENANT, List.of(E1, LESE), NOW.toString());
    }

    /** W7: bricht das Bauen beim zweiten Push ab, ist für KEINE Box etwas aufgezeichnet oder zugestellt. */
    @Test
    void bauenBrichtBeimZweitenPushAbDannIstNichtsAufgezeichnetUndNichtsZugestellt() {
        List<EntityRow> rows = new ArrayList<>(halle1());
        rows.add(row(K96, "modbus-generic", LESE, "{\"ip\":\"192.168.10.50\",\"port\":502,\"unit_id\":1}"));
        Welt w = zweiBoxen(rows);
        when(w.repo().roleAssignments(SITE)).thenReturn(Map.of())
                .thenThrow(new IllegalStateException("Abbruch beim Bauen des zweiten Pushs"));

        assertThatThrownBy(() -> w.service().pushRegistryBestEffort(SITE)).isInstanceOf(IllegalStateException.class);
        verify(w.repo(), times(2)).roleAssignments(SITE);
        verify(w.repo(), never()).upsertRegistryStates(any(), any(), anyList(), anyString());
        verify(w.repo(), never()).upsertRegistryState(any(), any(), any(), any());
        verify(w.pub(), never()).publishRegistry(any(), any(), any(), any());
    }

    /** W7: verfehlt die Zustellung EINE Box, ist der Push nicht zugestellt — und teilweise. Das Soll steht trotzdem. */
    @Test
    void verfehltEineBoxIhrenPushIstErTeilweiseZugestellt() {
        List<EntityRow> rows = new ArrayList<>(halle1());
        rows.add(row(K96, "modbus-generic", LESE, "{\"ip\":\"192.168.10.50\",\"port\":502,\"unit_id\":1}"));
        Welt w = zweiBoxen(rows);
        when(w.pub().publishRegistry(any(), any(), eq(LESE), any())).thenReturn(false);

        PushOutcome outcome = w.service().pushRegistryBestEffort(SITE);
        assertThat(outcome.attempted()).isTrue();
        assertThat(outcome.published()).isFalse();
        assertThat(outcome.reason()).isEqualTo("publish_failed");
        assertThat(outcome.teilweiseZugestellt()).isTrue();
        assertThat(outcome.boxen()).containsExactly(new BoxZustellung(E1, true), new BoxZustellung(LESE, false));
        verify(w.repo()).upsertRegistryStates(SITE, TENANT, List.of(E1, LESE), NOW.toString());
    }

    @Test
    void ohneFuehrendeBoxKeinPushAuchKeinerJeBox() {
        List<EntityRow> rows = new ArrayList<>(halle1());
        rows.add(row(K96, "modbus-generic", LESE, "{\"ip\":\"192.168.10.50\",\"port\":502,\"unit_id\":1}"));
        Map<UUID, UUID> quellen = new LinkedHashMap<>(halle1Quellen());
        quellen.put(K96, DQ96);
        Welt w = welt(rows, List.of(E1, LESE), null, quellen, List.of(), null);

        assertThat(w.service().pushRegistryBestEffort(SITE)).isEqualTo(PushOutcome.noGateway());
        verify(w.pub(), never()).publishRegistry(any(), any(), any(), any());
        verify(w.repo(), never()).upsertRegistryStates(any(), any(), anyList(), anyString());
        verify(w.repo(), never()).upsertRegistryState(any(), any(), any(), any());
    }

    // ================================================================ Gerüst

    /**
     * Wörtlich der Registry-Push VOR IP-6 (Stand PR 675, {@code pushRegistryBestEffort}): die führende
     * Box, EIN Push mit ALLEN Entitäten der Anlage.
     */
    private static byte[] alterPush(Welt w) {
        UUID gateway = new LeadDeviceService(w.repo()).fuehrendeBox(SITE).box();
        return w.service().composePush(TENANT, SITE, gateway, NOW, w.repo().entitiesForSite(SITE),
                w.repo().componentAuthority(SITE));
    }

    private static Welt zweiBoxen(List<EntityRow> rows) {
        Map<UUID, UUID> quellen = new LinkedHashMap<>(halle1Quellen());
        quellen.put(K96, DQ96);
        List<Zeitraum> z = new ArrayList<>(halle1Zustaendigkeiten(E1));
        z.add(zeitraum(DQ96, LESE, Instant.parse("2026-08-03T08:16:00Z"), null));
        return welt(rows, List.of(E1, LESE), E1, quellen, z, null);
    }

    @SuppressWarnings("unchecked")
    private static Welt welt(List<EntityRow> rows, List<UUID> boxen, UUID speicherBox, Map<UUID, UUID> quellen,
            List<Zeitraum> zeitraeume, String authority) {
        EntityRegistryRepository repo = mock(EntityRegistryRepository.class);
        when(repo.entitiesForSite(SITE)).thenReturn(rows);
        when(repo.siteDeviceIds(SITE)).thenReturn(boxen);
        when(repo.batteryAsset(SITE)).thenReturn(speicherBox == null ? null
                : new BatteryAsset(speicherBox, BigDecimal.TEN, BigDecimal.TEN, BigDecimal.valueOf(10),
                        BigDecimal.valueOf(90)));
        when(repo.componentAuthority(SITE)).thenReturn(authority);
        when(repo.consumerCycleLimits(any())).thenReturn(Map.of());
        when(repo.activeConsumerPolicies(any())).thenReturn(Map.of());
        when(repo.chargePointIdsByEntity(any())).thenReturn(Map.of());
        when(repo.roleAssignments(any())).thenReturn(Map.of());
        when(repo.datenquelleJeEntitaet(SITE)).thenReturn(quellen);
        when(repo.zustaendigkeitenDerQuellen(SITE)).thenReturn(zeitraeume);
        EntityRegistryPublisher pub = mock(EntityRegistryPublisher.class);
        when(pub.publishRegistry(any(), any(), any(), any())).thenReturn(true);
        ObjectProvider<EntityRegistryPublisher> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(pub);
        EntityRegistryService service = new EntityRegistryService(repo, provider, MAPPER,
                mock(EntityTypeCatalog.class), mock(AssetRepository.class), mock(FlowClaimRepository.class),
                mock(DeviceOverrideRepository.class), new LeadDeviceService(repo), Clock.fixed(NOW, ZoneOffset.UTC),
                mock(BerichtsBelege.class));
        return new Welt(repo, pub, service);
    }

    private static Map<UUID, byte[]> zugestellt(Welt w, int anzahl) {
        ArgumentCaptor<UUID> box = ArgumentCaptor.forClass(UUID.class);
        ArgumentCaptor<byte[]> push = ArgumentCaptor.forClass(byte[].class);
        verify(w.pub(), times(anzahl)).publishRegistry(eq(TENANT), eq(SITE), box.capture(), push.capture());
        Map<UUID, byte[]> out = new LinkedHashMap<>();
        for (int i = 0; i < anzahl; i++) {
            out.put(box.getAllValues().get(i), push.getAllValues().get(i));
        }
        return out;
    }

    /** Halle 1 wie im Referenzunternehmen: K-1 (mit Speicher) an Box Halle 1, Netzzähler K-3, Unterzähler K-4. */
    private static List<EntityRow> halle1() {
        return List.of(
                row(K1, "battery-hybrid", E1, "{\"ip\":\"192.168.10.21\",\"port\":502,\"unit_id\":1}"),
                row(K3, "grid-meter", null, "{\"ip\":\"192.168.10.30\",\"port\":502,\"unit_id\":1}"),
                row(K4, "modbus-generic", null, "{\"ip\":\"192.168.10.31\",\"port\":502,\"unit_id\":1}"));
    }

    private static Map<UUID, UUID> halle1Quellen() {
        Map<UUID, UUID> out = new LinkedHashMap<>();
        out.put(K1, DQ1);
        out.put(K3, DQ2);
        out.put(K4, DQ3);
        return out;
    }

    private static List<Zeitraum> halle1Zustaendigkeiten(UUID box) {
        return List.of(zeitraum(DQ1, box, SEIT, null), zeitraum(DQ2, box, SEIT, null), zeitraum(DQ3, box, SEIT, null));
    }

    private static Zeitraum zeitraum(UUID quelle, UUID box, Instant von, Instant bis) {
        return new Zeitraum(UUID.nameUUIDFromBytes((quelle + "→" + box).getBytes()), quelle, box, von, bis);
    }

    private static EntityRow row(UUID id, String type, UUID device, String connection) {
        return new EntityRow(id, type, null, null, null, null, connection == null ? null : "modbus_tcp", connection,
                null, device, "battery-hybrid".equals(type), type, "{\"measure\":[{\"channel\":\"power_kw\"}]}",
                "{\"failsafe\":{\"behavior\":\"measure-only\"}}", null, null, null, null, 1, null);
    }
}
