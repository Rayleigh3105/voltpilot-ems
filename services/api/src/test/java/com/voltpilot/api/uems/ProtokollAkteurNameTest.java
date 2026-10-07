package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * Konzept Nachweisen n1, Befund 4: der Urheber heißt wie die Person („Ines Kaltenbach“), nicht wie ihr Anmeldename
 * („ines“) - der stand bis dahin in Verlauf, Kopf und PDF eines Berichts. Review Nachweisen r1, P0-1: der Name kommt aus
 * dem Spiegel {@code benutzer.anzeigename} (von der Kundenadministration angelegt), nie aus dem Claim {@code name} -
 * den darf jedes Konto in Keycloak selbst ändern.
 */
class ProtokollAkteurNameTest {
    private static final UUID KUNDENBEREICH = UUID.fromString("20000000-0000-0000-0000-000000000001");
    private static final Instant JETZT = Instant.parse("2029-04-30T10:00:00Z");

    private static JwtAuthenticationToken token(Map<String, Object> claims) {
        Jwt jwt = new Jwt("t", JETZT, Instant.parse("2029-04-30T11:00:00Z"), Map.of("alg", "none"), claims);
        return new JwtAuthenticationToken(jwt, List.of());
    }

    private static void spiegel(String sub, String anzeigename) {
        ZugriffContext.set(new Zugriff(sub, Konto.BENUTZER, KUNDENBEREICH, Zugang.KONTO, List.of(), JETZT, true,
                List.of(), anzeigename));
    }

    @AfterEach
    void aufraeumen() {
        ZugriffContext.clear();
    }

    @Test
    void derNameAusDemSpiegelStehtVorDemAnmeldenamen() {
        spiegel("s-ines", "Ines Kaltenbach");
        var a = ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "preferred_username", "ines"))).orElseThrow();
        assertThat(a.name()).isEqualTo("Ines Kaltenbach");
        assertThat(a.sub()).isEqualTo("s-ines");
    }

    /** P0-1: ein Konto, das sich in Keycloak „Jonas Wendlinger“ nennt, unterschreibt nicht unter diesem Namen. */
    @Test
    void einSelbstGewaehlterNameImTokenIstNieDerUrheber() {
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-mallory", "preferred_username", "mallory", "name",
                "Jonas Wendlinger"))).orElseThrow().name()).isEqualTo("mallory");
        spiegel("s-mallory", "Mallory Muster");
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-mallory", "preferred_username", "mallory", "name",
                "Jonas Wendlinger"))).orElseThrow().name()).isEqualTo("Mallory Muster");
    }

    /** Der Spiegel eines anderen Subjects (ein fremder Kontext) zählt nicht. */
    @Test
    void derSpiegelEinesAnderenKontosZaehltNicht() {
        spiegel("s-jonas", "Jonas Wendlinger");
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "preferred_username", "ines"))).orElseThrow().name())
                .isEqualTo("ines");
    }

    @Test
    void ohneSpiegelDerAnmeldename_ohneBeidesDasSubject() {
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "preferred_username", "ines"))).orElseThrow().name())
                .isEqualTo("ines");
        spiegel("s-ines", " ");
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "preferred_username", "ines"))).orElseThrow().name())
                .isEqualTo("ines");
        ZugriffContext.clear();
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines"))).orElseThrow().name()).isEqualTo("s-ines");
    }

    /** Wie vor PR 0: nur ein Token ganz ohne Anmeldenamen (Test-Fixtures, nie Keycloak) nimmt den Claim {@code name}. */
    @Test
    void ohneAnmeldenamenWieBisherDerClaimName() {
        assertThat(ProtokollAkteur.aus(token(Map.of("sub", "s-ines", "name", "Ines Kaltenbach"))).orElseThrow().name())
                .isEqualTo("Ines Kaltenbach");
    }
}
