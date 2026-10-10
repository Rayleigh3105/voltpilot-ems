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
import org.springframework.stereotype.Repository;

/**
 * AP-16 IP-17 (G5): die Toleranz-Fassungen je Vergleichsquelle ({@code vergleich_toleranz}, V20260922251700) und
 * die gespeicherte Monatszeile eines Messkanals ({@code messreihe_periode}). Liest nur, was schon gebildet ist;
 * schreibt ausschließlich Fassungen. Die Sichtbarkeit (Mandant) kommt aus RLS.
 */
@Repository
public class VergleichToleranzRepository {

    /** Eine gespeicherte Fassung (ab 2) — Fassung 1 ist der Startwert des Vertrags und steht nie hier. */
    public record Fassung(UUID id, UUID quelleId, int fassung, BigDecimal prozent, LocalDate giltAbMonat,
            String begruendung, ProtokollAkteur akteur, Instant eingetragenAm) {}

    /** Die Monatszeile eines Messkanals, wie der Periodenlauf sie gespeichert hat — nie nachgerechnet. */
    public record Monat(BigDecimal menge, BigDecimal energie, String mengeZustand) {}

    private static final String SPALTEN = "id, messstelle_quelle_id, fassung, prozent, gilt_ab_monat, begruendung, "
            + "actor_sub, actor_name, actor_rolle, actor_art, eingetragen_am";

    private final JdbcTemplate jdbc;

    public VergleichToleranzRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Alle gespeicherten Fassungen einer Vergleichsquelle, älteste zuerst. */
    public List<Fassung> derQuelle(UUID quelleId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM vergleich_toleranz WHERE messstelle_quelle_id = ? "
                + "ORDER BY fassung", VergleichToleranzRepository::fassung, quelleId);
    }

    /**
     * Die nächste Fassung — zwei gleichzeitige Einträge an derselben Quelle warten aufeinander (Transaktions-Sperre
     * auf die Quelle; die App-Rolle darf die Bindung selbst nicht sperren).
     */
    public int naechsteFassung(UUID quelleId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?::text, 17))",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> { }, quelleId.toString());
        Integer hoechste = jdbc.queryForObject("SELECT max(fassung) FROM vergleich_toleranz "
                + "WHERE messstelle_quelle_id = ?", Integer.class, quelleId);
        return hoechste == null ? 2 : hoechste + 1;
    }

    public Fassung eintragen(UUID tenant, UUID quelleId, int fassung, BigDecimal prozent, LocalDate giltAbMonat,
            String begruendung, ProtokollAkteur akteur, Instant jetzt) {
        return jdbc.queryForObject("INSERT INTO vergleich_toleranz (tenant_id, messstelle_quelle_id, fassung, prozent, "
                + "gilt_ab_monat, begruendung, actor_sub, actor_name, actor_rolle, actor_art, eingetragen_am) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING " + SPALTEN, VergleichToleranzRepository::fassung,
                tenant, quelleId, fassung, prozent, giltAbMonat, begruendung, akteur.sub(), akteur.name(),
                akteur.rolle(), akteur.art(), Timestamp.from(jetzt));
    }

    /** Die Monatszeile (Version 1) des Kanals; ohne Zeile leer — „keine Werte“ oder noch nicht gebildet. */
    public Optional<Monat> monat(UUID tenant, UUID entityId, String kanal, LocalDate monat) {
        return jdbc.query("SELECT menge, energie, menge_zustand FROM messreihe_periode WHERE tenant_id = ? "
                + "AND entity_id = ? AND messkanal = ? AND art = 'monat' AND tag = ?",
                (rs, n) -> new Monat(rs.getBigDecimal("menge"), rs.getBigDecimal("energie"),
                        rs.getString("menge_zustand")), tenant, entityId, kanal, monat).stream().findFirst();
    }

    private static Fassung fassung(ResultSet rs, int n) throws SQLException {
        return new Fassung(rs.getObject("id", UUID.class), rs.getObject("messstelle_quelle_id", UUID.class),
                rs.getInt("fassung"), rs.getBigDecimal("prozent"), rs.getObject("gilt_ab_monat", LocalDate.class),
                rs.getString("begruendung"), new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"),
                        rs.getString("actor_rolle"), rs.getString("actor_art")),
                rs.getTimestamp("eingetragen_am").toInstant());
    }
}
