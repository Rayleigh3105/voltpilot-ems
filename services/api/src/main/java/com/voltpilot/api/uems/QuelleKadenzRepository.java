package com.voltpilot.api.uems;

import com.voltpilot.api.uems.ErwarteteKadenz.Messkanal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Kadenz-Fassungen je Quellenbindung ({@code quelle_kadenz}, Migration V20260912160000) —
 * unter RLS: eine fremde Fassung ist hier schlicht nicht da.
 *
 * <p>Geschrieben wird nur angelegt und beendet: die App-Rolle darf an einer Fassung allein
 * {@code gueltig_bis} setzen, und ein Trigger lässt es nur verkürzen. Welche Fassung wann endet,
 * entscheidet {@link KadenzRegeln}, nicht diese Klasse.
 */
@Repository
public class QuelleKadenzRepository {

    private static final String SPALTEN = "id, messstelle_quelle_id, erwartet_s, herkunft, gueltig_ab, "
            + "gueltig_bis, rueckwirkend, begruendung, actor_sub, actor_name, actor_rolle, actor_art, "
            + "eingetragen_am";

    private final JdbcTemplate jdbc;

    public QuelleKadenzRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine gespeicherte Fassung, mit allem, was die Schnittstelle über sie sagt. */
    public record Zeile(UUID id, UUID quelleId, int erwartetS, String herkunft, Instant gueltigAb,
            Instant gueltigBis, boolean rueckwirkend, String begruendung, String actorSub, String actorName,
            String actorRolle, String actorArt, Instant eingetragenAm) {

        /** Dieselbe Zeile in der Form, in der {@link KadenzRegeln} urteilt. */
        public KadenzRegeln.Fassung fuerRegeln() {
            return new KadenzRegeln.Fassung(id.toString(), erwartetS, gueltigAb, gueltigBis);
        }
    }

    /** Eine neue Fassung, wie sie geschrieben wird. */
    public record NeueFassung(UUID tenantId, UUID quelleId, int erwartetS, String herkunft, Instant gueltigAb,
            Instant gueltigBis, boolean rueckwirkend, String begruendung, ProtokollAkteur akteur,
            Instant eingetragenAm) {}

