package com.voltpilot.api.ocpp;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

class OcppActionPolicyTest {
    private final OcppActionPolicy policy = new OcppActionPolicy();

    @Test
    void d4SeparatesCustomerSiteAdminAndPlatformActions() {
        var operator = auth("ROLE_operator");
        var siteAdmin = auth("ROLE_site-admin");
        var platform = auth("ROLE_platform-admin");

        assertThat(policy.allowed(operator, "RemoteStartTransaction")).isTrue();
        assertThat(policy.allowed(operator, "RemoteStopTransaction")).isTrue();
        assertThat(policy.allowed(operator, "UnlockConnector")).isTrue();
        assertThat(policy.allowed(operator, "ReserveNow")).isFalse();
        assertThat(policy.allowed(operator, "SetChargingProfile")).isFalse();
        assertThat(policy.allowed(operator, "GetCompositeSchedule")).isFalse();
        assertThat(policy.allowed(operator, "ChangeConfiguration")).isFalse();
        assertThat(policy.allowed(operator, "UpdateFirmware")).isFalse();

        assertThat(policy.allowed(siteAdmin, "RemoteStopTransaction")).isTrue();
        assertThat(policy.allowed(siteAdmin, "ReserveNow")).isTrue();
        assertThat(policy.allowed(siteAdmin, "SetChargingProfile")).isTrue();
        assertThat(policy.allowed(siteAdmin, "GetCompositeSchedule")).isTrue();
        assertThat(policy.allowed(siteAdmin, "SoftReset")).isTrue();
        assertThat(policy.allowed(siteAdmin, "HardReset")).isFalse();
        assertThat(policy.allowed(auth("ROLE_admin"), "ChangeConfiguration"))
                .as("legacy tenant admin remains the D4 site-admin alias").isTrue();

        assertThat(policy.allowed(platform, "RemoteStartTransaction")).isTrue();
        assertThat(policy.allowed(platform, "ChangeAvailability")).isTrue();
        assertThat(policy.allowed(platform, "GetDiagnostics")).isTrue();
        assertThat(policy.allowed(platform, "DataTransfer")).isTrue();
        assertThat(policy.allowed(platform, "InventedCommand")).isFalse();
    }

    private static TestingAuthenticationToken auth(String authority) {
        return new TestingAuthenticationToken("test", "n/a",
                List.of(new SimpleGrantedAuthority(authority)));
    }
}
