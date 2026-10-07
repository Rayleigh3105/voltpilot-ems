package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * Konzept Nachweisen n1, Befund 4: der Urheber heißt wie die Person („Ines Kaltenbach“, Claim {@code name}), nicht wie
 * ihr Anmeldename („ines“, {@code preferred_username}) - der stand bis dahin in Verlauf, Kopf und PDF eines Berichts.
 */
class ProtokollAkteurNameTest {

    private static JwtAuthenticationToken token(Map<String, Object> claims) {
        Jwt jwt = new Jwt("t", Instant.parse("2029-04-30T10:00:00Z"), Instant.parse("2029-04-30T11:00:00Z"),
                Map.of("alg", "none"), claims);
        return new JwtAuthenticationToken(jwt, List.of());
    }

    @Test
    void derNameAusDemKontoStehtVorDemAnmeldenamen() {
        var a = ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "preferred_username", "ines", "name",
                "Ines Kaltenbach"))).orElseThrow();
        assertThat(a.name()).isEqualTo("Ines Kaltenbach");
        assertThat(a.sub()).isEqualTo("s-ines");
    }

    @Test
    void ohneNamenDerAnmeldename_ohneBeidesDasSubject() {
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "preferred_username", "ines"))).orElseThrow().name())
                .isEqualTo("ines");
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "preferred_username", "ines", "name", " ")))
                .orElseThrow().name()).isEqualTo("ines");
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines"))).orElseThrow().name()).isEqualTo("s-ines");
    }
}
