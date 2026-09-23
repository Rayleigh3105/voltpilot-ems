package com.voltpilot.api.probe;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/**
 * The probe answer's ingest, without Docker: identity, the closed error
 * vocabulary, and the honesty rules applied on ARRIVAL rather than trusted.
 *
 * <p>Everything a device sends here ends up in front of a customer, so the
 * question these tests keep asking is the same one: can a device make the
 * portal say something that is not true?
 */
class ProbeResultListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String REQ = "9f2c41ab77d0e315";

    private ProbeRegistry registry;
    private ProbeResultListener listener;

    private CompletableFuture<ProbeResult> arm() {
        registry = new ProbeRegistry();
        listener = new ProbeResultListener("tcp://unused", "", "", registry);
        return registry.register(REQ, DEVICE);
    }

    private static String topic(UUID tenant, UUID site, UUID device) {
        return "ems/" + tenant + "/" + site + "/" + device + "/v2/probe-result";
    }

    private static byte[] body(String json) {
        return json.getBytes(StandardCharsets.UTF_8);
    }

    private static String envelope(String results) {
        return envelope(TENANT, SITE, DEVICE, REQ, results, "");
    }

    private static String envelope(UUID tenant, UUID site, UUID device, String requestId,
            String results, String extra) {
        return "{\"schema_version\":\"1.0\",\"type\":\"probe_result\""
                + ",\"tenant_id\":\"" + tenant + "\""
                + ",\"site_id\":\"" + site + "\""
                + ",\"device_id\":\"" + device + "\""
                + ",\"request_id\":\"" + requestId + "\""
                + ",\"answered_at\":\"2026-08-11T09:12:02Z\""
                + extra
                + ",\"results\":[" + results + "]}";
    }

    private static ProbeResult get(CompletableFuture<ProbeResult> f) {
        return new ProbeRegistry().await(f, Duration.ofMillis(50));
    }

    @Test
    void aGoodAnswerReachesTheWaitingRequestWithRawAndValue() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"soc\",\"ok\":true,\"raw\":94,\"registers\":[94],\"value\":9.4}")));

        ProbeResult res = get(f);
        assertThat(res).isNotNull();
        assertThat(res.requestId()).isEqualTo(REQ);
        assertThat(res.errorCode()).isNull();
        assertThat(res.results()).hasSize(1);
        ProbeResult.OpResult line = res.results().get(0);
        assertThat(line.ok()).isTrue();
        assertThat(line.raw()).isEqualTo(94.0);
        assertThat(line.value()).isEqualTo(9.4);
        assertThat(line.registers()).containsExactly(94);
    }

    /**
     * AP-05: der Kopf eines WAGO-Registerbilds kommt als eigener Block an — mit den Vertragsnamen, auch
     * neben einer Ablehnung, und nur mit {@code signatur_ok}/{@code erkannt} als Aussage.
     */
    @Test
    void aWagoHeadTravelsAsItsOwnBlockAlsoBesideARefusal() throws Exception {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"kopf\",\"ok\":true,\"wago_kopf\":{\"signatur_ok\":true,\"erkannt\":true,"
                        + "\"hauptversion\":1,\"nebenversion\":0,\"kopflaenge\":12,\"kartenblocklaenge\":42,"
                        + "\"kartenzahl\":4,\"herzschlag\":900,\"controller_kennung\":4294967295}},"
                        + "{\"id\":\"fremd\",\"ok\":false,\"error_code\":\"invalid_response\",\"message\":\"x\","
                        + "\"wago_kopf\":{\"signatur_ok\":true,\"erkannt\":false,\"grund\":\"hauptversion_fremd\","
                        + "\"hauptversion\":2}},"
                        + "{\"id\":\"leer\",\"ok\":true,\"wago_kopf\":{\"kartenzahl\":4}}")));

        List<ProbeResult.OpResult> zeilen = get(f).results();
        ProbeResult.WagoKopf kopf = zeilen.get(0).wagoKopf();
        assertThat(zeilen.get(0).ok()).isTrue();
        assertThat(kopf.controllerKennung()).isEqualTo(4_294_967_295L);
        assertThat(kopf.kartenzahl()).isEqualTo(4);
        assertThat(zeilen.get(1).ok()).isFalse();
        assertThat(zeilen.get(1).errorCode()).isEqualTo("invalid_response");
        assertThat(zeilen.get(1).wagoKopf().grund()).isEqualTo("hauptversion_fremd");
        assertThat(zeilen.get(1).wagoKopf().kartenzahl()).isNull();
        // Ohne die beiden Pflichtfelder ist der Block keine Aussage — und die Zeile kein Erfolg.
        assertThat(zeilen.get(2).ok()).isFalse();
        assertThat(zeilen.get(2).wagoKopf()).isNull();
        assertThat(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(zeilen.get(0)))
                .contains("\"wago_kopf\":{\"signatur_ok\":true,\"erkannt\":true", "\"controller_kennung\":4294967295");
    }

    /**
     * The identity rule of every listener on the device topics: a device may
     * not answer for another one. Both halves are checked - a foreign TOPIC and
     * a payload that disagrees with its own topic.
     */
    @Test
    void anAnswerFromAnotherDeviceNeverCompletesTheRequest() {
        UUID other = UUID.randomUUID();

        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, other),
                body(envelope(TENANT, SITE, other, REQ, "", "")));
        assertThat(get(f)).as("a foreign device's answer is not ours").isNull();

        f = arm();
        // Topic says our device, payload claims another - the payload lies.
        listener.handle(topic(TENANT, SITE, DEVICE),
                body(envelope(TENANT, SITE, other, REQ, "", "")));
        assertThat(get(f)).as("payload identity must equal topic identity").isNull();

        f = arm();
        listener.handle(topic(UUID.randomUUID(), SITE, DEVICE),
                body(envelope(TENANT, SITE, DEVICE, REQ, "", "")));
        assertThat(get(f)).as("a foreign tenant topic is not ours").isNull();
    }

    @Test
    void anUnknownOrExpiredCorrelationIsDropped() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE),
                body(envelope(TENANT, SITE, DEVICE, "0000000000000000", "", "")));
        assertThat(get(f)).isNull();
    }

    @Test
    void aForeignFormIsIgnoredEntirely() {
        for (String payload : List.of(
                "nicht json",
                "[]",
                "{\"type\":\"probe_result\"}",
                envelope(TENANT, SITE, DEVICE, REQ, "", "").replace("\"1.0\"", "\"2.0\""),
                envelope(TENANT, SITE, DEVICE, REQ, "", "")
                        .replace("probe_result", "etwas_anderes"))) {
            CompletableFuture<ProbeResult> f = arm();
            listener.handle(topic(TENANT, SITE, DEVICE), body(payload));
            assertThat(get(f)).as(payload).isNull();
        }
    }

    /**
     * ⚠ THE honesty rule, enforced rather than trusted: a line that CLAIMS
     * success but carries no numbers is not a reading. Without this a device
     * could put an empty tile in front of a customer that reads like a
     * measured 0.
     */
    @Test
    void anOkLineWithoutNumbersIsNotAReading() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"a\",\"ok\":true},"
                        + "{\"id\":\"b\",\"ok\":true,\"raw\":5},"
                        + "{\"id\":\"c\",\"ok\":true,\"raw\":5,\"value\":5}")));

        ProbeResult res = get(f);
        assertThat(res.results()).hasSize(3);
        assertThat(res.results().get(0).ok()).isFalse();
        assertThat(res.results().get(0).raw()).isNull();
        assertThat(res.results().get(1).ok()).as("raw without value is half a statement").isFalse();
        assertThat(res.results().get(1).value()).isNull();
        assertThat(res.results().get(2).ok()).isTrue();
    }

    /** A failed line never carries a value, whatever the device attached. */
    @Test
    void aFailedLineIsStrippedOfAnyValue() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"a\",\"ok\":false,\"raw\":0,\"value\":0,\"registers\":[0],"
                        + "\"error_code\":\"no_answer\",\"message\":\"Das Gerät antwortet nicht.\"}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isFalse();
        assertThat(line.raw()).isNull();
        assertThat(line.value()).isNull();
        assertThat(line.registers()).isNull();
        assertThat(line.errorCode()).isEqualTo("no_answer");
        assertThat(line.message()).isNotBlank();
    }

    /**
     * The closed vocabulary: a word we do not understand must not become a
     * sentence (the sibling listeners' rule). Here it additionally stops a
     * device from inventing a status the portal would then render.
     */
    @Test
    void anInventedErrorCodeIsDropped() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(TENANT, SITE, DEVICE, REQ,
                "{\"id\":\"a\",\"ok\":false,\"error_code\":\"kaputt\",\"message\":\"…\"}",
                ",\"error_code\":\"auch_kaputt\"")));

        ProbeResult res = get(f);
        assertThat(res.errorCode()).as("a whole-request code must be known too").isNull();
        assertThat(res.results().get(0).errorCode()).isNull();
        // The German sentence survives - it is the device's own honest text and
        // carries no claim the portal keys on.
        assertThat(res.results().get(0).message()).isNotBlank();
    }

    @Test
    void aWholeRequestRefusalIsCarriedThroughWithAnEmptyResultList() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(TENANT, SITE, DEVICE, REQ,
                "", ",\"error_code\":\"rate_limited\",\"message\":\"Zu viele Prüfungen.\"")));

        ProbeResult res = get(f);
        assertThat(res.errorCode()).isEqualTo("rate_limited");
        assertThat(res.message()).isEqualTo("Zu viele Prüfungen.");
        assertThat(res.results()).isEmpty();
    }

    /** Bounds: a device cannot flood the portal through this channel. */
    @Test
    void theAnswerIsBounded() {
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 40; i++) {
            many.append(i == 0 ? "" : ",")
                    .append("{\"id\":\"o").append(i).append("\",\"ok\":false}");
        }
        String longMessage = "x".repeat(5000);

        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(TENANT, SITE, DEVICE, REQ,
                many.toString(), ",\"message\":\"" + longMessage + "\"")));

        ProbeResult res = get(f);
        assertThat(res.results()).hasSizeLessThanOrEqualTo(8);
        assertThat(res.message()).hasSizeLessThanOrEqualTo(400);
    }

    /** A register word outside 16 bit is not a register word - report none. */
    @Test
    void nonsenseRegisterWordsAreOmittedRatherThanShown() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"a\",\"ok\":true,\"raw\":1,\"value\":1,\"registers\":[70000]}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isTrue();
        assertThat(line.registers()).isNull();
    }

    /**
     * Der EHRLICHE Fehlschlag (Live-Fall Muehlfeldweg 2, 21.08.2026): die Box
     * hat wirklich gelesen, drei Kanaele sind sauber dekodiert, und NUR der
     * Ladestand hat die Plausibilitaetsregel verletzt. Dann reisen die Werte MIT
     * dem benannten Befund durch - vorher kam eine Ablehnung ohne eine einzige
     * Zahl an, und genau daran ist eine reale Neuanlage haengengeblieben.
     */
    @Test
    void aRefusalWithANamedFindingCarriesTheValuesItDidRead() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"verbindung\",\"ok\":false,\"error_code\":\"implausible\""
                        + ",\"reading\":{\"pv_kw\":6.1,\"load_kw\":4.3,\"grid_kw\":1.2}"
                        + ",\"finding\":{\"channel\":\"soc_pct\",\"rule\":\"missing\""
                        + ",\"raw\":0,\"value\":0}}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isFalse();
        assertThat(line.errorCode()).isEqualTo("implausible");
        assertThat(line.reading().pvKw()).isEqualTo(6.1);
        assertThat(line.reading().socPct()).isNull();
        assertThat(line.finding().channel()).isEqualTo("soc_pct");
        assertThat(line.finding().rule()).isEqualTo("missing");
        assertThat(line.finding().overridable()).isTrue();
        // Raw/Value der ZEILE gehoeren einer Register-Lesung, nie einem Test.
        assertThat(line.raw()).isNull();
        assertThat(line.value()).isNull();
    }

    /**
     * Ein Wort ausserhalb des Vokabulars wird VERWORFEN - und mit ihm die Werte:
     * ohne benannte Ursache waeren es Zahlen, von denen niemand sagen kann, ob
     * man ihnen trauen darf. Hier entscheidet das zusaetzlich, ob dem Kunden ein
     * Ausnahmeweg ANGEBOTEN wird, also darf nichts geraten werden.
     */
    @Test
    void anUnknownFindingWordIsDroppedTogetherWithItsValues() {
        for (String finding : List.of(
                "{\"channel\":\"temperatur\",\"rule\":\"missing\"}",
                "{\"channel\":\"soc_pct\",\"rule\":\"gefaellt_uns_nicht\"}")) {
            CompletableFuture<ProbeResult> f = arm();
            listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                    "{\"id\":\"verbindung\",\"ok\":false,\"error_code\":\"implausible\""
                            + ",\"reading\":{\"pv_kw\":6.1}"
                            + ",\"finding\":" + finding + "}")));
            ProbeResult.OpResult line = get(f).results().get(0);
            assertThat(line.finding()).isNull();
            assertThat(line.reading()).isNull();
        }
    }

    /**
     * Die SCHAETZUNG neben dem Befund (Ladestand aus der Batteriespannung): sie
     * reist mit, damit der Assistent eine Zahl zeigen kann statt nur einer
     * Ablehnung - und sie AENDERT DAS URTEIL NICHT. Der Test bleibt
     * ok=false/„missing", die Anlage braucht also weiterhin die ausdrueckliche
     * Zustimmung des Kunden und bleibt fuer die Batterie-Steuerung gesperrt.
     */
    @Test
    void theVoltageEstimateRidesNextToTheFindingWithoutChangingTheVerdict() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"verbindung\",\"ok\":false,\"error_code\":\"implausible\""
                        + ",\"reading\":{\"pv_kw\":6.1,\"load_kw\":4.3,\"grid_kw\":1.2}"
                        + ",\"finding\":{\"channel\":\"soc_pct\",\"rule\":\"missing\""
                        + ",\"raw\":0,\"value\":0"
                        + ",\"estimate\":{\"soc_pct\":36,\"voltage_v\":636.0}}}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isFalse();
        assertThat(line.finding().rule()).isEqualTo("missing");
        assertThat(line.finding().overridable()).isTrue();
        assertThat(line.finding().estimate().socPct()).isEqualTo(36.0);
        assertThat(line.finding().estimate().voltageV()).isEqualTo(636.0);
        // Der beanstandete Kanal steht NIE in der Lesung - auch nicht als Schaetzung.
        assertThat(line.reading().socPct()).isNull();
    }

    /**
     * Aus einer Lesung, der wir schon abgesprochen haben zu trauen, wird nichts
     * geschaetzt: eine Leerantwort und ein kaputter Rahmen tragen keine Zahl -
     * und eine unvollstaendige oder unmoegliche Schaetzung ebenso wenig. Die
     * Spannung ist dabei PFLICHT: sie ist der Beleg, an dem ein Skalierungs-
     * fehler sichtbar wird; ein Prozentwert ohne sie waere unpruefbar.
     */
    @Test
    void anEstimateIsDroppedWhenItCouldNotBeTrusted() {
        record Case(String rule, String estimate) {}
        List<Case> cases = List.of(
                new Case("no_answer", "{\"soc_pct\":36,\"voltage_v\":636.0}"),
                new Case("out_of_range", "{\"soc_pct\":36,\"voltage_v\":636.0}"),
                new Case("missing", "{\"soc_pct\":36}"),
                new Case("missing", "{\"voltage_v\":636.0}"),
                new Case("missing", "{\"soc_pct\":0,\"voltage_v\":636.0}"),
                new Case("missing", "{\"soc_pct\":140,\"voltage_v\":636.0}"),
                new Case("missing", "\"36 %\""));
        for (Case c : cases) {
            CompletableFuture<ProbeResult> f = arm();
            listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                    "{\"id\":\"verbindung\",\"ok\":false,\"error_code\":\"implausible\""
                            + ",\"reading\":{\"pv_kw\":6.1}"
                            + ",\"finding\":{\"channel\":\"soc_pct\",\"rule\":\"" + c.rule()
                            + "\",\"estimate\":" + c.estimate() + "}}")));
            ProbeResult.OpResult line = get(f).results().get(0);
            assertThat(line.finding()).as("finding for %s", c).isNotNull();
            assertThat(line.finding().estimate()).as("estimate for %s", c).isNull();
        }
    }

    /**
     * Die drei Regeln sind NICHT austauschbar: nur „missing" beschreibt einen
     * Geraetezustand, den ein Betreiber bewusst hinnehmen darf.
     */
    @Test
    void onlyTheMissingRuleIsEverOverridable() {
        assertThat(new ProbeResult.Finding("soc_pct", "missing", 0.0, 0.0).overridable()).isTrue();
        assertThat(new ProbeResult.Finding("soc_pct", "out_of_range", 1250.0, 1250.0)
                .overridable()).isFalse();
        assertThat(new ProbeResult.Finding("soc_pct", "no_answer", null, null)
                .overridable()).isFalse();
        assertThat(new ProbeResult.Finding("temperatur", "missing", 0.0, 0.0)
                .overridable()).isFalse();
    }

    /** Ein bestandener Test bleibt byte-fuer-byte wie vorher: kein Befund. */
    @Test
    void aPassingTestCarriesNoFinding() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"verbindung\",\"ok\":true"
                        + ",\"reading\":{\"pv_kw\":12.4,\"soc_pct\":87}}")));
        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isTrue();
        assertThat(line.finding()).isNull();
        assertThat(line.reading().socPct()).isEqualTo(87.0);
    }

    // ---- Die Zuordnungs-Vorschau der selbst angebundenen Batterie (P5d) ----

    /**
     * Die Vorschau-Zeile: je Zuordnung Roh- UND skalierter Wert nebeneinander -
     * genau das Paar, an dem ein Skalierungsfehler sichtbar wird.
     */
    @Test
    void aBatteryPreviewCarriesOneRowPerMappingWithRawAndValue() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"batterie\",\"ok\":true,\"samples\":["
                        + "{\"channel\":\"cell_min_mv\",\"topic\":\"diybms/bank/3/cell/11\""
                        + ",\"raw\":3.393,\"value\":3393.0,\"count\":176"
                        + ",\"at\":\"2026-09-09T18:04:08Z\"}]}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isTrue();
        assertThat(line.reading()).isNull();
        assertThat(line.samples()).hasSize(1);
        ProbeResult.Sample s = line.samples().get(0);
        assertThat(s.channel()).isEqualTo("cell_min_mv");
        assertThat(s.topic()).isEqualTo("diybms/bank/3/cell/11");
        assertThat(s.raw()).isEqualTo(3.393);
        assertThat(s.value()).isEqualTo(3393.0);
        assertThat(s.count()).isEqualTo(176);
        assertThat(s.at()).isEqualTo("2026-09-09T18:04:08Z");
    }

    /**
     * „Nichts empfangen" ist eine ehrliche Aussage - und sie trägt KEINE Zahl.
     * Selbst wenn die Box eine mitschickte, wird sie verworfen: eine Zahl ohne
     * Empfang wäre eine erfundene Messung, und die Fläche würde sie anzeigen.
     */
    @Test
    void aMappingThatReceivedNothingCarriesNoNumberAtAll() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"batterie\",\"ok\":true,\"samples\":["
                        + "{\"channel\":\"charge_allowed\",\"count\":0"
                        + ",\"raw\":0,\"value\":0,\"topic\":\"diybms/status\"}]}")));

        ProbeResult.Sample s = get(f).results().get(0).samples().get(0);
        assertThat(s.count()).isZero();
        assertThat(s.raw()).isNull();
        assertThat(s.value()).isNull();
        assertThat(s.topic()).isNull();
        assertThat(s.at()).isNull();
    }

    /**
     * Dieselbe Paar-Regel wie beim Register-Lesen: ohne BEIDE Zahlen ist es
     * keine Lesung. Die Zeile bleibt (sie belegt den Empfang), die Zahlen
     * fallen weg - eine halbe Lesung sähe aus wie eine ganze.
     */
    @Test
    void aSampleWithOnlyOneOfTheTwoNumbersKeepsNeither() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"batterie\",\"ok\":true,\"samples\":["
                        + "{\"channel\":\"soc_pct\",\"count\":3,\"value\":41.5}]}")));

        ProbeResult.Sample s = get(f).results().get(0).samples().get(0);
        assertThat(s.count()).isEqualTo(3);
        assertThat(s.raw()).isNull();
        assertThat(s.value()).isNull();
    }

    /**
     * Eine ABGELEHNTE Vorschau darf trotzdem Zeilen tragen: „im Fenster kam
     * nichts an" ist genau die Auskunft, wegen der die Vorschau existiert - und
     * die benannte Klasse reist daneben, nie statt ihrer.
     */
    @Test
    void aRefusedPreviewStillCarriesItsRowsAndItsNamedClass() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"batterie\",\"ok\":false,\"error_code\":\"no_answer\""
                        + ",\"message\":\"Im Lauschfenster kam nichts an.\""
                        + ",\"samples\":[{\"channel\":\"soc_pct\",\"count\":0}]}")));

        ProbeResult.OpResult line = get(f).results().get(0);
        assertThat(line.ok()).isFalse();
        assertThat(line.errorCode()).isEqualTo("no_answer");
        assertThat(line.samples()).hasSize(1);
        assertThat(line.samples().get(0).count()).isZero();
    }

    /** Eine Zeile ohne Kanal ist keine Zeile - sie ließe sich nirgends zuordnen. */
    @Test
    void aSampleWithoutAChannelIsDropped() {
        CompletableFuture<ProbeResult> f = arm();
        listener.handle(topic(TENANT, SITE, DEVICE), body(envelope(
                "{\"id\":\"batterie\",\"ok\":true,\"samples\":["
                        + "{\"count\":5,\"raw\":1,\"value\":1},"
                        + "{\"channel\":\"voltage_v\",\"count\":5,\"raw\":574,"
                        + "\"value\":574}]}")));

        List<ProbeResult.Sample> samples = get(f).results().get(0).samples();
        assertThat(samples).hasSize(1);
        assertThat(samples.get(0).channel()).isEqualTo("voltage_v");
    }
}
