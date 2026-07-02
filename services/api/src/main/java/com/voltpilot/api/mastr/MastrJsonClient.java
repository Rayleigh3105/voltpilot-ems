package com.voltpilot.api.mastr;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Keyless public MaStR web-search JSON backend - the DEFAULT source, so dev
 * and a fresh deployment work without any registry credentials (mirrors the
 * energy-charts-over-ENTSO-E default in services/market-data). Exact-match
 * lookup by unit number via the Kendo-grid filter syntax; verified live on
 * real records (feasibility scout voltpilot-mastr-scout-m1).
 *
 * <p>Two hard guards, because the backend SILENTLY IGNORES misspelled filter
 * columns (a typo returns the full 6-million-unit result set): the response
 * must carry {@code Total == 1} and the returned {@code MaStRNummer} must echo
 * the requested one. Storage units live in the same table (Energieträger
 * "Speicher") and resolve by their SEE number the same way. Unlike the SOAP
 * API this backend has no charging-power field and no PV<->storage cross-link;
 * the mapping leaves those {@code null} and the service layer falls back to a
 * symmetric charging assumption.
 */
public class MastrJsonClient implements PlantRegistryClient {

    private static final Logger log = LoggerFactory.getLogger(MastrJsonClient.class);

    /** WCF JSON epoch-millis date: {@code /Date(1782864000000)/}. */
    private static final Pattern WCF_DATE = Pattern.compile("/Date\\((-?\\d+)\\)/");

    private final MastrHttp http;
    private final URI baseEndpoint;
    private final ObjectMapper mapper = new ObjectMapper();

    public MastrJsonClient(MastrHttp http, URI baseEndpoint) {
        this.http = http;
        this.baseEndpoint = baseEndpoint;
    }

    @Override
    public String sourceId() {
        return "mastr-json";
    }

    @Override
    public MastrUnit fetchUnit(String unitNumber) throws RegistryLookupException {
        MastrHttp.Response res;
        try {
            res = http.get(lookupUri(unitNumber));
        } catch (IOException e) {
            log.warn("mastr.json.unreachable", e);
            throw unavailable(e);
        }
        if (res.status() != 200) {
            log.warn("mastr.json.error status={}", res.status());
            throw unavailable(null);
        }
        JsonNode root;
        try {
            root = mapper.readTree(res.body());
        } catch (IOException e) {
            log.warn("mastr.json.unparseable", e);
            throw unavailable(e);
        }
        int total = root.path("Total").asInt(-1);
        if (total == 0) {
            throw new RegistryLookupException(RegistryLookupException.Reason.NOT_FOUND,
                    "Zu dieser MaStR-Nummer wurde keine Einheit im Register gefunden. "
                            + "Bitte prüfen Sie die Nummer in Ihrer Registrierungsbestätigung.");
        }
        JsonNode unit = root.path("Data").path(0);
        // Guard against the silently-ignored-filter failure mode: exactly one
        // result that echoes the requested number, or we trust nothing.
        if (total != 1 || !unitNumber.equals(unit.path("MaStRNummer").asText(null))) {
            log.warn("mastr.json.filter_mismatch total={} echo={}", total,
                    unit.path("MaStRNummer").asText(null));
            throw unavailable(null);
        }
        return map(unitNumber, unit);
    }

    URI lookupUri(String unitNumber) {
        String filter = URLEncoder.encode(
                "MaStR-Nr. der Einheit~eq~'" + unitNumber + "'", StandardCharsets.UTF_8);
        return URI.create(baseEndpoint
                + "?sort=InbetriebnahmeDatum-desc&page=1&pageSize=1&filter=" + filter);
    }

    private MastrUnit map(String unitNumber, JsonNode u) {
        boolean storage = "Speicher".equals(text(u, "EnergietraegerName"));
        return new MastrUnit(
                unitNumber,
                storage ? MastrUnit.Kind.STORAGE : MastrUnit.Kind.SOLAR,
                text(u, "EinheitName"),
                text(u, "BetriebsStatusName"),
                storage
                        ? firstNonNull(text(u, "StromspeichertechnologieBezeichnung"), "Batteriespeicher")
                        : text(u, "ArtDerSolaranlageBezeichnung"),
                decimal(u, "Bruttoleistung"),
                decimal(u, "Nettonennleistung"),
                intOrNull(u, "AnzahlSolarModule"),
                storage ? null : intOrNull(u, "HauptausrichtungSolarModule"),
                storage ? null : intOrNull(u, "HauptneigungswinkelSolarmodule"),
                wcfDate(text(u, "InbetriebnahmeDatum")),
                storage ? decimal(u, "NutzbareSpeicherkapazitaet") : null,
                null,
                storage ? intOrNull(u, "Batterietechnologie") : null,
                text(u, "Plz"),
                firstNonNull(text(u, "Ort"), text(u, "Gemeinde")),
                null);
    }

    private static RegistryLookupException unavailable(Throwable cause) {
        return new RegistryLookupException(RegistryLookupException.Reason.UNAVAILABLE,
                "Das Marktstammdatenregister ist derzeit nicht erreichbar. "
                        + "Bitte versuchen Sie es später erneut.", cause);
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.path(field);
        return v.isNull() || v.isMissingNode() ? null : v.asText();
    }

    private static BigDecimal decimal(JsonNode node, String field) {
        JsonNode v = node.path(field);
        return v.isNumber() ? v.decimalValue() : null;
    }

    private static Integer intOrNull(JsonNode node, String field) {
        JsonNode v = node.path(field);
        return v.isNumber() ? v.intValue() : null;
    }

    /** {@code /Date(epochMillis)/} -> UTC calendar date, else null. */
    static LocalDate wcfDate(String raw) {
        if (raw == null) {
            return null;
        }
        Matcher m = WCF_DATE.matcher(raw);
        if (!m.matches()) {
            return null;
        }
        return Instant.ofEpochMilli(Long.parseLong(m.group(1))).atOffset(ZoneOffset.UTC).toLocalDate();
    }

    private static String firstNonNull(String a, String b) {
        return a != null ? a : b;
    }
}
