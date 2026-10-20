package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Base64;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.Transferable;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;

/**
 * UEMS AP-20 IP-20 (E12, BT6): der PRODUKTIONS-Realm-Import {@code infra/prod/keycloak/voltpilot-realm.json}
 * in einem echten Keycloak — dieselbe Version wie {@code deploy/keycloak/Dockerfile}, im Produktionsmodus
 * ({@code start --import-realm}), denn nur der liest die Datei so streng wie der Cluster; {@code start-dev}
 * übersieht unbekannte Felder.
 *
 * <p>{@link ProduktionsRealmAnmeldungTest} prüft die Felder der Datei; diese Klasse prüft, dass Keycloak sie
 * annimmt und so handelt, wie E12 es verlangt: Ereignisse werden gespeichert, die Passwort-Vorgabe greift beim
 * nächsten Setzen (bestehende Passwörter bleiben gültig), ein {@code platform-admin} muss den zweiten Faktor
 * einrichten und bekommt per Passwort-Grant gar kein Token, ein Kundenkonto meldet sich ohne zweiten Faktor an,
 * und das API-Servicekonto bleibt unberührt. Dazu fährt die Klasse das Skript des Blatts
 * ({@code live-realm-anmeldung.sh}) gegen einen Realm ohne Härtung und vergleicht das Ergebnis mit dem Import.
 * Drei Fälle halten fest, was am Blatt und am Skript falsch war: der Rückweg, wie er im Blatt steht (beide
 * Teile), ein mittendrin abgebrochener Lauf (der nächste bindet nichts Unvollständiges) und {@code pruefen}
 * gegen verstellte Rollen-Bedingungen.
 *
 * <p>Der Live-Realm ändert sich dadurch nicht: {@code --import-realm} überschreibt keinen bestehenden Realm.
 * Den Handgriff beschreibt {@code infra/prod/keycloak/live-realm-import.md}.
 */
@Testcontainers(disabledWithoutDocker = true)
class ProduktionsRealmImportTest {

    private static final Path REALM = Path.of("..", "..", "infra", "prod", "keycloak", "voltpilot-realm.json");
    private static final Path SKRIPT = Path.of("..", "..", "infra", "prod", "keycloak", "live-realm-anmeldung.sh");
    private static final Path BLATT = Path.of("..", "..", "infra", "prod", "keycloak", "live-realm-import.md");
    private static final Path THEMA = Path.of("..", "..", "deploy", "keycloak", "themes", "voltpilot");
    private static final String ORIGIN = "http://localhost:5173";
    private static final String API_SECRET = "api-geheimnis-nur-fuer-diesen-test";
    private static final String PORTAL_ADMIN_PASSWORT = "Betrieb-Anmeldung-2026";
    private static final String KC_ADMIN = "kcadmin";
    private static final String KC_ADMIN_PASSWORT = "kcadmin-nur-fuer-diesen-test";
    private static final ObjectMapper JSON = new ObjectMapper();
    /**
     * Stellt eine gerissene Verbindung nach: reicht jeden Aufruf an {@code kcadm.sh} durch und endet nach
     * {@code ABBRUCH_NACH} Aufrufen von {@code create} mit einem Fehler. Das Skript nimmt den Pfad über
     * {@code KCADM}; es bricht dann genau so ab wie bei einem echten Fehler von kcadm ({@code set -e}).
     */
    private static final String KCADM_MIT_ABBRUCH = """
            #!/usr/bin/env bash
            if [[ "${1:-}" == create ]]; then
              n=$(( $(cat "$ZAEHLER" 2> /dev/null || echo 0) + 1 )); echo "$n" > "$ZAEHLER"
              if (( n > ABBRUCH_NACH )); then echo "Probe: Abbruch beim $n. create" >&2; exit 1; fi
            fi
            exec /opt/keycloak/bin/kcadm.sh "$@"
            """;

    @Container
    static final GenericContainer<?> KEYCLOAK =
            new GenericContainer<>(DockerImageName.parse("quay.io/keycloak/keycloak:26.0.5"))
                    .withCopyFileToContainer(MountableFile.forHostPath(REALM),
                            "/opt/keycloak/data/import/voltpilot-realm.json")
                    .withCopyFileToContainer(MountableFile.forHostPath(THEMA), "/opt/keycloak/themes/voltpilot")
                    .withCopyFileToContainer(MountableFile.forHostPath(SKRIPT, 0755), "/opt/keycloak/live-realm-anmeldung.sh")
                    .withCopyToContainer(Transferable.of(KCADM_MIT_ABBRUCH, 0755), "/opt/keycloak/kcadm-mit-abbruch.sh")
                    .withEnv("KC_BOOTSTRAP_ADMIN_USERNAME", KC_ADMIN)
                    .withEnv("KC_BOOTSTRAP_ADMIN_PASSWORD", KC_ADMIN_PASSWORT)
                    .withEnv("VP_PUBLIC_ORIGIN", ORIGIN)
                    .withEnv("VP_API_CLIENT_SECRET", API_SECRET)
                    .withEnv("VP_PORTAL_ADMIN_PASSWORD", PORTAL_ADMIN_PASSWORT)
                    .withEnv("VP_RELEASE_PUBLISHER_SECRET", "publisher-geheimnis-nur-fuer-diesen-test")
                    .withCommand("start", "--import-realm", "--http-enabled=true", "--hostname-strict=false")
                    .withLogConsumer(new org.testcontainers.containers.output.Slf4jLogConsumer(
                            org.slf4j.LoggerFactory.getLogger("keycloak-produktion")))
                    .withExposedPorts(8080)
                    .waitingFor(Wait.forHttp("/realms/voltpilot").forPort(8080).forStatusCode(200)
                            .withStartupTimeout(Duration.ofMinutes(4)));

    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

