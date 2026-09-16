package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Persistenz der unveränderlichen Vorlagen-Fassungen; Mandant ausschließlich aus dem {@link TenantContext}. */
@Repository
public class BezugsdatenVorlageRepository {

    public record Zeile(
            UUID id,
            int fassung,
            String name,
            BezugsdatenImportDto.Zuordnung zuordnung,
            String actorName,
            String actorRolle,
            String actorArt,
            Instant erstelltAm) {}

    private static final String SPALTEN = "v.vorlage_id, v.fassung, v.name, v.formatregeln, v.bezug_tabelle, "
            + "v.synonyme, v.actor_name, v.actor_rolle, v.actor_art, v.created_at ";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public BezugsdatenVorlageRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Je Vorlage nur die aktuelle Fassung; ältere Fassungen bleiben für Importe erhalten. */
    public List<Zeile> aktuelle() {
        return jdbc.query("SELECT " + SPALTEN + "FROM bezugsdaten_vorlage v "
                + "WHERE v.fassung = (SELECT max(x.fassung) FROM bezugsdaten_vorlage x "
                + "WHERE x.tenant_id = v.tenant_id AND x.vorlage_id = v.vorlage_id) "
                + "ORDER BY lower(v.name), v.vorlage_id", this::zeile);
    }

    public Optional<Zeile> aktuell(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + "FROM bezugsdaten_vorlage v WHERE v.vorlage_id = ? "
                + "ORDER BY v.fassung DESC LIMIT 1", this::zeile, id).stream().findFirst();
    }

    /** Serialisiert zwei gleichzeitige neue Fassungen derselben Vorlage. */
    public int naechsteFassung(UUID id) {
        jdbc.queryForObject("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))) x",
                Integer.class, id);
        Integer n = jdbc.queryForObject("SELECT coalesce(max(fassung), 0) + 1 FROM bezugsdaten_vorlage "
                + "WHERE vorlage_id = ?", Integer.class, id);
        return n == null ? 1 : n;
    }

    public void einfuegen(UUID id, int fassung, String name, BezugsdatenImportDto.Zuordnung z,
            Collection<UUID> bezuege, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO bezugsdaten_vorlage (tenant_id, vorlage_id, fassung, name, formatregeln, "
                        + "bezug_tabelle, synonyme, actor_sub, actor_name, actor_rolle, actor_art) "
                        + "VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?)",
                TenantContext.get(), id, fassung, name, formatregeln(z), schreiben(z.bezugTabelle()),
                schreiben(z.synonyme()), wer.sub(), wer.name(), wer.rolle(), wer.art());
        for (UUID bezug : bezuege) {
            jdbc.update("INSERT INTO bezugsdaten_vorlage_bezug "
                            + "(tenant_id, vorlage_id, vorlage_fassung, bezugsgroesse_id) VALUES (?, ?, ?, ?)",
                    TenantContext.get(), id, fassung, bezug);
        }
    }

    private Zeile zeile(ResultSet rs, int n) throws SQLException {
        try {
            BezugsdatenImportDto.Zuordnung format = json.readValue(rs.getString("formatregeln"),
                    BezugsdatenImportDto.Zuordnung.class);
            BezugsdatenImportDto.Zuordnung z = new BezugsdatenImportDto.Zuordnung(format.csv(), format.spalten(),
                    format.deutung(), format.zahlformat(), format.einheit(), format.bezugsgroesse(),
                    lesen(rs.getString("bezug_tabelle")), lesen(rs.getString("synonyme")));
            return new Zeile(rs.getObject("vorlage_id", UUID.class), rs.getInt("fassung"), rs.getString("name"), z,
                    rs.getString("actor_name"), rs.getString("actor_rolle"), rs.getString("actor_art"),
                    rs.getTimestamp("created_at").toInstant());
        } catch (JsonProcessingException e) {
            throw new SQLException("Ungültige Bezugsdaten-Vorlage", e);
        }
    }

    private String formatregeln(BezugsdatenImportDto.Zuordnung z) {
        return schreiben(new BezugsdatenImportDto.Zuordnung(z.csv(), z.spalten(), z.deutung(), z.zahlformat(),
                z.einheit(), z.bezugsgroesse(), null, null));
    }

    private String schreiben(Object wert) {
        try {
            return json.writeValueAsString(wert == null ? java.util.Map.of() : wert);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Vorlage ist nicht serialisierbar", e);
        }
    }

    @SuppressWarnings("unchecked")
    private java.util.Map<String, String> lesen(String wert) throws JsonProcessingException {
        return json.readValue(wert, java.util.LinkedHashMap.class);
    }
}
