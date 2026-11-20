package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Der Java-Leser des Release-Manifests gegen die GETEILTEN Vektoren
 * ({@code docs/contracts/ota-release-manifest-vectors.json}) - derselbe Fall,
 * dasselbe Urteil wie im Go-Core ({@code otaverify.TestManifestVectors}).
 * Rein, ohne Docker, läuft in jedem Lauf mit.
 */
class ReleaseManifestVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");

    /** Das Urteil des Java-Lesers in den Worten der Vektoren. */
    private static String verdict(String manifest, String backend) {
        ReleaseManifest m;
        try {
            m = ReleaseManifest.read(manifest);
        } catch (ReleaseManifest.InvalidManifestException e) {
            assertThat(e.getMessage()).as("ein Formfehler sagt, warum").isNotBlank();
            return "rejected";
        }
        return m.notApplicableReason(backend).isPresent() ? "deferred" : "ok";
    }

    @Test
    @DisplayName("jeder Vektor: dasselbe Urteil wie das Gerät nach gültiger Signatur")
    void everyVectorHasTheDevicesVerdict() throws Exception {
        JsonNode doc = MAPPER.readTree(Files.readString(CONTRACTS.resolve("ota-release-manifest-vectors.json")));
        List<String> mismatches = new ArrayList<>();
        int checked = 0;
        int signatureOnly = 0;
        for (JsonNode c : doc.get("faelle")) {
            String name = c.get("name").asText();
            if (c.has("signatur") && !"gueltig".equals(c.get("signatur").asText())) {
                // Die API verifiziert bewusst keine Signatur - dieser Fall
                // gehört allein dem Gerät.
                signatureOnly++;
                continue;
            }
            String want = c.get("erwartet").asText();
            String got = verdict(c.get("manifest").toString(), c.get("backend").asText());
            if (!want.equals(got)) {
                mismatches.add(name + ": erwartet " + want + ", Java sagt " + got);
            }
            if ("deferred".equals(want)) {
                // Die einzige Zurückstellung, die das Manifest allein begründet,
                // ist die Box-Art; Boden und Rückschritt kennt nur das Gerät.
                assertThat(c.get("sperre").asText()).as(name).isEqualTo("backend");
            }
            checked++;
        }
        assertThat(mismatches).isEmpty();
        assertThat(checked).isGreaterThanOrEqualTo(15);
        assertThat(signatureOnly).as("die Signaturfälle sind benannt, nicht verschluckt").isPositive();
    }

    @Test
    @DisplayName("jeder Vektor: erzeugbar genau dann, wenn auch Go ihn streng liest (ParseManifestStrict)")
    void everyVectorHasTheToolsVerdict() throws Exception {
        JsonNode doc = MAPPER.readTree(Files.readString(CONTRACTS.resolve("ota-release-manifest-vectors.json")));
        List<String> mismatches = new ArrayList<>();
        int erzeugbar = 0;
        for (JsonNode c : doc.get("faelle")) {
            boolean want = c.get("erzeugbar").asBoolean();
            boolean got;
            try {
                ReleaseManifest.readStrict(c.get("manifest").toString());
                got = true;
            } catch (ReleaseManifest.InvalidManifestException e) {
                assertThat(e.getMessage()).as("ein Formfehler sagt, warum").isNotBlank();
                got = false;
            }
            if (want != got) {
                mismatches.add(c.get("name").asText() + ": erzeugbar " + want + ", Java sagt " + got);
            }
            if (got) {
                erzeugbar++;
            }
        }
        assertThat(mismatches).isEmpty();
        assertThat(erzeugbar).as("beide Box-Arten sind erzeugbar").isGreaterThanOrEqualTo(2);
    }

    @Test
    @DisplayName("ein Edge-Light-Release nennt seine Box-Art und seine Programme je Architektur")
    void anEdgeLightReleaseNamesItsBoxType() throws Exception {
        ReleaseManifest m = ReleaseManifest.read(
                Files.readString(CONTRACTS.resolve("examples/ota-release-manifest.valid.light.json")));
        assertThat(m.release()).isEqualTo("edge-light-2026.10.1");
        assertThat(m.releaseSeq()).isEqualTo(140L);
        assertThat(m.backends()).containsExactly(ReleaseManifest.BACKEND_LIGHT);
        assertThat(m.artifacts()).extracting(ReleaseManifest.Artifact::arch)
                .containsExactly("linux/mipsle", "linux/arm64", "linux/amd64");
        assertThat(m.notApplicableReason(ReleaseManifest.BACKEND_LIGHT)).isEmpty();

        Optional<String> onDocker = m.notApplicableReason(ReleaseManifest.BACKEND_COMPOSE);
        assertThat(onDocker).isPresent();
        assertThat(onDocker.get()).contains("Box-Art").contains("light");
        // Der Skriptstand für die Werkstatt reist signiert mit (vp-werkstatt-immer-neueste).
        assertThat(m.skripte()).contains(new ReleaseManifest.Skripte(ReleaseManifest.SKRIPTE_DATEI,
                "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a", 31744));
    }

    private static String vektor(String name) throws Exception {
        for (JsonNode c : MAPPER.readTree(CONTRACTS.resolve("ota-release-manifest-vectors.json").toFile()).get("faelle")) {
            if (name.equals(c.get("name").asText())) {
                return MAPPER.writeValueAsString(c.get("manifest"));
            }
        }
        throw new IllegalStateException("kein Vektor " + name);
    }

    @Test
    @DisplayName("ein Edge-Industrie-Release nennt seinen Skriptstand und das Tunnel-Programm für die Werkstatt")
    void anEdgeIndustrieReleaseCarriesTheWerkstattFiles() throws Exception {
        String raw = vektor("industrie-release-mit-skriptstand-und-tunnel-programm-auf-industrie-box");
        ReleaseManifest m = ReleaseManifest.readStrict(raw);
        assertThat(m.backends()).containsExactly(ReleaseManifest.BACKEND_INDUSTRIE);
        assertThat(m.skripte()).contains(new ReleaseManifest.Skripte(ReleaseManifest.INDUSTRIE_SKRIPTE_DATEI,
                "5".repeat(64), 20480));
        assertThat(m.wartung()).contains(new ReleaseManifest.Wartung(ReleaseManifest.WARTUNG_DATEI,
                "6".repeat(64), 7340032));
        // Kein Bestandteil des Updates: das Programm der Box bleibt der einzige.
        assertThat(m.programs()).hasSize(1);

        // Der Skriptstand der Mango gilt für Edge Industrie nicht, und umgekehrt; tolerant gelesen fehlt er nur.
        String mango = vektor("industrie-release-mit-skriptstand-auf-industrie-box");
        assertThat(ReleaseManifest.read(mango).skripte()).isEmpty();
        assertThatThrownBy(() -> ReleaseManifest.readStrict(mango))
                .isInstanceOf(ReleaseManifest.InvalidManifestException.class).hasMessageContaining("skripte");
        String light = vektor("light-release-mit-tunnel-programm-auf-light-box");
        assertThat(ReleaseManifest.read(light).wartung()).isEmpty();
        assertThatThrownBy(() -> ReleaseManifest.readStrict(light))
                .isInstanceOf(ReleaseManifest.InvalidManifestException.class).hasMessageContaining("wartung");
        String kaputt = vektor("industrie-tunnel-programm-ohne-pruefsumme-auf-industrie-box");
        assertThat(ReleaseManifest.read(kaputt).wartung()).isEmpty();
    }

    @Test
    @DisplayName("ein unvollständiger Skriptstand fehlt nur (tolerant wie die Box), erzeugt wird er nie")
    void anIncompleteSkriptstandIsOnlyMissing() throws Exception {
        String raw = Files.readString(CONTRACTS.resolve("examples/ota-release-manifest.valid.light.json"))
                .replace("5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a", "kaputt");
        assertThat(ReleaseManifest.read(raw).skripte()).isEmpty();
        assertThatThrownBy(() -> ReleaseManifest.readStrict(raw))
                .isInstanceOf(ReleaseManifest.InvalidManifestException.class)
                .hasMessageContaining("skripte");
    }

    @Test
    @DisplayName("das Docker-Release liest sich unverändert als compose")
    void theDockerReleaseIsCompose() throws Exception {
        ReleaseManifest m = ReleaseManifest.read(
                Files.readString(CONTRACTS.resolve("examples/ota-release-manifest.valid.compose.json")));
        assertThat(m.backends()).containsExactly(ReleaseManifest.BACKEND_COMPOSE);
        assertThat(m.artifacts()).extracting(ReleaseManifest.Artifact::type)
                .containsOnly(ReleaseManifest.TYPE_OCI_IMAGE);
        assertThat(m.notApplicableReason(ReleaseManifest.BACKEND_COMPOSE)).isEmpty();
        assertThat(m.notApplicableReason(ReleaseManifest.BACKEND_LIGHT)).isPresent();
    }

    @Test
    @DisplayName("ein bekannter Typ mit kaputten Feldern ist ein Formfehler mit Grund")
    void aBrokenKnownTypeIsAFormError() throws Exception {
        String raw = Files.readString(
                CONTRACTS.resolve("examples/ota-release-manifest.invalid.binary-ohne-pruefsumme.json"));
        assertThatThrownBy(() -> ReleaseManifest.read(raw))
                .isInstanceOf(ReleaseManifest.InvalidManifestException.class)
                .hasMessageContaining("sha256");
    }
}
