package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Pflege einer laufenden Bezugsbasis (UEMS AP-17 IP-17, F4/F5, A4): Frist lesen, „geprüft, bleibt“, beenden — und
 * die Übersicht am Unternehmen. Tabellen aus {@code V20260924071500__uems_bezugsbasis.sql}; Mandant über RLS.
 *
 * <p><b>Nichts wird gelöscht, nichts eingefroren angefasst:</b> „bleibt“ schreibt nur einen Protokolleintrag (die Fassung
 * bleibt byte-gleich, {@code freigegeben_am} ist eingefroren — die neue Frist steht im Protokoll); das Ende setzt
 * {@code beendet_*} an der Basis genau einmal ({@code WHERE beendet_am IS NULL}) und {@code gilt_bis} an der laufenden
 * Fassung (Trigger {@code bezugsbasis_fassung_eingefroren} lässt das Ende genau einmal zu). Offene Anstöße beantwortet
 * dieselbe Handlung (A4: {@code bleibt} bzw. {@code beendet}); Anstöße SCHREIBT hier niemand (IP-15).
 */
@Repository
public class BezugsbasisPflegeRepository {

    static final String GUELTIG_BLEIBT = "gueltig_bleibt";
    static final String BEENDET = "bezugsbasis_beendet";
    /** A1: das Wort, mit dem die Archivierung der Kennzahl die Basis beendet (F4). */
    static final String GRUND_ARCHIVIERT = "nicht_mehr_anwendbar";
    static final String BEGRUENDUNG_ARCHIVIERT = "Kennzahl archiviert";

    /** Eine Bezugsbasis mit ihrer laufenden (freigegebenen, nicht beendeten) Fassung — {@code fassung} ggf. leer. */
    public record Basis(UUID id, String kennzeichen, UUID kennzahlId, LocalDate beendetZum, Instant beendetAm,
            String beendetGrund, Optional<Fassung> laufende) {}

    /** Die laufende Fassung mit ihrer Frist-Grundlage und den offenen Anstößen. */
    public record Fassung(UUID id, int nummer, LocalDate giltAb, String datenlage, int wiedervorlageMonate,
            Instant freigegebenAm, Instant bestaetigtAm, int offeneAnstoesse) {}

    private static final String BASIS = "SELECT b.id, b.kennzeichen, b.kennzahl_id, b.beendet_zum, b.beendet_am, "
            + "b.beendet_grund, f.id AS f_id, f.fassung, f.gilt_ab, f.datenlage, f.wiedervorlage_monate, f.freigegeben_am, "
            + "(SELECT max(a.created_at) FROM bezugsbasis_aenderung a WHERE a.bezugsbasis_id = b.id "
            + "  AND a.fassung = f.fassung AND a.art = '" + GUELTIG_BLEIBT + "') AS bestaetigt_am, "
            + "(SELECT count(*) FROM bezugsbasis_anstoss s WHERE s.fassung_id = f.id AND s.antwort IS NULL) AS anstoesse "
            + "FROM bezugsbasis b LEFT JOIN LATERAL (SELECT * FROM bezugsbasis_fassung x WHERE x.bezugsbasis_id = b.id "
            + "  AND x.tenant_id = b.tenant_id AND x.freigabe_status = 'freigegeben' AND x.gilt_bis IS NULL "
            + "  ORDER BY x.fassung DESC LIMIT 1) f ON true ";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public BezugsbasisPflegeRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Die Basis {@code id} an der Kennzahl {@code kennzahl} — eine Basis einer anderen Kennzahl ist nicht da. */
    public Optional<Basis> basis(UUID kennzahl, UUID id) {
        return jdbc.query(BASIS + "WHERE b.id = ? AND b.kennzahl_id = ?", BezugsbasisPflegeRepository::basis, id, kennzahl)
                .stream().findFirst();
    }

    /** Sperrt die Basis-Zeile für eine Handlung (zwei gleichzeitige Enden: eines gewinnt, das andere ist 409). */
    public void sperre(UUID id) {
        jdbc.query("SELECT id FROM bezugsbasis WHERE id = ? FOR UPDATE", rs -> {}, id);
    }

    /** Alle laufenden (nicht beendeten) Basen des Kundenbereichs, nach Kennzeichen — die Übersicht. */
    public List<Basis> laufende() {
        return jdbc.query(BASIS + "WHERE b.beendet_am IS NULL ORDER BY b.kennzeichen", BezugsbasisPflegeRepository::basis);
    }

