package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * RL-P2a (RL-3 = B): der Client {@code grafana} im PRODUKTIONS-Realm-Import
 * {@code infra/prod/keycloak/voltpilot-realm.json} und im Skript für den laufenden Realm
 * ({@code live-realm-grafana.sh}) — beides dieselbe Definition.
 *
 * <p>Geprüft wird OHNE laufendes Keycloak, rein an den zwei Dateien. Der Vertrag steht im GitOps-Repository
 * ({@code infra/monitoring/grafana-zugang/README.md}, „Der Client in Keycloak“) und weicht an einer Stelle vom
 * Naheliegenden ab: Das Zugriffstoken dieses Clients trägt keine Rolle. Das API macht aus jedem gültig signierten
 * Token des Realms mit {@code platform-admin} unter {@code realm_access.roles} das Plattform-Konto
 * ({@code KeycloakRealmRoleConverter}) und prüft weder {@code aud} noch {@code azp}; Grafana bewahrt die Token
 * seiner Benutzer auf. Darum hängt der Scope {@code roles} nicht am Client, Full Scope ist aus, und die Rolle
 * steht unter dem eigenen Namen {@code grafana_roles} nur im ID-Token.
 *
 * <p>Dass Keycloak beide Wege gleich annimmt und solche Token ausstellt, zeigt
 * {@link ProduktionsRealmGrafanaClientTest} im Container.
 */
class ProduktionsRealmGrafanaDateiTest {

    private static final Path REALM = Path.of("..", "..", "infra", "prod", "keycloak", "voltpilot-realm.json");
    private static final Path SKRIPT = Path.of("..", "..", "infra", "prod", "keycloak", "live-realm-grafana.sh");
    private static final String ADRESSE = "https://grafana.voltpilot.de/login/generic_oauth";
    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode realm;
    private static JsonNode client;
    private static String skript;

    @BeforeAll
    static void lesen() throws Exception {
        realm = JSON.readTree(REALM.toFile());
        List<JsonNode> treffer = new ArrayList<>();
        realm.path("clients").forEach(c -> {
            if ("grafana".equals(c.path("clientId").asText())) {
                treffer.add(c);
            }
        });
        assertThat(treffer).as("genau ein Client grafana im Import").hasSize(1);
        client = treffer.get(0);
        skript = Files.readString(SKRIPT, StandardCharsets.UTF_8);
    }

    @Test
    void importUndSkriptTragenDieselbeDefinition() throws Exception {
        // Das Skript legt den Client mit genau diesem Rumpf an und setzt einen vorhandenen darauf zurück.
        Matcher m = Pattern.compile("(?s)read -r -d '' DEFINITION << 'JSON' \\|\\| true\\n(.*?)\\nJSON\\n").matcher(skript);
        assertThat(m.find()).as("Definition im Skript").isTrue();
        assertThat(JSON.readTree(m.group(1))).isEqualTo(client);

        // Was das Skript daneben als Sollwert führt, steht in derselben Definition.
        assertThat(skript).contains("ADRESSE='" + ADRESSE + "'");
        assertThat(skript).contains("SCOPES=(basic profile email)");
        assertThat(skript).contains("ROLLE=platform-admin").contains("CLAIM=grafana_roles");
    }

    @Test
    void vertraulichNurStandardFlowMitPkceUndGenauEinerAdresse() {
        assertThat(client.path("enabled").asBoolean()).isTrue();
        assertThat(client.path("protocol").asText()).isEqualTo("openid-connect");
        assertThat(client.path("publicClient").asBoolean(true)).as("vertraulich").isFalse();
        assertThat(client.path("standardFlowEnabled").asBoolean()).isTrue();
        // Jeder dieser Wege gäbe ein Token ohne den Browser-Ablauf mit zweitem Faktor. Fehlt das Feld, gilt die
        // Vorgabe von Keycloak — und die ist für Direct Access Grants „an“.
        for (String aus : List.of("implicitFlowEnabled", "directAccessGrantsEnabled", "serviceAccountsEnabled")) {
            assertThat(client.has(aus)).as(aus + " steht ausdrücklich da").isTrue();
            assertThat(client.path(aus).asBoolean(true)).as(aus).isFalse();
        }
        assertThat(texte(client.path("redirectUris"))).as("genau eine Rückruf-Adresse, kein Platzhalter")
                .containsExactly(ADRESSE);
        assertThat(client.path("webOrigins").isArray()).isTrue();
        assertThat(client.path("webOrigins")).isEmpty();
        assertThat(client.path("attributes").path("pkce.code.challenge.method").asText()).isEqualTo("S256");
        assertThat(client.path("attributes").path("post.logout.redirect.uris").asText()).isEqualTo(ADRESSE);
    }

