package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Ein Deye über das Modbus TCP seines Datenloggers (Feld 25.11.2026) entsteht nur an einer Box, die den Weg liest
 * (Fähigkeit deye_modbus_tcp): eine ältere Box fiele auf den Solarman-Weg zurück und lehnte die Anlage ab.
 */
class DeyeModbusTcpWegTest {

    private static final UUID BOX = UUID.fromString("33333333-3333-4333-8333-333333333333");

    @Test
    void nurEineBoxMitDerFaehigkeitBekommtDenWeg() {
        assertThatCode(() -> ComponentService.requireBoxKannWeg("deye_modbus_tcp", BOX, b -> true))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> ComponentService.requireBoxKannWeg("deye_modbus_tcp", BOX, b -> false))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    org.assertj.core.api.Assertions.assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                    org.assertj.core.api.Assertions.assertThat(e.getReason()).contains("deye_modbus_tcp")
                            .contains("Solarman V5").contains("RS485");
                });
        // Ohne eindeutige führende Box ist nicht belegbar, dass sie den Weg liest.
        assertThatThrownBy(() -> ComponentService.requireBoxKannWeg("deye_modbus_tcp", null, b -> true))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void andereWegeBleibenUnberuehrt() {
        assertThatCode(() -> ComponentService.requireBoxKannWeg("solarman_v5", null, b -> false))
                .doesNotThrowAnyException();
        assertThatCode(() -> ComponentService.requireBoxKannWeg("modbus_tcp", BOX, b -> false))
                .doesNotThrowAnyException();
    }
}
