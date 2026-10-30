package com.voltpilot.api.geraetesuche;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Der Vertrag der Gerätesuche ({@code docs/contracts/v2/mqtt-geraetesuche.md}): Topics, Grenzen, die geschlossenen
 * Wörter, der Erkennungskatalog und die Zuordnung eines Fundes zu seiner Gruppe. Alles steht gleichlautend in
 * {@code docs/contracts/v2/geraetesuche-vectors.json}; Go-Zwilling {@code edge-app/core/internal/geraetesuche},
 * TS-Zwilling {@code frontend/portal/src/geraetesuche.ts} (die Wörter der Antwort). Rein: ohne Datenbank, ohne Broker.
 *
 * <p>Gesucht wird hier nichts; die Suche läuft auf der Box. Starten, Abbrechen und den Verlauf darf, wer
 * {@code geraet.einrichten} an der Anlage hat (DP-4 A) - das bestehende Recht deckt sie wie Verbindungstest und Probe.
 */
public final class GeraetesucheVertrag {

    public static final String SCHEMA_VERSION = "1.0";
    public static final String TOPIC_AUFTRAG = "geraetesuche";
    public static final String TOPIC_STAND = "geraetesuche-stand";
    public static final String TOPIC_ERGEBNIS = "geraetesuche-ergebnis";

    /** gueltig_bis = ausgeloest_am + FRIST, nie später. */
    public static final Duration FRIST = Duration.ofSeconds(120);
    public static final Duration STAND_TAKT = Duration.ofSeconds(2);
    public static final Duration MAX_DAUER = Duration.ofSeconds(180);
    public static final int MAX_JE_STUNDE = 6;
    public static final int MAX_NETZE = 2;
    public static final int MAX_PRAEFIX = 24;
    public static final int MAX_FUNDE = 256;
    public static final int MAX_MERKMALE = 8;
    /** So lange wartet die Cloud auf einen Zwischenstand, bevor die Suche {@code keine_antwort} heißt. */
    public static final Duration KEINE_ANTWORT = Duration.ofSeconds(30);

    /** Erkenner und Wege, in Vertragsfolge. */
    public static final List<String> ERKENNER = List.of("solarman", "shelly", "goe", "netztechnik", "modbus_offen",
            "sunspec", "fronius_solar_api", "kaco_aiswei", "kostal", "huawei", "sma", "victron", "opendtu_ahoy",
            "ebyte", "wago", "mdns", "ssdp", "funkmodul");
    /** Wege erzeugen keinen eigenen Fund und laufen nur auf Edge Light. */
    public static final List<String> WEGE = List.of("mdns", "ssdp", "funkmodul");
    public static final List<String> ARTEN = List.of("wechselrichter", "wallbox", "schaltaktor", "zaehler",
            "io_modul", "sps", "dtu", "modbus_geraet", "router", "zugangspunkt");
    public static final List<String> NETZTECHNIK_ARTEN = List.of("router", "zugangspunkt");
    /** DP-3 A: was nur als Anzahl die Box verlässt. */
    public static final List<String> WEITERE_ARTEN = List.of("telefon_tablet", "rechner", "unbekannt");

    public static final String UEBERNEHMEN = "uebernehmen";
    public static final String SELBST_BESCHREIBEN = "selbst_beschreiben";
    public static final String NICHT_MIT_DIESER_BOX = "nicht_mit_dieser_box";
    public static final String KEIN_LESEWEG = "kein_leseweg";
    public static final String NUR_ANZEIGE = "nur_anzeige";
    public static final List<String> ANBINDUNGEN = List.of(UEBERNEHMEN, SELBST_BESCHREIBEN, NICHT_MIT_DIESER_BOX,
            KEIN_LESEWEG, NUR_ANZEIGE);
    public static final List<String> ERKENNUNGEN = List.of("sicher", "wahrscheinlich", "unbekannt");
    public static final List<String> HINDERNISSE = List.of("geschuetzt", "lokale_api_aus");
    public static final List<String> COMMUNICATIONS = List.of("solarman_v5", "shelly_http", "goe_http_api",
            "fronius_solar_api", "fronius_sunspec", "sunspec_tcp", "kaco_http", "kostal_modbus", "huawei_modbus",
            "ebyte_modbus_tcp", "modbus_tcp");
    public static final List<String> SCHRITTE = List.of("netze_bestimmen", "nachbarn_finden", "geraete_ansprechen",
            "geraete_erkennen");
    public static final List<String> ROLLEN = List.of("kundennetz", "box_netz");

    /** Je Zustand des Ergebnisses die Gründe, die er tragen darf; fertig trägt keinen. */
    public static final Map<String, List<String>> GRUENDE = gruende();

    /** Die Antwort an das Portal (OpenAPI {@code Geraetesuche}). */
    public static final List<String> GRUPPEN = List.of("braucht_hilfe", "bereit", "nicht_anbindbar", "vielleicht",
            "schon_eingerichtet", "weitere");
    public static final String NEU = "neu";
    public static final String SCHON_EINGERICHTET = "schon_eingerichtet";
    public static final String ADRESSE_GEAENDERT = "adresse_geaendert";
    public static final String ANDERES_GERAET = "anderes_geraet_an_bekannter_adresse";
    public static final String KENNUNG_OFFEN = "adresse_bekannt_kennung_offen";
    public static final List<String> ABGLEICH = List.of(NEU, SCHON_EINGERICHTET, ADRESSE_GEAENDERT, ANDERES_GERAET,
            KENNUNG_OFFEN);
    public static final List<String> ZUSTAENDE_API = List.of("wartet", "laeuft", "fertig", "abgebrochen",
            "fehlgeschlagen", "abgelehnt", "keine_antwort");
    public static final List<String> FEHLER_409 = List.of("laeuft_schon", "nicht_unterstuetzt", "box_offline");
    public static final List<String> FEHLER_429 = List.of("zu_oft");

