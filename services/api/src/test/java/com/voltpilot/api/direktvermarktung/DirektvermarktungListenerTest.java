package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.Stand;
import com.voltpilot.api.repo.DirektvermarktungRepository.Zustellung;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangZeile;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die drei MQTT-Eingänge der Zustellung, direkt über {@code handle()} (Surefire schaltet die Broker-Clients
 * ab): Topic-Identität gegen Nutzlast-Identität, nur die Zustell-Box schreibt den Spiegel, Quittungen räumen
 * die Buchführung und sind idempotent.
 */
class DirektvermarktungListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    private static final UUID BOX = UUID.fromString("00000000-0000-0000-0000-00000000000c");
    private static final UUID EINTRAG = UUID.fromString("00000000-0000-0000-0000-00000000000e");
    private static final UUID ZUGANG = UUID.fromString("00000000-0000-0000-0000-00000000000f");
    private static final Instant JETZT = Instant.parse("2026-11-25T12:00:00Z");
    private static final Clock UHR = Clock.fixed(JETZT, ZoneOffset.UTC);

    private DeviceRepository devices;
    private DirektvermarktungRepository repo;
    private DirektvermarktungZustellung zustellung;
    private TransactionTemplate tx;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        repo = mock(DirektvermarktungRepository.class);
        zustellung = mock(DirektvermarktungZustellung.class);
        tx = mock(TransactionTemplate.class);
        org.mockito.Mockito.doAnswer(inv -> {
            @SuppressWarnings("unchecked")
            java.util.function.Consumer<org.springframework.transaction.TransactionStatus> arbeit =
                    inv.getArgument(0, java.util.function.Consumer.class);
            arbeit.accept(new SimpleTransactionStatus());
            return null;
        }).when(tx).executeWithoutResult(any());
        when(tx.execute(any())).thenAnswer(inv ->
                inv.getArgument(0, TransactionCallback.class).doInTransaction(new SimpleTransactionStatus()));
        when(devices.findById(BOX)).thenReturn(Optional.of(device()));
    }

    private static DeviceDto device() {
        return new DeviceDto(BOX, SITE, "edge-x", "edge", null, "ok", JETZT, JETZT, null, null, null);
    }

    private static Eintrag eintrag(String zustand) {
        return new Eintrag(EINTRAG, SITE, "luox", zustand, null, null, null, null, null, null, null, 1,
                JETZT, JETZT);
    }

    private static String topicStatus() {
        return "ems/" + TENANT + "/" + SITE + "/" + BOX + "/status";
    }

    private static String topicQuittung() {
        return "ems/" + TENANT + "/" + SITE + "/" + BOX + "/v2/direktvermarktung-quittung";
    }

    private static byte[] statusPayload(String lage) {
        return ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + BOX + "\",\"direktvermarktung\":{\"partner\":\"luox\",\"lage\":\""
                + lage + "\",\"revision\":1,\"vorgabe_pct\":30,"
                + "\"lebenszeichen_am\":\"2026-11-25T11:59:48Z\"}}").getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] quittungPayload(String ereignis, String fingerabdruck) {
        return ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + BOX + "\",\"zugang_fingerabdruck\":\"" + fingerabdruck
                + "\",\"ereignis\":\"" + ereignis + "\",\"am\":\"2026-11-25T12:00:00Z\"}")
                .getBytes(StandardCharsets.UTF_8);
    }

    private DirektvermarktungStandListener standListener() {
        return new DirektvermarktungStandListener("tcp://nirgendwo:1", "", "", devices, repo, tx, UHR);
    }

    private DirektvermarktungQuittungListener quittungListener() {
        return new DirektvermarktungQuittungListener("tcp://nirgendwo:1", "", "", devices, repo, zustellung,
                tx, UHR);
    }

    @Test
    void standVonDerZustellBoxLandetImSpiegelUndFuehrtDenZustandNach() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBINDET));
        when(repo.zustellung(EINTRAG)).thenReturn(new Zustellung(EINTRAG, BOX, JETZT, 1, "SHA256:abc"));

        standListener().handle(topicStatus(), statusPayload("verbunden"));

        ArgumentCaptor<Stand> stand = ArgumentCaptor.forClass(Stand.class);
        verify(repo).standSchreiben(eq(TENANT), eq(SITE), stand.capture(), eq(JETZT));
        assertThat(stand.getValue().vorgabePct()).isEqualTo(30);
        assertThat(stand.getValue().lebenszeichenAm()).isEqualTo(Instant.parse("2026-11-25T11:59:48Z"));
        assertThat(stand.getValue().einspeisungW()).isNull(); // Unbekannt ist keine Null
        verify(repo).zustandSetzen(EINTRAG, DirektvermarktungRepository.VERBUNDEN, JETZT);
    }

    @Test
    void standVonEinerAnderenBoxWirdVerworfen() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBUNDEN));
        when(repo.zustellung(EINTRAG)).thenReturn(new Zustellung(EINTRAG,
                UUID.fromString("00000000-0000-0000-0000-0000000000dd"), JETZT, 1, "SHA256:abc"));

        standListener().handle(topicStatus(), statusPayload("verbunden"));
        verify(repo, never()).standSchreiben(any(), any(), any(), any());
    }

    @Test
    void fremdeIdentitaetInDerNutzlastWirdVerworfen() {
        byte[] fremd = ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"00000000-0000-0000-0000-0000000000dd\","
                + "\"direktvermarktung\":{\"partner\":\"luox\",\"lage\":\"verbunden\"}}")
                .getBytes(StandardCharsets.UTF_8);
        standListener().handle(topicStatus(), fremd);
        verify(repo, never()).standSchreiben(any(), any(), any(), any());
    }

    @Test
    void einHerzschlagOhneBlockLaesstAllesStehen() {
        standListener().handle(topicStatus(), ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + BOX + "\"}")
                .getBytes(StandardCharsets.UTF_8));
        verify(repo, never()).standSchreiben(any(), any(), any(), any());
        verify(repo, never()).zustandSetzen(any(), any(), any());
    }

    @Test
    void unbekannteLageSpiegeltAberBewegtKeinenZustand() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBUNDEN));
        when(repo.zustellung(EINTRAG)).thenReturn(new Zustellung(EINTRAG, BOX, JETZT, 1, "SHA256:abc"));
        standListener().handle(topicStatus(), statusPayload("ein_neues_wort"));
        verify(repo).standSchreiben(eq(TENANT), eq(SITE), any(), eq(JETZT));
        verify(repo, never()).zustandSetzen(any(), any(), any());
    }

    @Test
    void zugestelltQuittungSetztZugangUndHebtDenWartendenAnschluss() {
        when(repo.zugangZuFingerabdruck(SITE, "SHA256:abc"))
                .thenReturn(new ZugangZeile(ZUGANG, EINTRAG, "SHA256:abc", null, null, null));
        when(repo.zugangZugestellt(ZUGANG, JETZT)).thenReturn(true);
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.WARTET_AUF_ZUGANG));

        quittungListener().handle(topicQuittung(), quittungPayload("zugestellt", "SHA256:abc"));

        verify(repo).zugangZugestellt(ZUGANG, JETZT);
        verify(repo).protokolliere(eq(TENANT), eq(SITE), eq(EINTRAG), eq("zugang_zugestellt"), eq(null),
                anyString(), anyString(), eq(JETZT));
        verify(repo).zustandSetzen(EINTRAG, DirektvermarktungRepository.VERBINDET, JETZT);
    }

    @Test
    void zugestelltQuittungIstIdempotent() {
        when(repo.zugangZuFingerabdruck(SITE, "SHA256:abc"))
                .thenReturn(new ZugangZeile(ZUGANG, EINTRAG, "SHA256:abc", null, JETZT, null));
        when(repo.zugangZugestellt(ZUGANG, JETZT)).thenReturn(false);
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBINDET));

        quittungListener().handle(topicQuittung(), quittungPayload("zugestellt", "SHA256:abc"));
        verify(repo, never()).protokolliere(any(), any(), any(), eq("zugang_zugestellt"), any(), any(),
                any(), any());
        verify(repo, never()).zustandSetzen(any(), any(), any());
    }

    @Test
    void geloeschtQuittungRaeumtDieBuchfuehrungUndStoesstDenAbgleichAn() {
        // Box-Tausch: der Zugang bleibt aktuell (er geht gleich an die neue Box) - nur die Buchführung fällt.
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of(
                new Zustellung(EINTRAG, BOX, JETZT, 2, "SHA256:abc")));
        when(repo.zugangZuFingerabdruck(SITE, "SHA256:abc"))
                .thenReturn(new ZugangZeile(ZUGANG, EINTRAG, "SHA256:abc", null, JETZT, null));
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBUNDEN));
        when(repo.aktuellerZugang(EINTRAG))
                .thenReturn(new ZugangZeile(ZUGANG, EINTRAG, "SHA256:abc", null, JETZT, null));

        quittungListener().handle(topicQuittung(), quittungPayload("geloescht", "SHA256:abc"));

        verify(repo).profilZurueckgezogen(EINTRAG, JETZT);
        verify(repo, never()).zugangZurueckgezogen(any(), any());
        verify(repo, never()).standLoeschen(any());
        verify(zustellung).abgleichen(SITE);
    }

    @Test
    void geloeschtNachBeendenZiehtDenZugangZurueckUndRaeumtDenSpiegel() {
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of(
                new Zustellung(EINTRAG, BOX, JETZT, 2, "SHA256:abc")));
        when(repo.zugangZuFingerabdruck(SITE, "SHA256:abc"))
                .thenReturn(new ZugangZeile(ZUGANG, EINTRAG, "SHA256:abc", null, JETZT, null));
        when(repo.aktiverOhneEnde(SITE)).thenReturn(null); // beendet
        when(repo.zugangZurueckgezogen(ZUGANG, JETZT)).thenReturn(true);

        quittungListener().handle(topicQuittung(), quittungPayload("geloescht", "SHA256:abc"));

        verify(repo).profilZurueckgezogen(EINTRAG, JETZT);
        verify(repo).zugangZurueckgezogen(ZUGANG, JETZT);
        verify(repo).protokolliere(eq(TENANT), eq(SITE), eq(EINTRAG), eq("zugang_zurueckgezogen"), eq(null),
                anyString(), anyString(), eq(JETZT));
        verify(repo).standLoeschen(SITE);
        verify(zustellung).abgleichen(SITE);
    }

    @Test
    void anfrageGehtAnDenDienstNurMitStimmigerIdentitaet() {
        PartnerzugangSpeicher speicher = mock(PartnerzugangSpeicher.class);
        DirektvermarktungAnfrageListener listener = new DirektvermarktungAnfrageListener(
                "tcp://nirgendwo:1", "", "", devices, zustellung, speicher);
        String topic = "ems/" + TENANT + "/" + SITE + "/" + BOX + "/v2/direktvermarktung-anfrage";
        byte[] gut = ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + BOX + "\",\"zugang_fingerabdruck\":\"SHA256:abc\","
                + "\"angefragt_am\":\"2026-11-25T12:00:00Z\"}").getBytes(StandardCharsets.UTF_8);
        listener.handle(topic, gut);
        verify(zustellung).zugangSenden(SITE, BOX, "SHA256:abc", speicher);

        byte[] fremd = new String(gut, StandardCharsets.UTF_8)
                .replace(BOX.toString(), "00000000-0000-0000-0000-0000000000dd")
                .getBytes(StandardCharsets.UTF_8);
        listener.handle(topic, fremd);
        org.mockito.Mockito.verifyNoMoreInteractions(zustellung);
    }
}
