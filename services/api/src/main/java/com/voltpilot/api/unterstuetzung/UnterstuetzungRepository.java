package com.voltpilot.api.unterstuetzung;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die beiden Tabellen, die eine Unterstützung BEGLEITEN (UEMS AP-03 IP-8, {@code V20260916070000}): die
 * Anfrage von VoltPilot ({@code unterstuetzung_anfrage} + ihre Standorte) und der Hinweis an die
 * Kundenadministratoren ({@code unterstuetzung_hinweis}).
 *
 * <p><b>Der Zugriff selbst steht nicht hier.</b> Wer hineindarf, sagt allein {@code zugriff}
 * ({@link com.voltpilot.api.zugriff.ZugriffRepository}, IP-2) — diese Tabellen sind Wunsch und Postfach, nie
 * Erlaubnis. Eine Anfrage ohne Entscheidung gewährt nichts; ein Hinweis, der nie gelesen wird, verlängert
 * nichts.
 *
 * <p>Alles über die RLS-Verbindung im Kundenbereich des {@link TenantContext} (nie aus einem Anfragekörper).
 */
@Repository
public class UnterstuetzungRepository {

    private final JdbcTemplate jdbc;

    public UnterstuetzungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------ Anfrage

    /** Ein Wunsch von VoltPilot: Umfang, Standorte, Zeitraum und Grund (E8, A5). */
    public record NeueAnfrage(Umfang umfang, List<UUID> standorte, String angefragtVon, String angefragtName,
            String angefragtEmail, Instant gueltigAb, LocalDate gueltigBis, ZoneId zeitzone, String grund) {}

    /**
     * Eine gespeicherte Anfrage. Der Zustand wird ABGELEITET, nie gespeichert: ohne {@code entschiedenAm} ist
     * sie offen, mit ihr und einem {@code zugriffId} bestätigt, mit ihr und ohne ihn abgelehnt.
     */
    public record Anfrage(UUID id, Art art, Umfang umfang, List<UUID> standorte, String angefragtVon,
            String angefragtName, String angefragtEmail, Instant gueltigAb, LocalDate gueltigBis, ZoneId zeitzone,
            String grund, Instant entschiedenAm, String entschiedenVon, UUID zugriffId, Instant erzeugtAm) {

        /** {@code offen} · {@code bestaetigt} · {@code abgelehnt}. */
        public String zustand() {
            if (entschiedenAm == null) {
                return "offen";
            }
            return zugriffId != null ? "bestaetigt" : "abgelehnt";
        }

        public boolean offen() {
            return entschiedenAm == null;
        }
    }

    public UUID anfragen(NeueAnfrage a) {
        UUID tenant = kundenbereich();
        UUID id = jdbc.queryForObject("INSERT INTO unterstuetzung_anfrage (tenant_id, art, umfang, angefragt_von, "
                + "angefragt_name, angefragt_email, gueltig_ab, gueltig_bis, zeitzone, grund) "
                + "VALUES (?, 'voltpilot', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, tenant,
                a.umfang().code(), a.angefragtVon(), a.angefragtName(), a.angefragtEmail(), utc(a.gueltigAb()),
                a.gueltigBis(), a.zeitzone().getId(), a.grund());
        for (UUID standort : a.standorte()) {
            jdbc.update("INSERT INTO unterstuetzung_anfrage_standort (anfrage_id, tenant_id, standort_id) "
                    + "VALUES (?, ?, ?)", id, tenant, standort);
        }
        return id;
    }

    public Optional<Anfrage> anfrage(UUID id) {
        return jdbc.query(ANFRAGE + " WHERE a.tenant_id = ? AND a.id = ?", (rs, n) -> anfrage(rs, n), kundenbereich(), id)
                .stream().findFirst();
    }

    /** Jede Anfrage des Kundenbereichs, jüngste zuerst; {@code nurOffene} lässt entschiedene aus. */
    public List<Anfrage> anfragen(boolean nurOffene) {
        return jdbc.query(ANFRAGE + " WHERE a.tenant_id = ?" + (nurOffene ? " AND a.entschieden_am IS NULL" : "")
                + " ORDER BY a.created_at DESC, a.id", (rs, n) -> anfrage(rs, n), kundenbereich());
    }

    /**
     * Entscheidet eine Anfrage EINMAL: {@code zugriffId} = der Griff der gewährten Unterstützung, {@code null}
     * = abgelehnt. {@code false}, wenn es sie nicht gibt oder sie schon entschieden ist — der Aufrufer
     * antwortet dann 409, ohne etwas gewährt zu haben.
     */
    public boolean entscheiden(UUID id, Instant am, String von, UUID zugriffId) {
        return jdbc.update("UPDATE unterstuetzung_anfrage SET entschieden_am = ?, entschieden_von = ?, "
                + "zugriff_id = ? WHERE id = ? AND tenant_id = ? AND entschieden_am IS NULL",
                utc(am), von, zugriffId, id, kundenbereich()) == 1;
    }

    // ------------------------------------------------------------------ Hinweis

