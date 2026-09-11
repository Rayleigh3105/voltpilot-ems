package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die zeitgültigen Zuordnungen der Messstelle zu Ort und elektrischer Stellung
 * ({@code messstelle_ort}, {@code messstelle_stellung}, Migration V20260911230000), unter RLS.
 *
 * <p>Dieselbe Mechanik wie {@link OrtZuordnungRepository} (Vertrag
 * {@code docs/contracts/v2/ortsbaum-vectors.json}): „gültig ab" ist ein Tag,
 * {@code gueltigBis} der LETZTE gültige Tag (einschließlich, {@code null} = offen); erst
 * beenden bzw. aufheben, dann eintragen — umgekehrt lehnt das Überlappungsverbot ab. Welche
 * Einträge erlaubt sind, urteilt {@link MessstelleZuordnungService}, bevor er hier schreibt.
 * Eine Zeile wird nie gelöscht und nie umgeschrieben: die App-Rolle darf nur
 * {@code gueltig_bis} und {@code aufgehoben_am} ändern.
 */
@Repository
public class MessstelleZuordnungRepository {

    /** Das Ziel eines Orts, wie der Vertrag es nennt ({@code $defs/ortArt}). */
    public static final String UNTERNEHMEN = "unternehmen";
    public static final String STANDORT = "standort";

    private static final String ORT_SELECT = "SELECT mo.id, mo.messstelle_id, mo.unternehmen_id, "
            + "mo.standort_id, mo.ort_id, s.kurzzeichen AS standort_kz, o.kurzzeichen AS ort_kz, "
            + "o.art AS ort_art, mo.gueltig_ab, mo.gueltig_bis, mo.aufgehoben_am, mo.created_at "
            + "FROM messstelle_ort mo LEFT JOIN standort s ON s.id = mo.standort_id "
            + "LEFT JOIN ort o ON o.id = mo.ort_id ";
    private static final String ORT_ORDNUNG = " ORDER BY mo.messstelle_id, mo.gueltig_ab, mo.created_at, mo.id";

    private static final String STELLUNG_SELECT = "SELECT ms.id, ms.messstelle_id, ms.site_id, "
            + "ms.stellung, ms.unterzaehler_von, b.kennzeichen AS bezug_kz, ms.gueltig_ab, "
            + "ms.gueltig_bis, ms.aufgehoben_am, ms.created_at FROM messstelle_stellung ms "
            + "LEFT JOIN messstelle b ON b.id = ms.unterzaehler_von ";
    private static final String STELLUNG_ORDNUNG =
            " ORDER BY ms.messstelle_id, ms.gueltig_ab, ms.created_at, ms.id";

    private final JdbcTemplate jdbc;

    public MessstelleZuordnungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein Intervall, gleich welcher Zuordnung: sein Tag-Zeitraum und ob es aufgehoben ist. */
    public interface Tagesintervall {
        UUID id();

        LocalDate gueltigAb();

        LocalDate gueltigBis();

        Instant aufgehobenAm();

        default boolean aufgehoben() {
            return aufgehobenAm() != null;
        }

        default boolean deckt(LocalDate tag) {
            return !gueltigAb().isAfter(tag) && (gueltigBis() == null || !tag.isAfter(gueltigBis()));
        }
    }

    /**
     * Ein Ort-Intervall. {@code zielArt} ist das Wort des Vertrags ({@code unternehmen} ·
     * {@code standort} · {@code gebaeude} · {@code bereich}), {@code kennzeichen} das
     * Kurzzeichen des Ziels bzw. {@link OrtsbaumAbleitung#UNTERNEHMEN}.
     */
    public record OrtZeile(UUID id, UUID messstelleId, String zielArt, UUID zielId, String kennzeichen,
            LocalDate gueltigAb, LocalDate gueltigBis, Instant aufgehobenAm, Instant createdAt)
            implements Tagesintervall {}

    /** Ein Stellungs-Intervall; {@code unterzaehlerVonKennzeichen} ist das HEUTIGE Kennzeichen des Bezugs. */
    public record StellungZeile(UUID id, UUID messstelleId, UUID siteId, String stellung,
            UUID unterzaehlerVon, String unterzaehlerVonKennzeichen, LocalDate gueltigAb,
            LocalDate gueltigBis, Instant aufgehobenAm, Instant createdAt) implements Tagesintervall {}

    // ---------------------------------------------------------------- lesen

    /** Die Ort-Intervalle EINER Messstelle, aufgehobene eingeschlossen, nach Beginn — leer für eine fremde. */
    public List<OrtZeile> orte(UUID messstelleId) {
        return List.copyOf(jdbc.query(ORT_SELECT + "WHERE mo.messstelle_id = ?" + ORT_ORDNUNG,
                MessstelleZuordnungRepository::ort, messstelleId));
    }

    /** Alle Ort-Intervalle des Mandanten — EIN Lesezug für Liste und Ortsbaum. */
    public List<OrtZeile> orteAlle() {
        return List.copyOf(jdbc.query(ORT_SELECT + ORT_ORDNUNG, MessstelleZuordnungRepository::ort));
    }

    public List<StellungZeile> stellungen(UUID messstelleId) {
        return List.copyOf(jdbc.query(STELLUNG_SELECT + "WHERE ms.messstelle_id = ?" + STELLUNG_ORDNUNG,
                MessstelleZuordnungRepository::stellung, messstelleId));
    }

