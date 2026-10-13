package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

/**
 * Die Log-Kennung {@code tenant_id} ist ein Spiegel des {@link TenantContext} (docs/k8s-readiness.md,
 * Abschnitt "Logs") - für jeden, der ihn beschreibt: Filter, Läufer, MQTT-Listener.
 */
class TenantContextLogKennungTest {

    private static final UUID A = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID B = UUID.fromString("10000000-0000-0000-0000-000000000001");

    @AfterEach
    void clear() {
        TenantContext.clear();
    }

    @Test
    void setzenNenntDenMandantenUndAbraeumenNimmtIhnWieder() {
        TenantContext.set(A);
        assertThat(MDC.get("tenant_id")).isEqualTo(A.toString());

        TenantContext.clear();
        assertThat(MDC.get("tenant_id")).isNull();
    }

    /** Das Muster der Läufer: je Mandant setzen, danach den vorigen Stand zurückgeben. */
    @Test
    void einWechselNenntImmerDenGeradeGeltendenMandanten() {
        TenantContext.set(A);
        UUID vorher = TenantContext.get();

        TenantContext.set(B);
        assertThat(MDC.get("tenant_id")).isEqualTo(B.toString());

        TenantContext.set(vorher);
        assertThat(MDC.get("tenant_id")).isEqualTo(A.toString());
    }

    @Test
    void ohneMandantStehtKeineLeereKennungImLog() {
        TenantContext.set(A);

        TenantContext.set(null);

        assertThat(TenantContext.get()).isNull();
        assertThat(MDC.get("tenant_id")).isNull();
    }
}
