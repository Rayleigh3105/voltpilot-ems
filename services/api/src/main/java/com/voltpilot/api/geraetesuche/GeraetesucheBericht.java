package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Was die Box über eine Gerätesuche meldet: der Zwischenstand auf {@code …/v2/geraetesuche-stand} und das Ergebnis auf
 * {@code …/v2/geraetesuche-ergebnis} ({@code docs/contracts/v2/mqtt-geraetesuche.md} §5/§6). {@link #stand} und
 * {@link #ergebnis} sind die reine Vertragsprüfung ohne Datenbank; {@code null} = verworfen.
 *
 * <p>Tolerant gelesen (Fallklassen der Vektoren): unbekannte Felder und Erkenner-Namen werden überlesen; ein Fund, der
 * eine Regel verletzt, wird überlesen und nie gespeichert, die übrige Suche gilt ({@code ueberlesen} zählt ihn); nur
 * eine Hülle, die nicht zur Suche passt (Identität, Version, Grund, Netze, Grenzen), wird ganz verworfen. Gespeichert
 * wird nur, was diese Records tragen - eine fehlerhaft gesendete MAC erreicht so nie eine Tabelle (DP-3 A).
 */
public final class GeraetesucheBericht {

    public record Netz(String rolle, String netz, String boxAdresse, Boolean ausschnitt, boolean erreichbar,
            int aktiv) {
    }

    /** Die Verbindung in den Schlüsseln der Vorlagen. */
    public record Verbindung(String communication, String ip, int port, Long serial, Integer unitId) {
    }

    public record Fund(String schluessel, String erkenner, String art, String hersteller, String modell,
            String seriennummer, String firmware, String familie, String spannung, Integer kanaele, String erkennung,
            List<String> merkmale, String anbindung, String hindernis, Verbindung verbindung,
            boolean liestBoxSchon) {
    }

    /** DP-3 A: nur Zahlen; null = nicht gezählt. */
    public record Weitere(Integer telefonTablet, Integer rechner, Integer unbekannt) {
    }

    /** @param ueberlesen wie viele Funde der Leser überlesen hat */
    public record Stand(UUID tenantId, UUID siteId, UUID deviceId, UUID suchId, int nr, Instant ts, String schritt,
            int erledigt, int gesamt, Integer restS, List<Netz> netze, List<Fund> funde,
            @JsonIgnore int ueberlesen) {
    }

    /** @param ueberlesen wie viele Funde der Leser überlesen hat */
    public record Ergebnis(UUID tenantId, UUID siteId, UUID deviceId, UUID suchId, Instant ts, String zustand,
            String grund, int dauerMs, List<String> erkenner, List<Netz> netze, List<Fund> funde, Weitere weitere,
            @JsonIgnore int ueberlesen) {
    }

    private static final Pattern UUID_MUSTER =
            Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern SCHLUESSEL = Pattern.compile("[a-z0-9_]{1,32}:[A-Za-z0-9._:-]{1,96}");
    private static final Pattern HERSTELLER = Pattern.compile("[a-z0-9][a-z0-9_-]{0,63}");
    private static final Pattern SERIENNUMMER = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._/-]{0,63}");
    private static final Pattern FAMILIE = Pattern.compile("[a-z0-9][a-z0-9_]{0,31}");
    private static final Pattern MERKMAL = Pattern.compile("[a-z0-9_]{1,64}");
    private static final Pattern TEXT64 = Pattern.compile("[^\\u0000-\\u001f\\u007f]{1,64}");

    /** Eine verworfene Hülle; nur im Leser. */
    private static final class Verworfen extends RuntimeException {
        Verworfen(String warum) {
            super(warum, null, false, false);
        }
    }

    private GeraetesucheBericht() {
    }

    public static Stand stand(String topic, byte[] payload, ObjectMapper mapper) {
        try {
            JsonNode r = huelle(topic, GeraetesucheVertrag.TOPIC_STAND, payload, mapper);
            int nr = ganz(r.path("nr"), 1, Integer.MAX_VALUE);
            String schritt = wort(r.path("schritt"), GeraetesucheVertrag.SCHRITTE);
            int erledigt = ganz(r.path("erledigt"), 0, Integer.MAX_VALUE);
            int gesamt = ganz(r.path("gesamt"), 0, Integer.MAX_VALUE);
            if (erledigt > gesamt) {
                throw new Verworfen("erledigt > gesamt");
            }
            JsonNode rest = r.path("rest_s");
            Integer restS = rest.isMissingNode() || rest.isNull() ? null
                    : ganz(rest, 0, (int) GeraetesucheVertrag.MAX_DAUER.toSeconds());
            List<Netz> netze = netze(r.path("netze"));
            List<Fund> funde = new ArrayList<>();
            int ueberlesen = funde(r.path("funde"), netze, funde);
            return new Stand(uuid(r, "tenant_id"), uuid(r, "site_id"), uuid(r, "device_id"), uuid(r, "such_id"), nr,
                    zeit(r.path("ts")), schritt, erledigt, gesamt, restS, netze, List.copyOf(funde), ueberlesen);
        } catch (RuntimeException e) {
            return null;
        }
    }

    public static Ergebnis ergebnis(String topic, byte[] payload, ObjectMapper mapper) {
        try {
            JsonNode r = huelle(topic, GeraetesucheVertrag.TOPIC_ERGEBNIS, payload, mapper);
            String zustand = wort(r.path("zustand"), List.copyOf(GeraetesucheVertrag.GRUENDE.keySet()));
            List<String> erlaubt = GeraetesucheVertrag.GRUENDE.get(zustand);
            JsonNode g = r.path("grund");
            String grund = g.isMissingNode() || g.isNull() ? null : g.isTextual() ? g.asText() : "";
            if (erlaubt.isEmpty() ? grund != null : !erlaubt.contains(grund)) {
                throw new Verworfen("grund " + grund + " zu " + zustand);
            }
            int dauerMs = ganz(r.path("dauer_ms"), 0, 600_000);
            JsonNode rohFunde = r.path("funde");
            if ("abgelehnt".equals(zustand) && (dauerMs != 0 || !rohFunde.isArray() || !rohFunde.isEmpty())) {
                throw new Verworfen("abgelehnt hat nicht gesucht");
            }
            List<String> erkenner = new ArrayList<>();
            if (!r.path("erkenner").isArray()) {
                throw new Verworfen("erkenner");
            }
            for (JsonNode e : r.path("erkenner")) {
                if (!e.isTextual()) {
                    throw new Verworfen("erkenner");
                }
                if (GeraetesucheVertrag.ERKENNER.contains(e.asText()) && !erkenner.contains(e.asText())) {
                    erkenner.add(e.asText());
                }
            }
            List<Netz> netze = netze(r.path("netze"));
            List<Fund> funde = new ArrayList<>();
            int ueberlesen = funde(rohFunde, netze, funde);
            return new Ergebnis(uuid(r, "tenant_id"), uuid(r, "site_id"), uuid(r, "device_id"), uuid(r, "such_id"),
                    zeit(r.path("ts")), zustand, grund, dauerMs, List.copyOf(erkenner), netze, List.copyOf(funde),
                    weitere(r.path("weitere")), ueberlesen);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static JsonNode huelle(String topic, String blatt, byte[] payload, ObjectMapper mapper) {
        String[] p = topic == null ? new String[0] : topic.split("/", -1);
        if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4]) || !blatt.equals(p[5])) {
            throw new Verworfen("topic");
        }
        JsonNode r;
        try {
            r = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload);
        } catch (Exception e) {
            throw new Verworfen("kein JSON");
        }
        if (r == null || !r.isObject() || !GeraetesucheVertrag.SCHEMA_VERSION.equals(r.path("schema_version").asText())
                || !r.path("schema_version").isTextual()
                || !p[1].equals(r.path("tenant_id").asText()) || !p[2].equals(r.path("site_id").asText())
                || !p[3].equals(r.path("device_id").asText())) {
            throw new Verworfen("hülle");
        }
        return r;
    }

    private static List<Netz> netze(JsonNode liste) {
        if (!liste.isArray() || liste.size() > GeraetesucheVertrag.MAX_NETZE) {
            throw new Verworfen("netze");
        }
        List<Netz> netze = new ArrayList<>();
        Set<String> rollen = new HashSet<>();
        for (JsonNode n : liste) {
            String rolle = wort(n.path("rolle"), GeraetesucheVertrag.ROLLEN);
            if (!rollen.add(rolle) || !n.path("erreichbar").isBoolean()) {
                throw new Verworfen("netz");
            }
            String netz = n.path("netz").asText(null);
            String box = n.path("box_adresse").asText(null);
            if (!n.path("netz").isTextual() || !n.path("box_adresse").isTextual()
                    || Suchbereich.pruefe(netz, box).grund() != null) {
                throw new Verworfen("netz " + netz);
            }
            JsonNode a = n.path("ausschnitt");
            if (!a.isMissingNode() && !a.isNull() && !a.isBoolean()) {
                throw new Verworfen("ausschnitt");
            }
            netze.add(new Netz(rolle, netz, box, a.isBoolean() ? a.asBoolean() : null, n.path("erreichbar").asBoolean(),
                    ganz(n.path("aktiv"), 0, 254)));
        }
        return List.copyOf(netze);
    }

    private static int funde(JsonNode liste, List<Netz> netze, List<Fund> out) {
        if (!liste.isArray() || liste.size() > GeraetesucheVertrag.MAX_FUNDE) {
            throw new Verworfen("funde");
        }
        List<Suchbereich.Bereich> bereiche = netze.stream()
                .map(n -> Suchbereich.pruefe(n.netz(), n.boxAdresse()).bereich()).toList();
        Set<String> schluessel = new HashSet<>();
        int ueberlesen = 0;
        for (JsonNode j : liste) {
            Fund f = fund(j, bereiche);
            if (f == null || !schluessel.add(f.schluessel())) {
                ueberlesen++;
            } else {
                out.add(f);
            }
        }
        return ueberlesen;
    }

    /** Ein Fund nach den Regeln des Vertrags, sonst null (überlesen). */
    static Fund fund(JsonNode j, List<Suchbereich.Bereich> bereiche) {
        try {
            String schluessel = muster(j.path("schluessel"), SCHLUESSEL, true);
            String erkenner = text(j.path("erkenner"));
            String art = text(j.path("art"));
            GeraetesucheVertrag.KatalogZeile zeile = GeraetesucheVertrag.paar(erkenner, art)
                    .orElseThrow(() -> new Verworfen("paar"));
            String erkennung = wort(j.path("erkennung"), GeraetesucheVertrag.ERKENNUNGEN);
            String anbindung = wort(j.path("anbindung"), GeraetesucheVertrag.ANBINDUNGEN);
            String hindernis = j.path("hindernis").isMissingNode() || j.path("hindernis").isNull() ? null
                    : wort(j.path("hindernis"), GeraetesucheVertrag.HINDERNISSE);
            String seriennummer = muster(j.path("seriennummer"), SERIENNUMMER, false);
            String firmware = muster(j.path("firmware"), TEXT64, false);
            String familie = muster(j.path("familie"), FAMILIE, false);
            String spannung = j.path("spannung").isMissingNode() || j.path("spannung").isNull() ? null
                    : wort(j.path("spannung"), List.of("hv", "lv"));
            Integer kanaele = j.path("kanaele").isMissingNode() || j.path("kanaele").isNull() ? null
                    : ganz(j.path("kanaele"), 1, 16);
            if (!j.path("merkmale").isArray() || j.path("merkmale").isEmpty()
                    || j.path("merkmale").size() > GeraetesucheVertrag.MAX_MERKMALE
                    || !j.path("liest_box_schon").isBoolean()) {
                return null;
            }
            List<String> merkmale = new ArrayList<>();
            for (JsonNode m : j.path("merkmale")) {
                merkmale.add(muster(m, MERKMAL, true));
            }
            boolean netztechnik = GeraetesucheVertrag.NETZTECHNIK_ARTEN.contains(art);
            if ("unbekannt".equals(erkennung) != GeraetesucheVertrag.SELBST_BESCHREIBEN.equals(anbindung)
                    || netztechnik != GeraetesucheVertrag.NUR_ANZEIGE.equals(anbindung)
                    || netztechnik && (seriennummer != null || firmware != null || familie != null || spannung != null
                            || kanaele != null || hindernis != null)) {
                return null;
            }
            Verbindung v = verbindung(j.path("verbindung"), zeile, anbindung, bereiche);
            return v == null ? null : new Fund(schluessel, erkenner, art,
                    muster(j.path("hersteller"), HERSTELLER, false), muster(j.path("modell"), TEXT64, false),
                    seriennummer, firmware, familie, spannung, kanaele, erkennung, List.copyOf(merkmale), anbindung,
                    hindernis, v, j.path("liest_box_schon").asBoolean());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Verbindung verbindung(JsonNode v, GeraetesucheVertrag.KatalogZeile zeile, String anbindung,
            List<Suchbereich.Bereich> bereiche) {
        if (!v.isObject() || !v.path("ip").isTextual() || Suchbereich.ziel(v.path("ip").asText(), bereiche) != null) {
            return null;
        }
        String communication = v.path("communication").isMissingNode() || v.path("communication").isNull() ? null
                : wort(v.path("communication"), GeraetesucheVertrag.COMMUNICATIONS);
        boolean braucht = GeraetesucheVertrag.UEBERNEHMEN.equals(anbindung)
                || GeraetesucheVertrag.SELBST_BESCHREIBEN.equals(anbindung);
        if (communication == null ? braucht : !communication.equals(zeile.communication())) {
            return null;
        }
        JsonNode s = v.path("serial");
        Long serial = null;
        if (!s.isMissingNode() && !s.isNull()) {
            if (!s.isIntegralNumber() || !s.canConvertToLong() || s.asLong() < 0 || s.asLong() > 4_294_967_295L) {
                return null;
            }
            serial = s.asLong();
        }
        if ("solarman_v5".equals(communication) && serial == null) {
            return null;
        }
        JsonNode u = v.path("unit_id");
        Integer unitId = u.isMissingNode() || u.isNull() ? null : ganz(u, 0, 255);
        return new Verbindung(communication, v.path("ip").asText(), ganz(v.path("port"), 1, 65535), serial, unitId);
    }

    private static Weitere weitere(JsonNode w) {
        if (!w.isObject()) {
            throw new Verworfen("weitere");
        }
        return new Weitere(zahl(w.path("telefon_tablet")), zahl(w.path("rechner")), zahl(w.path("unbekannt")));
    }

    private static Integer zahl(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? null : ganz(n, 0, 512);
    }

    private static int ganz(JsonNode n, int min, int max) {
        if (!n.isIntegralNumber() || !n.canConvertToInt() || n.asInt() < min || n.asInt() > max) {
            throw new Verworfen("zahl " + n);
        }
        return n.asInt();
    }

    private static String wort(JsonNode n, List<String> vokabular) {
        if (!n.isTextual() || !vokabular.contains(n.asText())) {
            throw new Verworfen("wort " + n);
        }
        return n.asText();
    }

    private static String text(JsonNode n) {
        if (!n.isTextual()) {
            throw new Verworfen("text");
        }
        return n.asText();
    }

    /** Ein Text nach Muster; fehlt er und ist er nicht Pflicht, null. */
    private static String muster(JsonNode n, Pattern muster, boolean pflicht) {
        if (!pflicht && (n.isMissingNode() || n.isNull())) {
            return null;
        }
        if (!n.isTextual() || !muster.matcher(n.asText()).matches()) {
            throw new Verworfen("muster " + n);
        }
        return n.asText();
    }

    private static UUID uuid(JsonNode r, String feld) {
        String s = r.path(feld).asText("");
        if (!r.path(feld).isTextual() || !UUID_MUSTER.matcher(s).matches()) {
            throw new Verworfen(feld);
        }
        return UUID.fromString(s);
    }

    private static Instant zeit(JsonNode n) {
        if (!n.isTextual()) {
            throw new Verworfen("zeit");
        }
        return OffsetDateTime.parse(n.asText()).toInstant();
    }
}