    @Test
    void keycloakNimmtDenImportImProduktionsmodusAnUndBindetDieAblaeufe() throws Exception {
        JsonNode realm = adminGet("");

        assertThat(realm.path("passwordPolicy").asText())
                .contains("length(12)").contains("notUsername").contains("passwordHistory(3)");
        assertThat(realm.path("eventsEnabled").asBoolean()).isTrue();
        assertThat(realm.path("eventsExpiration").asLong()).isEqualTo(90L * 24 * 3600);
        assertThat(realm.path("adminEventsEnabled").asBoolean()).isTrue();
        assertThat(realm.path("attributes").path("adminEventsExpiration").asText()).isEqualTo("7776000");
        assertThat(realm.path("browserFlow").asText()).isEqualTo("voltpilot-browser");
        assertThat(realm.path("directGrantFlow").asText()).isEqualTo("voltpilot-direct-grant");
        // Die übrigen Bindungen zeigen auf vorhandene Abläufe — ein Import mit eigenen Abläufen darf die
        // eingebauten (Client-Anmeldung, Passwort vergessen, Registrierung, ...) nicht verlieren.
        for (String bindung : new String[] {"clientAuthenticationFlow", "resetCredentialsFlow",
                "registrationFlow", "dockerAuthenticationFlow", "firstBrokerLoginFlow"}) {
            String alias = realm.path(bindung).asText();
            assertThat(alias).as(bindung).isNotBlank();
            assertThat(ablaufAliase()).as(bindung + " = " + alias).contains(alias);
        }
    }

    @Test
    void dasApiServicekontoBekommtWeiterSeinToken() throws Exception {
        HttpResponse<String> r = post(tokenUrl(), Map.of("grant_type", "client_credentials",
                "client_id", "voltpilot-api", "client_secret", API_SECRET));
        assertThat(r.statusCode()).as(r.body()).isEqualTo(200);
        assertThat(JSON.readTree(r.body()).path("access_token").asText()).isNotBlank();
    }

    @Test
    void einKundenkontoMeldetSichOhneZweitenFaktorAn() throws Exception {
        String name = "kunde-" + kurz();
        String passwort = "Kunde-Passwort-" + kurz();
        assertThat(kontoAnlegen(name, passwort, false)).isEqualTo(201);

        HttpResponse<String> grant = passwortGrant(name, passwort);
        assertThat(grant.statusCode()).as(grant.body()).isEqualTo(200);

        HttpResponse<String> nachFormular = browserAnmeldung(name, passwort);
        assertThat(nachFormular.statusCode()).as(nachFormular.body()).isEqualTo(302);
        assertThat(nachFormular.headers().firstValue("Location").orElse(""))
                .startsWith(ORIGIN + "/").contains("code=");
    }

    @Test
    void derPlattformAdminMussDenZweitenFaktorEinrichten() throws Exception {
        // Das importierte Konto admin (platform-admin): nach dem Passwort verlangt Keycloak die Einrichtung
        // des zweiten Faktors, statt zum Portal weiterzuleiten.
        HttpResponse<String> nachFormular = browserAnmeldung("admin", PORTAL_ADMIN_PASSWORT);
        assertThat(nachFormular.statusCode()).as(nachFormular.body()).isEqualTo(200);
        assertThat(nachFormular.body()).contains("totpSecret");

        // Der Passwort-Grant gibt einem Betriebskonto kein Token — sauber abgelehnt, kein Serverfehler.
        HttpResponse<String> grant = passwortGrant("admin", PORTAL_ADMIN_PASSWORT);
        assertThat(grant.statusCode()).as(grant.body()).isBetween(400, 401);
        assertThat(grant.body()).doesNotContain("access_token");

        // Ein weiteres Betreiber-Konto gilt genauso — die Regel hängt an der Rolle, nicht am Namen.
        String name = "betrieb-" + kurz();
        String passwort = "Betrieb-Passwort-" + kurz();
        assertThat(kontoAnlegen(name, passwort, true)).isEqualTo(201);
        assertThat(browserAnmeldung(name, passwort).body()).contains("totpSecret");
        assertThat(passwortGrant(name, passwort).statusCode()).isBetween(400, 401);
    }

    @Test
    void diePasswortVorgabeGiltBeimNaechstenSetzenNichtRueckwirkend() throws Exception {
        // Neue Passwörter: mindestens 12 Zeichen, nicht der Benutzername.
        assertThat(kontoAnlegen("kurz-" + kurz(), "Elf-Zeichen", false)).isEqualTo(400);
        String gleich = "gleich-wie-name-" + kurz();
        assertThat(kontoAnlegen(gleich, gleich, false)).isEqualTo(400);

        // Ein BESTEHENDES Konto mit kurzem Passwort: angelegt, bevor die Vorgabe galt (Vorgabe kurz aus,
        // Konto anlegen, Vorgabe wieder an — so sieht jedes heutige Konto im Live-Realm aus, wenn der
        // Betreiber die Vorgabe einschaltet).
        String vorgabe = adminGet("").path("passwordPolicy").asText();
        String name = "bestand-" + kurz();
        assertThat(adminPut("", "{\"passwordPolicy\":\"\"}")).isEqualTo(204);
        try {
            assertThat(kontoAnlegen(name, "kurz-alt", false)).isEqualTo(201);
        } finally {
            assertThat(adminPut("", JSON.writeValueAsString(Map.of("passwordPolicy", vorgabe)))).isEqualTo(204);
        }
        // Das alte Passwort gilt weiter — keine Sperre, kein Zwangswechsel.
        assertThat(passwortGrant(name, "kurz-alt").statusCode()).isEqualTo(200);

        // Erst beim nächsten Setzen greift die Vorgabe, und die letzten drei kommen nicht wieder.
        String id = kontoId(name);
        assertThat(passwortSetzen(id, "zu-kurz-11z")).isEqualTo(400);
        assertThat(passwortSetzen(id, "Erstes-langes-Passwort")).isEqualTo(204);
        assertThat(passwortSetzen(id, "Zweites-langes-Passwort")).isEqualTo(204);
        assertThat(passwortSetzen(id, "Erstes-langes-Passwort")).isEqualTo(400);
    }

