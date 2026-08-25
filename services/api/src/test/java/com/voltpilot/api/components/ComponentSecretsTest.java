package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ComponentSecretsTest {

    private static ComponentTemplateDto template() {
        return new ComponentTemplateDto("t", "builtin", 1, "b", "B", "m", "M",
                "inverter", null, "f", "F", "modbus", "Modbus",
                "[{\"key\":\"ip\",\"label\":\"IP\"},{\"key\":\"password\","
                        + "\"label\":\"Kennwort\",\"type\":\"password\",\"secret\":true}]",
                null, null, null, 0, "builtin", null, null, null, null);
    }

    @Test
    void masksSecretsAndKeepsThemOnlyWhenTheEditLeavesThemUntouched() {
        assertThat(ComponentSecrets.maskedJson("{\"ip\":\"10.0.0.2\",\"password\":\"secret\"}",
                ComponentSecrets.keys(template())))
                .contains(ComponentSecrets.MASK).doesNotContain("secret");

        Map<String, Object> merged = ComponentSecrets.merge(
                Map.of("ip", "10.0.0.3", "password", ComponentSecrets.MASK),
                "{\"ip\":\"10.0.0.2\",\"password\":\"secret\"}",
                ComponentSecrets.keys(template()));
        assertThat(merged).containsEntry("password", "secret").containsEntry("ip", "10.0.0.3");
    }

    @Test
    void replacesASecretOnlyForANewNonBlankValue() {
        Map<String, Object> merged = ComponentSecrets.merge(Map.of("password", "new"),
                "{\"password\":\"old\"}", ComponentSecrets.keys(template()));
        assertThat(merged).containsEntry("password", "new");
    }

    @Test
    void masksSecretLookingKeysEvenWhenTheOldTemplateIsUnavailable() {
        String masked = ComponentSecrets.maskedJson(
                "{\"ip\":\"10.0.0.2\",\"api_token\":\"never-return-me\"}", Set.of());
        assertThat(masked).contains("10.0.0.2", ComponentSecrets.MASK)
                .doesNotContain("never-return-me");
    }

    @Test
    void treatsProtocolMasksAsSecretsEvenForUnknownKeysAndMissingTemplates() {
        Map<String, Object> merged = ComponentSecrets.merge(
                Map.of("customCredential", ComponentSecrets.MASK),
                "{\"customCredential\":\"server-secret\"}", Set.of());
        assertThat(merged).containsEntry("customCredential", "server-secret");
        assertThat(ComponentSecrets.maskedJson("{\"customCredential\":\"••••••••\"}", Set.of()))
                .contains(ComponentSecrets.MASK);
    }

    @Test
    void failsClosedForARealCredentialWhenTemplateDisappears() {
        assertThat(ComponentSecrets.maskedJson("{\"customCredential\":\"server-secret\"}", Set.of(), true))
                .contains(ComponentSecrets.MASK)
                .doesNotContain("server-secret");
    }
}
