package com.voltpilot.api.werkstatt;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.fernwartung.Akteur;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Lauf-Seite der Werkstatt (Konzept vp-werkstatt-lauf-seite, entschieden
 * 05.11.2026): „Nochmal versuchen“ als Auftrag an den Werkstatt-Dienst (E1 A)
 * und die Liste „Zur Seite gelegt“ (E2 A).
 *
 * <p>Ein Auftrag geht nicht zum Dienst, der Dienst holt ihn mit seiner Meldung
 * der Ansicht ab. Angenommen wird er nur, wenn die zuletzt gemeldete Ansicht
 * aktuell ist, genau diesen Lauf zeigt und der Dienst ihn als
 * {@code nochmal_moeglich} meldet: das entscheidet der Dienst nach dem Fall
 * (nie bei einem Handgriff an der Box). Ein älterer Dienst meldet das Feld
 * nicht, dann gibt es kein „Nochmal“. Gelöscht wird nichts, an keiner Box.
 *
 * <p>Jeder Schreibweg ist eine Anweisung (Abholen: {@code UPDATE … RETURNING},
 * Zur Seite: {@code ON CONFLICT DO NOTHING}). Zwei gleichzeitige „Nochmal“ für
 * denselben Lauf ergäben zwei Aufträge; der Dienst nimmt nur den ersten an
 * ({@code nochmal_seit}), der zweite tut nichts.
 */
@Service
public class LaufSeiteService {

    /** So lange wartet ein Auftrag auf die Abholung; danach gilt er als verfallen. */
    public static final Duration AUFTRAG_FRIST = Duration.ofMinutes(10);
    public static final String NOCHMAL = "nochmal";
    /** „Erneut erstellen“ der Box-Druckdatei (Gehäuse, P10): {@code lauf} trägt hier die Edge-Referenz. */
    public static final String GEHAEUSE = "gehaeuse";

    private static final Pattern KENNUNG = Pattern.compile("^[A-Za-z0-9._:-]{1,80}$");

    /** Ein Auftrag an den Dienst, wie er ihn abholt. */
    public record Auftrag(UUID id, String art, String lauf, Instant erteiltAm) {
    }

    /** Eine zur Seite gelegte Box. */
    public record ZurSeite(UUID id, String lauf, String box, String fall, String loesungTitel, String schritt,
            String grund, Instant gelegtAm, String gelegtVon) {
    }

    /** {@code neu}: diesmal angelegt (201), sonst schon da (200). */
    public record Angelegt<T>(T wert, boolean neu) {
    }

    private final JdbcTemplate jdbc;
    private final DienstAnsichtService ansichten;

    public LaufSeiteService(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate,
            DienstAnsichtService ansichten) {
        this.jdbc = adminJdbcTemplate;
        this.ansichten = ansichten;
    }

