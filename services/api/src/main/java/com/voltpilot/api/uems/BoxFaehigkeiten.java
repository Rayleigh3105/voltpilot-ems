package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.ota.RolloutStates;
import com.voltpilot.api.repo.EdgeVersionRepository;
import com.voltpilot.api.repo.EdgeVersionRepository.RegisterEntry;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** The tenant-fenced answer to "can box X do Y?". Never infer capabilities from SHA ordering. */
@Service
public class BoxFaehigkeiten {
    private static final List<DatenquelleRegeln.TabellenEintrag> TABLE = loadTable();
    private final JdbcTemplate jdbc;
    private final EdgeVersionRepository versions;

    public BoxFaehigkeiten(JdbcTemplate jdbc, EdgeVersionRepository versions) {
        this.jdbc = jdbc;
        this.versions = versions;
    }

    public boolean kann(UUID deviceId, String capability) {
        if (capability == null || !EdgeSupports.NAMES.contains(capability)) return false;
        return versions.findAll().stream().filter(v -> v.deviceId().equals(deviceId)).findFirst()
                .map(v -> effective(v.coreVersion(), v.supports(), versions.releases()).contains(capability))
                .orElse(false);
    }

    /** Woher die Fähigkeit kommt (IP-24): {@code gemeldet} · {@code versions_tabelle} · {@code fehlt}. */
    public String herkunft(UUID deviceId, String capability) {
        if (capability == null || !EdgeSupports.NAMES.contains(capability)) return FEHLT;
        return versions.findAll().stream().filter(v -> v.deviceId().equals(deviceId)).findFirst()
                .map(v -> v.supports() != null && v.supports().contains(capability) ? GEMELDET
                        : effective(v.coreVersion(), v.supports(), versions.releases()).contains(capability)
                                ? VERSIONS_TABELLE : FEHLT)
                .orElse(FEHLT);
    }

    public static final String GEMELDET = "gemeldet";
    public static final String VERSIONS_TABELLE = "versions_tabelle";
    public static final String FEHLT = "fehlt";

    /** Separate transaction: a failed extension must not prevent legacy source handling. */
    @org.springframework.transaction.annotation.Transactional(
            propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public void record(UUID deviceId, Instant at, List<String> supports) {
        String raw;
        try { raw = supports == null ? null : new ObjectMapper().writeValueAsString(supports); }
        catch (Exception e) { throw new IllegalArgumentException(e); }
        jdbc.update("UPDATE device SET supports = ?::jsonb, supports_reported_at = ? "
                + "WHERE id = ? AND ausgebaut_am IS NULL "
                + "AND (supports_reported_at IS NULL OR supports_reported_at <= ?)",
                raw, Timestamp.from(at), deviceId, Timestamp.from(at));
    }

    public static List<String> effective(String version, List<String> supports, List<RegisterEntry> register) {
        return effective(version, supports, register, TABLE);
    }

    static List<String> effective(String version, List<String> supports, List<RegisterEntry> register,
            List<DatenquelleRegeln.TabellenEintrag> table) {
        String release = register.stream().sorted(Comparator.comparingLong(RegisterEntry::releaseSeq).reversed())
                .filter(r -> RolloutStates.releaseIsRunning(r.version(), version))
                .map(RegisterEntry::version).findFirst().orElse(null);
        var order = register.stream().sorted(Comparator.comparingLong(RegisterEntry::releaseSeq))
                .map(RegisterEntry::version).toList();
        var tableSupports = DatenquelleRegeln.faehigkeiten(
                new DatenquelleRegeln.Stand(version, release, supports), table, order).faehigkeiten().stream()
                .filter(DatenquelleRegeln.FaehigkeitStatus::vorhanden)
                .map(DatenquelleRegeln.FaehigkeitStatus::code).toList();
        return EdgeSupports.NAMES.stream().filter(n -> tableSupports.contains(n)
                || (supports != null && supports.contains(n))).toList();
    }

    private static List<DatenquelleRegeln.TabellenEintrag> loadTable() {
        try (var in = BoxFaehigkeiten.class.getResourceAsStream("/uems/edge-capabilities.json")) {
            var rows = new ObjectMapper().readTree(in).path("faehigkeiten");
            var table = new java.util.ArrayList<DatenquelleRegeln.TabellenEintrag>();
            for (var r : rows) table.add(new DatenquelleRegeln.TabellenEintrag(
                    r.path("code").asText(), r.path("name").asText(), r.path("ab_release").asText(null)));
            return List.copyOf(table);
        } catch (Exception e) { throw new IllegalStateException("Missing capability table", e); }
    }
}
