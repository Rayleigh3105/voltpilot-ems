package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * AP-00 IP-7: das lokale Realm kennt einen dritten Demo-Login {@code ahrenberg}.
 *
 * <p>Geprüft wird OHNE laufendes Keycloak — rein strukturell gegen
 * {@code infra/local/keycloak/voltpilot-realm.json} (dieselbe Datei importiert
 * {@code PortalApiTest} und ein Dutzend weitere Klassen in ihren
 * Keycloak-Testcontainer; der Maven-Testpfad hängt sie als {@code keycloak/}
 * an den Klassenpfad, siehe {@code services/api/pom.xml}).
 *
 * <p>Seit AP-03 IP-16 stehen daneben die SIEBEN Personen der Referenz mit je
 * einem Login. Sie tragen eine FESTE {@code id} — das ist das Subject, unter dem
 * {@code infra/local/seed/ahrenberg.sql} ihren Benutzer-Spiegel anlegt; ohne sie
 * vergäbe Keycloak beim Import eine zufällige, und kein Spiegel fände sein Konto.
 *
 * <p>Zwei Dinge hält diese Klasse zusammen, die sonst auseinanderlaufen: der
 * neue Login trägt GENAU die Pflichtfelder der bestehenden Demo-Logins, und
 * sein {@code tenant_id}-Attribut ist derselbe Kundenbereich, den
 * {@code infra/local/seed/ahrenberg.sql} anlegt. Die bestehenden Logins bleiben
 * unberührt — ihr Inhalt steht hier ausgeschrieben.
 */
class AhrenbergDemoLoginTest {

    private static final Path REALM =
            Path.of("..", "..", "infra", "local", "keycloak", "voltpilot-realm.json");
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");

