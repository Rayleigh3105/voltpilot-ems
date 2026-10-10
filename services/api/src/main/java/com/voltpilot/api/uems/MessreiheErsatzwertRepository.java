package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.MessreiheFassungen.ts;
import static com.voltpilot.api.uems.MessreiheFassungen.zeit;

import com.voltpilot.api.uems.MessreiheFassungen.Fassung;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Lesen und Fortschreiben der Ersatzwerte ({@code messreihe_ersatzwert}, UEMS AP-08 IP-12,
 * Migration V20260913190000) — nie ändern, nie löschen.
 *
 * <p><b>Ein Ersatzwert ist kein Messwert.</b> Er steht in seiner eigenen Tabelle, mit Kennung
 * ({@code EW-<Jahr>-<lfd. Nr.>}), Methode a–g (E7), Pflicht-Begründung und Urheber; kein Rohwert
 * und keine Periode wird hier angefasst. Zurückgenommen wird er mit einer weiteren Fassung, nie
 * durch Löschen.
 *
 * <p>Die Regeln hält die Datenbank und dieser Weg rät keine: welche Methode welchen Bezug braucht,
 * dass a–c genau den gemessenen Zuwachs einer Lücke verteilen und e–g nur stehen, wo keiner
 * gemessen ist, welcher Status auf welchen folgt. Eine Verletzung kommt als Ausnahme der Datenbank
 * mit dem Namen ihrer Regel zurück. Die Rechenmethoden sind IP-13, die Route IP-16.
 * Noch ruft niemand an.
 *
 * <p>Der Kundenbereich kommt vom Aufrufer (aus dem Anmelde-Kontext, nie aus einer Anfrage) und muss
 * der der Sitzung sein — sonst lässt RLS die Zeile nicht zu.
 */
@Repository
public class MessreiheErsatzwertRepository {

    static final String TABELLE = "messreihe_ersatzwert";

    private final JdbcTemplate jdbc;

    public MessreiheErsatzwertRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Was einen Ersatzwert ausmacht — die Spalten der anlegenden Fassung. Welche davon gesetzt sein
     * müssen, sagt die Methode (siehe {@code messreihe_korrektur_vokabular()}): a–c Lücke, Zuwachs,
     * Stände und Einheit; b/f Vorperiode; c/g Vergleichsquelle; d Zeitpunkt, Ablesestände, Einheit;
     * e Betrag, Einheit und Beleg.
     */
    public record Anlage(String methode, UUID entityId, String messkanal, UUID messstelleId, Instant von,
            Instant bis, Instant zeitpunkt, String begruendung, String beleg, UUID lueckeEreignisId,
            BigDecimal zuwachs, BigDecimal standVor, BigDecimal standNach, String einheit, Instant vorperiodeVon,
            UUID vergleichQuelleId, BigDecimal endstand, BigDecimal anfangsstand, BigDecimal betrag) {
    }

    /** Ein Ersatzwert mit allen Fassungen; die letzte ist sein Stand. */
    public record Ersatzwert(String kennung, Anlage anlage, List<Fassung> fassungen) {

        public String status() {
            return fassungen.get(fassungen.size() - 1).status();
        }

        /** Wer ihn erfasst hat (Fassung 1). */
        public ProtokollAkteur erfasser() {
            return fassungen.get(0).akteur();
        }
    }

