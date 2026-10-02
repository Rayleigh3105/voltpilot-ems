package com.voltpilot.api.mispel;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Was der {@link MispelMonatslaufLaeufer} vor dem Rechnen fragt, unter RLS: welche Anlagen des Kundenbereichs je eine
 * Fassung in der Abgrenzungsoption hatten ({@code site_foerderweg}, MP-5) und ob seit einem Lauf Werte des
 * Messstellenbetreibers für eine Messstelle der Anlage eingelesen wurden ({@code mispel_msb_import}, MP-15).
 * MiSpeL MP-8b.
 */
@Repository
public class MispelMonatslaufRepository {

    private final JdbcTemplate jdbc;

    public MispelMonatslaufRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Anlagen mit mindestens einer wirksamen Fassung „marktpraemie_abgrenzung“ — die Kandidaten des Monatslaufs. */
    public List<UUID> anlagenMitAbgrenzung() {
        return List.copyOf(jdbc.queryForList("SELECT DISTINCT site_id FROM site_foerderweg WHERE aufgehoben_am IS NULL "
                + "AND foerderweg = 'marktpraemie_abgrenzung' ORDER BY site_id", UUID.class));
    }

    /**
     * Ob nach {@code seit} ein Import des Messstellenbetreibers {@code [von, bis)} überdeckt — an einer Messstelle, die
     * irgendwann an dieser Anlage stand ({@code messstelle_stellung}). Ein endgültiger Lauf rechnet dann neu.
     */
    public boolean msbWerteSeit(UUID siteId, Instant von, Instant bis, Instant seit) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM mispel_msb_import i "
                + "WHERE i.importiert_am > ? AND i.von < ? AND i.bis > ? AND i.messstelle_id IN "
                + "(SELECT s.messstelle_id FROM messstelle_stellung s WHERE s.site_id = ?))", Boolean.class,
                Timestamp.from(seit), Timestamp.from(bis), Timestamp.from(von), siteId));
    }
}
