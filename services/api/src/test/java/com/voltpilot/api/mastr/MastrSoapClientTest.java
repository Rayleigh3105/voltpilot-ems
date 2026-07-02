package com.voltpilot.api.mastr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Offline tests of the SOAP client: the EXACT envelope/header shape that was
 * live-verified against the real webservice on 2026-07-02 (any drift here IS
 * the bug the reference implementation exists to prevent), plus response
 * parsing against the recorded-shape fixtures and the solar->storage method
 * fallthrough for SEE-numbered battery units.
 */
class MastrSoapClientTest {

    private static final URI ENDPOINT =
            URI.create("https://www.marktstammdatenregister.de/MaStRApi/Api.svc/Soap11/Anlage");

    // ---- envelope building ---------------------------------------------------

    @Test
    void buildsTheVerifiedEnvelopeShape() {
        String xml = MastrSoapClient.buildEnvelope(
                "GetEinheitSolar", "key-123", "SOM999", "SEE966831669444");

        // Wrapper element: method + "Request" suffix, in the Modelle/Anlage namespace.
        assertThat(xml).contains("<anl:GetEinheitSolarRequest>");
        assertThat(xml).contains("</anl:GetEinheitSolarRequest>");
        assertThat(xml).contains(
                "xmlns:anl=\"https://www.marktstammdatenregister.de/Services/Public/1_2/Modelle/Anlage\"");
        // Auth params: in the PLAIN Modelle namespace (the WCF split generic
        // SOAP libraries get wrong).
        assertThat(xml).contains(
                "xmlns:mod=\"https://www.marktstammdatenregister.de/Services/Public/1_2/Modelle\"");
        assertThat(xml).contains("<mod:apiKey>key-123</mod:apiKey>");
        assertThat(xml).contains("<mod:marktakteurMastrNummer>SOM999</mod:marktakteurMastrNummer>");
        assertThat(xml).contains("<mod:einheitMastrNummer>SEE966831669444</mod:einheitMastrNummer>");
        assertThat(xml).startsWith("<?xml version=\"1.0\" encoding=\"utf-8\"?>");
        assertThat(xml).contains("xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"");
    }

    @Test
    void escapesXmlInCredentials() {
        String xml = MastrSoapClient.buildEnvelope("GetEinheitSolar", "a<b&c>d", "M", "SEE1");
        assertThat(xml).contains("<mod:apiKey>a&lt;b&amp;c&gt;d</mod:apiKey>");
    }

    @Test
    void sendsTheBareMethodNameQuotedAsSoapAction() throws Exception {
        RecordingHttp http = new RecordingHttp(List.of(
                new MastrHttp.Response(200, fixture("soap_solar_SEE966831669444.xml"))));
        client(http).fetchUnit("SEE966831669444");

        RecordingHttp.Call call = http.calls.get(0);
        assertThat(call.headers().get("SOAPAction")).isEqualTo("\"GetEinheitSolar\"");
        assertThat(call.headers().get("Content-Type")).isEqualTo("text/xml; charset=utf-8");
        assertThat(call.uri()).isEqualTo(ENDPOINT);
    }

    // ---- response parsing ----------------------------------------------------

    @Test
    void parsesTheSolarFixtureIntoAUnit() throws Exception {
        RecordingHttp http = new RecordingHttp(List.of(
                new MastrHttp.Response(200, fixture("soap_solar_SEE966831669444.xml"))));
        MastrUnit unit = client(http).fetchUnit("SEE966831669444");

        assertThat(unit.kind()).isEqualTo(MastrUnit.Kind.SOLAR);
        assertThat(unit.unitNumber()).isEqualTo("SEE966831669444");
        assertThat(unit.grossPowerKw()).isEqualByComparingTo(new BigDecimal("6.05"));
        assertThat(unit.netPowerKw()).isEqualByComparingTo(new BigDecimal("6.00"));
        assertThat(unit.moduleCount()).isEqualTo(13);
        assertThat(unit.azimuthCatalogId()).isEqualTo(699);
        assertThat(unit.tiltCatalogId()).isEqualTo(809);
        assertThat(unit.commissionedOn()).isEqualTo(LocalDate.of(2026, 7, 1));
        assertThat(unit.postalCode()).isEqualTo("89150");
        assertThat(unit.city()).isEqualTo("Laichingen");
        assertThat(unit.operatingStatus()).isEqualTo("In Betrieb");
        assertThat(unit.plantTypeLabel()).isEqualTo("Gebäudesolaranlage");
        assertThat(unit.name()).isEqualTo("PV Anlage");
        assertThat(unit.storageCapacityKwh()).isNull();
    }

    @Test
    void storageSeeNumberFallsThroughToTheStorageMethod() throws Exception {
        // A battery's SEE gets KeineDatenVorhanden from GetEinheitSolar first.
        RecordingHttp http = new RecordingHttp(List.of(
                new MastrHttp.Response(500, fixture("soap_fault_keine_daten.xml")),
                new MastrHttp.Response(200, fixture("soap_storage_SEE972142227037.xml"))));
        MastrUnit unit = client(http).fetchUnit("SEE972142227037");

        assertThat(http.calls).hasSize(2);
        assertThat(http.calls.get(0).headers().get("SOAPAction")).isEqualTo("\"GetEinheitSolar\"");
        assertThat(http.calls.get(1).headers().get("SOAPAction"))
                .isEqualTo("\"GetEinheitStromSpeicher\"");

        assertThat(unit.kind()).isEqualTo(MastrUnit.Kind.STORAGE);
        assertThat(unit.storageCapacityKwh()).isEqualByComparingTo(new BigDecimal("12.8"));
        assertThat(unit.grossPowerKw()).isEqualByComparingTo(new BigDecimal("8.76"));
        assertThat(unit.chargePowerKw()).isEqualByComparingTo(new BigDecimal("8.20"));
        assertThat(unit.batteryTechnologyId()).isEqualTo(727);
        assertThat(unit.linkedUnitNumber()).isEqualTo("SEE912345678901");
        assertThat(unit.postalCode()).isEqualTo("79674");
    }

    @Test
    void unknownNumberIsNotFoundAfterAllMethods() {
        RecordingHttp http = new RecordingHttp(List.of(
                new MastrHttp.Response(500, fixture("soap_fault_keine_daten.xml")),
                new MastrHttp.Response(500, fixture("soap_fault_keine_daten.xml"))));
        RegistryLookupException e = catchThrowableOfType(
                () -> client(http).fetchUnit("SEE000000000000"), RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.NOT_FOUND);
        assertThat(e.getMessage()).contains("keine Einheit");
    }

    @Test
    void authFaultMapsToUnavailableWithSupportHint() {
        String fault = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>"
                + "<s:Fault><faultcode>s:Client</faultcode>"
                + "<faultstring>Der Parameter apiKey fehlt oder ist ungültig.</faultstring>"
                + "</s:Fault></s:Body></s:Envelope>";
        RecordingHttp http = new RecordingHttp(List.of(new MastrHttp.Response(500, fault)));
        RegistryLookupException e = catchThrowableOfType(
                () -> client(http).fetchUnit("SEE966831669444"), RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.UNAVAILABLE);
        assertThat(e.getMessage()).contains("Zugangsdaten");
    }

    @Test
    void networkErrorMapsToUnavailableGerman() {
        MastrHttp down = new MastrHttp() {
            @Override
            public Response post(URI uri, Map<String, String> headers, String body)
                    throws IOException {
                throw new IOException("connect timed out");
            }

            @Override
            public Response get(URI uri) {
                throw new UnsupportedOperationException();
            }
        };
        RegistryLookupException e = catchThrowableOfType(
                () -> client(down).fetchUnit("SEE966831669444"), RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.UNAVAILABLE);
        assertThat(e.getMessage()).contains("nicht erreichbar");
    }

    @Test
    void parseAllFieldsIsNamespacePrefixAgnosticAndFirstWins() {
        Map<String, String> fields = MastrSoapClient.parseAllFields(
                "<x:Ergebniscode>OK</x:Ergebniscode><Bruttoleistung>1.5</Bruttoleistung>"
                        + "<y:Bruttoleistung>9.9</y:Bruttoleistung><Leer></Leer>");
        assertThat(fields).containsEntry("Ergebniscode", "OK")
                .containsEntry("Bruttoleistung", "1.5")
                .doesNotContainKey("Leer");
    }

    // ---- helpers ---------------------------------------------------------------

    private MastrSoapClient client(MastrHttp http) {
        return new MastrSoapClient(http, ENDPOINT, "key-123", "SOM999");
    }

    static String fixture(String name) {
        try (var in = MastrSoapClientTest.class.getResourceAsStream("/mastr/" + name)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Scripted transport: returns the queued responses in order, records calls. */
    static class RecordingHttp implements MastrHttp {
        record Call(URI uri, Map<String, String> headers, String body) {
        }

        final List<Call> calls = new ArrayList<>();
        private final List<Response> responses;

        RecordingHttp(List<Response> responses) {
            this.responses = responses;
        }

        @Override
        public Response post(URI uri, Map<String, String> headers, String body) {
            calls.add(new Call(uri, headers, body));
            return responses.get(calls.size() - 1);
        }

        @Override
        public Response get(URI uri) {
            calls.add(new Call(uri, Map.of(), null));
            return responses.get(calls.size() - 1);
        }
    }
}
