package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Der {@code component_apply}-Ingest des Entitäts-Zuhörers - ein REINER
 * Unit-Test, er läuft also ohne Docker (die Reise durch die echte Datenbank
 * liegt in {@code ComponentApiTest}).
 *
 * <p>Was er schützt: dieser Block ist der EINZIGE Beleg der Cloud dafür, was
 * die Box mit einem Push gemacht hat. Er trägt seit Befund L8 eine vierte
 * Antwort - die RÜCKGABE der Autorität -, und aus ihr wird ein Kundensatz.
 * Eine stehen gebliebene Portal-Zeile hinter einer solchen Rückgabe war genau
 * der Befund.
 */
class EntityStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private EntityObservedRepository observed;
    private ComponentApplyRepository componentApply;
    private EntityStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        observed = mock(EntityObservedRepository.class);
        componentApply = mock(ComponentApplyRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(
                DEVICE, SITE, "demo-inverter-01", "inverter", null, "active", Instant.now(),
                Instant.now())));
        listener = new EntityStatusListener("tcp://localhost:1883", "", "", devices, observed,
                componentApply);
    }

    /** Ein Herzschlag mit dem gegebenen {@code component_apply}-Block. */
    private void ingest(String applyBlock) {
        String block = applyBlock == null ? "" : ",\"component_apply\":" + applyBlock;
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "entities":{"revision":"r9"%s}}
                """.formatted(TENANT, SITE, DEVICE, block);
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Der behobene Befund (L8): meldet die Box die Rückgabe der Autorität,
     * RÄUMT der Upsert die Zeile - die zuletzt angewandte Revision, eine
     * Ablehnung und ein Halt gehören der Portal-Ära und dürfen sie nicht
     * überleben. Vorher schwieg die Box hier, die alte
     * {@code authority=portal}-Zeile blieb stehen, und das Portal behauptete
     * über eine wieder box-verwaltete Anlage dauerhaft einen Stand, den
     * niemand mehr fährt.
     */
    @Test
    void aReportedReturnOfAuthorityClearsTheRow() {
        ingest("{\"authority\":\"box\"}");

        ArgumentCaptor<String> authority = ArgumentCaptor.forClass(String.class);
        verify(componentApply).upsert(eq(DEVICE), eq(TENANT), eq(SITE), authority.capture(),
                eq(null), eq(null), eq(null), eq(null), eq(null), eq(null), any());
        assertThat(authority.getValue()).isEqualTo("box");
    }

    /**
     * <b>Die Zeile wird NICHT gelöscht - und es gibt strukturell keinen Weg
     * dorthin.</b> {@code authority=box} ist eine Aussage („diese Box pflegt
     * ihre Geräte selbst"); sie zu entfernen machte sie wieder von „hat sich
     * nie geäußert" ununterscheidbar - genau die Zweideutigkeit, aus der der
     * Befund entstand. Ein „Aufräumen" wäre die naheliegende künftige
     * Vereinfachung, deshalb steht der Wächter am REPOSITORY statt am Aufruf.
     */
    @Test
    void theReturnIsRecordedAndTheRepositoryOffersNoWayToDeleteARow() {
        ingest("{\"authority\":\"box\"}");
        verify(componentApply).upsert(any(), any(), any(), eq("box"), any(), any(), any(), any(),
                any(), any(), any());
        assertThat(java.util.Arrays.stream(ComponentApplyRepository.class.getDeclaredMethods())
                .map(java.lang.reflect.Method::getName)
                .filter(n -> n.toLowerCase().contains("delete") || n.toLowerCase().contains("clear")
                        || n.toLowerCase().contains("remove")))
                .as("die Rückgabe wird BERICHTET, nicht weggeräumt")
                .isEmpty();
    }

    /** Der portal-verwaltete Normalfall bleibt Zeichen für Zeichen wie vorher. */
    @Test
    void aPortalManagedReportIsUnchanged() {
        ingest("""
                {"authority":"portal","revision":"r9","applied_at":"2026-08-31T10:00:00Z",
                 "refused_revision":"r8","refused_reason":"zwei Wechselrichter"}""");

        verify(componentApply).upsert(eq(DEVICE), eq(TENANT), eq(SITE), eq("portal"), eq("r9"),
                eq(Instant.parse("2026-08-31T10:00:00Z")), eq("r8"), eq("zwei Wechselrichter"),
                eq(null), eq(null), any());
    }

    /**
     * ⚠ ABWESEND heißt UNBEKANNT. Eine ältere Box sendet den Block gar nicht -
     * dann wird die Zeile NICHT angefasst, und das Portal sagt „unbekannt"
     * statt „box-verwaltet" zu behaupten. Der Rest des Herzschlags wird
     * unverändert verarbeitet.
     */
    @Test
    void anOlderBoxWithoutTheBlockIsNeverReadAsAReturn() {
        ingest(null);

        verifyNoInteractions(componentApply);
        verify(observed).replaceForDevice(eq(DEVICE), eq(TENANT), eq(SITE), any(), anyList());
    }

    /** Ein Wort außerhalb des Vokabulars wird VERWORFEN, nie gespeichert. */
    @Test
    void anUnknownAuthorityWordIsDiscarded() {
        ingest("{\"authority\":\"irgendwas\"}");
        verifyNoInteractions(componentApply);
    }

    /** Eine gefälschte Identität erreicht die Zeile nie. */
    @Test
    void aSpoofedIdentityNeverReachesTheRow() {
        String foreign = UUID.fromString("00000000-0000-0000-0000-0000000000ff").toString();
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "entities":{"revision":"r9","component_apply":{"authority":"box"}}}
                """.formatted(TENANT, SITE, foreign);
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));

        verifyNoInteractions(componentApply);
        verifyNoInteractions(observed);
    }
}
