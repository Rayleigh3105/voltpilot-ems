package com.voltpilot.api.ocpp;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class OcppPrivacyTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final OcppPrivacy privacy = new OcppPrivacy("stable-test-pepper");

    @Test
    void removesSecretsAndMakesTagReferencesStable() throws Exception {
        JsonNode raw = mapper.readTree("""
                {"idTag":"clear-rfid","idTagInfo":{"parentIdTag":"clear-parent"},
                 "configurationKey":[
                   {"key":"AuthorizationKey","readonly":false,"value":"top-secret"},
                   {"key":"RigVendor.Mode","readonly":true,"value":"complete"}]}
                """);
        JsonNode first = privacy.redact(raw, "GetConfiguration");
        JsonNode second = privacy.redact(raw, "GetConfiguration");

        assertThat(first.toString()).doesNotContain("clear-rfid", "clear-parent", "top-secret");
        assertThat(first.path("idTag").asText()).startsWith("tagref_")
                .isEqualTo(second.path("idTag").asText());
        assertThat(first.path("configurationKey").get(0).path("value").isNull()).isTrue();
        assertThat(first.path("configurationKey").get(0).path("redacted").asBoolean()).isTrue();
        assertThat(first.toString()).contains("RigVendor.Mode", "complete");
        // Caller-owned input is never mutated by the boundary.
        assertThat(raw.toString()).contains("clear-rfid", "top-secret");
    }

    @Test
    void diagnosticLocationsAndUntypedDataTransferBodiesAreNotPersistable() throws Exception {
        JsonNode diagnostics = privacy.redact(mapper.readTree(
                "{\"location\":\"https://user:pass@example.invalid/upload?token=x\"}"),
                "GetDiagnostics");
        JsonNode transfer = privacy.redact(mapper.readTree(
                "{\"vendorId\":\"Acme\",\"data\":\"credential-shaped-vendor-data\"}"),
                "DataTransfer");
        JsonNode meter = privacy.redact(mapper.readTree(
                "{\"sampledValue\":[{\"value\":\"230\",\"location\":\"Outlet\"}]}"),
                "MeterValues");

        assertThat(diagnostics.path("location").asText()).isEqualTo("[redacted-url]");
        assertThat(transfer.path("data").asText()).isEqualTo("[redacted-untyped-vendor-data]");
        assertThat(transfer.path("vendorId").asText()).isEqualTo("Acme");
        assertThat(meter.path("sampledValue").get(0).path("location").asText()).isEqualTo("Outlet");
    }

    @Test
    void callErrorFreeTextIsNeverSelectivelyTrusted() {
        for (String canary : new String[] {
                "AuthorizationKey=cloud-secret",
                "https://station.invalid/upload?token=url-secret",
                "idTag=clear-rfid",
                "client_secret=generic-secret"
        }) {
            assertThat(privacy.redactErrorDescription("failure: " + canary))
                    .isEqualTo(OcppPrivacy.REDACTED_CALL_ERROR_DESCRIPTION)
                    .doesNotContain(canary);
        }
        assertThat(privacy.redactErrorDescription(null)).isNull();
        assertThat(privacy.redactErrorDescription("  ")).isNull();
    }
}
