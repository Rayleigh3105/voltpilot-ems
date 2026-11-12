package com.voltpilot.api.mastr;

import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Official BNetzA MaStR webservice (SOAP), used when the captain's Webdienst
 * credentials are configured. Port of the PROVEN reference implementation
 * (energy-sharing-voltpilot {@code src/lib/mastr.ts}): the envelope is built by
 * STRING because generic SOAP libraries mishandle the WCF namespace split - the
 * request wrapper element carries the {@code Request} suffix and lives in the
 * {@code Modelle/Anlage} namespace, while {@code apiKey}/{@code
 * marktakteurMastrNummer}/{@code einheitMastrNummer} live in the {@code
 * Modelle} namespace. The {@code SOAPAction} header is the BARE method name in
 * quotes. Call shape live-verified against the real API on 2026-07-02.
 *
 * <p>Storage units are ALSO SEE-numbered, so a SEE lookup tries the methods in
 * order (solar first - ~98 % of lookups) and falls through on
 * "KeineDatenVorhanden". The method map is extensible the same way the
 * reference maps SEW/SEB/... for wind/biomass; v1 accepts SEE only.
 */
public class MastrSoapClient implements PlantRegistryClient {

    private static final Logger log = LoggerFactory.getLogger(MastrSoapClient.class);

    private static final String NS_SOAP = "http://schemas.xmlsoap.org/soap/envelope/";
    private static final String NS_ANLAGE =
            "https://www.marktstammdatenregister.de/Services/Public/1_2/Modelle/Anlage";
    private static final String NS_MODELLE =
            "https://www.marktstammdatenregister.de/Services/Public/1_2/Modelle";

    /** Prefix -> methods to try in order (extensible: SEW -> GetEinheitWind, ...). */
    private static final Map<String, List<String>> METHODS_BY_PREFIX = Map.of(
            "SEE", List.of("GetEinheitSolar", "GetEinheitStromSpeicher"));

    /** Any namespaced-or-not element with simple text content; first match wins. */
    private static final Pattern FIELD = Pattern.compile(
            "<(?:[^:>]+:)?([A-Za-z][A-Za-z0-9_]*)(?:\\s[^>]*)?>([^<]+)</");

    private final MastrHttp http;
    private final URI endpoint;
    private final String apiKey;
    private final String marktakteurNummer;

    public MastrSoapClient(MastrHttp http, URI endpoint, String apiKey, String marktakteurNummer) {
        this.http = http;
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.marktakteurNummer = marktakteurNummer;
    }

    @Override
    public String sourceId() {
        return "mastr-soap";
    }

    @Override
    public MastrUnit fetchUnit(String unitNumber) throws RegistryLookupException {
        List<String> methods = METHODS_BY_PREFIX.get(unitNumber.substring(0, 3));
        if (methods == null) {
            throw new RegistryLookupException(RegistryLookupException.Reason.INVALID_NUMBER,
                    "Dieses Nummernpräfix wird noch nicht unterstützt.");
        }
        for (String method : methods) {
            Map<String, String> fields = call(method, "einheitMastrNummer", unitNumber);
            if (fields != null) {
                return method.equals("GetEinheitStromSpeicher")
                        ? mapStorage(unitNumber, fields)
                        : mapSolar(unitNumber, fields);
            }
        }
        throw new RegistryLookupException(RegistryLookupException.Reason.NOT_FOUND,
                "Zu dieser MaStR-Nummer wurde keine Einheit im Register gefunden. "
                        + "Bitte prüfen Sie die Nummer in Ihrer Registrierungsbestätigung.");
    }

    /**
     * S2 (Lokations-Suche, Abschnitt 5.3): every unit sharing the given
     * Lokation, via {@code GetLokationStromErzeuger} (returns only the
     * connected unit numbers, {@code VerknuepfteEinheiten}) then one detail
     * fetch per unit ({@link #fetchUnit}) - the webservice has no "give me
     * everything at once" call. Includes the unit the customer already
     * resolved (it IS connected to its own Lokation); the caller dedupes.
     */
    @Override
    public List<MastrUnit> fetchUnitsAtLocation(String locationNumber) throws RegistryLookupException {
        String xml = rawCall("GetLokationStromErzeuger", "lokationMastrNummer", locationNumber);
        if (xml == null) {
            return List.of();
        }
        // Guard 1: the response must itself echo the requested Lokation (the
        // top-level, singular "MastrNummer" field - NOT the repeated
        // per-unit "MaStRNummer" below, different casing by design, WSDL
        // GetLokationErzeugerVerbraucherBasisAntwort).
        String echoedLocation = parseAllFields(xml).get("MastrNummer");
        if (!locationNumber.equals(echoedLocation)) {
            log.warn("mastr.soap.location_mismatch expected={} echo={}", locationNumber, echoedLocation);
            throw unavailable(null);
        }
        List<String> unitNumbers = parseRepeatedField(xml, "MaStRNummer");
        // Guard 2: a real Lokation never carries more units than this.
        if (unitNumbers.size() > MastrJsonClient.MAX_UNITS_PER_LOCATION) {
            log.warn("mastr.soap.location_too_many count={} lokation={}", unitNumbers.size(), locationNumber);
            throw unavailable(null);
        }
        List<MastrUnit> units = new ArrayList<>();
        for (String unitNumber : unitNumbers) {
            units.add(fetchUnit(unitNumber));
        }
        return List.copyOf(units);
    }