    /** Alle Fassungen EINER Bindung, die früheste zuerst. */
    public List<Zeile> derBindung(UUID quelleId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM quelle_kadenz WHERE messstelle_quelle_id = ? "
                + "ORDER BY gueltig_ab, id", QuelleKadenzRepository::zeile, quelleId);
    }

    /**
     * Die zum {@code zeitpunkt} geltende Fassung DIESER Bindungen — der Leseweg der Beobachtung.
     * Eine Bindung ohne Fassung fehlt in der Karte.
     */
    public Map<UUID, Integer> jeBindung(Collection<UUID> quelleIds, Instant zeitpunkt) {
        if (quelleIds.isEmpty()) {
            return Map.of();
        }
        UUID[] ids = quelleIds.toArray(UUID[]::new);
        Map<UUID, Integer> out = new LinkedHashMap<>();
        jdbc.query(con -> {
            var ps = con.prepareStatement("""
                    SELECT k.messstelle_quelle_id, k.erwartet_s
                      FROM quelle_kadenz k
                      JOIN unnest(?::uuid[]) AS p(id) ON p.id = k.messstelle_quelle_id
                     WHERE k.gueltig_ab <= ? AND (k.gueltig_bis IS NULL OR k.gueltig_bis > ?)
                    """);
            ps.setArray(1, con.createArrayOf("uuid", ids));
            ps.setTimestamp(2, Timestamp.from(zeitpunkt));
            ps.setTimestamp(3, Timestamp.from(zeitpunkt));
            return ps;
        }, (ResultSet rs) -> {
            out.put(rs.getObject(1, UUID.class), rs.getInt(2));
        });
        return Map.copyOf(out);
    }

    /**
     * Die zum {@code zeitpunkt} geltenden Fassungen dieser MESSKANÄLE, je Kanal die SCHNELLSTE über
     * alle Bindungen, die dann laufen (siehe {@link ErwarteteKadenz}) — der Leseweg des Publishers.
     */
    public Map<Messkanal, Integer> jeKanal(Collection<Messkanal> kanaele, Instant zeitpunkt) {
        if (kanaele.isEmpty()) {
            return Map.of();
        }
        List<Messkanal> liste = List.copyOf(kanaele);
        UUID[] komponenten = liste.stream().map(Messkanal::entityId).toArray(UUID[]::new);
        String[] namen = liste.stream().map(Messkanal::kanal).toArray(String[]::new);
        Map<Messkanal, Integer> out = new LinkedHashMap<>();
        jdbc.query(con -> {
            var ps = con.prepareStatement("""
                    SELECT q.entity_id, q.kanal, min(k.erwartet_s) AS erwartet_s
                      FROM messstelle_quelle q
                      JOIN unnest(?::uuid[], ?::text[]) AS p(komponente, kanal)
                        ON p.komponente = q.entity_id AND p.kanal = q.kanal
                      JOIN quelle_kadenz k ON k.messstelle_quelle_id = q.id
                     WHERE q.gueltig_ab <= ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?)
                       AND k.gueltig_ab <= ? AND (k.gueltig_bis IS NULL OR k.gueltig_bis > ?)
                     GROUP BY q.entity_id, q.kanal
                    """);
            ps.setArray(1, con.createArrayOf("uuid", komponenten));
            ps.setArray(2, con.createArrayOf("text", namen));
            Timestamp t = Timestamp.from(zeitpunkt);
            ps.setTimestamp(3, t);
            ps.setTimestamp(4, t);
            ps.setTimestamp(5, t);
            ps.setTimestamp(6, t);
            return ps;
        }, (ResultSet rs) -> {
            out.put(new Messkanal(rs.getObject(1, UUID.class), rs.getString(2)), rs.getInt(3));
        });
        return Map.copyOf(out);
    }

    /**
     * Sperrt die Messstelle bis zum Ende der Transaktion: zwei Einträge an derselben Bindung warten
     * aufeinander, statt beide „die laufende" Fassung zu beenden. {@code false}, wenn es sie (für
     * den Aufrufer) nicht gibt.
     */
    public boolean sperreMessstelle(UUID messstelleId) {
        return !jdbc.queryForList("SELECT id FROM messstelle WHERE id = ? FOR UPDATE", UUID.class, messstelleId)
                .isEmpty();
    }

    public UUID anlegen(NeueFassung f) {
        ProtokollAkteur a = f.akteur();
        return jdbc.queryForObject("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, "
                + "herkunft, gueltig_ab, gueltig_bis, rueckwirkend, begruendung, actor_sub, actor_name, "
                + "actor_rolle, actor_art, eingetragen_am) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                UUID.class, f.tenantId(), f.quelleId(), f.erwartetS(), f.herkunft(),
                Timestamp.from(f.gueltigAb()), ts(f.gueltigBis()), f.rueckwirkend(), f.begruendung(),
                a.sub(), a.name(), a.rolle(), a.art(), Timestamp.from(f.eingetragenAm()));
    }

    /** Beendet eine Fassung bei {@code bis} (verkürzt sie — länger wird sie nie). */
    public void beenden(UUID id, Instant bis) {
        jdbc.update("UPDATE quelle_kadenz SET gueltig_bis = ? WHERE id = ?", Timestamp.from(bis), id);
    }

    private static Zeile zeile(ResultSet rs, int n) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getObject("messstelle_quelle_id", UUID.class),
                rs.getInt("erwartet_s"), rs.getString("herkunft"), zeit(rs, "gueltig_ab"),
                zeit(rs, "gueltig_bis"), rs.getBoolean("rueckwirkend"), rs.getString("begruendung"),
                rs.getString("actor_sub"), rs.getString("actor_name"), rs.getString("actor_rolle"),
                rs.getString("actor_art"), zeit(rs, "eingetragen_am"));
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
