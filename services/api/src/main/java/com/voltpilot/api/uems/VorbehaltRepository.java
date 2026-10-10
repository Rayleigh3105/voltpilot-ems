package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Lese- und Schreibwege des Vorbehalts aus Messwerten (UEMS AP-15 IP-13, Migration V20260921230000): die Tages-
 * Höchstwerte des Ungeregelten aus {@code steuerungsverbund_bilanz} (IP-12 rechnet sie, hier wird nur gelesen) und die
 * Zeilen von {@code steuerungsverbund_vorbehalt}. Alles unter RLS des aktuellen Mandanten (TenantContext).
 */
@Repository
public class VorbehaltRepository {

    /** Eine Zeile: selbsttätige Erhöhung ({@code erhoeht}/{@code wirksam}) oder Vorschlag zum Senken. */
    public record Zeile(UUID id, String richtung, String art, String zustand, BigDecimal altKw, BigDecimal neuKw,
            BigDecimal hoechstwertKw, Instant hoechstwertVon, LocalDate zeitraumVon, LocalDate zeitraumBis,
            int messtage, String anteile, String erstelltVon, Instant erstelltAm, String entschiedenVon,
            Instant entschiedenAm) {}

    public static final String ERHOEHT = "erhoeht";
    public static final String VORSCHLAG = "vorschlag";
    public static final String WIRKSAM = "wirksam";
    public static final String OFFEN = "offen";
    public static final String FREIGEGEBEN = "freigegeben";
    public static final String ERSETZT = "ersetzt";
    public static final String HINFAELLIG = "hinfaellig";

    private static final String SPALTEN = "id, richtung, art, zustand, alt_kw, neu_kw, hoechstwert_kw, "
            + "hoechstwert_von, zeitraum_von, zeitraum_bis, messtage, anteile, erstellt_von, erstellt_am, "
            + "entschieden_von, entschieden_am";

    private static final String SPALTEN_Z = java.util.Arrays.stream(SPALTEN.split(", ")).map(c -> "z." + c)
            .collect(java.util.stream.Collectors.joining(", "));

    private static final RowMapper<Zeile> ZEILE = VorbehaltRepository::zeile;

    private final JdbcTemplate jdbc;

    public VorbehaltRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Anlagen des Kundenbereichs (RLS) mit Gemeinsamer Steuerung, in fester Reihenfolge. */
    public List<UUID> anlagenMitVerbund() {
        return jdbc.queryForList("SELECT site_id FROM steuerungsverbund ORDER BY created_at, id", UUID.class);
    }

    /**
     * Die gerechneten Tage [von, bis] der Verbund-Bilanz mit ihrem höchsten belegten Wert (IP-12);
     * NULL = kein Messtag.
     */
    public List<VorbehaltRegel.Tag> tage(UUID verbundId, LocalDate von, LocalDate bis) {
        return jdbc.query("SELECT tag, hoechstes_ungeregeltes_kw, hoechstes_von FROM steuerungsverbund_bilanz "
                + "WHERE steuerungsverbund_id = ? AND tag BETWEEN ? AND ? ORDER BY tag",
                (rs, n) -> new VorbehaltRegel.Tag(rs.getObject(1, LocalDate.class), rs.getBigDecimal(2),
                        instant(rs, 3)), verbundId, von, bis);
    }

    /** Legt eine Zeile an; Zeit setzt die Datenbank (dieselbe Transaktion wie {@code vorbehaltSetzen}). */
    public UUID anlegen(UUID tenant, UUID verbundId, String art, String zustand, VorbehaltRegel.Urteil u,
            String wer) {
        return jdbc.queryForObject("INSERT INTO steuerungsverbund_vorbehalt (tenant_id, site_id, "
                + "steuerungsverbund_id, richtung, art, zustand, alt_kw, neu_kw, hoechstwert_kw, hoechstwert_von, "
                + "zeitraum_von, zeitraum_bis, messtage, fassung, erstellt_von) SELECT ?::uuid, v.site_id, v.id, "
                + "'bezug', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM steuerungsverbund v WHERE v.id = ? RETURNING id",
                UUID.class, tenant, art, zustand,
                u.altKw(), u.neuKw(), u.hoechstwertKw(),
                u.hoechstwertVon() == null ? null : Timestamp.from(u.hoechstwertVon()), u.zeitraumVon(),
                u.zeitraumBis(), u.messtage(), VorbehaltRegel.FASSUNG, wer, verbundId);
    }