    /**
     * Ein Paar (erkenner, art) des Erkennungskatalogs.
     *
     * @param communication die Kommunikationsart der Vorlage; null = kein Leser in VoltPilot
     * @param docker        was die Docker-Box meldet; null = das Paar kommt dort nicht vor
     * @param edgeLight     was Edge Light meldet; null = das Paar kommt dort nicht vor
     */
    public record KatalogZeile(String erkenner, String art, int schnitt, String communication, String docker,
            String edgeLight) {
    }

    public static final List<KatalogZeile> KATALOG = List.of(
            new KatalogZeile("solarman", "wechselrichter", 1, "solarman_v5", UEBERNEHMEN, UEBERNEHMEN),
            new KatalogZeile("shelly", "schaltaktor", 1, "shelly_http", UEBERNEHMEN, UEBERNEHMEN),
            new KatalogZeile("shelly", "zaehler", 2, null, KEIN_LESEWEG, KEIN_LESEWEG),
            new KatalogZeile("goe", "wallbox", 1, "goe_http_api", UEBERNEHMEN, UEBERNEHMEN),
            new KatalogZeile("netztechnik", "router", 1, null, NUR_ANZEIGE, NUR_ANZEIGE),
            new KatalogZeile("netztechnik", "zugangspunkt", 1, null, NUR_ANZEIGE, NUR_ANZEIGE),
            new KatalogZeile("modbus_offen", "modbus_geraet", 1, "modbus_tcp", SELBST_BESCHREIBEN,
                    SELBST_BESCHREIBEN),
            new KatalogZeile("sunspec", "wechselrichter", 2, "sunspec_tcp", UEBERNEHMEN, NICHT_MIT_DIESER_BOX),
            new KatalogZeile("fronius_solar_api", "wechselrichter", 2, "fronius_solar_api", UEBERNEHMEN,
                    NICHT_MIT_DIESER_BOX),
            new KatalogZeile("kaco_aiswei", "wechselrichter", 2, "kaco_http", UEBERNEHMEN, NICHT_MIT_DIESER_BOX),
            new KatalogZeile("kostal", "wechselrichter", 2, "kostal_modbus", UEBERNEHMEN, NICHT_MIT_DIESER_BOX),
            new KatalogZeile("huawei", "wechselrichter", 2, "huawei_modbus", UEBERNEHMEN, NICHT_MIT_DIESER_BOX),
            new KatalogZeile("sma", "wechselrichter", 2, null, KEIN_LESEWEG, KEIN_LESEWEG),
            new KatalogZeile("sma", "zaehler", 2, null, null, KEIN_LESEWEG),
            new KatalogZeile("victron", "wechselrichter", 2, null, KEIN_LESEWEG, KEIN_LESEWEG),
            new KatalogZeile("opendtu_ahoy", "dtu", 2, null, KEIN_LESEWEG, KEIN_LESEWEG),
            new KatalogZeile("ebyte", "io_modul", 2, "ebyte_modbus_tcp", UEBERNEHMEN, UEBERNEHMEN),
            new KatalogZeile("wago", "sps", 2, "modbus_tcp", UEBERNEHMEN, NICHT_MIT_DIESER_BOX));

    private GeraetesucheVertrag() {
    }

    public static Optional<KatalogZeile> paar(String erkenner, String art) {
        return KATALOG.stream().filter(z -> z.erkenner().equals(erkenner) && z.art().equals(art)).findFirst();
    }

    /**
     * Die Gruppe eines abgeglichenen Fundes. In dieser Folge: ein Konflikt mit einer bekannten Komponente braucht Hilfe;
     * was schon eingerichtet ist (auch ohne belegbare Kennung), bleibt dort; ein Hindernis an einem neuen,
     * übernehmbaren Fund braucht Hilfe; sonst entscheidet die Anbindung.
     *
     * @param hindernis null = keines
     */
    public static String gruppe(String anbindung, String abgleich, String hindernis) {
        if (ADRESSE_GEAENDERT.equals(abgleich) || ANDERES_GERAET.equals(abgleich)) {
            return "braucht_hilfe";
        }
        if (SCHON_EINGERICHTET.equals(abgleich) || KENNUNG_OFFEN.equals(abgleich)) {
            return "schon_eingerichtet";
        }
        if (hindernis != null && UEBERNEHMEN.equals(anbindung)) {
            return "braucht_hilfe";
        }
        return switch (anbindung) {
            case UEBERNEHMEN -> "bereit";
            case NICHT_MIT_DIESER_BOX, KEIN_LESEWEG -> "nicht_anbindbar";
            case SELBST_BESCHREIBEN -> "vielleicht";
            case NUR_ANZEIGE -> "weitere";
            default -> throw new IllegalArgumentException("anbindung " + anbindung);
        };
    }

    /** {@code ems/{tenant}/{site}/{device}/v2/{blatt}}. */
    public static String topic(Object tenant, Object site, Object device, String blatt) {
        return "ems/" + tenant + "/" + site + "/" + device + "/v2/" + blatt;
    }

    private static Map<String, List<String>> gruende() {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("fertig", List.of());
        m.put("abgebrochen", List.of("auf_wunsch", "neustart", "zeitlimit"));
        m.put("abgelehnt", List.of("laeuft_schon", "zu_oft", "abgelaufen", "lan_host_fehlt", "kein_privates_netz"));
        m.put("fehlgeschlagen", List.of("interner_fehler"));
        return java.util.Collections.unmodifiableMap(m);
    }
}
