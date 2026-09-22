package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
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
 * AP-16 IP-15: die Messmittel-Angaben am Einbau ({@code geraet}), die Klasse an den Wandler-Fassungen
 * ({@code quelle_einstellung}) und das Journal {@code geraet_aenderung}. Liest und schreibt nur die
 * Spalten von V20260922245000; die Sichtbarkeit (Mandant, Standort-Zaun) kommt aus RLS.
 */
@Repository
public class MessmittelRepository {

    /** Die gespeicherte Angabe eines Einbaus — NULL heißt überall „nicht erhoben“. */
    public record Stand(UUID id, String kennzeichen, String einbauKennzeichen, String genauigkeitsklasse,
            String pruefungsart, LocalDate pruefungAm, LocalDate pruefungGueltigBis, Beleg beleg) {}

    public record Beleg(String bezeichnung, String ablage, String sha256, ProtokollAkteur person, Instant am) {}

    /** Eine Wandler-Fassung des Einbaus mit ihrer Klasse. */
    public record Wandler(UUID id, String art, JsonNode wert, Instant gueltigAb, Instant gueltigBis,
            String klasse) {}

    private static final String SPALTEN = "g.id, g.kennzeichen, g.einbau_kennzeichen, g.genauigkeitsklasse, "
            + "g.pruefungsart, g.pruefung_am, g.pruefung_gueltig_bis, g.beleg_bezeichnung, g.beleg_ablage, "
            + "g.beleg_sha256, g.beleg_actor_sub, g.beleg_actor_name, g.beleg_actor_rolle, g.beleg_actor_art, "
            + "g.beleg_am";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public MessmittelRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    public Optional<Stand> stand(UUID geraetId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraet g WHERE g.id = ?", this::zeile, geraetId)
                .stream().findFirst();
    }

    /** Sperrt die Zeile für die Dauer der Transaktion: zwei gleichzeitige Angaben protokollieren nacheinander. */
    public Optional<Stand> standZumAendern(UUID geraetId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraet g WHERE g.id = ? FOR UPDATE", this::zeile, geraetId)
                .stream().findFirst();
    }

    /** Alle Wandler-Fassungen des Einbaus, älteste zuerst — auch beendete (die Klasse gilt je Fassung). */
    public List<Wandler> wandler(UUID geraetId) {
        return jdbc.query("SELECT id, art, wert::text, gueltig_ab, gueltig_bis, klasse FROM quelle_einstellung "
                + "WHERE geraet_id = ? AND art IN ('wandler_strom', 'wandler_spannung') ORDER BY gueltig_ab, id",
                (rs, n) -> new Wandler(rs.getObject(1, UUID.class), rs.getString(2), baum(rs.getString(3)),
                        instant(rs, 4), instant(rs, 5), rs.getString(6)), geraetId);
    }

    /** Die Art einer Einstellungs-Fassung DIESES Einbaus — leer, wenn sie ihm nicht gehört. */
    public Optional<String> artDerFassung(UUID geraetId, UUID fassung) {
        return jdbc.queryForList("SELECT art FROM quelle_einstellung WHERE id = ? AND geraet_id = ?", String.class,
                fassung, geraetId).stream().findFirst();
    }

    public void speichern(UUID geraetId, Stand neu) {
        Beleg b = neu.beleg();
        ProtokollAkteur p = b == null ? null : b.person();
        jdbc.update("UPDATE geraet SET genauigkeitsklasse = ?, pruefungsart = ?, pruefung_am = ?, "
                + "pruefung_gueltig_bis = ?, beleg_bezeichnung = ?, beleg_ablage = ?, beleg_sha256 = ?, "
                + "beleg_actor_sub = ?, beleg_actor_name = ?, beleg_actor_rolle = ?, beleg_actor_art = ?, "
                + "beleg_am = ? WHERE id = ?",
                neu.genauigkeitsklasse(), neu.pruefungsart(), neu.pruefungAm(), neu.pruefungGueltigBis(),
                b == null ? null : b.bezeichnung(), b == null ? null : b.ablage(), b == null ? null : b.sha256(),
                p == null ? null : p.sub(), p == null ? null : p.name(), p == null ? null : p.rolle(),
                p == null ? null : p.art(), b == null ? null : Timestamp.from(b.am()), geraetId);
    }

    public void klasseSetzen(UUID fassung, String klasse) {
        jdbc.update("UPDATE quelle_einstellung SET klasse = ? WHERE id = ?", klasse, fassung);
    }

    public void protokollieren(UUID geraetId, JsonNode alt, JsonNode neu, ProtokollAkteur a) {
        jdbc.update("INSERT INTO geraet_aenderung (tenant_id, geraet_id, art, alt, neu, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 'messmittel_angabe', ?::jsonb, ?::jsonb, ?, ?, ?, ?)",
                TenantContext.get(), geraetId, alt.toString(), neu.toString(), a.sub(), a.name(), a.rolle(), a.art());
    }

    private Stand zeile(ResultSet rs, int n) throws SQLException {
        String sha = rs.getString("beleg_sha256");
        Beleg beleg = sha == null ? null : new Beleg(rs.getString("beleg_bezeichnung"), rs.getString("beleg_ablage"),
                sha, new ProtokollAkteur(rs.getString("beleg_actor_sub"), rs.getString("beleg_actor_name"),
                        rs.getString("beleg_actor_rolle"), rs.getString("beleg_actor_art")), instant(rs, 15));
        return new Stand(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                rs.getString("einbau_kennzeichen"), rs.getString("genauigkeitsklasse"), rs.getString("pruefungsart"),
                tag(rs, "pruefung_am"), tag(rs, "pruefung_gueltig_bis"), beleg);
    }

    private JsonNode baum(String text) {
        try {
            return json.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("quelle_einstellung.wert ist kein JSON", e);
        }
    }

    private static LocalDate tag(ResultSet rs, String spalte) throws SQLException {
        return rs.getObject(spalte, LocalDate.class);
    }

    private static Instant instant(ResultSet rs, int spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
