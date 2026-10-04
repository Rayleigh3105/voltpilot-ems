package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.web.dto.SiteChargingDto.ChargeConnectorDto;
import java.math.BigDecimal;
import java.sql.ResultSet;
import org.junit.jupiter.api.Test;

/**
 * {@code device_charge_connector.session_kwh} ist NUMERIC - der PostgreSQL-
 * Treiber liefert dafür BigDecimal. Ein blinder {@code (Double)}-Cast warf
 * eine ClassCastException, und jede Ladepunkt-Sicht (Steuerung,
 * Ladevorgänge, Boost, Prioritäten) scheiterte mit HTTP 500, sobald an der
 * Anlage ein OCPP-Ladevorgang mit Zählerstand lief (Produktion, 04.10.2026).
 */
class DeviceChargerStatusRepositoryTest {

    @Test
    void theSessionBalanceFromTheNumericColumnIsReadInsteadOfFailingTheWholeView() throws Exception {
        ResultSet rs = mock(ResultSet.class);
        when(rs.getInt("connector_id")).thenReturn(1);
        when(rs.getString("status")).thenReturn("Charging");
        when(rs.getBoolean("charging")).thenReturn(true);
        when(rs.getObject("power_kw")).thenReturn(6.82);                     // DOUBLE PRECISION
        when(rs.getObject("energy_kwh")).thenReturn(2045.878);               // DOUBLE PRECISION
        when(rs.getObject("session_kwh")).thenReturn(new BigDecimal("2.85")); // NUMERIC

        ChargeConnectorDto c = DeviceChargerStatusRepository.mapConnector(rs);

        assertThat(c.sessionKwh()).isEqualTo(2.85);
        assertThat(c.powerKw()).isEqualTo(6.82);
        assertThat(c.energyKwh()).isEqualTo(2045.878);
        // Was nicht gemessen ist, bleibt abwesend - keine erfundene 0.
        assertThat(c.socPct()).isNull();
        assertThat(c.allocatedKw()).isNull();
    }

    @Test
    void dblKeepsAbsentAbsentAndReadsEveryNumberTheDriverHandsBack() {
        assertThat(DeviceChargerStatusRepository.dbl(null)).isNull();
        assertThat(DeviceChargerStatusRepository.dbl(new BigDecimal("0.1"))).isEqualTo(0.1);
        assertThat(DeviceChargerStatusRepository.dbl(2.5d)).isEqualTo(2.5);
        assertThat(DeviceChargerStatusRepository.dbl(7)).isEqualTo(7.0);
    }
}
