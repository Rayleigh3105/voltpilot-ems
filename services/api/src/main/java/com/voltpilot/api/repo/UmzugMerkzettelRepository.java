package com.voltpilot.api.repo;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Merkzettel „Neues Haus? Bitte prüfen: Solaranlage, Stromtarif, Einspeisevergütung" nach
 * einem Umzug (vp-standort-konzept §7, E1 = B, Bericht 6.6 Punkt 7) — EINE Zeile je Anlage
 * ({@code anlage_umzug_merkzettel}, Migration {@code V20261127140000}), je Anlage gespeichert und
 * auf jedem Gerät sichtbar. „Geprüft" und „weggeklickt" sind dieselbe Handlung — ein Tipp auf den
 * jeweiligen Chip setzt seinen Haken; „geändert" für Stromtarif/Einspeisevergütung liest
 * {@link PreisfassungRepository} zur Anzeige, ohne eine eigene Spalte zu führen.
 */
@Repository
public class UmzugMerkzettelRepository {

    public record Merkzettel(Instant seit, boolean solaranlageErledigt, boolean stromtarifErledigt,
            boolean einspeiseverguetungErledigt) {
    }

    private final JdbcTemplate jdbc;

    public UmzugMerkzettelRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein Umzug ERSETZT eine noch offene Erinnerung vollständig — alle drei Haken wieder auf. */
    public void neuAnlegen(UUID tenantId, UUID siteId) {
        jdbc.update("""
                INSERT INTO anlage_umzug_merkzettel (site_id, tenant_id, seit)
                VALUES (?, ?, now())
                ON CONFLICT (site_id) DO UPDATE SET
                    seit = now(), solaranlage_erledigt = false,
                    stromtarif_erledigt = false, einspeiseverguetung_erledigt = false
                """, siteId, tenantId);
    }

    public Optional<Merkzettel> lesen(UUID siteId) {
        return jdbc.query(
                "SELECT seit, solaranlage_erledigt, stromtarif_erledigt, einspeiseverguetung_erledigt"
                        + " FROM anlage_umzug_merkzettel WHERE site_id = ?",
                rs -> rs.next()
                        ? Optional.of(new Merkzettel(rs.getTimestamp("seit").toInstant(),
                                rs.getBoolean("solaranlage_erledigt"), rs.getBoolean("stromtarif_erledigt"),
                                rs.getBoolean("einspeiseverguetung_erledigt")))
                        : Optional.empty(),
                siteId);
    }

    /** {@code false} ohne eigene Zeile (RLS blendet eine fremde Anlage aus — 404 im Controller). */
    public boolean erledigenSetzen(UUID siteId, MerkzettelTeil teil) {
        String spalte = switch (teil) {
            case solaranlage -> "solaranlage_erledigt";
            case stromtarif -> "stromtarif_erledigt";
            case einspeiseverguetung -> "einspeiseverguetung_erledigt";
        };
        return jdbc.update("UPDATE anlage_umzug_merkzettel SET " + spalte + " = true WHERE site_id = ?", siteId) > 0;
    }

    public enum MerkzettelTeil {
        solaranlage, stromtarif, einspeiseverguetung
    }
}