    /** F5: „geprüft, bleibt“ — beantwortet offene Anstöße der laufenden Fassung mit {@code bleibt}. */
    public int anstoesseBleiben(UUID fassung, String begruendung, Instant am, ProtokollAkteur wer) {
        return jdbc.update("UPDATE bezugsbasis_anstoss SET antwort = 'bleibt', antwort_begruendung = ?, beantwortet_am = ?, "
                + "beantwortet_sub = ?, beantwortet_name = ? WHERE fassung_id = ? AND antwort IS NULL", begruendung,
                Timestamp.from(am), wer.sub(), wer.name(), fassung);
    }

    /**
     * F4: beendet die Basis zum Tag {@code tag} (letzter eingeschlossener Tag), die laufende Fassung mit ihr, und
     * beantwortet jeden offenen Anstoß der Basis mit {@code beendet}. {@code false}, wenn die Basis schon beendet war.
     */
    public boolean beenden(UUID basis, Optional<Fassung> laufende, LocalDate tag, String grund, Instant am,
            ProtokollAkteur wer) {
        int n = jdbc.update("UPDATE bezugsbasis SET beendet_zum = ?, beendet_am = ?, beendet_grund = ? "
                + "WHERE id = ? AND beendet_am IS NULL", Date.valueOf(tag), Timestamp.from(am), grund, basis);
        if (n == 0) {
            return false;
        }
        // gilt_bis ≥ gilt_ab − 1 (CHECK): eine Fassung, die am Tag noch nicht galt, endet ganz (gilt_ab − 1).
        laufende.ifPresent(f -> jdbc.update("UPDATE bezugsbasis_fassung SET gilt_bis = greatest(?::date, gilt_ab - 1), "
                + "beendet_am = ?, beendet_grund = ? WHERE id = ? AND gilt_bis IS NULL", Date.valueOf(tag),
                Timestamp.from(am), grund, f.id()));
        jdbc.update("UPDATE bezugsbasis_anstoss SET antwort = 'beendet', beantwortet_am = ?, beantwortet_sub = ?, "
                + "beantwortet_name = ? WHERE antwort IS NULL AND fassung_id IN "
                + "(SELECT id FROM bezugsbasis_fassung WHERE bezugsbasis_id = ?)", Timestamp.from(am), wer.sub(),
                wer.name(), basis);
        return true;
    }

    /** Protokoll {@code bezugsbasis_aenderung}: nur anhängen; {@code created_at} ist der Zeitpunkt der Handlung. */
    public void protokoll(UUID tenant, UUID basis, Integer fassung, String art, Map<String, Object> alt,
            Map<String, Object> neu, String begruendung, Instant am, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO bezugsbasis_aenderung (tenant_id, bezugsbasis_id, fassung, art, alt, neu, begruendung, "
                + "actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?)",
                tenant, basis, fassung, art, text(alt), text(neu), begruendung, wer.sub(), wer.name(), wer.rolle(),
                wer.art(), Timestamp.from(am));
    }

    /**
     * Die Naht an der Kennzahl-Archivierung (F4, R13): die laufende Basis endet am Archivierungstag mit Grund
     * {@code nicht_mehr_anwendbar}; ohne laufende Basis geschieht nichts (Bestand, R10). Läuft in der Transaktion der
     * Archivierung.
     */
    public void beiArchivierung(UUID tenant, UUID kennzahl, LocalDate tag, Instant am, ProtokollAkteur wer) {
        List<Basis> laufend = jdbc.query(BASIS + "WHERE b.kennzahl_id = ? AND b.beendet_am IS NULL",
                BezugsbasisPflegeRepository::basis, kennzahl);
        for (Basis b : laufend) {
            sperre(b.id());
            if (beenden(b.id(), b.laufende(), tag, GRUND_ARCHIVIERT, am, wer)) {
                protokoll(tenant, b.id(), b.laufende().map(Fassung::nummer).orElse(null), BEENDET, null,
                        Map.of("beendet_zum", tag.toString(), "grund", GRUND_ARCHIVIERT, "anlass", "kennzahl_archiviert"),
                        BEGRUENDUNG_ARCHIVIERT, am, wer);
            }
        }
    }

    private String text(Map<String, Object> m) {
        if (m == null) {
            return null;
        }
        try {
            return json.writeValueAsString(m);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Basis basis(ResultSet rs, int i) throws SQLException {
        UUID fassung = rs.getObject("f_id", UUID.class);
        Optional<Fassung> f = fassung == null ? Optional.empty() : Optional.of(new Fassung(fassung, rs.getInt("fassung"),
                rs.getObject("gilt_ab", LocalDate.class), rs.getString("datenlage"), rs.getInt("wiedervorlage_monate"),
                instant(rs, "freigegeben_am"), instant(rs, "bestaetigt_am"), rs.getInt("anstoesse")));
        return new Basis(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                rs.getObject("kennzahl_id", UUID.class), rs.getObject("beendet_zum", LocalDate.class),
                instant(rs, "beendet_am"), rs.getString("beendet_grund"), f);
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
