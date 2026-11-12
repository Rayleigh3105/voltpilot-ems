package com.voltpilot.api.kundenbereich;

import com.voltpilot.api.uems.ProtokollAkteur;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Die Läufe des Löschwegs ({@code kundenbereich_loeschlauf}, V20261112152000): je Kundenbereich
 * höchstens EIN laufender Zug (Teil-Index), der Stand überlebt den Kundenbereich (kein
 * Fremdschlüssel). Geschrieben über die Admin-Verbindung; die App-Rolle sieht die Tabelle nicht.
 *
 * <p>{@code fertig} schreibt der Zug über {@link #fertigImZug} IN der Abbau-Transaktion - fertig
 * heißt committed. Alles andere (Start, Herzschlag, gescheitert, Bericht) läuft auf eigenen
 * Verbindungen mit Autocommit.
 */
@Repository
public class KundenbereichLoeschlaufRepository {

    /** Eine Zeile des Löschlaufs; {@code berichtJson} ist das rohe JSON des Abschlussberichts. */
    public record Lauf(UUID id, UUID kundenbereich, String name, String stand, Instant gestartetAm,
            Instant herzschlagAm, Instant beendetAm, String fehler, String berichtJson) {

        public boolean laeuft() {
            return "laeuft".equals(stand);
        }
    }

    private static final String SPALTEN = "id, kundenbereich, name, stand, gestartet_am,"
            + " herzschlag_am, beendet_am, fehler, bericht::text AS bericht";

    private static final RowMapper<Lauf> ZEILE = (rs, i) -> new Lauf(
            rs.getObject("id", UUID.class),
            rs.getObject("kundenbereich", UUID.class),
            rs.getString("name"),
            rs.getString("stand"),
            instant(rs.getObject("gestartet_am", OffsetDateTime.class)),
            instant(rs.getObject("herzschlag_am", OffsetDateTime.class)),
            instant(rs.getObject("beendet_am", OffsetDateTime.class)),
            rs.getString("fehler"),
            rs.getString("bericht"));

    private static Instant instant(OffsetDateTime t) {
        return t == null ? null : t.toInstant();
    }

    private final JdbcTemplate jdbc;

    public KundenbereichLoeschlaufRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /**
     * Legt den Lauf an - oder liefert {@code empty}, wenn für den Bereich schon einer läuft
     * (Teil-Index; ein Doppelklick bekommt über {@link #juengster} denselben Lauf zurück).
     */
    public Optional<Lauf> starte(UUID kundenbereich, String name, ProtokollAkteur akteur) {
        List<Lauf> angelegt = jdbc.query(
                "INSERT INTO kundenbereich_loeschlauf (kundenbereich, name, gestartet_von_sub, gestartet_von_name)"
                        + " VALUES (?, ?, ?, ?)"
                        + " ON CONFLICT (kundenbereich) WHERE stand = 'laeuft' DO NOTHING"
                        + " RETURNING " + SPALTEN,
                ZEILE, kundenbereich, name, akteur.sub(), akteur.name());
        return angelegt.stream().findFirst();
    }

    /** Der jüngste Lauf des Bereichs, gleich welchen Stands. */
    public Optional<Lauf> juengster(UUID kundenbereich) {
        return jdbc.query("SELECT " + SPALTEN + " FROM kundenbereich_loeschlauf"
                        + " WHERE kundenbereich = ? ORDER BY gestartet_am DESC, id LIMIT 1",
                ZEILE, kundenbereich).stream().findFirst();
    }

    /** Der Herzschlag des laufenden Zugs (alle 30 s, solange er arbeitet). */
    public void herzschlag(UUID id) {
        jdbc.update("UPDATE kundenbereich_loeschlauf SET herzschlag_am = now()"
                + " WHERE id = ? AND stand = 'laeuft'", id);
    }

    /** Der Zug ist gescheitert und zurückgerollt; {@code fehler} ist der ehrliche Satz fürs Portal. */
    public void gescheitert(UUID id, String fehler) {
        jdbc.update("UPDATE kundenbereich_loeschlauf SET stand = 'gescheitert', beendet_am = now(),"
                + " fehler = ? WHERE id = ?", fehler, id);
    }

    /**
     * Schreibt {@code fertig} auf der VERBINDUNG DER ABBAU-TRANSAKTION (Abbauwache, nach dem
     * Löschnachweis): committet der Abbau, ist der Lauf fertig - rollt er zurück, bleibt „laeuft".
     * Bewusst ohne Stand-Filter: hat der Auflöser den Lauf wegen eines verhungerten Herzschlags
     * schon als „gescheitert" markiert, während der Zug doch noch lief, gewinnt hier die Wahrheit
     * der Transaktion.
     */
    public static void fertigImZug(Connection con, UUID id) throws SQLException {
        try (PreparedStatement st = con.prepareStatement("UPDATE kundenbereich_loeschlauf"
                + " SET stand = 'fertig', beendet_am = now(), fehler = NULL WHERE id = ?")) {
            st.setObject(1, id);
            st.executeUpdate();
        }
    }

    /** Trägt den Abschlussbericht nach dem Commit nach (best effort; fertig bleibt fertig). */
    public void berichtNachtragen(UUID id, String berichtJson) {
        jdbc.update("UPDATE kundenbereich_loeschlauf SET bericht = ?::jsonb"
                + " WHERE id = ? AND stand = 'fertig'", berichtJson, id);
    }

    /**
     * Löst einen verwaisten Lauf auf (Absturz/Neustart: „laeuft", aber der Herzschlag ist älter als
     * {@code frist}): Mandant noch da → die Transaktion ist zurückgerollt, nichts gelöscht →
     * „gescheitert" mit {@code fehler}; Mandant weg → der Abbau hat committet → „fertig" (nur der
     * Bericht fehlt). Beide Wege sind auf „laeuft" UND die abgelaufene Frist bedingt, damit ein doch
     * noch lebender Zug (der seine Wahrheit selbst schreibt) nie überschrieben wird.
     * Liefert true, wenn diese Auflösung etwas geändert hat.
     */
    public boolean verwaistAufloesen(UUID id, String fristSql, boolean mandantVorhanden, String fehler) {
        if (mandantVorhanden) {
            return jdbc.update("UPDATE kundenbereich_loeschlauf SET stand = 'gescheitert', beendet_am = now(),"
                    + " fehler = ? WHERE id = ? AND stand = 'laeuft' AND herzschlag_am < now() - ?::interval",
                    fehler, id, fristSql) > 0;
        }
        return jdbc.update("UPDATE kundenbereich_loeschlauf SET stand = 'fertig', beendet_am = now()"
                + " WHERE id = ? AND stand = 'laeuft' AND herzschlag_am < now() - ?::interval",
                id, fristSql) > 0;
    }
}
