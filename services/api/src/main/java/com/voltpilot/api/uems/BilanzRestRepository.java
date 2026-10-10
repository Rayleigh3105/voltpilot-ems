package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Rest-Messstellen (AP-10 IP-9, E3/E18): welche berechnete Messstelle der Rest WELCHES
 * Hauptzählers ist. Gespeichert ist nur dieser eine Parameter an der Fassung
 * ({@code messstelle_formel_fassung.rest_hauptzaehler_id}, {@code V20260913235700}) — die Terme des
 * Rests leitet {@link BilanzAbleitung#restAusStellung} je Tag aus der Stellung ab und speichert sie nie.
 *
 * <p>⚠ Diese Klasse ist die EINZIGE, die die Spalte liest. Die älteren Abfragen der Fassungen
 * ({@link MessstelleFormelFassungRepository}) bleiben unverändert, damit Migrationstests, die sie gegen
 * einen Stand VOR der Spalte stellen, nicht an {@code column … does not exist} scheitern.
 */
@Repository
public class BilanzRestRepository {

    /** Eine Rest-Messstelle mit ihrem Hauptzähler. */
    public record Rest(UUID messstelleId, UUID hauptzaehlerId, UUID fassungId) {}

    private final JdbcTemplate jdbc;

    public BilanzRestRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Rest-Messstelle eines Hauptzählers (nicht aufgehobene Rest-Fassung), sonst leer. */
    public Optional<Rest> vonHauptzaehler(UUID hauptzaehlerId) {
        return jdbc.query("SELECT messstelle_id, rest_hauptzaehler_id, id FROM messstelle_formel_fassung "
                + "WHERE rest_hauptzaehler_id = ? AND aufgehoben_am IS NULL ORDER BY nummer LIMIT 1",
                (rs, n) -> new Rest(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getObject(3, UUID.class)),
                hauptzaehlerId).stream().findFirst();
    }

    /** Der Hauptzähler einer Rest-Fassung; leer, wenn die Fassung keine Rest-Fassung ist. */
    public Optional<UUID> hauptzaehlerDerFassung(UUID fassungId) {
        return jdbc.query("SELECT rest_hauptzaehler_id FROM messstelle_formel_fassung "
                + "WHERE id = ? AND rest_hauptzaehler_id IS NOT NULL",
                (rs, n) -> rs.getObject(1, UUID.class), fassungId).stream().findFirst();
    }

    /** Alle Rest-Messstellen des Mandanten: Hauptzähler → Rest (EIN Lesezug). */
    public Map<UUID, Rest> alle() {
        Map<UUID, Rest> out = new LinkedHashMap<>();
        jdbc.query("SELECT messstelle_id, rest_hauptzaehler_id, id FROM messstelle_formel_fassung "
                + "WHERE rest_hauptzaehler_id IS NOT NULL AND aufgehoben_am IS NULL ORDER BY nummer",
                rs -> {
                    Rest r = new Rest(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                            rs.getObject(3, UUID.class));
                    out.putIfAbsent(r.hauptzaehlerId(), r);
                });
        return out;
    }

    /**
     * Die wirksamen Fassungen gegebener berechneter Messstellen mit ihrem Rest-Hauptzähler — der
     * Register-Zug (AP-10 IP-9): EINE Abfrage für alle berechneten Zeilen, nie je Zeile.
     */
    public List<FassungMitRest> fassungen(List<UUID> messstellen) {
        if (messstellen.isEmpty()) {
            return List.of();
        }
        return jdbc.query(con -> {
            var ps = con.prepareStatement("SELECT id, messstelle_id, nummer, formel_typ, gueltig_ab, gueltig_bis, "
                    + "rest_hauptzaehler_id FROM messstelle_formel_fassung "
                    + "WHERE messstelle_id = ANY (?) AND aufgehoben_am IS NULL ORDER BY messstelle_id, nummer");
            ps.setArray(1, con.createArrayOf("uuid", messstellen.toArray()));
            return ps;
        }, (rs, n) -> new FassungMitRest(rs.getObject("id", UUID.class), rs.getObject("messstelle_id", UUID.class),
                rs.getInt("nummer"), rs.getString("formel_typ"),
                rs.getObject("gueltig_ab", LocalDate.class),
                rs.getObject("gueltig_bis", LocalDate.class),
                rs.getObject("rest_hauptzaehler_id", UUID.class)));
    }

    /** Eine wirksame Fassung mit ihrem Rest-Hauptzähler ({@code null} = keine Rest-Fassung). */
    public record FassungMitRest(UUID id, UUID messstelleId, int nummer, String formelTyp,
            LocalDate gueltigAb, LocalDate gueltigBis, UUID restHauptzaehlerId) {

        MessstelleFormelRegeln.Fassung alsRegel() {
            return new MessstelleFormelRegeln.Fassung(nummer, gueltigAb, gueltigBis);
        }
    }

    /**
     * Serialisiert „Rest anlegen“ für EINEN Hauptzähler bis zum Ende der Transaktion: zwei Menschen,
     * die gleichzeitig klicken, legen nacheinander an — der zweite sieht den ersten. Der eindeutige
     * Teil-Index {@code messstelle_formel_fassung_ein_rest_je_hauptzaehler} ist die Wand dahinter.
     */
    public void sperren(UUID hauptzaehlerId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> { },
                "uems_rest_hauptzaehler:" + TenantContext.get() + ":" + hauptzaehlerId);
    }

    /** Legt die Fassung 1 einer Rest-Messstelle an (ohne ersten Tag, ohne Terme). */
    public UUID fassungAnlegen(UUID messstelleId, UUID hauptzaehlerId, Instant eingetragenAm, ProtokollAkteur wer) {
        return jdbc.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, "
                + "formel_typ, gueltig_ab, herkunft, rueckwirkend, begruendung, actor_sub, actor_name, "
                + "actor_rolle, actor_art, eingetragen_am, rest_hauptzaehler_id) "
                + "VALUES (?, ?, 1, 'rest', NULL, 'anlage', false, NULL, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, TenantContext.get(), messstelleId, wer.sub(), wer.name(), wer.rolle(), wer.art(),
                Timestamp.from(eingetragenAm), hauptzaehlerId);
    }
}
