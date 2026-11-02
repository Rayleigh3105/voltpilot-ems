package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.enrollment.Csrs;
import com.voltpilot.api.werkstatt.EinloesenVertrag.Anfrage;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import org.bouncycastle.util.io.pem.PemReader;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: {@link EinloesenVertrag} liest die Vektoren
 * {@code docs/contracts/werkstatt-einloesen-vectors.json} - kanonischer Text
 * Byte für Byte, die Signatur des Vektors gilt (auch die des Go-Core,
 * {@code signatur_go}), jede Änderung eines Feldes
 * bricht sie, jeder Formfehler wird erkannt, und eine eigene Signatur mit dem
 * Testschlüssel gilt ebenso (ECDSA ist nicht deterministisch).
 */
class EinloesenVertragTest {

    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "werkstatt-einloesen-vectors.json");
    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode v;

    @BeforeAll
    static void lade() throws IOException {
        v = JSON.readTree(Files.readString(VEKTOREN));
    }

    private static Anfrage anfrage(JsonNode n) {
        return JSON.convertValue(n, Anfrage.class);
    }

    private static Anfrage mit(String feld, String wert) {
        ObjectNode n = v.get("anfrage").deepCopy();
        n.put(feld, wert);
        return anfrage(n);
    }

    @Test
    void kanonischerTextUndSignaturDesVektors() {
        Anfrage a = anfrage(v.get("anfrage"));
        assertThat(EinloesenVertrag.formfehler(a)).isEmpty();
        assertThat(EinloesenVertrag.kanonisch(a)).isEqualTo(v.get("kanonisch").asText());
        assertThat(EinloesenVertrag.sha256Hex(a.csrPem())).isEqualTo(v.get("csr_sha256").asText());
        assertThat(EinloesenVertrag.sha256Hex(Base64.getDecoder().decode(a.geraeteSchluessel())))
                .isEqualTo(v.get("geraete_schluessel_sha256").asText());
        assertThat(EinloesenVertrag.signaturGueltig(a)).isTrue();
        // Querbeleg: dieselbe Anfrage, signiert vom Go-Core (ecdsa.SignASN1), gilt ebenso.
        Anfrage go = new Anfrage(a.edgeRef(), a.code(), a.fassung(), a.geraeteSchluessel(), a.wireguardSchluessel(),
                a.hostSchluessel(), a.csrPem(), v.get("signatur_go").asText());
        assertThat(EinloesenVertrag.signaturGueltig(go)).as("signatur_go").isTrue();
        // Die Zertifikatsanfrage trägt denselben Schlüssel, in derselben festgehaltenen Form.
        assertThat(Csrs.schluesselSpki(Csrs.parseAndValidate(a.csrPem())))
                .isEqualTo(EinloesenVertrag.spki(EinloesenVertrag.geraeteSchluessel(a.geraeteSchluessel())))
                .isEqualTo(a.geraeteSchluessel());
    }

    @Test
    void jedeAenderungBrichtDieSignatur() {
        for (JsonNode f : v.get("signatur_ungueltig")) {
            Anfrage a = mit(f.get("feld").asText(), f.get("wert").asText());
            assertThat(EinloesenVertrag.signaturGueltig(a)).as(f.get("name").asText()).isFalse();
        }
    }

    @Test
    void formfehlerWerdenErkannt() {
        for (JsonNode f : v.get("formfehler")) {
            Anfrage a = mit(f.get("feld").asText(), f.get("wert").asText());
            assertThat(EinloesenVertrag.formfehler(a)).as(f.get("name").asText())
                    .anyMatch(t -> t.startsWith(f.get("feld").asText() + ":"));
        }
    }

    @Test
    void eigeneSignaturMitDemTestschluesselGilt() throws Exception {
        PrivateKey key;
        try (PemReader r = new PemReader(new StringReader(v.get("test_privater_schluessel_pkcs8_pem").asText()))) {
            key = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(r.readPemObject().getContent()));
        }
        Anfrage a = mit("fassung", "edge-light-2026.12.3");
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(key);
        s.update(EinloesenVertrag.kanonisch(a).getBytes(StandardCharsets.UTF_8));
        Anfrage signiert = new Anfrage(a.edgeRef(), a.code(), a.fassung(), a.geraeteSchluessel(),
                a.wireguardSchluessel(), a.hostSchluessel(), a.csrPem(), Base64.getEncoder().encodeToString(s.sign()));
        assertThat(EinloesenVertrag.signaturGueltig(signiert)).isTrue();
        assertThat(EinloesenVertrag.signaturGueltig(a)).as("alte Signatur über die alte Fassung").isFalse();
    }
}
