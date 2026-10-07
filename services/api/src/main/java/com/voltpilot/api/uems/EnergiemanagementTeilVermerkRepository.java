package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Konzept Nachweisen n1, Entscheid 5: die Vermerke „Trifft bei uns zurzeit nicht zu“ unter Mandanten-RLS und dem Zaun
 * „nur unternehmensweit“ ({@code site_scope}, V20261007004500). Nur anhängen: die App-Rolle legt an und setzt einmal die
 * Spalten des Aufhebens, sie löscht nie; den Rest hält der Trigger {@code energiemanagement_teil_vermerk_eingefroren}.
 */
@Repository
public class EnergiemanagementTeilVermerkRepository {

    public record Vermerk(UUID id, String teil, String satz, UUID entschiedenVon, LocalDate entschiedenAm,
            ProtokollAkteur akteur, Instant angelegtAm, ProtokollAkteur aufgehobenVon, Instant aufgehobenAm) {}

    private static final RowMapper<Vermerk> VERMERK = (rs, n) -> new Vermerk(rs.getObject("id", UUID.class),
            rs.getString("teil"), rs.getString("satz"), rs.getObject("entschieden_von", UUID.class),
            rs.getObject("entschieden_am", LocalDate.class), new ProtokollAkteur(rs.getString("actor_sub"),
                    rs.getString("actor_name"), rs.getString("actor_rolle"), rs.getString("actor_art")),
            instant(rs, "created_at"), aufgehobenVon(rs), instant(rs, "aufgehoben_am"));

    private final JdbcTemplate jdbc;

    public EnergiemanagementTeilVermerkRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Alle Vermerke im Zaun, auch aufgehobene, in der Folge ihres Eintragens. */
    public List<Vermerk> vermerke() {
        return jdbc.query("SELECT * FROM energiemanagement_teil_vermerk ORDER BY created_at, id", VERMERK);
    }

    public Optional<Vermerk> vermerk(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_teil_vermerk WHERE id = ?", VERMERK, id).stream().findFirst();
    }

    /** Sperrt den Vermerk für das Aufheben (FOR UPDATE). */
    public Optional<Vermerk> sperren(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_teil_vermerk WHERE id = ? FOR UPDATE", VERMERK, id).stream()
                .findFirst();
    }

    /** Der geltende Vermerk des Teils, höchstens einer (Index {@code energiemanagement_teil_vermerk_geltend_uq}). */
    public Optional<Vermerk> geltend(String teil) {
        return jdbc.query("SELECT * FROM energiemanagement_teil_vermerk WHERE teil = ? AND aufgehoben_am IS NULL",
                VERMERK, teil).stream().findFirst();
    }

    public UUID anlegen(String teil, String satz, UUID entschiedenVon, LocalDate entschiedenAm, Instant am,
            ProtokollAkteur wer) {
        return jdbc.queryForObject("""
                INSERT INTO energiemanagement_teil_vermerk (tenant_id, teil, satz, entschieden_von, entschieden_am,
                    created_at, actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), teil, satz, entschiedenVon, entschiedenAm, Timestamp.from(am), wer.sub(),
                wer.name(), wer.rolle(), wer.art());
    }

    /** Hebt den Vermerk einmal auf: Zeitpunkt und wer es eingetragen hat (CHECK {@code …_aufgehoben_chk}). */
    public void aufheben(UUID id, Instant am, ProtokollAkteur wer) {
        jdbc.update("UPDATE energiemanagement_teil_vermerk SET aufgehoben_am = ?, aufgehoben_sub = ?, "
                + "aufgehoben_name = ?, aufgehoben_rolle = ?, aufgehoben_art = ? WHERE id = ?", Timestamp.from(am),
                wer.sub(), wer.name(), wer.rolle(), wer.art(), id);
    }

    private static UUID tenant() {
        return Objects.requireNonNull(TenantContext.get(), "Mandant aus TenantContext erforderlich");
    }

    private static ProtokollAkteur aufgehobenVon(ResultSet rs) throws SQLException {
        return rs.getString("aufgehoben_name") == null ? null : new ProtokollAkteur(rs.getString("aufgehoben_sub"),
                rs.getString("aufgehoben_name"), rs.getString("aufgehoben_rolle"), rs.getString("aufgehoben_art"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
