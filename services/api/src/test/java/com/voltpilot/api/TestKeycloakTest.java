package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.testcontainers.DockerClientFactory;

/**
 * Belegt, dass ein {@link TestKeycloak} so isoliert ist wie der eigene Container, den er ersetzt:
 * nach dem Zurücksetzen ist der Realm genau der beim Hochfahren importierte (Einstellungen, Clients,
 * Rollen, Gruppen, Benutzer mit Attributen und Rollen), nichts aus der vorigen Klasse ist übrig, und
 * ein Token der vorigen Klasse gilt nicht mehr (neue Schlüssel wie bei einem neuen Container).
 */
class TestKeycloakTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** Bei jedem Import neu erzeugt - auch zwischen zwei frischen Containern verschieden. */
    private static final Set<String> JE_IMPORT = Set.of("id", "containerId", "createdTimestamp", "parentId");

    private static void docker() {
        Assumptions.assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker fehlt");
    }

    @Test
    void naechsteKlasseSiehtDenFrischImportiertenRealm() throws Exception {
        docker();
        TestKeycloak erste = new TestKeycloak();
        erste.start();
        String token = TestKeycloak.adminToken();
        JsonNode frisch = abdruck(token);
        String schluessel = schluessel(token);
        String alterBenutzerToken = benutzerToken(erste);

        // Die Klasse ändert Realm, Benutzer und Rollen ...
        String realm = "/admin/realms/" + TestKeycloak.REALM;
        TestKeycloak.anfrage(HttpRequest.newBuilder(URI.create(erste.getAuthServerUrl() + realm + "/users"))
                .POST(HttpRequest.BodyPublishers.ofString(
                        "{\"username\":\"spur\",\"enabled\":true,\"attributes\":{\"tenant_id\":[\"x\"]}}"))
                .header("Content-Type", "application/json"), token, 201);
        TestKeycloak.anfrage(HttpRequest.newBuilder(URI.create(erste.getAuthServerUrl() + realm + "/roles"))
                .POST(HttpRequest.BodyPublishers.ofString("{\"name\":\"spur-rolle\"}"))
                .header("Content-Type", "application/json"), token, 201);
        TestKeycloak.anfrage(HttpRequest.newBuilder(URI.create(erste.getAuthServerUrl() + realm))
                .PUT(HttpRequest.BodyPublishers.ofString("{\"accessTokenLifespan\":7}"))
                .header("Content-Type", "application/json"), token, 204);
        assertThat(abdruck(token)).isNotEqualTo(frisch);
        erste.stop();

        // ... und die nächste Klasse bekommt wieder genau den importierten Realm.
        int starts = TestKeycloak.containerStarts;
        TestKeycloak zweite = new TestKeycloak();
        zweite.start();
        assertThat(TestKeycloak.containerStarts).as("zurückgesetzt, nicht neu gestartet").isEqualTo(starts);
        String neu = TestKeycloak.adminToken();
        assertThat(unterschiede(frisch, abdruck(neu), "")).isEmpty();
        assertThat(schluessel(neu)).isNotEqualTo(schluessel);
        TestKeycloak.anfrage(HttpRequest.newBuilder(URI.create(zweite.getAuthServerUrl() + "/realms/"
                + TestKeycloak.REALM + "/protocol/openid-connect/userinfo")).GET(), alterBenutzerToken, 401);
        zweite.stop();

        // Auch nach einem Zurücksetzen: die dritte Klasse bekommt wieder denselben Realm im selben Container.
        TestKeycloak dritte = new TestKeycloak();
        dritte.start();
        assertThat(TestKeycloak.containerStarts).isEqualTo(starts);
        assertThat(unterschiede(frisch, abdruck(TestKeycloak.adminToken()), "")).isEmpty();
    }

    /** Neue Testklassen nehmen den geteilten Keycloak (Start je Klasse rund 20 bis 30 s). */
    @Test
    void keineTestklasseStartetEinenEigenenKeycloak() throws IOException {
        List<String> eigene = new ArrayList<>();
        try (Stream<Path> dateien = Files.walk(Path.of("src/test/java"))) {
            for (Path datei : dateien.filter(d -> d.toString().endsWith(".java")).sorted().toList()) {
                if (!Set.of("TestKeycloak.java", "TestKeycloakTest.java").contains(datei.getFileName().toString())
                        && Files.readString(datei, StandardCharsets.UTF_8).contains("new KeycloakContainer")) {
                    eigene.add(datei.toString());
                }
            }
        }
        assertThat(eigene).as("statt new KeycloakContainer: new TestKeycloak()").isEmpty();
    }

    /** Realm-Export (Einstellungen, Clients, Rollen, Gruppen) und alle Benutzer mit Rollen. */
    private static JsonNode abdruck(String token) throws Exception {
        String realm = "/realms/" + TestKeycloak.REALM;
        ObjectNode abdruck = JSON.createObjectNode();
        String export = TestKeycloak.anfrage(HttpRequest.newBuilder(URI.create(new TestKeycloak().getAuthServerUrl()
                        + "/admin" + realm + "/partial-export?exportClients=true&exportGroupsAndRoles=true"))
                .POST(HttpRequest.BodyPublishers.noBody()), token, 200);
        abdruck.set("realm", JSON.readTree(export));
        ArrayNode benutzer = abdruck.putArray("benutzer");
        for (JsonNode b : TestKeycloak.liesJson(realm + "/users?briefRepresentation=false&max=1000", token)) {
            ObjectNode eintrag = ((ObjectNode) b).deepCopy();
            eintrag.set("rollen", TestKeycloak.liesJson(realm + "/users/" + b.get("id").asText()
                    + "/role-mappings", token));
            benutzer.add(eintrag);
        }
        return ohneJeImport(abdruck);
    }

    private static String schluessel(String token) {
        List<String> kids = new ArrayList<>();
        TestKeycloak.liesJson("/realms/" + TestKeycloak.REALM + "/keys", token).get("keys")
                .forEach(k -> kids.add(k.get("kid").asText()));
        return String.join(",", kids);
    }

    /** Ein Benutzer-Token, wie es die Testklassen holen (Passwort-Zugang am Client voltpilot-api). */
    private static String benutzerToken(TestKeycloak kc) throws Exception {
        String antwort = TestKeycloak.anfrage(HttpRequest.newBuilder(URI.create(kc.getAuthServerUrl() + "/realms/"
                        + TestKeycloak.REALM + "/protocol/openid-connect/token"))
                .POST(HttpRequest.BodyPublishers.ofString("grant_type=password&client_id=voltpilot-api"
                        + "&client_secret=voltpilot-api-dev-secret&username=demo&password=demo&scope=openid"))
                .header("Content-Type", "application/x-www-form-urlencoded"), null, 200);
        return JSON.readTree(antwort).get("access_token").asText();
    }

    /** Pfade, an denen sich zwei Abdrücke unterscheiden (Listen nach Position, siehe {@link #ohneJeImport}). */
    private static List<String> unterschiede(JsonNode a, JsonNode b, String pfad) {
        List<String> unterschiede = new ArrayList<>();
        if (a.isObject() && b.isObject()) {
            Set<String> felder = new java.util.TreeSet<>();
            a.fieldNames().forEachRemaining(felder::add);
            b.fieldNames().forEachRemaining(felder::add);
            for (String feld : felder) {
                if (!a.has(feld) || !b.has(feld)) {
                    unterschiede.add(pfad + "/" + feld + ": " + a.get(feld) + " -> " + b.get(feld));
                } else {
                    unterschiede.addAll(unterschiede(a.get(feld), b.get(feld), pfad + "/" + feld));
                }
            }
        } else if (a.isArray() && b.isArray() && a.size() == b.size()) {
            for (int i = 0; i < a.size(); i++) {
                unterschiede.addAll(unterschiede(a.get(i), b.get(i), pfad + "[" + i + "]"));
            }
        } else if (!a.equals(b)) {
            String vorher = a.toString();
            String nachher = b.toString();
            unterschiede.add(pfad + ": " + vorher.substring(0, Math.min(200, vorher.length())) + " -> "
                    + nachher.substring(0, Math.min(200, nachher.length())));
        }
        return unterschiede;
    }

    private static JsonNode ohneJeImport(JsonNode knoten) {
        if (knoten.isObject()) {
            ObjectNode o = (ObjectNode) knoten;
            for (Iterator<String> it = o.fieldNames(); it.hasNext(); ) {
                String feld = it.next();
                if (JE_IMPORT.contains(feld)) {
                    it.remove();
                } else {
                    ohneJeImport(o.get(feld));
                }
            }
        } else if (knoten.isArray()) {
            // Keycloak liefert ungeordnete Mengen nach ihrer (zufälligen) Kennung sortiert.
            ArrayNode liste = (ArrayNode) knoten;
            List<JsonNode> elemente = new ArrayList<>();
            liste.forEach(e -> elemente.add(ohneJeImport(e)));
            elemente.sort(java.util.Comparator.comparing(JsonNode::toString));
            liste.removeAll();
            liste.addAll(elemente);
        }
        return knoten;
    }
}