    /** Was der Zweischritt aus einer Zeile machte. */
    public void anteileNachtragen(UUID id, String anteile) {
        jdbc.update("UPDATE steuerungsverbund_vorbehalt SET anteile = ? WHERE id = ?", anteile, id);
    }

    /** Entscheidet einen OFFENEN Vorschlag; false, wenn er es nicht mehr ist. */
    public boolean entscheiden(UUID id, String zustand, String wer) {
        return jdbc.update("UPDATE steuerungsverbund_vorbehalt SET zustand = ?, entschieden_von = ?, "
                + "entschieden_am = now() WHERE id = ? AND zustand = 'offen'", zustand, wer, id) > 0;
    }

    public Optional<Zeile> offenerVorschlag(UUID verbundId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerungsverbund_vorbehalt WHERE steuerungsverbund_id = ? "
                + "AND richtung = 'bezug' AND zustand = 'offen'", ZEILE, verbundId).stream().findFirst();
    }

    /** Die jüngste selbsttätige Erhöhung. */
    public Optional<Zeile> juengsteErhoehung(UUID verbundId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerungsverbund_vorbehalt WHERE steuerungsverbund_id = ? "
                + "AND art = 'erhoeht' ORDER BY erstellt_am DESC, id DESC LIMIT 1", ZEILE, verbundId).stream()
                .findFirst();
    }

    /**
     * Die Zeile, die den GELTENDEN Vorbehalt der Bezugsseite gesetzt hat — eine Erhöhung oder ein freigegebener
     * Vorschlag, gesetzt in derselben Transaktion wie {@code vorbehalt_am} und mit derselben Zahl. Leer = erklärt.
     */
    public Optional<Zeile> herkunftGemessen(UUID verbundId) {
        return jdbc.query("SELECT " + SPALTEN_Z + " FROM steuerungsverbund_vorbehalt z "
                + "JOIN steuerungsverbund v ON v.id = z.steuerungsverbund_id "
                + "WHERE z.steuerungsverbund_id = ? AND z.richtung = 'bezug' "
                + "AND ((z.art = 'erhoeht' AND z.erstellt_am = v.vorbehalt_am) "
                + "OR (z.zustand = 'freigegeben' AND z.entschieden_am = v.vorbehalt_am)) "
                + "AND z.neu_kw = v.vorbehalt_bezug_kw ORDER BY z.erstellt_am DESC LIMIT 1", ZEILE, verbundId)
                .stream().findFirst();
    }

    /** Alle Zeilen, jüngste zuerst (Tests und Auskunft). */
    public List<Zeile> zeilen(UUID verbundId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerungsverbund_vorbehalt WHERE steuerungsverbund_id = ? "
                + "ORDER BY erstellt_am DESC, id DESC", ZEILE, verbundId);
    }

    private static Zeile zeile(ResultSet rs, int n) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getString("richtung"), rs.getString("art"),
                rs.getString("zustand"), rs.getBigDecimal("alt_kw"), rs.getBigDecimal("neu_kw"),
                rs.getBigDecimal("hoechstwert_kw"), instant(rs, "hoechstwert_von"),
                rs.getObject("zeitraum_von", LocalDate.class), rs.getObject("zeitraum_bis", LocalDate.class),
                rs.getInt("messtage"), rs.getString("anteile"), rs.getString("erstellt_von"),
                instant(rs, "erstellt_am"), rs.getString("entschieden_von"), instant(rs, "entschieden_am"));
    }

    private static Instant instant(ResultSet rs, int spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