    public List<StellungZeile> stellungenAlle() {
        return List.copyOf(jdbc.query(STELLUNG_SELECT + STELLUNG_ORDNUNG, MessstelleZuordnungRepository::stellung));
    }

    // -------------------------------------------------------------- schreiben

    /**
     * Serialisiert die Zuordnungs-Schreibwege EINES Kundenbereichs bis zum Ende der Transaktion:
     * die Regeln über mehrere Messstellen (ein Hauptzähler je Anlage und Richtung, kein Zyklus)
     * urteilen über einen Stand, den kein zweiter Schreiber dazwischen verändert.
     */
    public void sperren(UUID tenantId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> { },
                "messstelle_zuordnung:" + tenantId);
    }

    /** Ein Ort ab {@code gueltigAb}: genau eines von Unternehmen, Standort, Ort (nach {@code zielArt}). */
    public UUID ortEintragen(UUID tenantId, UUID messstelleId, String zielArt, UUID zielId,
            LocalDate gueltigAb, LocalDate gueltigBis, String createdBy) {
        return jdbc.queryForObject("INSERT INTO messstelle_ort (tenant_id, messstelle_id, unternehmen_id, "
                + "standort_id, ort_id, gueltig_ab, gueltig_bis, created_by) VALUES (?,?,?,?,?,?,?,?) "
                + "RETURNING id", UUID.class, tenantId, messstelleId,
                UNTERNEHMEN.equals(zielArt) ? zielId : null,
                STANDORT.equals(zielArt) ? zielId : null,
                UNTERNEHMEN.equals(zielArt) || STANDORT.equals(zielArt) ? null : zielId,
                gueltigAb, gueltigBis, createdBy);
    }

    public UUID stellungEintragen(UUID tenantId, UUID messstelleId, UUID siteId, String stellung,
            UUID unterzaehlerVon, LocalDate gueltigAb, LocalDate gueltigBis, String createdBy) {
        return jdbc.queryForObject("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, "
                + "stellung, unterzaehler_von, gueltig_ab, gueltig_bis, created_by) "
                + "VALUES (?,?,?,?,?,?,?,?) RETURNING id", UUID.class, tenantId, messstelleId, siteId,
                stellung, unterzaehlerVon, gueltigAb, gueltigBis, createdBy);
    }

    /** Beendet ein (nicht aufgehobenes) Ort-Intervall am Tag {@code gueltigBis}, einschließlich. */
    public boolean ortBeenden(UUID id, LocalDate gueltigBis) {
        return beenden("messstelle_ort", id, gueltigBis);
    }

    /** Hebt ein Ort-Intervall auf (Korrektur): es bleibt lesbar, belegt aber keinen Tag mehr. */
    public boolean ortAufheben(UUID id, Instant am) {
        return aufheben("messstelle_ort", id, am);
    }

    public boolean stellungBeenden(UUID id, LocalDate gueltigBis) {
        return beenden("messstelle_stellung", id, gueltigBis);
    }

    public boolean stellungAufheben(UUID id, Instant am) {
        return aufheben("messstelle_stellung", id, am);
    }

    private boolean beenden(String tabelle, UUID id, LocalDate gueltigBis) {
        return jdbc.update("UPDATE " + tabelle + " SET gueltig_bis = ? WHERE id = ? AND aufgehoben_am IS NULL",
                gueltigBis, id) == 1;
    }

    private boolean aufheben(String tabelle, UUID id, Instant am) {
        return jdbc.update("UPDATE " + tabelle + " SET aufgehoben_am = ? WHERE id = ? AND aufgehoben_am IS NULL",
                Timestamp.from(am), id) == 1;
    }

    // ---------------------------------------------------------------- Gerüst

    private static OrtZeile ort(ResultSet rs, int n) throws SQLException {
        UUID unternehmen = rs.getObject("unternehmen_id", UUID.class);
        UUID standort = rs.getObject("standort_id", UUID.class);
        String art;
        UUID ziel;
        String kennzeichen;
        if (unternehmen != null) {
            art = UNTERNEHMEN;
            ziel = unternehmen;
            kennzeichen = OrtsbaumAbleitung.UNTERNEHMEN;
        } else if (standort != null) {
            art = STANDORT;
            ziel = standort;
            kennzeichen = rs.getString("standort_kz");
        } else {
            art = rs.getString("ort_art");
            ziel = rs.getObject("ort_id", UUID.class);
            kennzeichen = rs.getString("ort_kz");
        }
        return new OrtZeile(rs.getObject("id", UUID.class), rs.getObject("messstelle_id", UUID.class), art,
                ziel, kennzeichen, rs.getObject("gueltig_ab", LocalDate.class),
                rs.getObject("gueltig_bis", LocalDate.class), zeit(rs, "aufgehoben_am"), zeit(rs, "created_at"));
    }

    private static StellungZeile stellung(ResultSet rs, int n) throws SQLException {
        return new StellungZeile(rs.getObject("id", UUID.class), rs.getObject("messstelle_id", UUID.class),
                rs.getObject("site_id", UUID.class), rs.getString("stellung"),
                rs.getObject("unterzaehler_von", UUID.class), rs.getString("bezug_kz"),
                rs.getObject("gueltig_ab", LocalDate.class), rs.getObject("gueltig_bis", LocalDate.class),
                zeit(rs, "aufgehoben_am"), zeit(rs, "created_at"));
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