    @Test
    void anmeldeUndAdminEreignisseWerdenGespeichert() throws Exception {
        String name = "ereignis-" + kurz();
        String passwort = "Ereignis-Passwort-" + kurz();
        assertThat(kontoAnlegen(name, passwort, false)).isEqualTo(201);
        String id = kontoId(name);
        assertThat(passwortGrant(name, passwort).statusCode()).isEqualTo(200);
        assertThat(passwortGrant(name, "falsches-Passwort-123").statusCode()).isEqualTo(401);

        JsonNode anmeldungen = adminGet("/events?user=" + id + "&max=50");
        assertThat(anmeldungen.findValuesAsText("type")).contains("LOGIN", "LOGIN_ERROR");

        JsonNode adminEreignisse = adminGet("/admin-events?resourceTypes=USER&operationTypes=CREATE&max=200");
        assertThat(adminEreignisse.findValuesAsText("resourcePath")).contains("users/" + id);
    }

    /**
     * Die Anmeldeseite lädt jede Datei, die sie nennt (auch die Schriften aus dem CSS), und jede Datei unseres
     * Themas trägt die Thema-Version ({@code ?v=}, {@code assetVersion} in theme.properties; ungebaut
     * {@code dev}, das Image setzt den Inhalts-Hash ein). Beides fiel bisher erst live auf: ein Import aus dem
     * falschen Keycloak-Pfad ({@code authChecker.js}, 404 seit 23.08.2026) und eine neue Vorlage mit dem
     * 30 Tage gecachten CSS davor (20.10.2026).
     */
    @Test
    void dieAnmeldeseiteLaedtJedeDateiUndDasThemaTraegtSeineVersion() throws Exception {
        HttpResponse<String> seite = http.send(HttpRequest.newBuilder(URI.create(anmeldeUrl())).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(seite.statusCode()).as(seite.body()).isEqualTo(200);
        List<URI> dateien = new ArrayList<>();
        Matcher inSeite = Pattern.compile("\"(/resources/[^\"]+)\"").matcher(seite.body());
        while (inSeite.find()) {
            dateien.add(URI.create(basis() + inSeite.group(1).replace("&amp;", "&")));
        }
        URI css = dateien.stream().filter(d -> d.getPath().endsWith("/login/voltpilot/css/voltpilot.css"))
                .findFirst().orElseThrow();
        Matcher inCss = Pattern.compile("url\\('([^']+)'\\)").matcher(
                http.send(HttpRequest.newBuilder(css).GET().build(), HttpResponse.BodyHandlers.ofString()).body());
        while (inCss.find()) {
            dateien.add(css.resolve(inCss.group(1)));
        }

        List<String> nichtGeladen = new ArrayList<>();
        for (URI datei : dateien) {
            int status = http.send(HttpRequest.newBuilder(datei).GET().build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode();
            if (status != 200) {
                nichtGeladen.add(status + " " + datei.getPath());
            }
        }
        assertThat(dateien).as("Dateien der Anmeldeseite").hasSizeGreaterThanOrEqualTo(12);
        assertThat(nichtGeladen).isEmpty();
        assertThat(dateien.stream().filter(d -> d.getPath().contains("/login/voltpilot/"))
                .filter(d -> !"v=dev".equals(d.getQuery())).map(URI::toString).toList())
                .as("Dateien des Themas ohne Thema-Version").isEmpty();
    }

    @Test
    void dasSkriptDesBlattsMachtEinenBestehendenRealmGleichDemImport() throws Exception {
        // Ein Realm wie der heutige Live-Realm: eingebaute Abläufe, keine Vorgabe, keine Ereignisse, und Konten
        // mit kurzen Passwörtern — ein Betriebskonto und ein Kundenkonto.
        String alt = "altbestand-" + kurz();
        assertThat(adminPostIn("", "", JSON.writeValueAsString(Map.of("realm", alt, "enabled", true))))
                .isEqualTo(201);
        assertThat(adminPostIn(alt, "/roles", "{\"name\":\"platform-admin\"}")).isEqualTo(201);
        assertThat(kontoAnlegenIn(alt, "betrieb-alt", "kurz-alt", true)).isEqualTo(201);
        assertThat(kontoAnlegenIn(alt, "kunde-alt", "kurz-alt", false)).isEqualTo(201);

        org.testcontainers.containers.Container.ExecResult vorher = skript(alt, "pruefen");
        assertThat(vorher.getExitCode()).as(vorher.getStdout() + vorher.getStderr()).isEqualTo(1);
        assertThat(vorher.getStdout()).contains("ABWEICHUNG passwordPolicy");

        org.testcontainers.containers.Container.ExecResult lauf = skript(alt, "angleichen");
        assertThat(lauf.getExitCode()).as(lauf.getStdout() + lauf.getStderr()).isZero();
        org.testcontainers.containers.Container.ExecResult nochmal = skript(alt, "angleichen");
        assertThat(nochmal.getExitCode()).as(nochmal.getStdout() + nochmal.getStderr()).isZero();
        assertThat(nochmal.getStdout()).contains("Ablauf voltpilot-browser ist schon vollstaendig vorhanden.")
                .contains("Ablauf voltpilot-direct-grant ist schon vollstaendig vorhanden.");
        org.testcontainers.containers.Container.ExecResult danach = skript(alt, "pruefen");
        assertThat(danach.getExitCode()).as(danach.getStdout() + danach.getStderr()).isZero();

        // Live-Realm = Import: dieselben Realm-Werte und dieselben Abläufe, Schritt für Schritt.
        JsonNode angeglichen = adminGetIn(alt, "");
        JsonNode importiert = adminGet("");
        for (String feld : new String[] {"passwordPolicy", "eventsEnabled", "eventsExpiration",
                "adminEventsEnabled", "adminEventsDetailsEnabled", "browserFlow", "directGrantFlow"}) {
            assertThat(angeglichen.path(feld)).as(feld).isEqualTo(importiert.path(feld));
        }
        assertThat(angeglichen.path("attributes").path("adminEventsExpiration"))
                .isEqualTo(importiert.path("attributes").path("adminEventsExpiration"));
        for (String ablauf : new String[] {"voltpilot-browser", "voltpilot-direct-grant"}) {
            assertThat(ablaufBild(alt, ablauf)).as(ablauf).isEqualTo(ablaufBild("voltpilot", ablauf));
        }
        long anzahl = adminGetIn(alt, "/authentication/flows").findValuesAsText("alias").stream()
                .filter(a -> a.startsWith("voltpilot-")).count();
        assertThat(anzahl).as("zweiter Lauf legt nichts doppelt an").isEqualTo(2);

        // Die Konten von heute: das Kundenkonto meldet sich mit dem alten kurzen Passwort weiter an, das
        // Betriebskonto bekommt ohne zweiten Faktor kein Token mehr.
        String token = basis() + "/realms/" + alt + "/protocol/openid-connect/token";
        assertThat(post(token, Map.of("grant_type", "password", "client_id", "admin-cli",
                "username", "kunde-alt", "password", "kurz-alt")).statusCode()).isEqualTo(200);
        assertThat(post(token, Map.of("grant_type", "password", "client_id", "admin-cli",
                "username", "betrieb-alt", "password", "kurz-alt")).statusCode()).isBetween(400, 401);
    }

    @Test
    void derRueckwegDesBlattsBindetDieEingebautenAblaeufeUndLeertDieVorgabe() throws Exception {
        // Die zwei Befehle stehen so im Blatt (Abschnitt „Zurück“). Der Test fährt sie wörtlich am importierten,
        // gehärteten Realm voltpilot - genau der Stand, in dem der Betreiber sie braucht.
        List<String> rueckweg = rueckwegBefehleDesBlatts();
        String name = "betrieb-" + kurz();
        String passwort = "Betrieb-Passwort-" + kurz();
        assertThat(kontoAnlegen(name, passwort, true)).isEqualTo(201);
        assertThat(passwortGrant(name, passwort).statusCode()).isBetween(400, 401);
        String vorgabe = adminGet("").path("passwordPolicy").asText();
        try {
            // Teil 1: die eingebauten Abläufe. Die Anmeldung geht wieder wie vor der Härtung.
            org.testcontainers.containers.Container.ExecResult ablaeufe = angemeldet(rueckweg.get(0));
            assertThat(ablaeufe.getExitCode()).as(ablaeufe.getStdout() + ablaeufe.getStderr()).isZero();
            JsonNode realm = adminGet("");
            assertThat(realm.path("browserFlow").asText()).isEqualTo("browser");
            assertThat(realm.path("directGrantFlow").asText()).isEqualTo("direct grant");
            assertThat(realm.path("passwordPolicy").asText()).as("Teil 1 lässt die Vorgabe stehen").isEqualTo(vorgabe);
            assertThat(realm.path("eventsEnabled").asBoolean()).as("die Ereignisse bleiben an").isTrue();
            assertThat(passwortGrant(name, passwort).statusCode()).isEqualTo(200);
            HttpResponse<String> imBrowser = browserAnmeldung(name, passwort);
            assertThat(imBrowser.statusCode()).as(imBrowser.body()).isEqualTo(302);
            assertThat(imBrowser.headers().firstValue("Location").orElse("")).startsWith(ORIGIN + "/").contains("code=");

            // Teil 2: die Passwort-Vorgabe. `-s passwordPolicy=` (ohne Wert) ließ sie stehen; es wirkt nur die
            // Form des Blatts, bei der zwei Anführungszeichen bei kcadm ankommen.
            org.testcontainers.containers.Container.ExecResult vorgabeWeg = angemeldet(rueckweg.get(1));
            assertThat(vorgabeWeg.getExitCode()).as(vorgabeWeg.getStdout() + vorgabeWeg.getStderr()).isZero();
            assertThat(adminGet("").path("passwordPolicy").asText("")).as("Vorgabe geleert").isEmpty();
            assertThat(kontoAnlegen("kurz-" + kurz(), "Elf-Zeichen", false)).isEqualTo(201);

            // pruefen nennt genau das Zurückgenommene; die Abläufe selbst sind noch vollständig.
            org.testcontainers.containers.Container.ExecResult pruefen = skript("voltpilot", "pruefen");
            assertThat(pruefen.getExitCode()).as(pruefen.getStdout() + pruefen.getStderr()).isEqualTo(1);
            assertThat(pruefen.getStdout())
                    .contains("ABWEICHUNG passwordPolicy: ist '', soll 'length(12) and notUsername and passwordHistory(3)'")
                    .contains("ABWEICHUNG browserFlow: ist 'browser', soll 'voltpilot-browser'")
                    .contains("ABWEICHUNG directGrantFlow: ist 'direct grant', soll 'voltpilot-direct-grant'")
                    .doesNotContain("ABWEICHUNG voltpilot-");

            // Vorwärts geht es mit angleichen: nichts neu bauen, Vorgabe setzen, wieder binden.
            org.testcontainers.containers.Container.ExecResult wieder = skript("voltpilot", "angleichen");
            assertThat(wieder.getExitCode()).as(wieder.getStdout() + wieder.getStderr()).isZero();
            assertThat(wieder.getStdout()).contains("Ablauf voltpilot-browser ist schon vollstaendig vorhanden.");
            assertThat(passwortGrant(name, passwort).statusCode()).isBetween(400, 401);
        } finally {
            // Der importierte Realm gehört allen Tests dieser Klasse: in jedem Fall zurück auf den Import.
            assertThat(adminPutIn("voltpilot", "", JSON.writeValueAsString(Map.of("browserFlow", "voltpilot-browser",
                    "directGrantFlow", "voltpilot-direct-grant", "passwordPolicy", vorgabe)))).isEqualTo(204);
        }
        JsonNode danach = adminGet("");
        assertThat(danach.path("browserFlow").asText()).isEqualTo("voltpilot-browser");
        assertThat(danach.path("directGrantFlow").asText()).isEqualTo("voltpilot-direct-grant");
        assertThat(danach.path("passwordPolicy").asText()).isEqualTo(vorgabe);
    }

    @Test
    void nachEinemAbgebrochenenLaufBindetAngleichenNichtsUnvollstaendiges() throws Exception {
        String alt = "abbruch-" + kurz();
        assertThat(adminPostIn("", "", JSON.writeValueAsString(Map.of("realm", alt, "enabled", true))))
                .isEqualTo(201);
        assertThat(adminPostIn(alt, "/roles", "{\"name\":\"platform-admin\"}")).isEqualTo(201);
        assertThat(kontoAnlegenIn(alt, "betrieb-alt", "kurz-alt", true)).isEqualTo(201);
        assertThat(kontoAnlegenIn(alt, "kunde-alt", "kurz-alt", false)).isEqualTo(201);

        // 1. Der erste Lauf reißt nach zehn Anlagen ab: der Browser-Ablauf ist halb gebaut (mit Unterabläufen
        //    und einer Rollen-Bedingung), der Ablauf für den Passwort-Grant ist angelegt, aber leer.
        org.testcontainers.containers.Container.ExecResult abbruch = skriptMitAbbruch(alt, "angleichen", 10);
        assertThat(abbruch.getExitCode()).as(abbruch.getStdout() + abbruch.getStderr()).isNotZero();
        assertThat(abbruch.getStderr()).contains("Probe: Abbruch beim 11. create");
        assertThat(adminGetIn(alt, "").path("browserFlow").asText()).as("noch nichts umgeschaltet").isEqualTo("browser");
        assertThat(adminGetIn(alt, "").path("directGrantFlow").asText()).isEqualTo("direct grant");

        // 2. pruefen nennt beim Namen, was fehlt - auch den leeren Ablauf, an dem es früher still endete.
        org.testcontainers.containers.Container.ExecResult halb = skript(alt, "pruefen");
        assertThat(halb.getExitCode()).as(halb.getStdout() + halb.getStderr()).isEqualTo(1);
        assertThat(halb.getStdout())
                .contains("ABWEICHUNG voltpilot-browser-otp-betrieb: auth-otp-form REQUIRED fehlt")
                .contains("ABWEICHUNG voltpilot-browser-otp-gewaehlt: conditional-user-role REQUIRED fehlt")
                .contains("ABWEICHUNG voltpilot-direct-grant: Ablauf ist leer (kein einziger Schritt)");

        // 3. Der zweite Lauf bindet nichts Unvollständiges: Er entfernt die halben Abläufe, baut sie neu, prüft
        //    sie und bindet erst dann. Das Ergebnis ist derselbe Stand wie nach einem ungestörten Lauf.
        org.testcontainers.containers.Container.ExecResult zweiter = skript(alt, "angleichen");
        assertThat(zweiter.getExitCode()).as(zweiter.getStdout() + zweiter.getStderr()).isZero();
        assertThat(zweiter.getStdout())
                .contains("Ablauf voltpilot-browser entfernt, wird neu gebaut.")
                .contains("Ablauf voltpilot-direct-grant entfernt, wird neu gebaut.");
        org.testcontainers.containers.Container.ExecResult danach = skript(alt, "pruefen");
        assertThat(danach.getExitCode()).as(danach.getStdout() + danach.getStderr()).isZero();
        for (String ablauf : new String[] {"voltpilot-browser", "voltpilot-direct-grant"}) {
            assertThat(ablaufBild(alt, ablauf)).as(ablauf).isEqualTo(ablaufBild("voltpilot", ablauf));
        }
        JsonNode export = teilExport(alt);
        assertThat(mitVorsilbe(export.path("authenticationFlows"), "voltpilot-"))
                .as("keine Reste des abgebrochenen Laufs: zwei Abläufe und fünf Unterabläufe").hasSize(7);
        assertThat(mitVorsilbe(export.path("authenticatorConfig"), "voltpilot-rolle-"))
                .as("keine verwaiste Rollen-Bedingung").hasSize(4);
        String token = basis() + "/realms/" + alt + "/protocol/openid-connect/token";
        assertThat(post(token, Map.of("grant_type", "password", "client_id", "admin-cli",
                "username", "kunde-alt", "password", "kurz-alt")).statusCode()).isEqualTo(200);
        assertThat(post(token, Map.of("grant_type", "password", "client_id", "admin-cli",
                "username", "betrieb-alt", "password", "kurz-alt")).statusCode()).isBetween(400, 401);

        // 4. Weicht ein GEBUNDENER Ablauf ab (hier: eine Rollen-Bedingung fehlt; so sah auch der Stand aus, den
        //    das frühere Skript nach einem Abbruch gebunden hat), nennt pruefen die Stelle, und angleichen
        //    ändert nichts und sagt, wie es weitergeht.
        String bedingung = bedingungId(alt, "voltpilot-direct-grant", "voltpilot-direct-grant-otp-gewaehlt");
        assertThat(adminDeleteIn(alt, "/authentication/config/" + bedingung)).isEqualTo(204);
        org.testcontainers.containers.Container.ExecResult ohne = skript(alt, "pruefen");
        assertThat(ohne.getExitCode()).as(ohne.getStdout() + ohne.getStderr()).isEqualTo(1);
        assertThat(ohne.getStdout()).contains("ABWEICHUNG voltpilot-direct-grant-otp-gewaehlt: conditional-user-role "
                + "REQUIRED - Bedingung ist 'keine', soll 'platform-admin/negate=true'");
        org.testcontainers.containers.Container.ExecResult verweigert = skript(alt, "angleichen");
        assertThat(verweigert.getExitCode()).as(verweigert.getStdout() + verweigert.getStderr()).isEqualTo(3);
        assertThat(verweigert.getStdout())
                .contains("VERWEIGERT: Der Ablauf voltpilot-direct-grant weicht vom Import ab, ist aber als "
                        + "directGrantFlow gebunden. Nichts wurde geaendert.")
                .contains("kcadm.sh update realms/" + alt + " -s browserFlow=browser -s 'directGrantFlow=direct grant'");
        assertThat(adminGetIn(alt, "").path("directGrantFlow").asText()).isEqualTo("voltpilot-direct-grant");
        assertThat(mitVorsilbe(teilExport(alt).path("authenticationFlows"), "voltpilot-")).hasSize(7);

        // 5. Der Rückweg des Blatts (Teil 1) löst die Bindung; danach darf angleichen wieder bauen.
        org.testcontainers.containers.Container.ExecResult zurueck =
                angemeldet(rueckwegBefehleDesBlatts().get(0).replace("realms/voltpilot", "realms/" + alt));
        assertThat(zurueck.getExitCode()).as(zurueck.getStdout() + zurueck.getStderr()).isZero();
        assertThat(adminGetIn(alt, "").path("browserFlow").asText()).isEqualTo("browser");
        assertThat(adminGetIn(alt, "").path("directGrantFlow").asText()).isEqualTo("direct grant");
    }

    @Test
    void pruefenSchlaegtAnWennEineRollenBedingungFalschHaengt() throws Exception {
        // Der importierte Realm ist der Maßstab: an ihm endet pruefen mit Exit 0.
        org.testcontainers.containers.Container.ExecResult gut = skript("voltpilot", "pruefen");
        assertThat(gut.getExitCode()).as(gut.getStdout() + gut.getStderr()).isZero();

        // Der Import teilt zwei Konfigurationen: „platform-admin“ (Betrieb) und „nicht platform-admin“ (alle
        // anderen), je für den Browser-Ablauf und den Passwort-Grant. Verstellt wird je eine Eigenschaft.
        String betrieb = bedingungId("voltpilot", "voltpilot-browser", "voltpilot-browser-otp-betrieb");
        String gewaehlt = bedingungId("voltpilot", "voltpilot-direct-grant", "voltpilot-direct-grant-otp-gewaehlt");
        assertThat(betrieb).isNotEqualTo(gewaehlt);
        JsonNode betriebVorher = adminGet("/authentication/config/" + betrieb);
        JsonNode gewaehltVorher = adminGet("/authentication/config/" + gewaehlt);
        try {
            // „verneint“ am Betriebs-Zweig: Der zweite Faktor träfe alle AUSSER platform-admin.
            com.fasterxml.jackson.databind.node.ObjectNode verneint = betriebVorher.deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) verneint.path("config")).put("negate", "true");
            assertThat(adminPutIn("voltpilot", "/authentication/config/" + betrieb, verneint.toString())).isEqualTo(204);
            // Falsche Rolle am anderen Zweig.
            com.fasterxml.jackson.databind.node.ObjectNode andereRolle = gewaehltVorher.deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) andereRolle.path("config")).put("condUserRole", "operator");
            assertThat(adminPutIn("voltpilot", "/authentication/config/" + gewaehlt, andereRolle.toString())).isEqualTo(204);

