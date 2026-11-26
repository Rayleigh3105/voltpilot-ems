package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.direktvermarktung.DirektvermarktungZustellung.Ergebnis;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.entities.LeadDeviceService.FuehrendeBox;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.Zustellung;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangZeile;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Der Zustell-Abgleich (Vertrag {@code docs/contracts/v2/direktvermarktung-zustellung.md} §2/§4): Soll aus
 * aktivem Anschluss + Zugang + führender Box mit Fähigkeitswort; Rückzug VOR jeder neuen Zustellung
 * (PS-D22); idempotent, sobald der gewünschte Fingerabdruck zugestellt ist; das Dokument trägt den
 * Dokument waehlt das eingebettete Partnerprofil der Box und traegt die Referenzleistung.
 */
class DirektvermarktungZustellungTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    private static final UUID BOX = UUID.fromString("00000000-0000-0000-0000-00000000000c");
    private static final UUID ALTE_BOX = UUID.fromString("00000000-0000-0000-0000-00000000000d");
    private static final UUID EINTRAG = UUID.fromString("00000000-0000-0000-0000-00000000000e");
    private static final UUID ZUGANG = UUID.fromString("00000000-0000-0000-0000-00000000000f");
    private static final Instant JETZT = Instant.parse("2026-11-25T12:00:00Z");

    private DirektvermarktungRepository repo;
    private LeadDeviceService lead;
    private BoxFaehigkeiten faehigkeiten;
    private DirektvermarktungPublisher publisher;
    private DirektvermarktungZustellung zustellung;

    @BeforeEach
    void setUp() {
        repo = mock(DirektvermarktungRepository.class);
        lead = mock(LeadDeviceService.class);
        faehigkeiten = mock(BoxFaehigkeiten.class);
        publisher = mock(DirektvermarktungPublisher.class);
        PartnerKatalog katalog = mock(PartnerKatalog.class);
        when(katalog.finde("luox")).thenReturn(new PartnerProfil("luox", "luox energy", null, null));
        when(repo.referenzWp(SITE)).thenReturn(12000.0);
        zustellung = new DirektvermarktungZustellung(repo, katalog, lead, faehigkeiten,
                provider(publisher), leererProvider(), leererProvider(), JSON,
                Clock.fixed(JETZT, ZoneOffset.UTC));
        TenantContext.set(TENANT);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    private static Eintrag eintrag(String zustand) {
        return new Eintrag(EINTRAG, SITE, "luox", zustand, null, null, null, null, null, null, null, 1,
                JETZT, JETZT);
    }

    private static ZugangZeile zugang(String fingerabdruck) {
        return new ZugangZeile(ZUGANG, EINTRAG, fingerabdruck, JETZT.plusSeconds(86400 * 300), null, null);
    }

    @SuppressWarnings("unchecked")
    private static ObjectProvider<DirektvermarktungPublisher> provider(DirektvermarktungPublisher p) {
        ObjectProvider<DirektvermarktungPublisher> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(p);
        return provider;
    }

    /** Ohne Spring: Messplan und Config-Publisher fehlen, die Zustellung bleibt vollstaendig. */
    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> leererProvider() {
        return mock(ObjectProvider.class);
    }

    @Test
    void entwurfOderOhneZugangStelltNichtsZu() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.ENTWURF));
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of());
        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.KEIN_ZIEL);

        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.WARTET_AUF_ZUGANG));
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(null);
        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.KEIN_ZIEL);
        verify(publisher, never()).publishProfil(any(), any(), any(), any());
    }

    @Test
    void ohneFaehigkeitswortBleibtDieBoxOhneZustellung() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.WARTET_AUF_ZUGANG));
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(zugang("SHA256:abc"));
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of());
        when(lead.fuehrendeBox(SITE)).thenReturn(new FuehrendeBox(BOX, null));
        when(faehigkeiten.kann(BOX, "direktvermarktung")).thenReturn(false);
        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.KEIN_ZIEL);
        verify(publisher, never()).publishProfil(any(), any(), any(), any());
    }

    @Test
    void zustellungWaehltDasEingebetteteProfilUndTraegtDieReferenz() throws Exception {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.WARTET_AUF_ZUGANG));
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(zugang("SHA256:abc"));
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of());
        when(repo.zustellung(EINTRAG)).thenReturn(new Zustellung(EINTRAG, null, null, 0, null));
        when(lead.fuehrendeBox(SITE)).thenReturn(new FuehrendeBox(BOX, null));
        when(faehigkeiten.kann(BOX, "direktvermarktung")).thenReturn(true);
        when(publisher.publishProfil(any(), any(), any(), any())).thenReturn(true);

        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.ZUGESTELLT);

        ArgumentCaptor<byte[]> payload = ArgumentCaptor.forClass(byte[].class);
        verify(publisher).publishProfil(eq(TENANT), eq(SITE), eq(BOX), payload.capture());
        JsonNode doc = JSON.readTree(payload.getValue());
        assertThat(doc.path("schema_version").asText()).isEqualTo("1.0");
        assertThat(doc.path("tenant_id").asText()).isEqualTo(TENANT.toString());
        assertThat(doc.path("site_id").asText()).isEqualTo(SITE.toString());
        assertThat(doc.path("device_id").asText()).isEqualTo(BOX.toString());
        assertThat(doc.path("partner").asText()).isEqualTo("luox");
        assertThat(doc.path("revision").asInt()).isEqualTo(1);
        assertThat(doc.path("zugang_fingerabdruck").asText()).isEqualTo("SHA256:abc");
        // Keine Registerbelegung im Dokument: die Zustellung WAEHLT das eingebettete Profil der Box
        // (vermarktertunnel-Sicherheitsregel) und traegt nur, was die Cloud weiss.
        assertThat(doc.has("profil")).isFalse();
        assertThat(doc.path("referenz_wp").asDouble()).isEqualTo(12000.0);

        verify(repo).profilZugestellt(EINTRAG, BOX, 1, "SHA256:abc", JETZT);
        verify(repo).protokolliere(eq(TENANT), eq(SITE), eq(EINTRAG), eq("profil_zugestellt"), eq(null),
                eq("zustellung"), anyString(), eq(JETZT));
    }

    @Test
    void zugestellterFingerabdruckIstIdempotent() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBINDET));
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(zugang("SHA256:abc"));
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of(
                new Zustellung(EINTRAG, BOX, JETZT, 1, "SHA256:abc")));
        when(repo.zustellung(EINTRAG)).thenReturn(new Zustellung(EINTRAG, BOX, JETZT, 1, "SHA256:abc"));
        when(lead.fuehrendeBox(SITE)).thenReturn(new FuehrendeBox(BOX, null));
        when(faehigkeiten.kann(BOX, "direktvermarktung")).thenReturn(true);

        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.NICHTS);
        verify(publisher, never()).publishProfil(any(), any(), any(), any());
        verify(publisher, never()).clearProfil(any(), any(), any());
    }

    @Test
    void neuerFingerabdruckGehtAlsNeueRevisionAnDieselbeBox() throws Exception {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBUNDEN));
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(zugang("SHA256:neu"));
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of(
                new Zustellung(EINTRAG, BOX, JETZT, 3, "SHA256:alt")));
        when(repo.zustellung(EINTRAG)).thenReturn(new Zustellung(EINTRAG, BOX, JETZT, 3, "SHA256:alt"));
        when(lead.fuehrendeBox(SITE)).thenReturn(new FuehrendeBox(BOX, null));
        when(faehigkeiten.kann(BOX, "direktvermarktung")).thenReturn(true);
        when(publisher.publishProfil(any(), any(), any(), any())).thenReturn(true);

        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.ZUGESTELLT);
        ArgumentCaptor<byte[]> payload = ArgumentCaptor.forClass(byte[].class);
        verify(publisher).publishProfil(eq(TENANT), eq(SITE), eq(BOX), payload.capture());
        JsonNode doc = JSON.readTree(payload.getValue());
        assertThat(doc.path("revision").asInt()).isEqualTo(4);
        assertThat(doc.path("zugang_fingerabdruck").asText()).isEqualTo("SHA256:neu");
        verify(publisher, never()).clearProfil(any(), any(), any());
    }

    @Test
    void boxWechselZiehtErstZurueckUndStelltNieImSelbenLaufZu() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBUNDEN));
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(zugang("SHA256:abc"));
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of(
                new Zustellung(EINTRAG, ALTE_BOX, JETZT, 2, "SHA256:abc")));
        when(lead.fuehrendeBox(SITE)).thenReturn(new FuehrendeBox(BOX, null));
        when(faehigkeiten.kann(BOX, "direktvermarktung")).thenReturn(true);

        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.WARTET_AUF_QUITTUNG);
        verify(publisher).clearProfil(TENANT, SITE, ALTE_BOX);
        verify(publisher, never()).publishProfil(any(), any(), any(), any());
    }

    @Test
    void beendeterAnschlussWirdZurueckgezogen() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(null);
        when(repo.zustellungenMitBox(SITE)).thenReturn(List.of(
                new Zustellung(EINTRAG, BOX, JETZT, 2, "SHA256:abc")));

        assertThat(zustellung.abgleichen(SITE)).isEqualTo(Ergebnis.WARTET_AUF_QUITTUNG);
        verify(publisher).clearProfil(TENANT, SITE, BOX);
    }

    @Test
    void zugangGehtNurAnDieZustellBoxUndNurFuerDenAktuellenFingerabdruck() {
        PartnerzugangSpeicher speicher = mock(PartnerzugangSpeicher.class);
        when(repo.aktiverOhneEnde(SITE)).thenReturn(eintrag(DirektvermarktungRepository.VERBINDET));
        when(repo.zustellung(EINTRAG)).thenReturn(new Zustellung(EINTRAG, BOX, JETZT, 1, "SHA256:abc"));
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(zugang("SHA256:abc"));

        // Falsche Box: nichts.
        assertThat(zustellung.zugangSenden(SITE, ALTE_BOX, "SHA256:abc", speicher)).isFalse();
        // Falscher Fingerabdruck: nichts.
        assertThat(zustellung.zugangSenden(SITE, BOX, "SHA256:fremd", speicher)).isFalse();
        verify(publisher, never()).publishZugang(any(), any(), any(), any());

        // Richtige Box, richtiger Fingerabdruck: die Antwort traegt Material und Gegenstelle.
        when(speicher.lade(ZUGANG)).thenReturn(Optional.of(klartext()));
        when(publisher.publishZugang(any(), any(), any(), any())).thenReturn(true);
        assertThat(zustellung.zugangSenden(SITE, BOX, "SHA256:abc", speicher)).isTrue();
        ArgumentCaptor<byte[]> payload = ArgumentCaptor.forClass(byte[].class);
        verify(publisher).publishZugang(eq(TENANT), eq(SITE), eq(BOX), payload.capture());
        try {
            JsonNode antwort = JSON.readTree(payload.getValue());
            assertThat(antwort.path("schema_version").asText()).isEqualTo("1.0");
            assertThat(antwort.path("zugang_fingerabdruck").asText()).isEqualTo("SHA256:abc");
            assertThat(antwort.path("gegenstelle").path("host").asText()).isEqualTo("vpn.luox.example");
            assertThat(antwort.path("dateien").path("zertifikat_pem").asText()).startsWith("-----BEGIN");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        verify(repo).protokolliere(eq(TENANT), eq(SITE), eq(EINTRAG), eq("zugang_angefragt"), eq(null),
                eq("zustellung"), anyString(), eq(JETZT));
    }

    private static JsonNode klartext() {
        var n = JSON.createObjectNode();
        var gegenstelle = n.putObject("gegenstelle");
        gegenstelle.put("host", "vpn.luox.example");
        gegenstelle.put("port", 1194);
        var dateien = n.putObject("dateien");
        dateien.put("zertifikat_pem", "-----BEGIN CERTIFICATE-----\nZ\n-----END CERTIFICATE-----\n");
        dateien.put("schluessel_pem", "-----BEGIN PRIVATE KEY-----\nS\n-----END PRIVATE KEY-----\n");
        dateien.put("ca_pem", "-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----\n");
        return n;
    }
}