    /** „Nochmal versuchen“ für den angehaltenen Lauf {@code lauf}: 201 neu, 200 schon offen; 409/422 mit Grund. */
    public Angelegt<Auftrag> nochmal(String lauf, Akteur von) {
        pruefeKennung(lauf);
        DienstAnsichtService.Gemeldet g = ansichten.gemeldet().orElseThrow(() -> konflikt(
                "Der Werkstatt-Dienst hat sich noch nicht gemeldet."));
        if (Duration.between(g.gemeldetAm(), ansichten.jetzt()).compareTo(DienstAnsichtService.AKTUELL) > 0) {
            throw konflikt("Der Werkstatt-Dienst meldet sich nicht; ein Auftrag käme nicht an.");
        }
        JsonNode l = g.ansicht().path("lauf");
        if (!lauf.equals(l.path("kennung").asText())) {
            throw konflikt("Dieser Lauf ist nicht mehr der letzte des Dienstes; an der Werkbank steht schon etwas anderes.");
        }
        if (!"angehalten".equals(l.path("zustand").asText()) || !l.path("nochmal_moeglich").asBoolean(false)) {
            throw konflikt("Für diesen Lauf gibt es kein „Nochmal versuchen“ aus dem Portal: Er braucht einen Handgriff "
                    + "an der Box, geht zur Seite, oder der Dienst kennt den Auftrag noch nicht.");
        }
        if (l.hasNonNull("nochmal_seit")) {
            throw konflikt("Der Dienst versucht diesen Lauf schon noch einmal.");
        }
        Instant jetzt = ansichten.jetzt();
        Optional<Auftrag> offen = jdbc.query("SELECT id, art, lauf, erteilt_am FROM werkstatt_auftrag "
                        + "WHERE lauf = ? AND art = ? AND abgeholt_am IS NULL AND erteilt_am > ? ORDER BY erteilt_am DESC LIMIT 1",
                (rs, n) -> new Auftrag(rs.getObject("id", UUID.class), rs.getString("art"), rs.getString("lauf"),
                        rs.getTimestamp("erteilt_am").toInstant()),
                lauf, NOCHMAL, Timestamp.from(jetzt.minus(AUFTRAG_FRIST))).stream().findFirst();
        if (offen.isPresent()) {
            return new Angelegt<>(offen.get(), false);
        }
        Auftrag a = new Auftrag(UUID.randomUUID(), NOCHMAL, lauf, jetzt);
        jdbc.update("INSERT INTO werkstatt_auftrag (id, art, lauf, erteilt_am, erteilt_von) VALUES (?, ?, ?, ?, ?)",
                a.id(), a.art(), a.lauf(), Timestamp.from(jetzt), von.sub());
        return new Angelegt<>(a, true);
    }

    /**
     * „Erneut erstellen“ für die Box-Druckdatei dieser Referenz (Gehäuse, P10): ein Auftrag an den
     * Werkstatt-Dienst, ihren Bau noch einmal einzureihen - auch einen schon fertigen (Nachdruck,
     * nach einem behobenen Fehler). 201 neu, 200 schon offen. Anders als „nochmal“ braucht es keinen
     * angehaltenen Lauf: ein Gehäuse-Auftrag scheitert unabhängig vom Werkstatt-Lauf der Box, und der
     * Dienst reiht eine nie bestellte Box ohnehin selbst ein (Abgleich); das hier ist nur der
     * Handgriff für einen echten Fehler, den der automatische Abgleich bewusst nicht wiederholt.
     */
    public Angelegt<Auftrag> gehaeuseErneut(String edgeRef, Akteur von) {
        pruefeKennung(edgeRef);
        Instant jetzt = ansichten.jetzt();
        Optional<Auftrag> offen = jdbc.query("SELECT id, art, lauf, erteilt_am FROM werkstatt_auftrag "
                        + "WHERE lauf = ? AND art = ? AND abgeholt_am IS NULL AND erteilt_am > ? ORDER BY erteilt_am DESC LIMIT 1",
                (rs, n) -> new Auftrag(rs.getObject("id", UUID.class), rs.getString("art"), rs.getString("lauf"),
                        rs.getTimestamp("erteilt_am").toInstant()),
                edgeRef, GEHAEUSE, Timestamp.from(jetzt.minus(AUFTRAG_FRIST))).stream().findFirst();
        if (offen.isPresent()) {
            return new Angelegt<>(offen.get(), false);
        }
        Auftrag a = new Auftrag(UUID.randomUUID(), GEHAEUSE, edgeRef, jetzt);
        jdbc.update("INSERT INTO werkstatt_auftrag (id, art, lauf, erteilt_am, erteilt_von) VALUES (?, ?, ?, ?, ?)",
                a.id(), a.art(), a.lauf(), Timestamp.from(jetzt), von.sub());
        return new Angelegt<>(a, true);
    }