            org.testcontainers.containers.Container.ExecResult verstellt = skript("voltpilot", "pruefen");
            assertThat(verstellt.getExitCode()).as(verstellt.getStdout() + verstellt.getStderr()).isEqualTo(1);
            assertThat(verstellt.getStdout())
                    .contains("ABWEICHUNG voltpilot-browser-otp-betrieb: conditional-user-role REQUIRED - Bedingung ist "
                            + "'platform-admin/negate=true', soll 'platform-admin/negate=false'")
                    .contains("ABWEICHUNG voltpilot-direct-grant-betrieb: conditional-user-role REQUIRED - Bedingung ist "
                            + "'platform-admin/negate=true', soll 'platform-admin/negate=false'")
                    .contains("ABWEICHUNG voltpilot-browser-otp-gewaehlt: conditional-user-role REQUIRED - Bedingung ist "
                            + "'operator/negate=true', soll 'platform-admin/negate=true'")
                    .contains("ABWEICHUNG voltpilot-direct-grant-otp-gewaehlt: conditional-user-role REQUIRED - Bedingung ist "
                            + "'operator/negate=true', soll 'platform-admin/negate=true'")
                    .doesNotContain("traegt die Anmelde-Haertung");
        } finally {
            assertThat(adminPutIn("voltpilot", "/authentication/config/" + betrieb, betriebVorher.toString())).isEqualTo(204);
            assertThat(adminPutIn("voltpilot", "/authentication/config/" + gewaehlt, gewaehltVorher.toString())).isEqualTo(204);
        }
        assertThat(adminGet("/authentication/config/" + betrieb).path("config")).isEqualTo(betriebVorher.path("config"));
        assertThat(adminGet("/authentication/config/" + gewaehlt).path("config")).isEqualTo(gewaehltVorher.path("config"));
    }

    // --- Hilfen -------------------------------------------------------------------------------------------

    private static String basis() {
        return "http://" + KEYCLOAK.getHost() + ":" + KEYCLOAK.getMappedPort(8080);
    }

    private static String tokenUrl() {
        return basis() + "/realms/voltpilot/protocol/openid-connect/token";
    }

    private static String kurz() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    private HttpResponse<String> passwortGrant(String name, String passwort) throws Exception {
        return post(tokenUrl(), Map.of("grant_type", "password", "client_id", "voltpilot-frontend",
                "username", name, "password", passwort));
    }

    /**
     * Authorization Code + PKCE wie das Portal: Anmeldeseite holen, Formular abschicken, Weiterleitungen
     * INNERHALB von Keycloak folgen (etwa zu einer Pflicht-Aktion), und die erste Antwort zurückgeben, die
     * Keycloak verlässt oder eine Seite zeigt. Die Sitzungs-Cookies reicht die Hilfe selbst weiter — Keycloak
     * setzt sie mit {@code Secure}, und ein Cookie-Speicher schickte sie über das HTTP des Containers nicht
     * zurück ({@code cookie_not_found}).
     */
    private HttpResponse<String> browserAnmeldung(String name, String passwort) throws Exception {
        Map<String, String> cookies = new LinkedHashMap<>();
        HttpResponse<String> seite = mitCookies(HttpRequest.newBuilder(URI.create(anmeldeUrl())).GET(), cookies);
        assertThat(seite.statusCode()).as(seite.body()).isEqualTo(200);
        Matcher m = Pattern.compile("id=\"kc-form-login\"[^>]*action=\"([^\"]+)\"").matcher(seite.body());
        assertThat(m.find()).as("Anmeldeformular").isTrue();
        HttpResponse<String> antwort = mitCookies(HttpRequest.newBuilder(URI.create(m.group(1).replace("&amp;", "&")))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(formular(Map.of(
                        "username", name, "password", passwort, "credentialId", "")))), cookies);
        for (int i = 0; i < 5 && antwort.statusCode() == 302; i++) {
            String ziel = antwort.headers().firstValue("Location").orElse("");
            if (!ziel.startsWith(basis())) {
                break;
            }
            antwort = mitCookies(HttpRequest.newBuilder(URI.create(ziel)).GET(), cookies);
        }
        return antwort;
    }

    /** Die Anmeldeseite des Portals: Authorization Code + PKCE ({@code S256}), wie keycloak-js sie aufruft. */
    private static String anmeldeUrl() throws Exception {
        String verifier = UUID.randomUUID() + "-" + UUID.randomUUID();
        String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        return basis() + "/realms/voltpilot/protocol/openid-connect/auth?" + formular(Map.of(
                "client_id", "voltpilot-frontend", "redirect_uri", ORIGIN + "/", "response_type", "code",
                "scope", "openid", "code_challenge", challenge, "code_challenge_method", "S256"));
    }

    private HttpResponse<String> mitCookies(HttpRequest.Builder anfrage, Map<String, String> cookies)
            throws Exception {
        if (!cookies.isEmpty()) {
            anfrage.header("Cookie", cookies.entrySet().stream()
                    .map(e -> e.getKey() + "=" + e.getValue()).collect(Collectors.joining("; ")));
        }
        HttpResponse<String> r = http.send(anfrage.build(), HttpResponse.BodyHandlers.ofString());
        r.headers().allValues("Set-Cookie").forEach(c -> {
            String[] paar = c.split(";", 2)[0].split("=", 2);
            cookies.put(paar[0].trim(), paar.length > 1 ? paar[1] : "");
        });
        return r;
    }

    private int kontoAnlegen(String name, String passwort, boolean plattformAdmin) throws Exception {
        return kontoAnlegenIn("voltpilot", name, passwort, plattformAdmin);
    }

    private int kontoAnlegenIn(String realm, String name, String passwort, boolean plattformAdmin)
            throws Exception {
        Map<String, Object> konto = new LinkedHashMap<>();
        konto.put("username", name);
        konto.put("email", name + "@beispiel.invalid");
        konto.put("firstName", "Test");
        konto.put("lastName", "Konto");
        konto.put("enabled", true);
        konto.put("emailVerified", true);
        konto.put("credentials", new Object[] {Map.of("type", "password", "value", passwort, "temporary", false)});
        if (!plattformAdmin && "voltpilot".equals(realm)) {
            konto.put("attributes", Map.of("tenant_id", new String[] {UUID.randomUUID().toString()}));
        }
        int status = adminPostIn(realm, "/users", JSON.writeValueAsString(konto));
        if (status == 201 && plattformAdmin) {
            JsonNode rolle = adminGetIn(realm, "/roles/platform-admin");
            String id = adminGetIn(realm, "/users?exact=true&username=" + name).get(0).path("id").asText();
            assertThat(adminPostIn(realm, "/users/" + id + "/role-mappings/realm", "[" + rolle + "]"))
                    .isEqualTo(204);
        }
        return status;
    }

    private String kontoId(String name) throws Exception {
        return adminGet("/users?exact=true&username=" + URLEncoder.encode(name, StandardCharsets.UTF_8))
                .get(0).path("id").asText();
    }

    private int passwortSetzen(String id, String passwort) throws Exception {
        return adminPut("/users/" + id + "/reset-password",
                JSON.writeValueAsString(Map.of("type", "password", "value", passwort, "temporary", false)));
    }

    private String adminToken() throws Exception {
        HttpResponse<String> r = post(basis() + "/realms/master/protocol/openid-connect/token", Map.of(
                "grant_type", "password", "client_id", "admin-cli",
                "username", KC_ADMIN, "password", KC_ADMIN_PASSWORT));
        assertThat(r.statusCode()).as(r.body()).isEqualTo(200);
        return JSON.readTree(r.body()).path("access_token").asText();
    }

    private java.util.List<String> ablaufAliase() throws Exception {
        return adminGet("/authentication/flows").findValuesAsText("alias");
    }

    /** Ein Ablauf als Liste "Ebene|Index|Anforderung|Anbieter|Name|Bedingung", ohne Ids und Prioritäten. */
    private java.util.List<String> ablaufBild(String realm, String ablauf) throws Exception {
        java.util.List<String> bild = new java.util.ArrayList<>();
        for (JsonNode e : adminGetIn(realm, "/authentication/flows/" + ablauf + "/executions")) {
            String bedingung = "";
            if (e.hasNonNull("authenticationConfig")) {
                JsonNode c = adminGetIn(realm, "/authentication/config/" + e.path("authenticationConfig").asText());
                bedingung = c.path("alias").asText() + ":" + c.path("config");
            }
            bild.add(e.path("level").asText() + "|" + e.path("index").asText() + "|"
                    + e.path("requirement").asText() + "|" + e.path("providerId").asText() + "|"
                    + e.path("displayName").asText() + "|" + bedingung);
        }
        return bild;
    }

    private org.testcontainers.containers.Container.ExecResult skript(String realm, String modus)
            throws Exception {
        return angemeldet("REALM=" + realm + " /opt/keycloak/live-realm-anmeldung.sh " + modus);
    }

    /** Wie {@link #skript}, aber kcadm endet nach {@code anlagen} Aufrufen von {@code create} mit einem Fehler. */
    private org.testcontainers.containers.Container.ExecResult skriptMitAbbruch(String realm, String modus,
            int anlagen) throws Exception {
        return angemeldet("REALM=" + realm + " KCADM=/opt/keycloak/kcadm-mit-abbruch.sh ABBRUCH_NACH=" + anlagen
                + " ZAEHLER=/tmp/abbruch-" + kurz() + ".zahl /opt/keycloak/live-realm-anmeldung.sh " + modus);
    }

    /** Meldet kcadm im Container an (wie Schritt „Anmelden“ des Blatts) und fährt danach den Befehl. */
    private org.testcontainers.containers.Container.ExecResult angemeldet(String befehl) throws Exception {
        return KEYCLOAK.execInContainer("bash", "-c", "export HOME=/tmp && /opt/keycloak/bin/kcadm.sh config "
                + "credentials --server http://localhost:8080 --realm master --user " + KC_ADMIN + " --password "
                + KC_ADMIN_PASSWORT + " && " + befehl);
    }

    /**
     * Die zwei Befehle des Rückwegs, so wie sie im Blatt stehen: erst die Abläufe, dann die Passwort-Vorgabe.
     * Im Blatt umschließt sie {@code kubectl -n <namespace> exec deploy/keycloak -- bash -c "…"}; zurück kommt
     * der Teil, den diese Bash im Pod ausführt (ein {@code \"} des Blatts ist dort ein {@code "}).
     */
    private static List<String> rueckwegBefehleDesBlatts() throws Exception {
        Pattern form = Pattern.compile(
                "^\\s*kubectl -n <namespace> exec deploy/keycloak -- bash -c \"(.*kcadm\\.sh update realms/voltpilot .*)\"\\s*$");
        List<String> befehle = new ArrayList<>();
        for (String zeile : Files.readAllLines(BLATT, StandardCharsets.UTF_8)) {
            Matcher m = form.matcher(zeile);
            if (m.matches()) {
                befehle.add(m.group(1).replace("\\\"", "\""));
            }
        }
        assertThat(befehle).as("Rückweg im Blatt: zwei Befehle, erst die Abläufe, dann die Vorgabe").hasSize(2);
        assertThat(befehle.get(0)).contains("-s browserFlow=browser").contains("-s 'directGrantFlow=direct grant'");
        assertThat(befehle.get(1)).contains("passwordPolicy");
        return befehle;
    }

    /** Die Konfiguration der Rollen-Bedingung ({@code conditional-user-role}) in einem Unterablauf. */
    private String bedingungId(String realm, String ablauf, String unterablauf) throws Exception {
        boolean drin = false;
        for (JsonNode e : adminGetIn(realm, "/authentication/flows/" + ablauf + "/executions")) {
            if (e.path("authenticationFlow").asBoolean(false)) {
                drin = unterablauf.equals(e.path("displayName").asText());
            } else if (drin && "conditional-user-role".equals(e.path("providerId").asText())) {
                return e.path("authenticationConfig").asText();
            }
        }
        throw new AssertionError("keine Rollen-Bedingung in " + unterablauf);
    }

    /** Teil-Export des Realms: nennt ALLE Abläufe (auch Unterabläufe) und alle Authenticator-Konfigurationen. */
    private JsonNode teilExport(String realm) throws Exception {
        HttpResponse<String> r = http.send(adminAnfrage(realm,
                        "/partial-export?exportClients=false&exportGroupsAndRoles=false")
                        .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(r.statusCode()).as(r.body()).isEqualTo(200);
        return JSON.readTree(r.body());
    }

    private static List<String> mitVorsilbe(JsonNode liste, String vorsilbe) {
        List<String> namen = new ArrayList<>();
        for (JsonNode e : liste) {
            if (e.path("alias").asText().startsWith(vorsilbe)) {
                namen.add(e.path("alias").asText());
            }
        }
        return namen;
    }

    private JsonNode adminGet(String pfad) throws Exception {
        return adminGetIn("voltpilot", pfad);
    }

    private JsonNode adminGetIn(String realm, String pfad) throws Exception {
        HttpResponse<String> r = http.send(adminAnfrage(realm, pfad).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(r.statusCode()).as(pfad + " " + r.body()).isEqualTo(200);
        return JSON.readTree(r.body());
    }

    private int adminPostIn(String realm, String pfad, String body) throws Exception {
        return http.send(adminAnfrage(realm, pfad).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    private int adminPut(String pfad, String body) throws Exception {
        return adminPutIn("voltpilot", pfad, body);
    }

    private int adminPutIn(String realm, String pfad, String body) throws Exception {
        return http.send(adminAnfrage(realm, pfad).header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    private int adminDeleteIn(String realm, String pfad) throws Exception {
        return http.send(adminAnfrage(realm, pfad).DELETE().build(),
                HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    /** Admin-REST: {@code realm} leer = die Realm-Liste selbst ({@code POST /admin/realms}). */
    private HttpRequest.Builder adminAnfrage(String realm, String pfad) throws Exception {
        String wurzel = basis() + "/admin/realms" + (realm.isEmpty() ? "" : "/" + realm);
        return HttpRequest.newBuilder(URI.create(wurzel + pfad))
                .header("Authorization", "Bearer " + adminToken());
    }

    private HttpResponse<String> post(String url, Map<String, String> felder) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(url))
                        .header("Content-Type", "application/x-www-form-urlencoded")
                        .POST(HttpRequest.BodyPublishers.ofString(formular(felder))).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private static String formular(Map<String, String> felder) {
        return felder.entrySet().stream()
                .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "="
                        + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
    }
}
