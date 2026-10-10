package com.voltpilot.api.ocpp;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.web.SiteOcppActionController;
import com.voltpilot.api.web.SiteOcppControlController;
import com.voltpilot.api.web.SiteOcppController;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.prepost.PreAuthorize;
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
        assertThat(policy.allowed(siteAdmin, "SetChargingProfile")).isFalse();
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

    // ---- AP-03 IP-3 ---------------------------------------------------------------------

    private static final Set<String> KUNDE = Set.of("RemoteStartTransaction", "RemoteStopTransaction",
            "UnlockConnector");
    private static final Set<String> ANLAGE = union(KUNDE, Set.of("ReserveNow", "CancelReservation",
            "GetCompositeSchedule", "ChangeAvailability", "SoftReset", "GetConfiguration",
            "ChangeConfiguration", "ClearCache", "GetLocalListVersion", "SendLocalList", "TriggerMessage"));
    private static final Set<String> PLATTFORM = union(ANLAGE, Set.of("HardReset", "GetDiagnostics",
            "UpdateFirmware", "DataTransfer"));

    @Test
    void heutigeRollenBehaltenJedeFreigabeZeichengleich() {
        // Der Bestand, Aktion für Aktion (vor IP-3 genau so): wer heute was darf.
        assertThat(erlaubt("ROLE_operator")).isEqualTo(new TreeSet<>(KUNDE));
        assertThat(erlaubt("ROLE_operator", KeycloakRealmRoleConverter.KONTO_BENUTZER))
                .as("demo/demo2 nach IP-3: operator + abgeleitetes Kundenkonto").isEqualTo(new TreeSet<>(KUNDE));
        assertThat(erlaubt("ROLE_site-admin")).isEqualTo(new TreeSet<>(ANLAGE));
        assertThat(erlaubt("ROLE_admin")).isEqualTo(new TreeSet<>(ANLAGE));
        assertThat(erlaubt("ROLE_admin", KeycloakRealmRoleConverter.KONTO_BENUTZER)).isEqualTo(new TreeSet<>(ANLAGE));
        assertThat(erlaubt("ROLE_platform-admin")).isEqualTo(new TreeSet<>(PLATTFORM));
        assertThat(erlaubt("ROLE_platform-admin", "KONTO_plattform")).isEqualTo(new TreeSet<>(PLATTFORM));
        assertThat(policy.permissions(auth("ROLE_operator")).actions().keySet())
                .containsExactlyInAnyOrderElementsOf(OcppActionPolicy.ACTIONS);
    }

    @Test
    void kundenkontoOhneRealmRolleHatGenauDieStufeVonOperator() {
        Map<String, Boolean> operator = policy.permissions(auth("ROLE_operator")).actions();
        Map<String, Boolean> neuesKonto = policy.permissions(auth(KeycloakRealmRoleConverter.KONTO_BENUTZER)).actions();

        assertThat(neuesKonto).isEqualTo(operator);
    }

    /** AP-03 E13, IP-7: die Stufe aus der Zuweisung ergibt genau die Freigaben der alten Realm-Stufen. */
    @Test
    void jedeStufeAusDerZuweisungGibtDieFreigabenIhrerAltenRealmStufe() {
        assertThat(erlaubteDerStufe(RechteAbleitung.OcppStufe.KEINE)).isEmpty();
        assertThat(erlaubteDerStufe(RechteAbleitung.OcppStufe.CUSTOMER)).isEqualTo(new TreeSet<>(KUNDE));
        assertThat(erlaubteDerStufe(RechteAbleitung.OcppStufe.SITE_ADMIN)).isEqualTo(new TreeSet<>(ANLAGE));
        assertThat(erlaubteDerStufe(RechteAbleitung.OcppStufe.PLATFORM)).isEqualTo(new TreeSet<>(PLATTFORM));
        for (RechteAbleitung.OcppStufe stufe : RechteAbleitung.OcppStufe.values()) {
            assertThat(OcppActionPolicy.permissions(stufe).actions().keySet()).as(stufe.name())
                    .containsExactlyInAnyOrderElementsOf(OcppActionPolicy.ACTIONS);
        }
    }

    private static TreeSet<String> erlaubteDerStufe(RechteAbleitung.OcppStufe stufe) {
        return OcppActionPolicy.permissions(stufe).actions().entrySet().stream().filter(Map.Entry::getValue)
                .map(Map.Entry::getKey).collect(java.util.stream.Collectors.toCollection(TreeSet::new));
    }

    @Test
    void partnerKontoHatKeineOcppFreigabe() {
        assertThat(erlaubt("ROLE_partner", "KONTO_partner")).isEmpty();
        assertThat(erlaubt()).isEmpty();
    }

    /**
     * AP-03 IP-7: der grobe Riegel lässt zusätzlich das Partner-Konto durch — in einer angenommenen Unterstützung
     * entscheiden {@code @Recht} und die Stufe aus der Zuweisung; ohne Unterstützung weist schon der ZugriffFilter ab.
     */
    @Test
    void ocppRoutenLassenKundenkontoUndPartnerKontoDurchUndSonstNiemandenNeu() {
        String erwartet = "hasAnyRole('operator', 'admin', 'site-admin', 'platform-admin') or hasAuthority('"
                + KeycloakRealmRoleConverter.KONTO_BENUTZER + "') or hasAuthority('KONTO_partner')";
        assertThat(SiteOcppController.class.getAnnotation(PreAuthorize.class).value()).isEqualTo(erwartet);
        assertThat(SiteOcppControlController.class.getAnnotation(PreAuthorize.class).value()).isEqualTo(erwartet);
        assertThat(SiteOcppActionController.class.getAnnotation(PreAuthorize.class).value()).isEqualTo(erwartet);
    }

    private Set<String> erlaubt(String... authorities) {
        return policy.permissions(auth(authorities)).actions().entrySet().stream()
                .filter(e -> Boolean.TRUE.equals(e.getValue()))
                .map(Map.Entry::getKey)
                .collect(Collectors.toCollection(TreeSet::new));
    }

    private static Set<String> union(Set<String> a, Set<String> b) {
        Set<String> out = new TreeSet<>(a);
        out.addAll(b);
        return out;
    }

    private static TestingAuthenticationToken auth(String... authorities) {
        List<SimpleGrantedAuthority> granted = Arrays.stream(authorities).map(SimpleGrantedAuthority::new).toList();
        return new TestingAuthenticationToken("test", "n/a", List.copyOf(granted));
    }
}