    /**
     * Erfasst einen Ersatzwert: vergibt die Kennung im Jahr der Erfassung (in {@code zone}, der
     * Zeitzone des Standorts) und legt Fassung 1 mit dem Status {@code wirksam} an.
     */
    @Transactional
    public Ersatzwert erfassen(UUID tenantId, Anlage a, ProtokollAkteur akteur, ZoneId zone) {
        String kennung = MessreiheFassungen.naechsteKennung(jdbc, TABELLE, "EW", tenantId, zone);
        jdbc.update("INSERT INTO messreihe_ersatzwert (tenant_id, kennung, fassung, status, methode, entity_id, "
                + "messkanal, messstelle_id, von, bis, zeitpunkt, begruendung, beleg, luecke_ereignis_id, zuwachs, "
                + "stand_vor, stand_nach, einheit, vorperiode_von, vergleich_quelle_id, endstand, anfangsstand, "
                + "betrag, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                tenantId, kennung, EreignisVokabular.ERSATZWERT_STATUS.get(0), a.methode(), a.entityId(),
                a.messkanal(), a.messstelleId(), ts(a.von()), ts(a.bis()), ts(a.zeitpunkt()), a.begruendung(),
                a.beleg(), a.lueckeEreignisId(), a.zuwachs(), a.standVor(), a.standNach(), a.einheit(),
                ts(a.vorperiodeVon()), a.vergleichQuelleId(), a.endstand(), a.anfangsstand(), a.betrag(),
                akteur.sub(), akteur.name(), akteur.rolle(), akteur.art());
        return lies(tenantId, kennung).orElseThrow();
    }

    /** Nimmt einen Ersatzwert zurück — eine weitere Fassung mit Grund; er bleibt sichtbar. */
    @Transactional
    public Ersatzwert zuruecknehmen(UUID tenantId, String kennung, String grund, ProtokollAkteur akteur) {
        List<Fassung> bisher = MessreiheFassungen.fassungen(jdbc, TABELLE, tenantId, kennung);
        if (bisher.isEmpty()) {
            throw new IllegalArgumentException("kein Ersatzwert " + kennung);
        }
        MessreiheFassungen.fortschreiben(jdbc, TABELLE, tenantId, kennung, bisher.size() + 1,
                EreignisVokabular.ERSATZWERT_STATUS.get(1), grund, akteur);
        return lies(tenantId, kennung).orElseThrow();
    }

    public Optional<Ersatzwert> lies(UUID tenantId, String kennung) {
        return jdbc.query("SELECT * FROM messreihe_ersatzwert WHERE tenant_id = ? AND kennung = ? AND fassung = 1",
                (rs, n) -> new Ersatzwert(kennung, anlage(rs),
                        MessreiheFassungen.fassungen(jdbc, TABELLE, tenantId, kennung)),
                tenantId, kennung).stream().findFirst();
    }

    /** Die Ersatzwerte einer Reihe, deren Zeitraum [{@code von}, {@code bis}) berührt — frühester zuerst. */
    public List<Ersatzwert> fuerReihe(UUID tenantId, UUID entityId, String messkanal, Instant von, Instant bis) {
        return jdbc.queryForList("SELECT kennung FROM messreihe_ersatzwert WHERE tenant_id = ? AND fassung = 1 "
                + "AND entity_id = ? AND messkanal = ? AND von < ? AND bis > ? ORDER BY von, kennung", String.class,
                tenantId, entityId, messkanal, ts(bis), ts(von)).stream()
                .map(k -> lies(tenantId, k).orElseThrow())
                .toList();
    }

    private static Anlage anlage(ResultSet rs) throws SQLException {
        return new Anlage(rs.getString("methode"), rs.getObject("entity_id", UUID.class), rs.getString("messkanal"),
                rs.getObject("messstelle_id", UUID.class), zeit(rs, "von"), zeit(rs, "bis"), zeit(rs, "zeitpunkt"),
                rs.getString("begruendung"), rs.getString("beleg"), rs.getObject("luecke_ereignis_id", UUID.class),
                rs.getBigDecimal("zuwachs"), rs.getBigDecimal("stand_vor"), rs.getBigDecimal("stand_nach"),
                rs.getString("einheit"), zeit(rs, "vorperiode_von"), rs.getObject("vergleich_quelle_id", UUID.class),
                rs.getBigDecimal("endstand"), rs.getBigDecimal("anfangsstand"), rs.getBigDecimal("betrag"));
    }
}