    @Test
    void dasZugriffstokenKannKeineRolleTragen() {
        // Full Scope aus: in den Token steht nur, was die Scope-Zuordnung nennt — und das ist allein platform-admin.
        assertThat(client.has("fullScopeAllowed")).as("fullScopeAllowed steht ausdrücklich da (Vorgabe: an)").isTrue();
        assertThat(client.path("fullScopeAllowed").asBoolean(true)).isFalse();
        List<JsonNode> zuordnungen = new ArrayList<>();
        realm.path("scopeMappings").forEach(zuordnungen::add);
        assertThat(zuordnungen).as("eine Scope-Zuordnung im Import").hasSize(1);
        assertThat(zuordnungen.get(0).path("client").asText()).isEqualTo("grafana");
        assertThat(texte(zuordnungen.get(0).path("roles"))).containsExactly("platform-admin");
        assertThat(realm.path("clientScopeMappings").isMissingNode()).as("keine Client-Rolle im Scope").isTrue();

        // Der Scope roles hängt NICHT am Client: sein Mapper schriebe realm_access.roles ins Zugriffstoken. Fehlt die
        // Liste, hängt Keycloak die Vorgaben des Realms an — mit roles.
        assertThat(client.has("defaultClientScopes")).isTrue();
        assertThat(texte(client.path("defaultClientScopes"))).containsExactlyInAnyOrder("basic", "profile", "email");
        assertThat(client.has("optionalClientScopes")).isTrue();
        assertThat(client.path("optionalClientScopes")).isEmpty();

        // Genau ein Mapper, und er schreibt die Rolle unter einem Namen, den das API nicht liest, nur ins ID-Token.
        assertThat(client.path("protocolMappers")).hasSize(1);
        JsonNode mapper = client.path("protocolMappers").get(0);
        assertThat(mapper.path("protocolMapper").asText()).isEqualTo("oidc-usermodel-realm-role-mapper");
        JsonNode config = mapper.path("config");
        assertThat(config.path("claim.name").asText()).isEqualTo("grafana_roles").doesNotContain("realm_access");
        assertThat(config.path("multivalued").asText()).isEqualTo("true");
        assertThat(config.path("id.token.claim").asText()).isEqualTo("true");
        assertThat(config.path("access.token.claim").asText()).isEqualTo("false");
        assertThat(config.path("userinfo.token.claim").asText()).isEqualTo("false");
    }

    @Test
    void dasGeheimnisStehtInKeinerDerZweiDateien() {
        // Ohne das Feld erzeugt Keycloak beim Import ein zufälliges Geheimnis. Ein Platzhalter wäre keiner: fehlt die
        // Variable, bleibt „${VP_…}“ wörtlich als Geheimnis stehen, und ein leeres Geheimnis nimmt Keycloak 26.0.5 am
        // Token-Endpunkt an (beides am Container nachgestellt). ProduktionsRealmGrafanaClientTest liest das erzeugte.
        assertThat(client.has("secret")).as("kein secret am Client grafana").isFalse();
        assertThat(skript).doesNotContain("\"secret\"").doesNotContain("VP_GRAFANA");
        // Das Skript schaltet keine Befehlsverfolgung ein: mit ihr stünde das Geheimnis in der Fehlerausgabe.
        assertThat(skript).doesNotContain("set -x").doesNotContain("xtrace");
    }

    private static List<String> texte(JsonNode liste) {
        List<String> alle = new ArrayList<>();
        liste.forEach(e -> alle.add(e.asText()));
        return alle;
    }
}
