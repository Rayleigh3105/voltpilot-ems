package com.voltpilot.api.mastr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import java.math.BigDecimal;
import java.net.URI;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Offline tests of the keyless JSON source against the VERBATIM-recorded
 * public-backend responses (fixtures recorded 2026-07-02), plus the two hard
 * guards against the backend's silently-ignored-filter failure mode.
 */
class MastrJsonClientTest {

    private static final URI BASE = URI.create(
            "https://www.marktstammdatenregister.de/MaStR/Einheit/EinheitJson/"
                    + "GetErweiterteOeffentlicheEinheitStromerzeugung");

    @Test
    void lookupUriUsesTheExactKendoFilterSyntax() {
        MastrJsonClient client = new MastrJsonClient(null, BASE);
        assertThat(client.lookupUri("SEE966831669444").toString())
                .isEqualTo(BASE + "?sort=InbetriebnahmeDatum-desc&page=1&pageSize=1"
                        + "&filter=MaStR-Nr.+der+Einheit%7Eeq%7E%27SEE966831669444%27");
    }

    @Test
    void parsesTheRecordedPvRecord() throws Exception {
        MastrUnit unit = client("json_pv_SEE966831669444.json").fetchUnit("SEE966831669444");

        assertThat(unit.kind()).isEqualTo(MastrUnit.Kind.SOLAR);
        assertThat(unit.grossPowerKw()).isEqualByComparingTo(new BigDecimal("6.05"));
        assertThat(unit.netPowerKw()).isEqualByComparingTo(new BigDecimal("6.0"));
        assertThat(unit.moduleCount()).isEqualTo(13);
        assertThat(unit.azimuthCatalogId()).isEqualTo(699);
        assertThat(unit.tiltCatalogId()).isEqualTo(809);
        assertThat(unit.commissionedOn()).isEqualTo(LocalDate.of(2026, 7, 1));
        assertThat(unit.plantTypeLabel()).isEqualTo("Gebäudesolaranlage");
        assertThat(unit.operatingStatus()).isEqualTo("In Betrieb");
        assertThat(unit.postalCode()).isEqualTo("89150");
        assertThat(unit.city()).isEqualTo("Laichingen");
        assertThat(unit.name()).isEqualTo("PV Anlage");
        // Masked / not present for residential units and on this backend:
        assertThat(unit.storageCapacityKwh()).isNull();
        assertThat(unit.chargePowerKw()).isNull();
        assertThat(unit.linkedUnitNumber()).isNull();
    }

    @Test
    void parsesTheRecordedStorageRecord() throws Exception {
        MastrUnit unit = client("json_storage_SEE972142227037.json").fetchUnit("SEE972142227037");

        assertThat(unit.kind()).isEqualTo(MastrUnit.Kind.STORAGE);
        assertThat(unit.storageCapacityKwh()).isEqualByComparingTo(new BigDecimal("12.8"));
        assertThat(unit.grossPowerKw()).isEqualByComparingTo(new BigDecimal("8.76"));
        assertThat(unit.batteryTechnologyId()).isEqualTo(727);
        assertThat(unit.postalCode()).isEqualTo("79674");
        assertThat(unit.city()).isEqualTo("Todtnau");
        // No charging-power field on this backend - stays null, the service
        // layer assumes symmetric and says so.
        assertThat(unit.chargePowerKw()).isNull();
    }

    @Test
    void zeroResultsIsNotFound() {
        RegistryLookupException e = catchThrowableOfType(
                () -> clientWithBody("{\"Data\":[],\"Total\":0}").fetchUnit("SEE000000000000"),
                RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.NOT_FOUND);
        assertThat(e.getMessage()).contains("keine Einheit");
    }

    @Test
    void hugeResultSetMeansTheFilterWasIgnoredAndNothingIsTrusted() {
        // A misspelled filter column silently returns the FULL result set
        // (verified live); the guard must refuse rather than show unit #1.
        String body = "{\"Data\":[{\"MaStRNummer\":\"SEE111111111111\","
                + "\"EnergietraegerName\":\"Solare Strahlungsenergie\"}],\"Total\":6262962}";
        RegistryLookupException e = catchThrowableOfType(
                () -> clientWithBody(body).fetchUnit("SEE966831669444"),
                RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.UNAVAILABLE);
    }

    @Test
    void echoMismatchIsRefused() {
        String body = "{\"Data\":[{\"MaStRNummer\":\"SEE999999999999\","
                + "\"EnergietraegerName\":\"Solare Strahlungsenergie\"}],\"Total\":1}";
        RegistryLookupException e = catchThrowableOfType(
                () -> clientWithBody(body).fetchUnit("SEE966831669444"),
                RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.UNAVAILABLE);
    }

    @Test
    void httpErrorIsUnavailableGerman() {
        MastrJsonClient client = new MastrJsonClient(
                new MastrSoapClientTest.RecordingHttp(
                        List.of(new MastrHttp.Response(503, "maintenance"))), BASE);
        RegistryLookupException e = catchThrowableOfType(
                () -> client.fetchUnit("SEE966831669444"), RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.UNAVAILABLE);
        assertThat(e.getMessage()).contains("nicht erreichbar");
    }

    @Test
    void wcfDateDecodesEpochMillis() {
        assertThat(MastrJsonClient.wcfDate("/Date(1782864000000)/"))
                .isEqualTo(LocalDate.of(2026, 7, 1));
        assertThat(MastrJsonClient.wcfDate("2026-07-01")).isNull();
        assertThat(MastrJsonClient.wcfDate(null)).isNull();
    }

    private MastrJsonClient client(String fixtureName) {
        return clientWithBody(MastrSoapClientTest.fixture(fixtureName));
    }

    private MastrJsonClient clientWithBody(String body) {
        return new MastrJsonClient(
                new MastrSoapClientTest.RecordingHttp(
                        List.of(new MastrHttp.Response(200, body))), BASE);
    }
}
