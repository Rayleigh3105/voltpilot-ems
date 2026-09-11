package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Einstellungs-Fassungen je Quelle ({@code quelle_einstellung}, Migration V20260911280000) —
 * unter RLS: eine fremde Fassung ist hier schlicht nicht da.
 *
 * <p>Geschrieben wird nur angelegt und beendet: die App-Rolle darf an einer Fassung allein
 * {@code gueltig_bis} setzen, und ein Trigger lässt es nur verkürzen. Welche Fassung wann endet,
 * entscheidet {@link QuelleEinstellungRegeln}, nicht diese Klasse.
 */
@Repository
public class QuelleEinstellungRepository {

    private static final String SPALTEN = "id, geraet_id, entity_id, kanal, art, wert::text AS wert, "
            + "anwendung, herkunft, gueltig_ab, gueltig_bis, tatsaechlich_ab, rueckwirkend, begruendung, "
            + "actor_sub, actor_name, actor_rolle, actor_art, eingetragen_am";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public QuelleEinstellungRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Eine gespeicherte Fassung. {@code entityId}/{@code kanal} {@code null}: die Quelle ist der Einbau selbst. */
    public record Fassung(UUID id, UUID geraetId, UUID entityId, String kanal, String art, JsonNode wert,
            String anwendung, String herkunft, Instant gueltigAb, Instant gueltigBis, Instant tatsaechlichAb,
            boolean rueckwirkend, String begruendung, String actorSub, String actorName, String actorRolle,
            String actorArt, Instant eingetragenAm) {}

    /** Eine neue Fassung, wie sie geschrieben wird. */
    public record NeueFassung(UUID tenantId, UUID geraetId, UUID entityId, String kanal, String art,
            JsonNode wert, String anwendung, String herkunft, Instant gueltigAb, Instant gueltigBis,
            Instant tatsaechlichAb, boolean rueckwirkend, String begruendung, ProtokollAkteur akteur,
            Instant eingetragenAm) {}

    /** Die laufende Speisung einer Komponente: ihr Einbau und seit wann. */
    public record Speisung(UUID geraetId, Instant gueltigAb) {}

