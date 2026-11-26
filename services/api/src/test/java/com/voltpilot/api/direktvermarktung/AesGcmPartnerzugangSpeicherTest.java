package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.direktvermarktung.AesGcmPartnerzugangSpeicher.Verschluesselt;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangChiffrat;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Die Ablageform aus {@link PartnerzugangSpeicher}, von BEIDEN Richtungen derselben Klasse bewiesen:
 * AES-256-GCM mit Schlüssel aus der Umgebung (Base64, 32 Byte), Nonce 12 Byte, und die AAD-Bindung an
 * Mandant, Anlage und Zugangs-Zeile - ein in eine andere Zeile kopiertes Chiffrat entschlüsselt nicht.
 * Die Zugangsdatei-Übernahme (gehaltener Auftrag) nutzt genau {@code verschluessele}; dieser Test ist
 * ihr Vertrag.
 */
class AesGcmPartnerzugangSpeicherTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    private static final UUID ZUGANG = UUID.fromString("00000000-0000-0000-0000-00000000000f");
    private static final String KLARTEXT = "{\"gegenstelle\":{\"host\":\"vpn.luox.example\",\"port\":1194},"
            + "\"dateien\":{\"zertifikat_pem\":\"Z\",\"schluessel_pem\":\"S\",\"ca_pem\":\"C\"}}";

    private byte[] schluessel;
    private DirektvermarktungRepository repo;
    private AesGcmPartnerzugangSpeicher speicher;

    @BeforeEach
    void setUp() {
        schluessel = new byte[32];
        new SecureRandom().nextBytes(schluessel);
        repo = mock(DirektvermarktungRepository.class);
        speicher = new AesGcmPartnerzugangSpeicher(repo, JSON,
                Base64.getEncoder().encodeToString(schluessel));
    }

    private Verschluesselt verschluesselt() throws Exception {
        Optional<Verschluesselt> v = speicher.verschluessele(TENANT, SITE, ZUGANG, JSON.readTree(KLARTEXT));
        assertThat(v).isPresent();
        return v.get();
    }

    @Test
    void rundreiseUeberBeideRichtungen() throws Exception {
        Verschluesselt v = verschluesselt();
        assertThat(v.nonce()).hasSize(12);
        // Das Chiffrat traegt keinen Klartext.
        assertThat(new String(v.chiffrat(), StandardCharsets.ISO_8859_1)).doesNotContain("vpn.luox.example");

        when(repo.zugangChiffrat(ZUGANG)).thenReturn(new ZugangChiffrat(TENANT, SITE, v.chiffrat(), v.nonce()));
        Optional<JsonNode> klartext = speicher.lade(ZUGANG);
        assertThat(klartext).isPresent();
        assertThat(klartext.get().path("gegenstelle").path("host").asText()).isEqualTo("vpn.luox.example");
        assertThat(klartext.get().path("dateien").path("schluessel_pem").asText()).isEqualTo("S");
    }

    @Test
    void einKopiertesChiffratEntschluesseltInKeinerAnderenZeile() throws Exception {
        Verschluesselt v = verschluesselt();

        // Dieselbe Zeile, aber unter einem anderen Mandanten / einer anderen Anlage: Tag faellt.
        when(repo.zugangChiffrat(ZUGANG)).thenReturn(new ZugangChiffrat(UUID.randomUUID(), SITE,
                v.chiffrat(), v.nonce()));
        assertThat(speicher.lade(ZUGANG)).isEmpty();
        when(repo.zugangChiffrat(ZUGANG)).thenReturn(new ZugangChiffrat(TENANT, UUID.randomUUID(),
                v.chiffrat(), v.nonce()));
        assertThat(speicher.lade(ZUGANG)).isEmpty();

        // In eine andere Zugangs-Zeile kopiert (auch ein Ersatz-Upload desselben Zertifikats ist eine
        // NEUE Zeile): Tag faellt ebenso.
        UUID andereZeile = UUID.randomUUID();
        when(repo.zugangChiffrat(andereZeile)).thenReturn(new ZugangChiffrat(TENANT, SITE,
                v.chiffrat(), v.nonce()));
        assertThat(speicher.lade(andereZeile)).isEmpty();
    }

    @Test
    void einChiffratOhneAadBindungEntschluesseltNicht() throws Exception {
        // Die alte (ungebundene) Form darf nie lesbar sein - es gibt keine Alt-Chiffrate, also keine
        // Uebergangslesung.
        byte[] nonce = new byte[12];
        new SecureRandom().nextBytes(nonce);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(schluessel, "AES"),
                new GCMParameterSpec(128, nonce));
        byte[] ohneAad = cipher.doFinal(KLARTEXT.getBytes(StandardCharsets.UTF_8));
        when(repo.zugangChiffrat(ZUGANG)).thenReturn(new ZugangChiffrat(TENANT, SITE, ohneAad, nonce));
        assertThat(speicher.lade(ZUGANG)).isEmpty();
    }

    @Test
    void jedeVerschluesselungNimmtEineFrischeNonce() throws Exception {
        Verschluesselt a = verschluesselt();
        Verschluesselt b = verschluesselt();
        assertThat(a.nonce()).isNotEqualTo(b.nonce());
        assertThat(a.chiffrat()).isNotEqualTo(b.chiffrat());
    }

    @Test
    void verschluesselnLehntOhneSchluesselUndAusserhalbDerAblageformAb() throws Exception {
        assertThat(speicher.verschluessele(TENANT, SITE, ZUGANG, JSON.readTree("{\"anderes\":1}"))).isEmpty();
        assertThat(speicher.verschluessele(TENANT, SITE, ZUGANG, null)).isEmpty();
        AesGcmPartnerzugangSpeicher ohne = new AesGcmPartnerzugangSpeicher(repo, JSON, "");
        assertThat(ohne.verschluessele(TENANT, SITE, ZUGANG, JSON.readTree(KLARTEXT))).isEmpty();
    }

    @Test
    void falscherSchluesselBeschaedigtOderFehlendBleibtLeer() throws Exception {
        Verschluesselt v = verschluesselt();
        when(repo.zugangChiffrat(ZUGANG)).thenReturn(new ZugangChiffrat(TENANT, SITE, v.chiffrat(), v.nonce()));

        byte[] falsch = new byte[32];
        new SecureRandom().nextBytes(falsch);
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON,
                Base64.getEncoder().encodeToString(falsch)).lade(ZUGANG)).isEmpty();
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON, "").lade(ZUGANG)).isEmpty();
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON, "kein base64!").lade(ZUGANG)).isEmpty();
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON,
                Base64.getEncoder().encodeToString(new byte[16])).lade(ZUGANG)).isEmpty();

        // Entschluesselbar, aber nicht die Ablageform: ebenso leer - verschluessele laesst das zwar nie
        // entstehen, aber die Leseseite glaubt der Datenbank trotzdem nichts.
        when(repo.zugangChiffrat(ZUGANG)).thenReturn(null);
        assertThat(speicher.lade(ZUGANG)).isEmpty();
    }

}
