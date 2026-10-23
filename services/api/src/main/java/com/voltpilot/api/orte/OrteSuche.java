package com.voltpilot.api.orte;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Die hausgenaue Adresssuche (Anlage-Flow a1, Entscheid D4 = A): ein Proxy auf einen Geocoder mit
 * OpenStreetMap-Adressdaten im Photon-Format ({@code /api?q=…}, GeoJSON). Vorgabe ist der öffentliche
 * Dienst {@code photon.komoot.io}; der Betrieb kann einen eigenen Photon mit einem OSM-Auszug
 * DE/AT/CH betreiben ({@code voltpilot.orte.suche.url}). Das Portal fragt nur die eigene API -
 * seine CSP bleibt {@code 'self'}.
 *
 * <p>Vorher suchte das Portal über die Open-Meteo-Ortssuche im Browser: Orte statt Adressen, ohne
 * Länderfilter - „10115“ fand New York, „Weißenburg“ zuerst das Elsass, eine Hausadresse nichts
 * (Befund F3, {@code belege/plz-1440}). Jetzt: nur Treffer in Deutschland, Österreich und der
 * Schweiz, Hausnummern zuerst, doppelte Treffer zusammengelegt.
 *
 * <p>Fair use der Datenquelle: Anfragen unter drei Zeichen gehen nicht hinaus, jede Antwort wird
 * {@link #GEMERKT} lang gemerkt (höchstens {@link #MERKEN_HOECHSTENS} Anfragen), der Client nennt
 * sich ({@code User-Agent}) und wartet höchstens {@code timeout}. Die Anfrage (eine Adresse) wird
 * nie protokolliert. Namensnennung: jede Antwort trägt {@link #QUELLE}, das Portal zeigt sie.
 */
@Service
public class OrteSuche {

    /** Die Namensnennung der Daten (ODbL) - das Portal zeigt sie unter den Vorschlägen. */
    public static final String QUELLE = "© OpenStreetMap-Mitwirkende";
    static final Set<String> LAENDER = Set.of("DE", "AT", "CH");
    /** Der Rahmen um Deutschland, Österreich und die Schweiz - die Länder filtert danach {@link #LAENDER}. */
    static final String RAHMEN = "5.86,45.81,17.17,55.06";
    static final Duration GEMERKT = Duration.ofHours(24);
    static final int MERKEN_HOECHSTENS = 5000;
    static final int HOECHSTENS = 5;
    static final int MINDESTENS_ZEICHEN = 3;
    static final int HOECHSTENS_ZEICHEN = 200;

    /** Ein Vorschlag. {@code genau}: {@code haus}, {@code strasse} oder {@code ort}. */
    public record Treffer(String text, String strasse, String hausnummer, String plz, String ort,
            String land, double breitengrad, double laengengrad, String genau) {
    }

    public record Antwort(List<Treffer> treffer, String quelle) {
    }

    /** Der Dienst antwortete nicht oder falsch - das Portal lässt dann den Punkt auf der Karte setzen. */
    public static final class NichtErreichbar extends RuntimeException {
        NichtErreichbar(String grund, Throwable ursache) {
            super(grund, ursache);
        }
    }

    /** Der Weg zum Dienst - im Test ersetzbar. */
    interface Abruf {
        /** Status und Körper der Antwort. */
        Ergebnis holen(URI uri) throws IOException;
    }

    record Ergebnis(int status, String koerper) {
    }

    private record Gemerkt(Instant am, Antwort antwort) {
    }

    private final URI basis;
    private final Abruf abruf;
    private final ObjectMapper json;
    private final Clock uhr;
    private final Map<String, Gemerkt> gemerkt = new LinkedHashMap<>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Gemerkt> e) {
            return size() > MERKEN_HOECHSTENS;
        }
    };

    @Autowired
    public OrteSuche(@Value("${voltpilot.orte.suche.url:https://photon.komoot.io/api}") String url,
            @Value("${voltpilot.orte.suche.timeout:PT3S}") Duration timeout, ObjectMapper json) {
        this(URI.create(url), jdk(timeout), json, Clock.systemUTC());
    }

    OrteSuche(URI basis, Abruf abruf, ObjectMapper json, Clock uhr) {
        this.basis = basis;
        this.abruf = abruf;
        this.json = json;
        this.uhr = uhr;
    }

    /** Die Vorschläge zu {@code anfrage} - leer unter drei Zeichen. */
    public Antwort suchen(String anfrage) {
        String q = anfrage == null ? "" : anfrage.strip().replaceAll("\\s+", " ");
        if (q.length() > HOECHSTENS_ZEICHEN) {
            throw new IllegalArgumentException("Die Suche hat höchstens " + HOECHSTENS_ZEICHEN + " Zeichen.");
        }
        if (q.length() < MINDESTENS_ZEICHEN) {
            return new Antwort(List.of(), QUELLE);
        }
        String schluessel = q.toLowerCase(Locale.GERMAN);
        Instant jetzt = uhr.instant();
        synchronized (gemerkt) {
            Gemerkt g = gemerkt.get(schluessel);
            if (g != null && g.am().plus(GEMERKT).isAfter(jetzt)) {
                return g.antwort();
            }
        }
        Antwort a = new Antwort(lies(abrufen(q)), QUELLE);
        synchronized (gemerkt) {
            gemerkt.put(schluessel, new Gemerkt(jetzt, a));
        }
        return a;
    }

    private JsonNode abrufen(String q) {
        URI uri = URI.create(basis + "?q=" + URLEncoder.encode(q, StandardCharsets.UTF_8).replace("+", "%20")
                + "&lang=de&limit=15&bbox=" + RAHMEN);
        Ergebnis e;
        try {
            e = abruf.holen(uri);
        } catch (IOException ex) {
            throw new NichtErreichbar("Adresssuche nicht erreichbar", ex);
        }
        if (e.status() != 200) {
            throw new NichtErreichbar("Adresssuche antwortete " + e.status(), null);
        }
        try {
            return json.readTree(e.koerper());
        } catch (IOException ex) {
            throw new NichtErreichbar("Adresssuche antwortete kein JSON", ex);
        }
    }

    /** Die Treffer aus der GeoJSON-Antwort: nur DE/AT/CH, Häuser vor Straßen vor Orten, ohne Doppel. */
    static List<Treffer> lies(JsonNode antwort) {
        List<Treffer> haeuser = new ArrayList<>();
        List<Treffer> strassen = new ArrayList<>();
        List<Treffer> orte = new ArrayList<>();
        Set<String> gesehen = new LinkedHashSet<>();
        for (JsonNode f : antwort.path("features")) {
            JsonNode p = f.path("properties");
            JsonNode c = f.path("geometry").path("coordinates");
            String land = text(p, "countrycode");
            if (land == null || !LAENDER.contains(land.toUpperCase(Locale.ROOT)) || c.size() < 2) {
                continue;
            }
            land = land.toUpperCase(Locale.ROOT);
            String typ = text(p, "type");
            String plz = text(p, "postcode");
            String ort = erster(text(p, "city"), text(p, "town"), text(p, "village"), text(p, "locality"));
            String hausnummer = text(p, "housenumber");
            String strasse = text(p, "street");
            Treffer t;
            if (hausnummer != null && (strasse != null || "house".equals(typ))) {
                String s = strasse != null ? strasse : text(p, "name");
                t = new Treffer(zeile(s + " " + hausnummer, plz, ort), s, hausnummer, plz, ort, land,
                        c.get(1).asDouble(), c.get(0).asDouble(), "haus");
                if (gesehen.add(t.text())) haeuser.add(t);
            } else if ("street".equals(typ)) {
                String s = text(p, "name");
                t = new Treffer(zeile(s, plz, ort), s, null, plz, ort, land,
                        c.get(1).asDouble(), c.get(0).asDouble(), "strasse");
                if (gesehen.add(t.text())) strassen.add(t);
            } else if (Set.of("city", "town", "village", "locality", "district").contains(typ)
                    || "place".equals(text(p, "osm_key"))) {
                // Eine Postleitzahl („10115“) heißt wie ihr Ort: „10115 Berlin“.
                boolean postleitzahl = "postcode".equals(text(p, "osm_value"));
                String name = postleitzahl ? erster(ort, text(p, "name")) : erster(text(p, "name"), ort);
                if (postleitzahl && plz == null) plz = text(p, "name");
                String o = plz == null ? name : plz + " " + name;
                t = new Treffer(o + laenderzusatz(land), null, null, plz, name, land,
                        c.get(1).asDouble(), c.get(0).asDouble(), "ort");
                if (gesehen.add(t.text())) orte.add(t);
            }
        }
        List<Treffer> alle = new ArrayList<>(haeuser);
        alle.addAll(strassen);
        alle.addAll(orte);
        return List.copyOf(alle.subList(0, Math.min(HOECHSTENS, alle.size())));
    }

    private static String zeile(String vorne, String plz, String ort) {
        String hinten = String.join(" ", java.util.stream.Stream.of(plz, ort).filter(x -> x != null).toList());
        return hinten.isEmpty() ? vorne : vorne + ", " + hinten;
    }

    private static String laenderzusatz(String land) {
        return switch (land) {
            case "AT" -> ", Österreich";
            case "CH" -> ", Schweiz";
            default -> "";
        };
    }

    private static String text(JsonNode p, String feld) {
        String v = p.path(feld).asText(null);
        return v == null || v.isBlank() ? null : v.strip();
    }

    private static String erster(String... werte) {
        for (String w : werte) {
            if (w != null) return w;
        }
        return null;
    }

    private static Abruf jdk(Duration timeout) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(timeout)
                .followRedirects(HttpClient.Redirect.NORMAL).build();
        return uri -> {
            HttpRequest r = HttpRequest.newBuilder(uri).timeout(timeout)
                    .header("User-Agent", "VoltPilot-EMS (Adresssuche beim Anlegen)")
                    .header("Accept", "application/json").GET().build();
            try {
                HttpResponse<String> res = client.send(r, HttpResponse.BodyHandlers.ofString());
                return new Ergebnis(res.statusCode(), res.body());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("unterbrochen", e);
            }
        };
    }
}
