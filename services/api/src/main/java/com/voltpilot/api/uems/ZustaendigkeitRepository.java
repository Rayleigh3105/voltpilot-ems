package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die zeitgültige Zuständigkeit Box → Datenquelle ({@code data_source_assignment},
 * Migration V20260911150000), unter RLS.
 *
 * <p>Die Mechanik ist Vertrag ({@code docs/contracts/v2/data-source-assignment.md} §4,
 * {@link DatenquelleRegeln}): ein Zeitraum ist HALBOFFEN auf die Minute —
 * {@code effectiveFrom} gehört dazu, {@code effectiveTo} nicht, {@code null} =
 * offen. Je Quelle und Zeitpunkt liest höchstens eine Box, und an einer Box je
 * Zeitpunkt nur eine Quelle je Protokoll + Adresse; beides erzwingt die
 * Datenbank selbst (Exklusions-Constraints). Sie beendet nichts von selbst: wer
 * zuerst einträgt und dann beendet, bekommt die Ablehnung — die Reihenfolge
 * eines Wechsels ab {@code t} ist: erst {@link #beenden} bei {@code t}, dann
 * {@link #eintragen} ab {@code t} (Ende alt = Beginn neu).
 *
 * <p>Eine Zeile wird nie gelöscht und nie umgeschrieben: die App-Rolle darf nur
 * {@code effective_to} ändern. Ob ein Eintrag erlaubt ist (nie rückwirkend,
 * Steuerquelle, Prüfung von genau der Ziel-Box, …), prüft der Schreibweg mit
 * {@link DatenquelleRegeln#pruefeAntrag}, bevor er hier schreibt (IP-3).
 */
@Repository
public class ZustaendigkeitRepository {

    private final JdbcTemplate jdbc;

    public ZustaendigkeitRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** {@code deviceId} ist die lesende Box — auch eine, die es inzwischen nicht mehr gibt. */
    public record Zeitraum(UUID id, UUID dataSourceId, UUID deviceId, Instant effectiveFrom,
            Instant effectiveTo) {}

    /**
     * Trägt ein, dass {@code deviceId} die Quelle ab {@code effectiveFrom} liest, bis
     * {@code effectiveTo} ausschließlich ({@code null} = offen). Protokoll und
     * Adresse kopiert die Anweisung von der Quelle — der Fremdschlüssel hält sie
     * gleich. Leer, wenn die Quelle im Zaun nicht vorhanden ist (→ 404).
     */
    public Optional<UUID> eintragen(UUID tenantId, UUID dataSourceId, UUID deviceId,
            Instant effectiveFrom, Instant effectiveTo, String createdBy) {
        return jdbc.queryForList("INSERT INTO data_source_assignment (tenant_id, data_source_id, "
                + "device_id, protokoll, adresse, effective_from, effective_to, created_by) "
                + "SELECT ?::uuid, d.id, ?::uuid, d.protokoll, d.adresse, ?::timestamptz, "
                + "?::timestamptz, ?::text FROM data_source d WHERE d.id = ? RETURNING id",
                UUID.class, tenantId, deviceId, utc(effectiveFrom), utc(effectiveTo), createdBy,
                dataSourceId)
                .stream().findFirst();
    }

    /**
     * Beendet einen Zeitraum bei {@code effectiveTo} (ausschließlich) — nur einen, der
     * dann noch läuft: ein Ende rückt nie nach hinten, ein beendeter Zeitraum wird
     * nie wieder offen.
     */
    public boolean beenden(UUID id, Instant effectiveTo) {
        return jdbc.update("UPDATE data_source_assignment SET effective_to = ? "
                + "WHERE id = ? AND (effective_to IS NULL OR effective_to > ?)",
                utc(effectiveTo), id, utc(effectiveTo)) == 1;
    }

    /** Alle Zeiträume einer Quelle, nach Beginn. */
    public List<Zeitraum> fuerQuelle(UUID dataSourceId) {
        return List.copyOf(jdbc.query("SELECT id, data_source_id, device_id, effective_from, "
                + "effective_to FROM data_source_assignment WHERE data_source_id = ? "
                + "ORDER BY effective_from, id",
                ZustaendigkeitRepository::map, dataSourceId));
    }

    /**
     * Alle Zeiträume des Kundenbereichs, je Quelle nach Beginn — die Ausgangslage eines
     * Antrags: Eindeutigkeit je Box und Doppel-Lesen sehen über die Anlage hinaus (eine Box
     * darf Quellen anderer Anlagen lesen, Vertrag §1).
     */
    public List<Zeitraum> alle() {
        return List.copyOf(jdbc.query("SELECT id, data_source_id, device_id, effective_from, "
                + "effective_to FROM data_source_assignment "
                + "ORDER BY data_source_id, effective_from, id",
                ZustaendigkeitRepository::map));
    }

    private static Zeitraum map(ResultSet rs, int n) throws SQLException {
        OffsetDateTime bis = rs.getObject("effective_to", OffsetDateTime.class);
        return new Zeitraum(
                rs.getObject("id", UUID.class),
                rs.getObject("data_source_id", UUID.class),
                rs.getObject("device_id", UUID.class),
                rs.getObject("effective_from", OffsetDateTime.class).toInstant(),
                bis == null ? null : bis.toInstant());
    }

    private static OffsetDateTime utc(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }
}
