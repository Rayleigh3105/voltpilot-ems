package com.voltpilot.api.uems;

import java.math.BigDecimal;
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
 * Die Quellenbindungen der Messstellen ({@code messstelle_quelle}, Migration V20260911250000) —
 * unter RLS: eine fremde Bindung ist hier schlicht nicht da.
 *
 * <p>Eine Zeile ist EINE Bindung einer Größe an EINEN Messkanal (Komponente + Einbau + Kanal).
 * Sie wird angelegt und genau einmal beendet — nie überschrieben, nie gelöscht (Trigger und
 * Spaltenrechte der Migration). Ob sie das darf, urteilt {@link MessstelleRegeln}; hier steht nur
 * das Lesen und Schreiben.
 */
@Repository
public class MessstelleQuelleRepository {

    private static final String SPALTEN = "q.id, q.messstelle_id, m.kennzeichen AS messstelle, q.groesse, "
            + "q.richtung, q.entity_id, p.site_id, p.label AS komponente_name, q.geraet_id, "
            + "g.kennzeichen AS geraet, g.einbau_kennzeichen AS einbau, q.kanal, q.kanal_wertart, "
            + "q.herleitung, q.rolle, q.zweck, q.gueltig_ab, q.gueltig_bis, q.anfangsstand, "
            + "q.anfangsstand_einheit, q.endstand, q.endstand_einheit, q.rueckwirkend, q.herkunft, "
            + "q.eingetragen_am, q.actor_name, q.anteil";
    private static final String VON = " FROM messstelle_quelle q JOIN messstelle m ON m.id = q.messstelle_id "
            + "JOIN geraet g ON g.id = q.geraet_id JOIN measurement_point p ON p.id = q.entity_id ";
    /** Hauptgröße vor Nebengrößen ist Sache der Darstellung; hier: je Größe nach Rolle und Beginn. */
    private static final String REIHENFOLGE = " ORDER BY q.groesse, q.richtung, q.rolle, q.gueltig_ab, q.id";

    private final JdbcTemplate jdbc;

    public MessstelleQuelleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein abgelesener Stand; {@code einheit} darf fehlen. */
    public record Stand(double wert, String einheit) {}

    /**
     * Eine Bindung, wie sie gespeichert ist — mit dem Kennzeichen der Messstelle, der Anlage und
     * dem Namen der Komponente und Gerät + Einbau des Messkanals. {@code anteil}: {@code null} = der
     * ganze Wert, sonst {@code positiv}/{@code negativ} eines Vorzeichen-Werts (AP-08 IP-7).
     */
    public record Quelle(UUID id, UUID messstelleId, String messstelle, String groesse, String richtung,
            UUID entityId, UUID siteId, String komponenteName, UUID geraetId, String geraet, String einbau,
            String kanal, String kanalWertart, String herleitung, String rolle, String zweck,
            Instant gueltigAb, Instant gueltigBis, Stand anfangsstand, Stand endstand, boolean rueckwirkend,
            String herkunft, Instant eingetragenAm, String eingetragenVon, String anteil) {}

    /**
     * {@code herkunft}: {@code null} = von Hand gebunden, {@code bestandsuebernahme} = aus der Liste (IP-16);
     * {@code anteil}: {@code null} = der ganze Wert (AP-08 IP-7).
     */
    public record NeueQuelle(UUID tenantId, UUID messstelleId, String groesse, String richtung, UUID entityId,
            UUID geraetId, String kanal, String kanalWertart, String herleitung, String rolle, String zweck,
            Instant gueltigAb, Instant gueltigBis, Stand anfangsstand, boolean rueckwirkend, String herkunft,
            Instant eingetragenAm, ProtokollAkteur wer, String anteil) {}