    /** Der Dienst holt die offenen Aufträge ab (jeder genau einmal); verfallene bleiben liegen. */
    public List<Auftrag> abholen() {
        Instant jetzt = ansichten.jetzt();
        return jdbc.query("UPDATE werkstatt_auftrag SET abgeholt_am = ? WHERE abgeholt_am IS NULL AND erteilt_am > ? "
                        + "RETURNING id, art, lauf, erteilt_am",
                (rs, n) -> new Auftrag(rs.getObject("id", UUID.class), rs.getString("art"), rs.getString("lauf"),
                        rs.getTimestamp("erteilt_am").toInstant()),
                Timestamp.from(jetzt), Timestamp.from(jetzt.minus(AUFTRAG_FRIST)));
    }

    /** Eine angehaltene Box zur Seite legen: 201 neu, 200 schon zur Seite; 404 Lauf unbekannt, 409 nicht angehalten. */
    public Angelegt<ZurSeite> zurSeiteLegen(String lauf, Akteur von) {
        pruefeKennung(lauf);
        Optional<ZurSeite> schon = zurSeite(lauf);
        if (schon.isPresent()) {
            return new Angelegt<>(schon.get(), false);
        }
        DienstAnsichtService.Lauf l = ansichten.lauf(lauf).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Diesen Lauf kennt die Werkstatt nicht."));
        if (!"angehalten".equals(l.zustand())) {
            throw konflikt("Nur ein angehaltener Lauf kommt zur Seite; dieser ist " + l.zustand() + ".");
        }
        JsonNode s = l.stand();
        ZurSeite z = new ZurSeite(UUID.randomUUID(), lauf, text(s, "box"), text(s, "fall"),
                text(s.path("loesung"), "titel"), l.schritt(), l.grund(), ansichten.jetzt(), von.sub());
        int n = jdbc.update("INSERT INTO werkstatt_zur_seite (id, lauf, box, fall, loesung_titel, schritt, grund, gelegt_am, "
                        + "gelegt_von) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (lauf) DO NOTHING",
                z.id(), z.lauf(), z.box(), z.fall(), z.loesungTitel(), z.schritt(), z.grund(), Timestamp.from(z.gelegtAm()),
                z.gelegtVon());
        return n == 1 ? new Angelegt<>(z, true) : new Angelegt<>(zurSeite(lauf).orElseThrow(), false);
    }

    /** Die zur Seite gelegten Boxen, neueste zuerst. */
    public List<ZurSeite> zurSeite(int limit) {
        return jdbc.query("SELECT id, lauf, box, fall, loesung_titel, schritt, grund, gelegt_am, gelegt_von "
                + "FROM werkstatt_zur_seite ORDER BY gelegt_am DESC LIMIT ?", this::zeile, Math.max(1, Math.min(limit, 200)));
    }

    private Optional<ZurSeite> zurSeite(String lauf) {
        return jdbc.query("SELECT id, lauf, box, fall, loesung_titel, schritt, grund, gelegt_am, gelegt_von "
                + "FROM werkstatt_zur_seite WHERE lauf = ?", this::zeile, lauf).stream().findFirst();
    }

    private ZurSeite zeile(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new ZurSeite(rs.getObject("id", UUID.class), rs.getString("lauf"), rs.getString("box"),
                rs.getString("fall"), rs.getString("loesung_titel"), rs.getString("schritt"), rs.getString("grund"),
                rs.getTimestamp("gelegt_am").toInstant(), rs.getString("gelegt_von"));
    }

    private static String text(JsonNode n, String feld) {
        String s = n.path(feld).asText(null);
        return s == null || s.isBlank() ? null : (s.length() > 2000 ? s.substring(0, 2000) : s);
    }

    private static void pruefeKennung(String kennung) {
        if (kennung == null || !KENNUNG.matcher(kennung).matches()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT, "Kennung fehlt oder hat nicht die Form (lauf oder edgeRef).");
        }
    }

    private static ResponseStatusException konflikt(String grund) {
        return new ResponseStatusException(HttpStatus.CONFLICT, grund);
    }
}