    // ---- SOAP plumbing -------------------------------------------------------

    /** Exact envelope shape the WCF endpoint accepts (see class doc). */
    static String buildEnvelope(String method, String apiKey, String marktakteurNummer,
            String einheitMastrNummer) {
        return buildEnvelope(method, apiKey, marktakteurNummer, "einheitMastrNummer", einheitMastrNummer);
    }

    /**
     * Same envelope shape, generalized over the ONE request-specific
     * parameter: {@code einheitMastrNummer} for the per-unit calls,
     * {@code lokationMastrNummer} for {@code GetLokationStromErzeuger}
     * (mastrbasetypes.xsd {@code GetLokationErzeugerVerbraucherBasisParameter}).
     */
    static String buildEnvelope(String method, String apiKey, String marktakteurNummer,
            String paramName, String paramValue) {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
                + "<soapenv:Envelope xmlns:soapenv=\"" + NS_SOAP + "\" xmlns:anl=\"" + NS_ANLAGE
                + "\" xmlns:mod=\"" + NS_MODELLE + "\">\n"
                + "  <soapenv:Body>\n"
                + "    <anl:" + method + "Request>\n"
                + "      <mod:apiKey>" + escapeXml(apiKey) + "</mod:apiKey>\n"
                + "      <mod:marktakteurMastrNummer>" + escapeXml(marktakteurNummer)
                + "</mod:marktakteurMastrNummer>\n"
                + "      <mod:" + paramName + ">" + escapeXml(paramValue)
                + "</mod:" + paramName + ">\n"
                + "    </anl:" + method + "Request>\n"
                + "  </soapenv:Body>\n"
                + "</soapenv:Envelope>";
    }

    static String escapeXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /** All simple-text elements of the response, first occurrence wins. */
    static Map<String, String> parseAllFields(String xml) {
        Map<String, String> fields = new LinkedHashMap<>();
        Matcher m = FIELD.matcher(xml);
        while (m.find()) {
            String value = m.group(2).trim();
            if (!value.isEmpty()) {
                fields.putIfAbsent(m.group(1), value);
            }
        }
        return fields;
    }

    /**
     * EVERY occurrence of one tag name, in document order (unlike {@link
     * #parseAllFields}, which keeps only the first) - needed for a
     * repeated element like {@code VerknuepfteEinheiten}'s per-unit
     * {@code MaStRNummer} (S2 location lookup).
     */
    static List<String> parseRepeatedField(String xml, String tagName) {
        List<String> values = new ArrayList<>();
        Matcher m = FIELD.matcher(xml);
        while (m.find()) {
            if (tagName.equals(m.group(1))) {
                String value = m.group(2).trim();
                if (!value.isEmpty()) {
                    values.add(value);
                }
            }
        }
        return values;
    }

    /**
     * @return the raw response body, or {@code null} when this call has no
     *     data ("KeineDatenVorhanden" / "nicht gefunden" - try the next
     *     method, or an empty Lokation result).
     */
    private String rawCall(String method, String paramName, String paramValue) throws RegistryLookupException {
        String body = buildEnvelope(method, apiKey, marktakteurNummer, paramName, paramValue);
        MastrHttp.Response res;
        try {
            res = http.post(endpoint, Map.of(
                    "Content-Type", "text/xml; charset=utf-8",
                    "SOAPAction", "\"" + method + "\""), body);
        } catch (IOException e) {
            log.warn("mastr.soap.unreachable method={}", method, e);
            throw unavailable(e);
        }
        String xml = res.body() == null ? "" : res.body();
        if (res.status() != 200 || xml.contains("Fault")) {
            Map<String, String> fault = parseAllFields(xml);
            String faultString = fault.getOrDefault("faultstring", "");
            if (faultString.contains("KeineDatenVorhanden") || faultString.contains("nicht gefunden")) {
                return null;
            }
            if (faultString.contains("apiKey")) {
                log.error("mastr.soap.auth_failed method={} fault={}", method, faultString);
                throw new RegistryLookupException(RegistryLookupException.Reason.UNAVAILABLE,
                        "Die Registerabfrage ist derzeit nicht möglich (Zugangsdaten). "
                                + "Bitte wenden Sie sich an den Support.");
            }
            log.warn("mastr.soap.error method={} status={} fault={}", method, res.status(), faultString);
            throw unavailable(null);
        }
        Map<String, String> fields = parseAllFields(xml);
        String ergebniscode = fields.getOrDefault("Ergebniscode", "");
        if (ergebniscode.contains("KeineDatenVorhanden")) {
            return null;
        }
        return xml;
    }

