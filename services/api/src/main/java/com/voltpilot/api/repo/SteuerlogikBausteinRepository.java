package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die gespeicherten Bausteine (Steuerlogik Stufe 5, {@code steuerlogik_baustein}, V20261115200000): die eines
 * Fachbetriebs (Partner-Konto) und die, die VoltPilot für alle speichert. Die Tabelle gehört keinem Kundenbereich;
 * welche Zeilen eine Anfrage sieht, setzt die Datenbank durch (Policy {@code steuerlogik_baustein_sicht}: VoltPilot
 * für alle, ein Fachbetrieb nur in den Kundenbereichen, die ihm eine Unterstützung der Art Installateur gewährt
 * haben). Hier steht darum kein Mandantenfilter, und er darf auch keiner werden.
 */
@Repository
public class SteuerlogikBausteinRepository {

    public static final String HERKUNFT_VOLTPILOT = "voltpilot";
    public static final String HERKUNFT_FACHBETRIEB = "fachbetrieb";

    private final JdbcTemplate jdbc;

    public SteuerlogikBausteinRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein gespeicherter Baustein; {@code text} ist seine Form (block, name, sentence, logic). */
    public record Baustein(UUID id, String herkunft, String partnerSub, String name, String text, String contentHash,
            Instant angelegtAm, String angelegtVon, String angelegtName) {}

    private static final String SPALTEN =
            "id, herkunft, partner_sub, name, text, content_hash, angelegt_am, angelegt_von, angelegt_name";

    private static Baustein zeile(java.sql.ResultSet rs) throws java.sql.SQLException {
        Timestamp am = rs.getTimestamp(7);
        return new Baustein(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getString(4),
                rs.getString(5), rs.getString(6), am == null ? null : am.toInstant(), rs.getString(8),
                rs.getString(9));
    }

    /** Die Bausteine, die diese Anfrage sieht und die niemand entfernt hat: VoltPilot zuerst, dann nach Zeit. */
    public List<Baustein> sichtbare() {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerlogik_baustein WHERE entfernt_am IS NULL "
                + "ORDER BY herkunft DESC, angelegt_am, id", (rs, i) -> zeile(rs));
    }

    /** Ein sichtbarer, nicht entfernter Baustein; {@code null}, wenn es ihn für diese Anfrage nicht gibt. */
    public Baustein finde(UUID id) {
        List<Baustein> l = jdbc.query("SELECT " + SPALTEN + " FROM steuerlogik_baustein "
                + "WHERE id = ? AND entfernt_am IS NULL", (rs, i) -> zeile(rs), id);
        return l.isEmpty() ? null : l.get(0);
    }

    public void lege(Baustein b) {
        jdbc.update("INSERT INTO steuerlogik_baustein (" + SPALTEN + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                b.id(), b.herkunft(), b.partnerSub(), b.name(), b.text(), b.contentHash(),
                Timestamp.from(b.angelegtAm()), b.angelegtVon(), b.angelegtName());
    }

    /** Entfernt einen Baustein (er bleibt gespeichert, mit wer und wann); {@code false}, wenn er schon fort ist. */
    public boolean entferne(UUID id, String von, Instant jetzt) {
        return jdbc.update("UPDATE steuerlogik_baustein SET entfernt_am = ?, entfernt_von = ? "
                + "WHERE id = ? AND entfernt_am IS NULL", Timestamp.from(jetzt), von, id) > 0;
    }

    /** Der Anzeigename eines Kontos in diesem Kundenbereich; {@code null}, wenn es dort keinen Spiegel hat. */
    public String anzeigename(String sub) {
        List<String> l = jdbc.queryForList("SELECT NULLIF(btrim(anzeigename), '') FROM benutzer WHERE sub = ?",
                String.class, sub);
        return l.isEmpty() ? null : l.get(0);
    }
}
