package com.voltpilot.api.kundenbereich;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Die reinen Regeln des Gesamtabzugs (UEMS AP-20 IP-17): Objektart je Tabelle, Zugangsdaten, CSV-Zeile. */
class GesamtabzugTest {

    @Test
    void jedeTabelleHatEineObjektartUndProtokolleGehenVor() {
        assertThat(Gesamtabzug.objektart("bericht_stand")).isEqualTo("berichte");
        assertThat(Gesamtabzug.objektart("bericht_aenderung")).isEqualTo("protokolle");
        assertThat(Gesamtabzug.objektart("bericht_abruf")).isEqualTo("protokolle");
        assertThat(Gesamtabzug.objektart("zugriff_protokoll")).isEqualTo("protokolle");
        assertThat(Gesamtabzug.objektart("kundenbereich_abzug")).isEqualTo("protokolle");
        assertThat(Gesamtabzug.objektart("energiemanagement_dokument_fassung")).isEqualTo("nachweise");
        assertThat(Gesamtabzug.objektart("internes_audit_eintrag")).isEqualTo("nachweise");
        assertThat(Gesamtabzug.objektart("managementbewertung_sitzung")).isEqualTo("nachweise");
        assertThat(Gesamtabzug.objektart("messreihe_viertelstunde")).isEqualTo("messreihen");
        assertThat(Gesamtabzug.objektart("telemetry")).isEqualTo("messreihen");
        assertThat(Gesamtabzug.objektart("device_measurement_sample")).isEqualTo("messreihen");
        assertThat(Gesamtabzug.objektart("messstelle")).isEqualTo("bestand");
        assertThat(Gesamtabzug.objektart("standort")).isEqualTo("bestand");
    }

    @Test
    void zugangsdatenSindTextOderBytesMitGeheimemNamenNieEinMerker() {
        assertThat(Gesamtabzug.zugangsdaten("token", "S", "text")).isTrue();
        assertThat(Gesamtabzug.zugangsdaten("mqtt_password_hash", "S", "text")).isTrue();
        assertThat(Gesamtabzug.zugangsdaten("private_key", "U", "bytea")).isTrue();
        assertThat(Gesamtabzug.zugangsdaten("secret", "B", "bool")).as("ocpp_configuration_key.secret").isFalse();
        assertThat(Gesamtabzug.zugangsdaten("pruefsumme", "S", "text")).isFalse();
        assertThat(Gesamtabzug.zugangsdaten("anzeigename", "S", "text")).isFalse();
    }

    @Test
    void eineCsvZeileSchuetztNurTextzellenVorFormeln() {
        List<String> zellen = Arrays.asList("=SUMME(A1)", "-2.5000", null, "a;b", "sagt \"ja\"", "zwei\nZeilen");
        List<Boolean> text = List.of(true, false, true, true, true, true);
        assertThat(Gesamtabzug.csvZeile(zellen, text))
                .isEqualTo("'=SUMME(A1);-2.5000;;\"a;b\";\"sagt \"\"ja\"\"\";\"zwei\nZeilen\"\r\n");
        assertThat(Gesamtabzug.csvZeile(List.of("-x", "+y"), null)).as("Kopfzeile: jede Zelle ist Text")
                .isEqualTo("'-x;'+y\r\n");
    }

    @Test
    void sha256IstHexUeberDieBytes() {
        assertThat(Gesamtabzug.sha256(new byte[0]))
                .isEqualTo("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
