package com.voltpilot.api.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.AnfrageKennungen;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Optional;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die Anfrage-Kennung ({@code Idempotency-Key}) der Plattform-Verwaltung (Befund
 * vp-kundenakte-fremde-personen, Punkt 5): dieselbe Mechanik wie {@link AnfrageKennungen}, aber je
 * BETREIBER-KONTO ({@code akteur_sub}) statt je Kundenbereich - beim Anlegen eines Kunden gibt es noch
 * keinen TenantContext. Tabelle {@code admin_anfrage_kennung} (V20261111150000), gelesen und
 * geschrieben nur über die BYPASSRLS-Rolle; Form, 24-h-Frist und die 422 bei anderem Fingerabdruck
 * sind dieselben wie beim Kunden.
 *
 * <p>Gleichzeitige Anfragen mit derselben Kennung reiht ein Advisory-Lock auf EINER Verbindung
 * hintereinander: die gemerkte Antwort wird VOR dem Lösen des Locks committet (autocommit), wer
 * danach kommt, findet sie. Gemerkt wird nur der Erfolg, wie beim Kunden.
 */
@Component
public class AdminAnfrageKennungen {

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public AdminAnfrageKennungen(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate,
            ObjectMapper json) {
        this.jdbc = adminJdbcTemplate;
        this.json = json;
    }

    /**
     * Führt {@code anlegen} genau einmal je (Konto, Route, Kennung) aus: die erste Anfrage legt an und
     * merkt Status und Körper, jede weitere mit derselben Kennung bekommt dieselbe Antwort zurück
     * (Kopf {@code Idempotent-Replayed}), dieselbe Kennung mit einer ANDEREN Anfrage die 422 des
     * Kunden-Mechanismus.
     */
    public ResponseEntity<String> einmal(String akteurSub, String route, String kennung,
            String fingerabdruck, HttpStatus status, Supplier<Object> anlegen) {
        return jdbc.execute((java.sql.Connection con) -> {
            try (PreparedStatement lock = con.prepareStatement(
                    "SELECT pg_advisory_lock(hashtextextended(?, 0))")) {
                lock.setString(1, akteurSub + "|" + route + "|" + kennung);
                lock.execute();
            }
            try {
                Optional<AnfrageKennungen.Gemerkt> gemerkt = gemerkt(con, akteurSub, route, kennung,
                        fingerabdruck);
                if (gemerkt.isPresent()) {
                    return AnfrageKennungen.antwort(gemerkt.get());
                }
                String antwort = alsJson(anlegen.get());
                merken(con, akteurSub, route, kennung, fingerabdruck, status, antwort);
                return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).body(antwort);
            } catch (java.sql.SQLException e) {
                throw new org.springframework.jdbc.UncategorizedSQLException("admin_anfrage_kennung", null, e);
            } finally {
                try (PreparedStatement unlock = con.prepareStatement(
                        "SELECT pg_advisory_unlock(hashtextextended(?, 0))")) {
                    unlock.setString(1, akteurSub + "|" + route + "|" + kennung);
                    unlock.execute();
                }
            }
        });
    }

    private static Optional<AnfrageKennungen.Gemerkt> gemerkt(java.sql.Connection con, String sub,
            String route, String kennung, String fingerabdruck) throws java.sql.SQLException {
        try (PreparedStatement st = con.prepareStatement("""
                SELECT fingerabdruck, status, antwort FROM admin_anfrage_kennung
                 WHERE akteur_sub = ? AND route = ? AND kennung = ?
                   AND angelegt_am > now() - interval '24 hours'""")) {
            st.setString(1, sub);
            st.setString(2, route);
            st.setString(3, kennung);
            try (ResultSet rs = st.executeQuery()) {
                if (!rs.next()) {
                    return Optional.empty();
                }
                if (!fingerabdruck.equals(rs.getString("fingerabdruck"))) {
                    throw AnfrageKennungen.andereAnfrage();
                }
                return Optional.of(new AnfrageKennungen.Gemerkt(rs.getInt("status"), rs.getString("antwort")));
            }
        }
    }

    private static void merken(java.sql.Connection con, String sub, String route, String kennung,
            String fingerabdruck, HttpStatus status, String antwort) throws java.sql.SQLException {
        try (PreparedStatement weg = con.prepareStatement(
                "DELETE FROM admin_anfrage_kennung WHERE akteur_sub = ? AND angelegt_am <= now() - interval '24 hours'")) {
            weg.setString(1, sub);
            weg.executeUpdate();
        }
        try (PreparedStatement st = con.prepareStatement("""
                INSERT INTO admin_anfrage_kennung (akteur_sub, route, kennung, fingerabdruck, status, antwort)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (akteur_sub, route, kennung) DO UPDATE
                   SET fingerabdruck = EXCLUDED.fingerabdruck, status = EXCLUDED.status,
                       antwort = EXCLUDED.antwort, angelegt_am = now()""")) {
            st.setString(1, sub);
            st.setString(2, route);
            st.setString(3, kennung);
            st.setString(4, fingerabdruck);
            st.setInt(5, status.value());
            st.setString(6, antwort);
            st.executeUpdate();
        }
    }

    private String alsJson(Object antwort) {
        try {
            return json.writeValueAsString(antwort);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Antwort merken", e);
        }
    }
}