    public UUID anlegen(NeueQuelle q) {
        return jdbc.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, zweck, gueltig_ab, gueltig_bis, "
                + "anfangsstand, anfangsstand_einheit, rueckwirkend, herkunft, eingetragen_am, actor_sub, "
                + "actor_name, actor_rolle, actor_art, anteil) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                + "RETURNING id",
                UUID.class, q.tenantId(), q.messstelleId(), q.groesse(), q.richtung(), q.entityId(),
                q.geraetId(), q.kanal(), q.kanalWertart(), q.herleitung(), q.rolle(), q.zweck(),
                Timestamp.from(q.gueltigAb()), zeit(q.gueltigBis()), wert(q.anfangsstand()),
                q.anfangsstand() == null ? null : q.anfangsstand().einheit(), q.rueckwirkend(), q.herkunft(),
                Timestamp.from(q.eingetragenAm()), q.wer().sub(), q.wer().name(), q.wer().rolle(), q.wer().art(),
                q.anteil());
    }

    /**
     * Beendet eine OFFENE Bindung. {@code false}, wenn sie inzwischen beendet ist (oder fremd) —
     * die Datenbank beendet eine Bindung ohnehin nur einmal.
     */
    public boolean beenden(UUID id, Instant bis, Stand endstand) {
        return jdbc.update("UPDATE messstelle_quelle SET gueltig_bis = ?, endstand = ?, endstand_einheit = ? "
                + "WHERE id = ? AND gueltig_bis IS NULL", Timestamp.from(bis), wert(endstand),
                endstand == null ? null : endstand.einheit(), id) == 1;
    }

    public Optional<Quelle> eine(UUID messstelleId, UUID id) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE q.id = ? AND q.messstelle_id = ?",
                MessstelleQuelleRepository::quelle, id, messstelleId).stream().findFirst();
    }

    /** Alle Bindungen der Messstelle, beendete eingeschlossen. */
    public List<Quelle> derMessstelle(UUID messstelleId) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE q.messstelle_id = ?" + REIHENFOLGE,
                MessstelleQuelleRepository::quelle, messstelleId);
    }

    /** Alle Bindungen des Kundenbereichs — für das Register. */
    public List<Quelle> alle() {
        return jdbc.query("SELECT " + SPALTEN + VON + REIHENFOLGE, MessstelleQuelleRepository::quelle);
    }

    /**
     * Die führenden Bindungen desselben Messwerts (Komponente + Kanal) an ANDEREN Messstellen —
     * der Eingang von {@code kanal_bereits_fuehrend}.
     */
    public List<Quelle> fuehrendAnderswo(UUID entityId, String kanal, UUID messstelleId) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE q.entity_id = ? AND q.kanal = ? AND q.rolle = 'fuehrend' "
                + "AND q.messstelle_id <> ?" + REIHENFOLGE, MessstelleQuelleRepository::quelle, entityId, kanal,
                messstelleId);
    }

    /**
     * Alle Bindungen, die aus DIESEM Einbau lesen (führend wie Vergleich) und zum Zeitpunkt schon
     * begonnen haben — beendete eingeschlossen: der Zählerwechsel (IP-17) muss auch die sehen, die
     * schon beendet sind, um sie nicht ein zweites Mal zu beenden.
     */
    public List<Quelle> desEinbausAb(UUID geraetId, Instant zeitpunkt) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE q.geraet_id = ? AND q.gueltig_ab <= ?" + REIHENFOLGE,
                MessstelleQuelleRepository::quelle, geraetId, Timestamp.from(zeitpunkt));
    }

    /** Die Bindungen dieses Einbaus, die NACH dem Zeitpunkt erst beginnen (angekündigt). */
    public List<Quelle> desEinbausNach(UUID geraetId, Instant zeitpunkt) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE q.geraet_id = ? AND q.gueltig_ab > ?" + REIHENFOLGE,
                MessstelleQuelleRepository::quelle, geraetId, Timestamp.from(zeitpunkt));
    }

    /** Die Bindungen der Komponente, die zum Zeitpunkt laufen — „speist MS-06 (führend)“. */
    public List<Quelle> derKomponenteAm(UUID entityId, Instant zeitpunkt) {
        Timestamp t = Timestamp.from(zeitpunkt);
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE q.entity_id = ? AND q.gueltig_ab <= ? "
                + "AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?) ORDER BY q.kanal, m.kennzeichen, q.rolle, "
                + "q.groesse, q.richtung", MessstelleQuelleRepository::quelle, entityId, t, t);
    }

    private static Quelle quelle(ResultSet rs, int n) throws SQLException {
        return new Quelle(rs.getObject("id", UUID.class), rs.getObject("messstelle_id", UUID.class),
                rs.getString("messstelle"), rs.getString("groesse"), rs.getString("richtung"),
                rs.getObject("entity_id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getString("komponente_name"), rs.getObject("geraet_id", UUID.class), rs.getString("geraet"),
                rs.getString("einbau"), rs.getString("kanal"), rs.getString("kanal_wertart"),
                rs.getString("herleitung"), rs.getString("rolle"), rs.getString("zweck"),
                zeit(rs, "gueltig_ab"), zeit(rs, "gueltig_bis"),
                stand(rs.getBigDecimal("anfangsstand"), rs.getString("anfangsstand_einheit")),
                stand(rs.getBigDecimal("endstand"), rs.getString("endstand_einheit")),
                rs.getBoolean("rueckwirkend"), rs.getString("herkunft"), zeit(rs, "eingetragen_am"),
                rs.getString("actor_name"), rs.getString("anteil"));
    }

    private static Stand stand(BigDecimal wert, String einheit) {
        return wert == null ? null : new Stand(wert.doubleValue(), einheit);
    }

    private static BigDecimal wert(Stand s) {
        return s == null ? null : BigDecimal.valueOf(s.wert());
    }

    private static Timestamp zeit(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
