package com.voltpilot.api.mastr;

import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.time.LocalDate;
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
            Map<String, String> fields = call(method, unitNumber);
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

    // ---- SOAP plumbing -------------------------------------------------------

    /** Exact envelope shape the WCF endpoint accepts (see class doc). */
    static String buildEnvelope(String method, String apiKey, String marktakteurNummer,
            String einheitMastrNummer) {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
                + "<soapenv:Envelope xmlns:soapenv=\"" + NS_SOAP + "\" xmlns:anl=\"" + NS_ANLAGE
                + "\" xmlns:mod=\"" + NS_MODELLE + "\">\n"
                + "  <soapenv:Body>\n"
                + "    <anl:" + method + "Request>\n"
                + "      <mod:apiKey>" + escapeXml(apiKey) + "</mod:apiKey>\n"
                + "      <mod:marktakteurMastrNummer>" + escapeXml(marktakteurNummer)
                + "</mod:marktakteurMastrNummer>\n"
                + "      <mod:einheitMastrNummer>" + escapeXml(einheitMastrNummer)
                + "</mod:einheitMastrNummer>\n"
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

    /** @return parsed fields, or {@code null} when this METHOD has no data (try the next). */
    private Map<String, String> call(String method, String unitNumber) throws RegistryLookupException {
        String body = buildEnvelope(method, apiKey, marktakteurNummer, unitNumber);
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
        return fields;
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
                intOrNull(f.get("Hauptausrichtung")),
                intOrNull(f.get("HauptausrichtungNeigungswinkel")),
                dateOrNull(f.get("Inbetriebnahmedatum")),
                null,
                null,
                null,
                f.get("Postleitzahl"),
                firstNonNull(f.get("Ort"), f.get("Gemeinde")),
                // Cross-link to a co-located storage unit (SOAP-only field).
                f.get("SpeicherAmGleichenOrt"));
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
                f.get("GemeinsamRegistrierteSolareinheitMastrNummer"));
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
