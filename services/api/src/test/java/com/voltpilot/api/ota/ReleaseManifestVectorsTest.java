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
