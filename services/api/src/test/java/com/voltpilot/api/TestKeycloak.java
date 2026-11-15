package com.voltpilot.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import org.testcontainers.lifecycle.Startable;

/**
 * Ein frisch importierter Realm {@code voltpilot} je Testklasse - in einem Keycloak-Container, den
 * alle Testklassen eines Testlaufs (einer JVM) teilen. Ersetzt den eigenen {@code KeycloakContainer}
 * je Klasse (Start rund 20 bis 30 s, im Nachtlauf rund 70 Mal).
 *
 * <p>Wie ein eigener Container: der erste {@link #start()} importiert den Realm beim Hochfahren
 * ({@code --import-realm}), jeder weitere löscht den Realm samt Benutzern, Sitzungen und Schlüsseln
 * und legt ihn aus derselben Datei über die Admin-Schnittstelle neu an (neue Signaturschlüssel, wie
 * ein neuer Container). Der Realm {@code master} bleibt; ändert eine Klasse ihn, startet der nächste
 * {@link #start()} einen neuen Container. Belegt in {@code TestKeycloakTest}.
 */
public final class TestKeycloak implements Startable {

    private static final String BILD = "quay.io/keycloak/keycloak:26.0.5";
    static final String REALM_DATEI = "keycloak/voltpilot-realm.json";
    static final String REALM = "voltpilot";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    private static KeycloakContainer container;
    private static String masterAbdruck;
    /** Wie oft ein Container hochgefahren ist - für den Beleg, dass Zurücksetzen keinen braucht. */
    static int containerStarts;

    @Override
    public void start() {
        synchronized (TestKeycloak.class) {
            if (container != null) {
                String master = masterAbdruck();
                if (masterAbdruck.equals(master)) {
                    neuerRealm();
                    // Der neue Realm ändert master mit (sein Verwaltungs-Client voltpilot-realm).
                    masterAbdruck = masterAbdruck();
                } else {
                    System.err.println("TestKeycloak: Realm master geändert, neuer Container:\n" + masterAbdruck
                            + "\n->\n" + master);
                    container.stop();
                    container = null;
                }
            }
            if (container == null) {
                container = new KeycloakContainer(BILD).withRealmImportFile(REALM_DATEI);
                container.start();
                containerStarts++;
                masterAbdruck = masterAbdruck();
            }
        }
    }

    /** Nichts: der nächste {@link #start()} setzt den Realm zurück. */
    @Override
    public void stop() {
    }

    public String getAuthServerUrl() {
        return laufend().getAuthServerUrl();
    }

    public String getAdminUsername() {
        return laufend().getAdminUsername();
    }

    public String getAdminPassword() {
        return laufend().getAdminPassword();
    }

    private static KeycloakContainer laufend() {
        if (container == null) {
            throw new IllegalStateException("TestKeycloak ist nicht gestartet");
        }
        return container;
    }

    private static void neuerRealm() {
        String token = adminToken();
        anfrage(HttpRequest.newBuilder(admin("/realms/" + REALM)).DELETE(), token, 204);
        byte[] realm;
        try (InputStream in = Objects.requireNonNull(
                TestKeycloak.class.getClassLoader().getResourceAsStream(REALM_DATEI), REALM_DATEI)) {
            realm = in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        anfrage(HttpRequest.newBuilder(admin("/realms")).POST(HttpRequest.BodyPublishers.ofByteArray(realm))
                .header("Content-Type", "application/json"), token, 201);
    }

    /** Was eine Klasse am Realm {@code master} ändern könnte: Einstellungen, Benutzer, Clients, Rollen. */
    private static String masterAbdruck() {
        String token = adminToken();
        StringBuilder b = new StringBuilder();
        for (String pfad : new String[] {"/realms/master", "/realms/master/users?briefRepresentation=false",
                "/realms/master/clients", "/realms/master/roles", "/realms/master/groups"}) {
            b.append(lies(pfad, token)).append('\n');
        }
        return b.toString();
    }

    static String lies(String pfad, String token) {
        return anfrage(HttpRequest.newBuilder(admin(pfad)).GET(), token, 200);
    }

    static JsonNode liesJson(String pfad, String token) {
        try {
            return JSON.readTree(lies(pfad, token));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static String adminToken() {
        String form = "grant_type=password&client_id=admin-cli&username="
                + URLEncoder.encode(container.getAdminUsername(), StandardCharsets.UTF_8)
                + "&password=" + URLEncoder.encode(container.getAdminPassword(), StandardCharsets.UTF_8);
        String antwort = anfrage(HttpRequest.newBuilder(
                        URI.create(container.getAuthServerUrl() + "/realms/master/protocol/openid-connect/token"))
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .header("Content-Type", "application/x-www-form-urlencoded"), null, 200);
        try {
            return JSON.readTree(antwort).get("access_token").asText();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static URI admin(String pfad) {
        return URI.create(container.getAuthServerUrl() + "/admin" + pfad);
    }

    static String anfrage(HttpRequest.Builder anfrage, String token, int erwartet) {
        if (token != null) {
            anfrage.header("Authorization", "Bearer " + token);
        }
        HttpRequest r = anfrage.build();
        try {
            HttpResponse<String> antwort = HTTP.send(r, HttpResponse.BodyHandlers.ofString());
            if (antwort.statusCode() != erwartet) {
                throw new IllegalStateException(r.method() + " " + r.uri() + " -> " + antwort.statusCode()
                        + ": " + antwort.body());
            }
            return antwort.body();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
