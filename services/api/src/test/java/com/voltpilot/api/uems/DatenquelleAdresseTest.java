package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * Die EINE Darstellung einer Adresse (Vertrag {@code data-source-assignment.md} §3 Nr. 5): ohne
 * sie wären dieselbe Steuerung unter drei Schreibweisen drei Wege an derselben Box, und die
 * Eindeutigkeit je Box sähe keinen davon. Adressen aus dem Referenzunternehmen.
 */
class DatenquelleAdresseTest {

    @ParameterizedTest(name = "{0} „{1}“ → {2}")
    @CsvSource(delimiter = '|', value = {
        "modbus_tcp     | 192.168.20.10:502          | 192.168.20.10:502",
        "modbus_tcp     | ' 192.168.20.10 : 502 '    | 192.168.20.10:502",
        "modbus_tcp     | 192.168.20.10              | 192.168.20.10:502",
        "sunspec_modbus | WR-Halle1.Local:1502       | wr-halle1.local:1502",
        "modbus_tcp     | [FD00::10]                 | [fd00::10]:502",
        "modbus_tcp     | '[fd00::10] :503'          | [fd00::10]:503",
        "http           | HTTP://Zaehler.LAN/api?x=A | http://zaehler.lan:80/api?x=A",
        "http           | https://192.168.30.20      | https://192.168.30.20:443",
        "http           | http://192.168.30.20:8080/ | http://192.168.30.20:8080/",
        "mqtt           | '  Halle1/BMS/+/Zelle  '   | Halle1/BMS/+/Zelle",
        "ocpp           | ' AHR-LP-01 '              | AHR-LP-01",
        "solarman_v5    | ' 192.168.0.28 : 8899 / 2985159064 ' | 192.168.0.28:8899/2985159064",
        "solarman_v5    | Deye-Halle.LAN/2985159064  | deye-halle.lan:8899/2985159064",
    })
    void normalisiertJeProtokoll(String protokoll, String roh, String gespeichert) {
        assertThat(DatenquelleAdresse.normalisiere(protokoll, roh)).isEqualTo(gespeichert);
    }

    @ParameterizedTest(name = "{0} „{1}“ abgelehnt")
    @CsvSource(delimiter = '|', value = {
        "modbus_tcp | ''                    | Unter welcher Adresse",
        "modbus_tcp | 192.168.20.10:0       | Port",
        "modbus_tcp | 192.168.20.10:70000   | Port",
        "modbus_tcp | 192.168.20.10:abc     | Port",
        "modbus_tcp | fd00::10              | eckigen Klammern",
        "modbus_tcp | [fd00::10             | schließende Klammer",
        "modbus_tcp | _wago_:502            | Host und Port",
        "http       | ftp://192.168.30.20   | http:// oder https://",
        "http       | http://nutzer:geheim@zaehler.lan/api | Zugangsdaten",
        "solarman_v5 | 192.168.0.28:8899    | Seriennummer",
        "solarman_v5 | 192.168.0.28:8899/   | Seriennummer",
        "solarman_v5 | 192.168.0.28:0/2985159064 | Port",
    })
    void lehntEineAdresseOhneFormMitSatzAb(String protokoll, String roh, String satz) {
        assertThatThrownBy(() -> DatenquelleAdresse.normalisiere(protokoll, roh))
                .isInstanceOf(DatenquelleAdresse.Ungueltig.class)
                .hasMessageContaining(satz);
    }

    @Test
    void hostUndPortDerGespeichertenAdresseFuerDenLeseSchritt() {
        assertThat(DatenquelleAdresse.hostPort("192.168.10.31:502"))
                .isEqualTo(new DatenquelleAdresse.HostPort("192.168.10.31", 502));
        assertThat(DatenquelleAdresse.hostPort("[fd00::10]:503"))
                .isEqualTo(new DatenquelleAdresse.HostPort("fd00::10", 503));
    }
}
