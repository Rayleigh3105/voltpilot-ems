package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Was die Kostenstellen-Sicht (UEMS AP-10 IP-11) liest und nirgends sonst gelesen wird: die Anteile des GANZEN
 * Kundenbereichs über einen Zeitraum, die Kostenstellen mit ihren Tagen (und Kennungen) und die Tageswerte ab Version 2. Jede Abfrage
 * läuft unter RLS — ein fremder Kundenbereich hat keine Zeilen. Hier wird nichts geschrieben.
 */
@Repository
public class KostenstelleEnergieRepository {

    /**
     * Ein Anteil mit seiner Fassung. Fassung n = der n-te Tag, ab dem ein Satz für die Messstelle geschrieben wurde —
     * gezählt über ALLE Zeilen, auch aufgehobene (eine Korrektur am selben Tag bleibt dieselbe Fassung).
     */
    public record Anteil(UUID messstelleId, String kostenstelle, BigDecimal anteilProzent, LocalDate gueltigAb,
            LocalDate gueltigBis, int fassung) {}

    /** Eine Kostenstelle mit ihren Tagen. */
    public record Ziel(String kennzeichen, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /** Ein Tageswert ab Version 2 — Reihe ({@code entityId}+{@code messkanal}) ODER berechnete Messstelle. */
    public record Version(UUID entityId, String messkanal, UUID messstelleId, LocalDate tag, int version,
            BigDecimal menge, String zustand, Integer abdeckungProzent, String kennzeichen, String anlass,
            Instant erstellt) {}

    private final JdbcTemplate jdbc;

    public KostenstelleEnergieRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Alle nicht aufgehobenen Anteile, die den Zeitraum berühren. */
    public List<Anteil> anteile(LocalDate von, LocalDate bis) {
        return jdbc.query("""
                SELECT v.messstelle_id, k.kennzeichen, v.anteil_prozent, v.gueltig_ab, v.gueltig_bis,
                       (SELECT count(DISTINCT a.gueltig_ab) FROM messstelle_verteilung a
                         WHERE a.tenant_id = v.tenant_id AND a.messstelle_id = v.messstelle_id
                           AND a.gueltig_ab <= v.gueltig_ab) AS fassung
                  FROM messstelle_verteilung v
                  JOIN kostenstelle k ON k.id = v.kostenstelle_id AND k.tenant_id = v.tenant_id
                 WHERE v.aufgehoben_am IS NULL AND v.gueltig_ab <= ? AND (v.gueltig_bis IS NULL OR v.gueltig_bis >= ?)
                 ORDER BY v.messstelle_id, v.gueltig_ab, k.kennzeichen
                """, (rs, n) -> new Anteil(rs.getObject("messstelle_id", UUID.class), rs.getString("kennzeichen"),
                        rs.getBigDecimal("anteil_prozent"), rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class), rs.getInt("fassung")),
                bis, von);
    }

    /** Alle Kostenstellen des Kundenbereichs, beendete eingeschlossen. */
    public List<Ziel> ziele() {
        return jdbc.query("SELECT kennzeichen, gueltig_ab, gueltig_bis FROM kostenstelle ORDER BY kennzeichen",
                (rs, n) -> new Ziel(rs.getString("kennzeichen"), rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class)));
    }

    /** Das Kennzeichen jeder Kostenstelle nach ihrer Kennung — das Ziel eines Verteilungs-Terms trägt die Kennung. */
    public Map<UUID, String> kennzeichenDerZiele() {
        Map<UUID, String> raus = new HashMap<>();
        jdbc.query("SELECT id, kennzeichen FROM kostenstelle",
                rs -> {
                    raus.put(rs.getObject("id", UUID.class), rs.getString("kennzeichen"));
                });
        return raus;
    }

    /** Die Zeitzone des Unternehmens — {@code null} ohne Unternehmen. */
    public String zeitzone() {
        return jdbc.queryForList("SELECT zeitzone FROM unternehmen ORDER BY created_at, id LIMIT 1", String.class)
                .stream().findFirst().orElse(null);
    }

    /**
     * Die Tageswerte ab Version 2 einer Reihe ({@code messstelle == null}) oder einer berechneten Messstelle, je Tag
     * alle Versionen bis {@code hoechstens} ({@code null} = alle) — die Auswahl der neuesten trifft der Dienst.
     */
    public List<Version> versionen(UUID entityId, String messkanal, UUID messstelle, LocalDate von, LocalDate bis,
            Integer hoechstens) {
        String spur = messstelle == null ? "entity_id = ? AND messkanal = ? AND messstelle_id IS NULL"
                : "messstelle_id = ?";
        Object[] args = messstelle == null
                ? new Object[] {entityId, messkanal, von, bis, hoechstens == null ? Integer.MAX_VALUE : hoechstens}
                : new Object[] {messstelle, von, bis, hoechstens == null ? Integer.MAX_VALUE : hoechstens};
        return jdbc.query("SELECT entity_id, messkanal, messstelle_id, tag, version, menge, menge_zustand, "
                + "abdeckung_prozent, kennzeichen::text AS kennzeichen, anlass_kennung, created_at "
                + "FROM messreihe_periode_version WHERE ebene = 'tag' AND " + spur
                + " AND tag BETWEEN ? AND ? AND version <= ? ORDER BY tag, version",
                (rs, n) -> new Version(rs.getObject("entity_id", UUID.class), rs.getString("messkanal"),
                        rs.getObject("messstelle_id", UUID.class), rs.getObject("tag", LocalDate.class),
                        rs.getInt("version"), rs.getBigDecimal("menge"), rs.getString("menge_zustand"),
                        (Integer) rs.getObject("abdeckung_prozent"), rs.getString("kennzeichen"),
                        rs.getString("anlass_kennung"), zeit(rs.getTimestamp("created_at"))),
                args);
    }

    private static Instant zeit(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