    /** @return parsed fields, or {@code null} when this call has no data (try the next method). */
    private Map<String, String> call(String method, String paramName, String paramValue) throws RegistryLookupException {
        String xml = rawCall(method, paramName, paramValue);
        return xml == null ? null : parseAllFields(xml);
    }

    private static RegistryLookupException unavailable(Throwable cause) {
        return new RegistryLookupException(RegistryLookupException.Reason.UNAVAILABLE,
                "Das Marktstammdatenregister ist derzeit nicht erreichbar. "
                        + "Bitte versuchen Sie es später erneut.", cause);
    }

    // ---- field mapping (WSDL names, mastrservicetypes_anlage.xsd) ------------

    private MastrUnit mapSolar(String unitNumber, Map<String, String> f) {
        Integer solarType = intOrNull(f.get("ArtDerSolaranlage"));
        return new MastrUnit(
                unitNumber,
                MastrUnit.Kind.SOLAR,
                firstNonNull(f.get("NameStromerzeugungseinheit"), f.get("EinheitName")),
                operatingStatus(f),
                MastrCatalog.solarTypeLabel(solarType),
                decimalOrNull(f.get("Bruttoleistung")),
                decimalOrNull(f.get("Nettonennleistung")),
                intOrNull(firstNonNull(f.get("AnzahlModule"), f.get("AnzahlSolarModule"))),
                MastrCatalog.azimuthCatalogIdForEnumName(f.get("Hauptausrichtung")),
                MastrCatalog.tiltCatalogIdForEnumName(f.get("HauptausrichtungNeigungswinkel")),
                dateOrNull(f.get("Inbetriebnahmedatum")),
                null,
                null,
                null,
                f.get("Postleitzahl"),
                firstNonNull(f.get("Ort"), f.get("Gemeinde")),
                // Cross-link to a co-located storage unit (SOAP-only field).
                f.get("SpeicherAmGleichenOrt"),
                f.get("LokationMastrNummer"), f.get("AnlagenbetreiberMastrNummer"));
    }

    private MastrUnit mapStorage(String unitNumber, Map<String, String> f) {
        return new MastrUnit(
                unitNumber,
                MastrUnit.Kind.STORAGE,
                firstNonNull(f.get("NameStromerzeugungseinheit"), f.get("EinheitName")),
                operatingStatus(f),
                "Batteriespeicher",
                decimalOrNull(f.get("Bruttoleistung")),
                decimalOrNull(f.get("Nettonennleistung")),
                null,
                null,
                null,
                dateOrNull(f.get("Inbetriebnahmedatum")),
                decimalOrNull(f.get("NutzbareSpeicherkapazitaet")),
                // Charging power - the exact semantic match for max_charge_kw
                // (only the SOAP API publishes it).
                decimalOrNull(f.get("LeistungsaufnahmeBeimEinspeichern")),
                intOrNull(f.get("Batterietechnologie")),
                f.get("Postleitzahl"),
                firstNonNull(f.get("Ort"), f.get("Gemeinde")),
                // Cross-link back to the co-registered PV unit (SOAP-only field).
                f.get("GemeinsamRegistrierteSolareinheitMastrNummer"),
                f.get("LokationMastrNummer"), f.get("AnlagenbetreiberMastrNummer"));
    }

    private static String operatingStatus(Map<String, String> f) {
        String raw = f.get("EinheitBetriebsstatus");
        if (raw == null) {
            return null;
        }
        // The webservice returns the catalog id; 35 = "In Betrieb" (verified).
        return switch (raw) {
            case "35" -> "In Betrieb";
            case "InBetrieb" -> "In Betrieb";
            default -> raw;
        };
    }

    private static String firstNonNull(String a, String b) {
        return a != null ? a : b;
    }

    private static BigDecimal decimalOrNull(String s) {
        if (s == null) {
            return null;
        }
        try {
            return new BigDecimal(s.replace(",", "."));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Integer intOrNull(String s) {
        if (s == null) {
            return null;
        }
        try {
            return Integer.valueOf(s.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static LocalDate dateOrNull(String s) {
        if (s == null) {
            return null;
        }
        try {
            // XML date, possibly with a time/zone tail: keep the date part.
            return LocalDate.parse(s.length() > 10 ? s.substring(0, 10) : s);
        } catch (Exception e) {
            return null;
        }
    }
}