    @Test
    void dasRealmIstGueltigesJsonUndKenntDenLoginAhrenberg() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());

        List<String> namen = new ArrayList<>();
        realm.path("users").forEach(u -> namen.add(u.path("username").asText()));
        assertThat(namen).containsExactly("service-account-voltpilot-release-publisher",
                "service-account-voltpilot-api", "admin", "demo", "demo2", "ahrenberg",
                "jonas", "ines", "peter", "murat", "claudia", "partner-brunner", "support-voss");

        JsonNode a = benutzer(realm, "ahrenberg");
        JsonNode demo = benutzer(realm, "demo");
        // Dieselben Pflichtfelder wie die bestehenden Demo-Logins - kein Feld mehr, keines weniger.
        assertThat(feldnamen(a)).isEqualTo(feldnamen(demo));
        assertThat(a.path("enabled").asBoolean()).isTrue();
        assertThat(a.path("emailVerified").asBoolean()).isTrue();
        assertThat(a.path("email").asText()).isEqualTo("ahrenberg@voltpilot.local");
        assertThat(a.path("credentials").get(0).path("type").asText()).isEqualTo("password");
        assertThat(a.path("credentials").get(0).path("value").asText()).isEqualTo("ahrenberg");
        assertThat(a.path("credentials").get(0).path("temporary").asBoolean()).isFalse();
        assertThat(a.path("realmRoles")).singleElement()
                .satisfies(r -> assertThat(r.asText()).isEqualTo("operator"));
    }

    @Test
    void derLoginZeigtAufDenKundenbereichDesSeeds() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());
        String ausDemRealm = benutzer(realm, "ahrenberg")
                .path("attributes").path("tenant_id").get(0).asText();

        // Die erste tenant-Zeile des Seeds ist der Kundenbereich, den er anlegt.
        Matcher m = Pattern.compile("INSERT INTO tenant[^']*'([0-9a-f-]{36})'")
                .matcher(Files.readString(SEED));
        assertThat(m.find()).as("der Seed legt einen Kundenbereich an").isTrue();
        assertThat(ausDemRealm).isEqualTo(m.group(1));
    }

    @Test
    void diebestehendenDemoLoginsBleibenUnveraendert() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());
        assertThat(benutzer(realm, "demo").path("attributes").path("tenant_id").get(0).asText())
                .isEqualTo("00000000-0000-0000-0000-000000000001");
        assertThat(benutzer(realm, "demo").path("credentials").get(0).path("value").asText())
                .isEqualTo("demo");
        assertThat(benutzer(realm, "demo2").path("attributes").path("tenant_id").get(0).asText())
                .isEqualTo("10000000-0000-0000-0000-000000000001");
        assertThat(benutzer(realm, "demo2").path("credentials").get(0).path("value").asText())
                .isEqualTo("demo2");
        assertThat(benutzer(realm, "admin").path("realmRoles").get(0).asText()).isEqualTo("platform-admin");
    }

    /**
     * AP-03 IP-16: die sieben Personen der Referenz haben je ein Login, und jedes zeigt die
     * KONTOART, die {@code KeycloakRealmRoleConverter} aus dem Token ableitet:
     *
     * <ul>
     *   <li>ein Kundenkonto trägt {@code tenant_id} und KEINE Realm-Rolle — seine Rechte kommen
     *       allein aus der Zuweisung, nie aus dem Token (AP-03 IP-3/IP-4);</li>
     *   <li>das Partner-Konto trägt die Realm-Rolle {@code partner} und NIE einen
     *       Kundenbereich: es kommt nur über eine gewährte Unterstützung herein;</li>
     *   <li>das VoltPilot-Konto trägt {@code platform-admin} — die einzige Realm-Rolle, aus der
     *       der Konverter {@code KONTO_plattform} ableitet — und ebenfalls keinen
     *       Kundenbereich.</li>
     * </ul>
     */
    @Test
    void dieSiebenPersonenDerReferenzHabenIhrLogin() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());
        String seed = Files.readString(SEED);

        for (String login : List.of("jonas", "ines", "peter", "murat", "claudia")) {
            JsonNode u = benutzer(realm, login);
            assertThat(u.path("enabled").asBoolean()).as(login + " aktiv").isTrue();
            assertThat(u.path("attributes").path("tenant_id").get(0).asText()).as(login + " Kundenbereich")
                    .isEqualTo("20000000-0000-0000-0000-000000000001");
            assertThat(u.path("realmRoles")).as(login + " ohne Realm-Rolle").isEmpty();
            assertThat(u.path("credentials").get(0).path("value").asText()).isEqualTo(login);
        }

        JsonNode partner = benutzer(realm, "partner-brunner");
        assertThat(partner.path("realmRoles")).singleElement()
                .satisfies(r -> assertThat(r.asText()).isEqualTo("partner"));
        assertThat(partner.has("attributes")).as("ein Partner-Konto hat nie einen Kundenbereich").isFalse();

        JsonNode support = benutzer(realm, "support-voss");
        assertThat(support.path("realmRoles")).singleElement()
                .satisfies(r -> assertThat(r.asText()).isEqualTo("platform-admin"));
        assertThat(support.has("attributes")).as("ein Plattform-Konto hat nie einen Kundenbereich").isFalse();

        // Die feste id IST das Subject des Benutzer-Spiegels: jede muss im Seed vorkommen.
        for (String login : List.of("jonas", "ines", "peter", "murat", "claudia",
                "partner-brunner", "support-voss")) {
            String id = benutzer(realm, login).path("id").asText();
            assertThat(id).as(login + " trägt eine feste id").matches("[0-9a-f-]{36}");
            assertThat(seed).as("Spiegel von " + login + " im Seed").contains(id);
        }
    }

    /**
     * Die Zelle AP-03 IP-16 nennt ACHT Logins, der Seed trägt SIEBEN: die Referenzdatei
     * streicht Sabine Rauch ausdrücklich zusammen mit ihrem Standort ST-3
     * ({@code _herkunft.bewusst_ausgelassen} — AP-00 §4.4 führt das Referenzunternehmen mit
     * ZWEI Standorten). Dieser Test hält das fest, damit ein achtes Login nicht still
     * nachwächst: wer Sabine will, braucht erst ST-3 in der Referenz.
     */
    @Test
    void esGibtKeinLoginSabineUndKeinenStandortSt3() throws Exception {
        JsonNode realm = new ObjectMapper().readTree(REALM.toFile());
        List<String> namen = new ArrayList<>();
        realm.path("users").forEach(u -> namen.add(u.path("username").asText()));
        assertThat(namen).doesNotContain("sabine");

        // Geprüft werden die DATEN, nicht der Kopfkommentar - der nennt beide und sagt, warum.
        String seed = Files.readString(SEED);
        String daten = seed.lines().filter(z -> !z.stripLeading().startsWith("--"))
                .collect(java.util.stream.Collectors.joining("\n"));
        assertThat(daten).doesNotContain("Sabine");
        assertThat(daten).doesNotContain("ST-3");
        assertThat(seed).as("der Kommentar erklärt, warum sie fehlen").contains("Sabine Rauch");

        // Und die Referenz selbst sagt, warum.
        JsonNode ref = new ObjectMapper().readTree(
                Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json").toFile());
        assertThat(ref.path("_herkunft").path("bewusst_ausgelassen").asText())
                .contains("ST-3").contains("Sabine Rauch");
        assertThat(ref.path("personen")).hasSize(7);
    }

    private static JsonNode benutzer(JsonNode realm, String name) {
        for (JsonNode u : realm.path("users")) {
            if (name.equals(u.path("username").asText())) {
                return u;
            }
        }
        throw new AssertionError("Login " + name + " fehlt im Realm");
    }

    private static List<String> feldnamen(JsonNode u) {
        List<String> felder = new ArrayList<>();
        u.fieldNames().forEachRemaining(felder::add);
        return felder;
    }
}
