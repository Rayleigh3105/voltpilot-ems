package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.junit.jupiter.api.Test;

/**
 * Die Ablageform aus {@link PartnerzugangSpeicher}, von der Leseseite bewiesen: AES-256-GCM mit Schlüssel
 * aus der Umgebung (Base64, 32 Byte), Nonce 12 Byte, Klartext = das Draht-JSON. Die Schreibseite (der
 * gehaltene Zugangsdatei-Auftrag) muss GENAU diese Form erzeugen - dieser Test ist ihr Vertrag.
 */
class AesGcmPartnerzugangSpeicherTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String KLARTEXT = "{\"gegenstelle\":{\"host\":\"vpn.luox.example\",\"port\":1194},"
            + "\"dateien\":{\"zertifikat_pem\":\"Z\",\"schluessel_pem\":\"S\",\"ca_pem\":\"C\"}}";

    private static ZugangChiffrat verschluesselt(byte[] schluessel, String klartext) throws Exception {
        byte[] nonce = new byte[12];
        new SecureRandom().nextBytes(nonce);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(schluessel, "AES"), new GCMParameterSpec(128, nonce));
        return new ZugangChiffrat(cipher.doFinal(klartext.getBytes(StandardCharsets.UTF_8)), nonce);
    }

    @Test
    void entschluesseltDieAbgelegteForm() throws Exception {
        byte[] schluessel = new byte[32];
        new SecureRandom().nextBytes(schluessel);
        UUID id = UUID.randomUUID();
        DirektvermarktungRepository repo = mock(DirektvermarktungRepository.class);
        when(repo.zugangChiffrat(id)).thenReturn(verschluesselt(schluessel, KLARTEXT));

        AesGcmPartnerzugangSpeicher speicher = new AesGcmPartnerzugangSpeicher(repo, JSON,
                Base64.getEncoder().encodeToString(schluessel));
        Optional<JsonNode> klartext = speicher.lade(id);
        assertThat(klartext).isPresent();
        assertThat(klartext.get().path("gegenstelle").path("host").asText()).isEqualTo("vpn.luox.example");
        assertThat(klartext.get().path("dateien").path("schluessel_pem").asText()).isEqualTo("S");
    }

    @Test
    void falscherSchluesselBeschaedigtOderFehlendBleibtLeer() throws Exception {
        byte[] richtig = new byte[32];
        byte[] falsch = new byte[32];
        new SecureRandom().nextBytes(richtig);
        new SecureRandom().nextBytes(falsch);
        UUID id = UUID.randomUUID();
        DirektvermarktungRepository repo = mock(DirektvermarktungRepository.class);
        when(repo.zugangChiffrat(id)).thenReturn(verschluesselt(richtig, KLARTEXT));

        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON,
                Base64.getEncoder().encodeToString(falsch)).lade(id)).isEmpty();
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON, "").lade(id)).isEmpty();
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON, "kein base64!").lade(id)).isEmpty();
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON,
                Base64.getEncoder().encodeToString(new byte[16])).lade(id)).isEmpty();

        // Entschluesselbar, aber nicht die Ablageform: ebenso leer.
        when(repo.zugangChiffrat(id)).thenReturn(verschluesselt(richtig, "{\"anderes\":1}"));
        assertThat(new AesGcmPartnerzugangSpeicher(repo, JSON,
                Base64.getEncoder().encodeToString(richtig)).lade(id)).isEmpty();
    }

    @Test
    void laufzeitKatalogTraegtDasAufgeloesteLuoxProfil() {
        VermarkterLaufzeitKatalog katalog = new VermarkterLaufzeitKatalog(JSON);
        JsonNode luox = katalog.profil("luox");
        assertThat(luox).isNotNull();
        assertThat(luox.path("modbus").path("wortfolge").asText()).isIn("little", "big");
        assertThat(luox.path("regeln").path("bei_veraltet").asText()).doesNotStartWith("offen");
        assertThat(katalog.profil("unbekannt")).isNull();
    }
}
