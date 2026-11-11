package com.voltpilot.api.werkstatt;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Akteur;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Was der Werkstatt-Dienst gerade tut (Ansicht {@value #SCHEMA},
 * {@code docs/contracts/werkstatt-ansicht-v1.md}), für die
 * Werkstatt-Bildschirme (WI-8 A). Der Dienst meldet sie jeden Takt; die API
 * prüft nur die Form, hält die letzte und je Lauf seinen letzten Stand. Sie ist
 * Anzeige, kein Beweis: Belege stehen an der Abnahme.
 */
@Service
public class DienstAnsichtService {

    public static final String SCHEMA = "vp-werkstatt-ansicht.v1";
    public static final int MAX_BYTES = 64 * 1024;
    /** Älter als das: die Bildschirme nennen die Ansicht veraltet. */
    public static final Duration AKTUELL = Duration.ofSeconds(60);

    private static final Pattern KENNUNG = Pattern.compile("^[A-Za-z0-9._:-]{1,80}$");
    private static final Set<String> ZUSTAENDE = Set.of("laeuft", "wartet", "fertig", "angehalten");
    /** Kein Schlüsselmaterial in einer Ansicht: ein Fehler des Dienstes soll nicht im Portal landen. */
    private static final List<String> VERBOTEN = List.of("PRIVATE KEY", "AGE ENCRYPTED FILE", "AGE-SECRET-KEY");

    /** Die gemeldete Ansicht mit ihrem Alter. */
    public record Gemeldet(JsonNode ansicht, Instant dienstZeit, Instant gemeldetAm, String gemeldetVon) {
    }

    /** Der letzte Stand eines Laufs. */
    public record Lauf(String kennung, String freigabe, String boxArt, String zustand, String schritt, String titel,
            String grund, Instant beginn, Instant ende, JsonNode stand, Instant aktualisiertAm) {
    }

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private Clock uhr = Clock.systemUTC();

    public DienstAnsichtService(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate, ObjectMapper json) {
        this.jdbc = adminJdbcTemplate;
        this.json = json;
    }

    void setzeUhr(Clock uhr) {
        this.uhr = uhr;
    }

    public Instant jetzt() {
        return uhr.instant();
    }

    /** Prüft die Form; wirft 422 mit Grund. Gibt die gelesene Ansicht zurück. */
    public JsonNode pruefe(String roh) {
        if (roh == null || roh.isBlank()) {
            throw fehler("keine Ansicht");
        }
        if (roh.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            throw fehler("die Ansicht ist größer als " + MAX_BYTES + " Byte");
        }
        for (String v : VERBOTEN) {
            if (roh.contains(v)) {
                throw fehler("die Ansicht enthält Schlüsselmaterial");
            }
        }
        JsonNode a;
        try {
            a = json.readTree(roh);
        } catch (JsonProcessingException e) {
            throw fehler("die Ansicht ist kein JSON");
        }
        if (a == null || !a.isObject()) {
            throw fehler("die Ansicht ist kein Objekt");
        }
        if (!SCHEMA.equals(a.path("schema").asText())) {
            throw fehler("schema muss " + SCHEMA + " sein");
        }
        zeit(a.path("zeit"), "zeit");
        if (!a.path("werkbank").isObject() || !a.path("freigabe").isObject()) {
            throw fehler("werkbank und freigabe sind Pflicht");
        }
        JsonNode l = a.path("lauf");
        if (!l.isMissingNode() && !l.isNull()) {
            if (!l.isObject() || !KENNUNG.matcher(l.path("kennung").asText()).matches()) {
                throw fehler("lauf.kennung fehlt oder hat nicht die Form");
            }
            if (!ZUSTAENDE.contains(l.path("zustand").asText())) {
                throw fehler("lauf.zustand: laeuft, wartet, fertig oder angehalten");
            }
            zeit(l.path("beginn"), "lauf.beginn");
            if (l.hasNonNull("ende") && !l.path("ende").asText().startsWith("0001-")) {
                zeit(l.path("ende"), "lauf.ende");
            }
        }
        return a;
    }

    /** Hält die Ansicht fest und den Stand ihres Laufs. */
    public void melden(String roh, Akteur dienst) {
        JsonNode a = pruefe(roh);
        Instant dienstZeit = zeit(a.path("zeit"), "zeit");
        String text = a.toString();
        jdbc.update("INSERT INTO werkstatt_dienst_ansicht (id, ansicht, dienst_zeit, gemeldet_am, gemeldet_von) "
                        + "VALUES (1, ?::jsonb, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ansicht = EXCLUDED.ansicht, "
                        + "dienst_zeit = EXCLUDED.dienst_zeit, gemeldet_am = EXCLUDED.gemeldet_am, "
                        + "gemeldet_von = EXCLUDED.gemeldet_von",
                text, Timestamp.from(dienstZeit), Timestamp.from(jetzt()), dienst.sub());
        JsonNode l = a.path("lauf");
        if (l.isObject()) {
            Instant ende = l.hasNonNull("ende") && !l.path("ende").asText().startsWith("0001-")
                    ? zeit(l.path("ende"), "lauf.ende") : null;
            jdbc.update("INSERT INTO werkstatt_lauf (kennung, freigabe, box_art, zustand, schritt, titel, grund, beginn, "
                            + "ende, stand, aktualisiert_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?) "
                            + "ON CONFLICT (kennung) DO UPDATE SET freigabe = EXCLUDED.freigabe, box_art = EXCLUDED.box_art, "
                            + "zustand = EXCLUDED.zustand, schritt = EXCLUDED.schritt, titel = EXCLUDED.titel, "
                            + "grund = EXCLUDED.grund, ende = EXCLUDED.ende, stand = EXCLUDED.stand, "
                            + "aktualisiert_am = EXCLUDED.aktualisiert_am",
                    l.path("kennung").asText(), text(l, "freigabe"), text(l, "box_art"), l.path("zustand").asText(),
                    text(l, "schritt"), text(l, "titel"), text(l, "grund"),
                    Timestamp.from(zeit(l.path("beginn"), "lauf.beginn")), ende == null ? null : Timestamp.from(ende),
                    l.toString(), Timestamp.from(jetzt()));
        }
    }

    public Optional<Gemeldet> gemeldet() {
        return jdbc.query("SELECT ansicht::text AS ansicht, dienst_zeit, gemeldet_am, gemeldet_von "
                + "FROM werkstatt_dienst_ansicht WHERE id = 1", (rs, n) -> new Gemeldet(lies(rs.getString("ansicht")),
                rs.getTimestamp("dienst_zeit").toInstant(), rs.getTimestamp("gemeldet_am").toInstant(),
                rs.getString("gemeldet_von"))).stream().findFirst();
    }

    /** Die letzten Läufe, neueste zuerst. */
    public List<Lauf> laeufe(int limit) {
        return jdbc.query("SELECT kennung, freigabe, box_art, zustand, schritt, titel, grund, beginn, ende, "
                        + "stand::text AS stand, aktualisiert_am FROM werkstatt_lauf ORDER BY beginn DESC LIMIT ?",
                (rs, n) -> new Lauf(rs.getString("kennung"), rs.getString("freigabe"), rs.getString("box_art"),
                        rs.getString("zustand"), rs.getString("schritt"), rs.getString("titel"), rs.getString("grund"),
                        rs.getTimestamp("beginn").toInstant(),
                        rs.getTimestamp("ende") == null ? null : rs.getTimestamp("ende").toInstant(),
                        lies(rs.getString("stand")), rs.getTimestamp("aktualisiert_am").toInstant()),
                Math.max(1, Math.min(limit, 200)));
    }

    /** Der letzte Stand eines Laufs. */
    public Optional<Lauf> lauf(String kennung) {
        return jdbc.query("SELECT kennung, freigabe, box_art, zustand, schritt, titel, grund, beginn, ende, "
                        + "stand::text AS stand, aktualisiert_am FROM werkstatt_lauf WHERE kennung = ?",
                (rs, n) -> new Lauf(rs.getString("kennung"), rs.getString("freigabe"), rs.getString("box_art"),
                        rs.getString("zustand"), rs.getString("schritt"), rs.getString("titel"), rs.getString("grund"),
                        rs.getTimestamp("beginn").toInstant(),
                        rs.getTimestamp("ende") == null ? null : rs.getTimestamp("ende").toInstant(),
                        lies(rs.getString("stand")), rs.getTimestamp("aktualisiert_am").toInstant()),
                kennung).stream().findFirst();
    }

    private JsonNode lies(String text) {
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            return json.createObjectNode();
        }
    }

    private static String text(JsonNode n, String feld) {
        String s = n.path(feld).asText(null);
        return s == null || s.isBlank() ? null : (s.length() > 2000 ? s.substring(0, 2000) : s);
    }

    private static Instant zeit(JsonNode n, String feld) {
        try {
            return Instant.parse(n.asText());
        } catch (DateTimeParseException e) {
            throw fehler(feld + " ist keine Zeit (RFC 3339)");
        }
    }

    private static ResponseStatusException fehler(String grund) {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT, "Ansicht ungültig: " + grund + ".");
    }
}