    /** Alle Fassungen eines Einbaus. */
    public List<Fassung> desEinbaus(UUID geraetId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM quelle_einstellung WHERE geraet_id = ? "
                + "ORDER BY gueltig_ab, id", this::fassung, geraetId);
    }

    /** Die Fassungen EINER Quelle und Art, die früheste zuerst. */
    public List<Fassung> derQuelle(UUID geraetId, UUID entityId, String kanal, String art) {
        return jdbc.query("SELECT " + SPALTEN + " FROM quelle_einstellung WHERE geraet_id = ? "
                + "AND entity_id IS NOT DISTINCT FROM ? AND kanal IS NOT DISTINCT FROM ? AND art = ? "
                + "ORDER BY gueltig_ab", this::fassung, geraetId, entityId, kanal, art);
    }

    public Optional<Fassung> eine(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM quelle_einstellung WHERE id = ?", this::fassung, id)
                .stream().findFirst();
    }

    /**
     * Sperrt den Einbau bis zum Ende der Transaktion: zwei Einträge an derselben Quelle warten
     * aufeinander, statt beide „die laufende" Fassung zu beenden. {@code false}, wenn es ihn (für
     * den Aufrufer) nicht gibt.
     */
    public boolean sperreEinbau(UUID geraetId) {
        return !jdbc.queryForList("SELECT id FROM geraet WHERE id = ? FOR UPDATE", UUID.class, geraetId)
                .isEmpty();
    }

    /** Die laufende Speisung der Komponente; leer ohne — nie geraten. */
    public Optional<Speisung> laufendeSpeisung(UUID entityId) {
        return jdbc.query("SELECT geraet_id, gueltig_ab FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", (rs, n) -> new Speisung(rs.getObject("geraet_id", UUID.class),
                        rs.getTimestamp("gueltig_ab").toInstant()), entityId).stream().findFirst();
    }

    /**
     * Die Fassung 1 der Komponente aus ihrer HEUTIGEN Verbindung — die Regel der Migration
     * ({@code uems_einstellungen_ableiten_fuer}), dieselbe wie für den Bestand. Legt je (Quelle, Art)
     * nur an, wo es noch keine Fassung gibt; gibt zurück, wie viele.
     */
    public int fassungEinsAbleiten(UUID entityId) {
        Integer n = jdbc.queryForObject("SELECT uems_einstellungen_ableiten_fuer(?)", Integer.class, entityId);
        return n == null ? 0 : n;
    }

    public UUID anlegen(NeueFassung f) {
        ProtokollAkteur a = f.akteur();
        return jdbc.queryForObject("INSERT INTO quelle_einstellung (tenant_id, geraet_id, entity_id, kanal, art, "
                + "wert, anwendung, herkunft, gueltig_ab, gueltig_bis, tatsaechlich_ab, rueckwirkend, begruendung, "
                + "actor_sub, actor_name, actor_rolle, actor_art, eingetragen_am) "
                + "VALUES (?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class,
                f.tenantId(), f.geraetId(), f.entityId(), f.kanal(), f.art(), f.wert().toString(), f.anwendung(),
                f.herkunft(), ts(f.gueltigAb()), ts(f.gueltigBis()), ts(f.tatsaechlichAb()), f.rueckwirkend(),
                f.begruendung(), a.sub(), a.name(), a.rolle(), a.art(), ts(f.eingetragenAm()));
    }

    /** Beendet eine Fassung bei {@code bis} (verkürzt sie — länger wird sie nie). */
    public void beenden(UUID id, Instant bis) {
        jdbc.update("UPDATE quelle_einstellung SET gueltig_bis = ? WHERE id = ?", ts(bis), id);
    }

    /** Eine Messstelle, die eine Quelle speist: ihre Zeile und ihr Kennzeichen (MS-01). */
    public record Gespeist(UUID id, String kennzeichen) {}

    /**
     * Die Messstellen, deren Quellenbindung (messstelle_quelle, führend ODER Vergleich) zum Zeitpunkt
     * {@code ab} aus dieser Quelle liest: aus dem Einbau — und, wenn gesetzt, aus dieser Komponente
     * und diesem Kanal. Je Messstelle einmal, nach Kennzeichen.
     */
    public List<Gespeist> gespeisteMessstellen(UUID geraetId, UUID entityId, String kanal, Instant ab) {
        return jdbc.query("SELECT DISTINCT m.id, m.kennzeichen FROM messstelle_quelle q "
                + "JOIN messstelle m ON m.id = q.messstelle_id AND m.tenant_id = q.tenant_id "
                + "WHERE q.geraet_id = ? AND (CAST(? AS uuid) IS NULL OR q.entity_id = ?) "
                + "AND (CAST(? AS text) IS NULL OR q.kanal = ?) "
                + "AND q.gueltig_ab <= ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?) ORDER BY m.kennzeichen",
                (rs, n) -> new Gespeist(rs.getObject("id", UUID.class), rs.getString("kennzeichen")),
                geraetId, entityId, entityId, kanal, kanal, ts(ab), ts(ab));
    }

    private Fassung fassung(ResultSet rs, int n) throws SQLException {
        JsonNode wert;
        try {
            wert = json.readTree(rs.getString("wert"));
        } catch (Exception e) {
            throw new SQLException("unlesbarer Wert einer Einstellungs-Fassung", e);
        }
        return new Fassung(rs.getObject("id", UUID.class), rs.getObject("geraet_id", UUID.class),
                rs.getObject("entity_id", UUID.class), rs.getString("kanal"), rs.getString("art"), wert,
                rs.getString("anwendung"), rs.getString("herkunft"), zeit(rs, "gueltig_ab"),
                zeit(rs, "gueltig_bis"), zeit(rs, "tatsaechlich_ab"), rs.getBoolean("rueckwirkend"),
                rs.getString("begruendung"), rs.getString("actor_sub"), rs.getString("actor_name"),
                rs.getString("actor_rolle"), rs.getString("actor_art"), zeit(rs, "eingetragen_am"));
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