    /**
     * Woraufhin ein Hinweis entsteht — das geschlossene Vokabular dieses Pakets, Zwilling des CHECK
     * {@code unterstuetzung_hinweis_anlass_chk} und der Aufzählung in {@code openapi.yaml}/{@code api.ts}.
     */
    public enum Anlass {
        /** VoltPilot hat eine Unterstützung angefragt (A5). */
        ANFRAGE("anfrage"),
        /** Eine Unterstützung wurde gewährt oder verlängert. */
        GEWAEHRT("gewaehrt"),
        /** VoltPilot hat sich einen Notfall-Zugriff genommen (E8, A14) — 24 h, Grund, laut. */
        NOTFALL("notfall"),
        /** Sie endet in 7 Tagen (E6). */
        ERINNERUNG("erinnerung"),
        /** Sie endete durch Zeitablauf (A4). */
        ABGELAUFEN("abgelaufen"),
        /** Sie wurde vorzeitig beendet. */
        BEENDET("beendet");

        private final String code;

        Anlass(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Ein Hinweis im Postfach eines Kundenadministrators. */
    public record Hinweis(UUID id, Anlass anlass, String empfaengerSub, String empfaengerEmail, UUID zugriffId,
            UUID anfrageId, String text, Instant gelesenAm, Instant emailVersandtAm, Instant erzeugtAm) {}

    /**
     * Legt EINEN Hinweis an; {@code false}, wenn es ihn schon gibt (Teil-Index je Anlass, Empfänger und
     * Bezug). Damit darf der Ablauf-Läufer seinen Takt zweimal fahren, ohne zweimal zu melden.
     */
    public boolean hinweisen(Anlass anlass, String empfaengerSub, String empfaengerEmail, UUID zugriffId,
            UUID anfrageId, String text) {
        return jdbc.update("INSERT INTO unterstuetzung_hinweis (tenant_id, anlass, empfaenger_sub, empfaenger_email, "
                + "zugriff_id, anfrage_id, text) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                kundenbereich(), anlass.code(), empfaengerSub, empfaengerEmail, zugriffId, anfrageId, text) == 1;
    }

    /** Das Postfach eines Kontos, jüngster zuerst; {@code nurOffene} lässt gelesene aus. */
    public List<Hinweis> hinweise(String empfaengerSub, boolean nurOffene) {
        return jdbc.query(HINWEIS + " WHERE h.tenant_id = ? AND h.empfaenger_sub = ?"
                + (nurOffene ? " AND h.gelesen_am IS NULL" : "") + " ORDER BY h.created_at DESC, h.id",
                UnterstuetzungRepository::hinweis, kundenbereich(), empfaengerSub);
    }

    /** Markiert EINEN Hinweis des Aufrufers als gelesen; {@code false}, wenn es ihn nicht gibt. */
    public boolean gelesen(UUID id, String empfaengerSub, Instant am) {
        return jdbc.update("UPDATE unterstuetzung_hinweis SET gelesen_am = ? WHERE id = ? AND tenant_id = ? "
                + "AND empfaenger_sub = ? AND gelesen_am IS NULL", utc(am), id, kundenbereich(), empfaengerSub) == 1;
    }

    // ------------------------------------------------------------------ intern

    private static final String ANFRAGE = "SELECT a.id, a.art, a.umfang, a.angefragt_von, a.angefragt_name, "
            + "a.angefragt_email, a.gueltig_ab, a.gueltig_bis, a.zeitzone, a.grund, a.entschieden_am, "
            + "a.entschieden_von, a.zugriff_id, a.created_at FROM unterstuetzung_anfrage a";

    private static final String HINWEIS = "SELECT h.id, h.anlass, h.empfaenger_sub, h.empfaenger_email, "
            + "h.zugriff_id, h.anfrage_id, h.text, h.gelesen_am, h.email_versandt_am, h.created_at "
            + "FROM unterstuetzung_hinweis h";

    private Anfrage anfrage(ResultSet rs, int n) throws SQLException {
        UUID id = rs.getObject("id", UUID.class);
        return new Anfrage(id, Art.vonCode(rs.getString("art")), Umfang.vonCode(rs.getString("umfang")),
                jdbc.queryForList("SELECT standort_id FROM unterstuetzung_anfrage_standort WHERE anfrage_id = ? "
                        + "AND tenant_id = ? ORDER BY standort_id", UUID.class, id, kundenbereich()),
                rs.getString("angefragt_von"), rs.getString("angefragt_name"), rs.getString("angefragt_email"),
                instant(rs, "gueltig_ab"), rs.getObject("gueltig_bis", LocalDate.class),
                ZoneId.of(rs.getString("zeitzone")), rs.getString("grund"), instant(rs, "entschieden_am"),
                rs.getString("entschieden_von"), rs.getObject("zugriff_id", UUID.class), instant(rs, "created_at"));
    }

    private static Hinweis hinweis(ResultSet rs, int n) throws SQLException {
        return new Hinweis(rs.getObject("id", UUID.class), anlass(rs.getString("anlass")),
                rs.getString("empfaenger_sub"), rs.getString("empfaenger_email"),
                rs.getObject("zugriff_id", UUID.class), rs.getObject("anfrage_id", UUID.class), rs.getString("text"),
                instant(rs, "gelesen_am"), instant(rs, "email_versandt_am"), instant(rs, "created_at"));
    }

    private static Anlass anlass(String code) {
        for (Anlass a : Anlass.values()) {
            if (a.code().equals(code)) {
                return a;
            }
        }
        throw new IllegalStateException("Unbekannter Anlass: " + code);
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        OffsetDateTime t = rs.getObject(spalte, OffsetDateTime.class);
        return t == null ? null : t.toInstant();
    }

    private static OffsetDateTime utc(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static UUID kundenbereich() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new IllegalStateException("Unterstützungen gibt es nur im Kundenbereich (TenantContext fehlt)");
        }
        return tenant;
    }
}
