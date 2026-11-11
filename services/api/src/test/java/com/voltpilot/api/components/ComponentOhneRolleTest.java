package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Geräte, denen die Box keine Rolle zuordnen kann, legt der Anlege-Weg nicht an (Bericht
 * {@code vp-heizstab-rolle-push-rot} §7 N2): ein Schaltausgang und die nur lesende HTTP-Schnittstelle
 * einer Wallbox entstehen als Messgerät ohne {@code actuate}, die Box überspringt sie seit #1635 still
 * und meldet sie nur als abgelehnt. Statt dieser Sackgasse sagt die API, wie es geht.
 */
class ComponentOhneRolleTest {

    private static ComponentTemplateDto vorlage(String deviceType) {
        return new ComponentTemplateDto("builtin:x:y", "builtin", 1, "x", "X", "y", "Y", null, deviceType, null,
                "fam", "Fam", "comm", "Comm", null, null, null, BigDecimal.ONE, 0, "builtin", null, null, null, null);
    }

    @Test
    void eineWallboxUeberIhreHttpSchnittstelleWirdAlsVerbraucherMitHinweisAufOcppAbgelehnt() {
        assertThatThrownBy(() -> ComponentService.requireNoRolelessSwitch("consumer", vorlage("wallbox"), false))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
                    assertThat(e.getReason()).contains("OCPP").contains("Ladesäule mit OCPP 1.6");
                });
    }

    @Test
    void einSchaltausgangBleibtAbgelehntEinHeizstabUndAndereGeraeteNicht() {
        assertThatThrownBy(() -> ComponentService.requireNoRolelessSwitch("consumer", vorlage("switch"), false))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getReason()).isEqualTo(ComponentService.SCHALTER_OHNE_ROLLE));
        assertThatCode(() -> ComponentService.requireNoRolelessSwitch("consumer", vorlage("switch"), true))
                .doesNotThrowAnyException();
        assertThatCode(() -> ComponentService.requireNoRolelessSwitch("inverter", vorlage("inverter"), false))
                .doesNotThrowAnyException();
        assertThatCode(() -> ComponentService.requireNoRolelessSwitch("consumer", vorlage("io_module"), false))
                .doesNotThrowAnyException();
    }
}
