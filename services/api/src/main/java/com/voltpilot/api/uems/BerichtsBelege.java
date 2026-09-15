package com.voltpilot.api.uems;

import java.sql.PreparedStatement;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Welche freigegebenen Berichtsstände zitieren, was ein harter Löschweg wegnähme? (UEMS AP-12 E13 S2, IP-12)
 *
 * <p>Ein Berichtsstand zitiert Messstellen ({@code bericht_quelle.objekt_id} — unmittelbar, mittelbar, als
 * Vergleich), nie eine Komponente, eine Box oder eine Anlage. Die Regel „welcher Stand zitiert dieses Objekt“
 * steht EINMAL in der Datenbank-Funktion {@code uems_berichts_belege} (V20260915050000: auch ein ersetzter Stand,
 * nie ein Entwurf); hier steht nur der Weg vom Löschgegenstand zu seinen Messstellen:
 * <ul>
 *   <li><b>Komponente</b>: jede Messstelle, deren Quelle sie JE war — laufende oder beendete Bindung, das
 *       Protokoll {@code quelle_gebunden} (es überlebt die Bindungs-Zeile) oder ein Messkanal-Term einer Formel;
 *       dieselbe Menge wie {@code uems_messreihen_belege}. Eine beendete Bindung schützt also weiter: der Stand
 *       zitiert die Zeit, in der sie lief.</li>
 *   <li><b>Anlage, Box</b>: die Messstellen aus {@link MessreihenBelege} — die Liste, die diese Wege schon
 *       heute sperrt. Ohne Messstellen-Beleg gibt es dort keinen Berichts-Beleg.</li>
 * </ul>
 *
 * <p>Die Antwort ist die LISTE der Stände, nie ein Ja/Nein. Unter RLS zählen nur die des eigenen Kundenbereichs.
 */
@Repository
public class BerichtsBelege {

    /** Was eine Komponente schützt: die zitierten Messstellen, deren Quelle sie war, und die Stände. */
    public record Komponente(List<MessreihenBelege.Beleg> messstellen, List<BerichtRegeln.StandBezeichnung> staende) {
    }

    private static final Comparator<BerichtRegeln.StandBezeichnung> REIHENFOLGE =
            Comparator.comparing(BerichtRegeln.StandBezeichnung::kennung).thenComparingInt(BerichtRegeln.StandBezeichnung::nr);

    private static final String DER_MESSSTELLEN = """
            SELECT DISTINCT b.kennung, b.nr
              FROM unnest(?::uuid[]) AS m(id)
             CROSS JOIN LATERAL uems_berichts_belege(m.id) b
             ORDER BY b.kennung, b.nr
            """;

    private static final String DER_KOMPONENTE = """
            WITH gespeist AS (
                SELECT q.messstelle_id FROM messstelle_quelle q WHERE q.entity_id = ?
                UNION
                SELECT a.messstelle_id FROM messstelle_aenderung a
                 WHERE a.art = 'quelle_gebunden' AND a.neu->>'kanal' IS NOT NULL
                   AND lower(a.neu->>'komponente') = ?
                UNION
                SELECT t.messstelle_id FROM messstelle_formel_term t
                 WHERE t.entity_id = ? AND t.point_key IS NOT NULL
            )
            SELECT m.id, m.kennzeichen, m.name, b.kennung, b.nr
              FROM gespeist g
              JOIN messstelle m ON m.id = g.messstelle_id
             CROSS JOIN LATERAL uems_berichts_belege(m.id) b
             WHERE EXISTS (SELECT 1 FROM measurement_point p WHERE p.id = ? AND p.site_id = ?)
             ORDER BY m.kennzeichen, m.id
            """;

    private final JdbcTemplate jdbc;

    public BerichtsBelege(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die freigegebenen Stände, die eine dieser Messstellen zitieren — leer: keine. */
    public List<BerichtRegeln.StandBezeichnung> derMessstellen(Collection<MessreihenBelege.Beleg> messstellen) {
        if (messstellen.isEmpty()) {
            return List.of();
        }
        UUID[] ids = messstellen.stream().map(MessreihenBelege.Beleg::id).distinct().toArray(UUID[]::new);
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement(DER_MESSSTELLEN);
            ps.setArray(1, con.createArrayOf("uuid", ids));
            return ps;
        }, (rs, n) -> new BerichtRegeln.StandBezeichnung(rs.getString("kennung"), rs.getInt("nr")));
    }

    /** Was die Komponente dieser Anlage schützt — beide Listen leer: sie ist kein Beleg. */
    public Komponente derKomponente(UUID siteId, UUID entityId) {
        Map<UUID, MessreihenBelege.Beleg> messstellen = new LinkedHashMap<>();
        TreeSet<BerichtRegeln.StandBezeichnung> staende = new TreeSet<>(REIHENFOLGE);
        jdbc.query(DER_KOMPONENTE, rs -> {
            UUID id = rs.getObject("id", UUID.class);
            messstellen.putIfAbsent(id, new MessreihenBelege.Beleg(id, rs.getString("kennzeichen"), rs.getString("name")));
            staende.add(new BerichtRegeln.StandBezeichnung(rs.getString("kennung"), rs.getInt("nr")));
        }, entityId, entityId.toString().toLowerCase(java.util.Locale.ROOT), entityId, entityId, siteId);
        return new Komponente(List.copyOf(messstellen.values()), List.copyOf(staende));
    }

    /**
     * Die Prüfung VOR dem ersten Schreiben jedes Wegs, der die Komponente löscht (Komponente löschen, Batterie am
     * Standort abmelden, Verbraucher entfernen).
     *
     * @throws BelegeImWeg {@code 409 berichts_belege} mit der Liste der Stände, wenn ein freigegebener Stand eine
     *     Messstelle zitiert, deren Quelle die Komponente war
     */
    public void pruefeKomponente(UUID siteId, UUID entityId) {
        Komponente k = derKomponente(siteId, entityId);
        if (!k.staende().isEmpty()) {
            throw new BelegeImWeg(BelegeImWeg.Gegenstand.KOMPONENTE, k.messstellen(), k.staende());
        }
    }
}
