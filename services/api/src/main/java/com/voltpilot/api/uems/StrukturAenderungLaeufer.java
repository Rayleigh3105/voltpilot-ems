package com.voltpilot.api.uems;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der Strukturänderungs-Läufer der Berichte, Pfad 2 (UEMS AP-12 IP-9, E6 = A; bericht.md B3): er liest, was
 * {@code ort_aenderung} und {@code messstelle_aenderung} seit seinem letzten Lauf Neues tragen, und ruft für eine
 * rückwirkende Strukturänderung DIESELBEN drei Methoden der Naht wie die Korrektur-Kaskade — {@code betroffene},
 * {@code entwurfNeuBilden}, {@code revisionAusloesen} — in einer EIGENEN Transaktion je Protokollzeile.
 *
 * <p><b>Warum asynchron:</b> die Schreibwege (Umzug, Fläche, Verteilung, Verschieben) behalten ihre Zusagen — ein Umzug
 * schreibt weiter nur {@code anlage_standort} und {@code ort_aenderung} ({@code AnlageUmzugApiTest}), und ein Fehler in
 * der Berichtsbildung rollt nie eine Strukturänderung zurück (E6 Option C verworfen).
 *
 * <ul>
 *   <li><b>Urteil</b> je Zeile: {@link BerichtRegeln#struktur} — eine Umbenennung ({@code bearbeitet}, B10) liest der Läufer
 *       gar nicht erst, eine nicht rückwirkende Änderung bekommt ihr Urteil und keinen Aufruf (B6).</li>
 *   <li><b>Objekte:</b> {@link StrukturAufloesung#objekte}; <b>betroffen</b> ist, wessen Quellenverzeichnis sie ab
 *       {@code gilt_ab} zitiert und wessen Datenstand vor dem Eintrag liegt ({@link BerichtKaskade#betroffene(Connection,
 *       BerichteNaht.StrukturBetroffen)}).</li>
 *   <li><b>Die Grenze von E9</b> steht an EINER Stelle ({@link #benachrichtigen}): ein Entwurf bildet sich neu, ein
 *       freigegebener Stand bekommt NUR den Anstoß.</li>
 *   <li><b>Wasserzeichen:</b> {@code bericht_struktur_gelesen}, in derselben Transaktion — nichts zweimal, nichts
 *       übersprungen; ein zweiter Läufer (Cluster) wartet nicht, sondern überspringt die Zeile, die der erste hält
 *       ({@code pg_try_advisory_xact_lock}).</li>
 *   <li><b>Bezugsgrößen</b> liest er NICHT: {@code bezugsgroesse_aenderung} kennt nur angelegt/bearbeitet/archiviert, und
 *       Berichtigung, Rücknahme und rückwirkendes Stammdatum trägt seit AP-11 IP-9 Pfad 1 (Anstoß {@code bezugsgroesse_fassung}
 *       mit {@code BK-…} bzw. {@code bezugsgroesse_stammdatum:<ID>}). Läse Pfad 2 dieselbe Änderung, trüge sein Anstoß eine
 *       andere Art und Kennung — {@code bericht_revision_anstoss_einmal} finge das NICHT ab, es gäbe zwei Anstöße.</li>
 * </ul>
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire) und in PRODUKTION AN ({@code application.yml},
 * {@code matchIfMissing}); er läuft nur, wenn auch {@value BerichtKaskade#SCHALTER} an ist. Er wirft nie: eine Zeile, deren
 * Transaktion scheitert, ist nicht gelesen und kommt im nächsten Takt wieder; die übrigen laufen weiter.
 */
@Component
@ConditionalOnProperty(name = {StrukturAenderungLaeufer.SCHALTER, BerichtKaskade.SCHALTER}, havingValue = "true",
        matchIfMissing = true)
public class StrukturAenderungLaeufer {

    /** Der Not-Aus des Läufers; die Naht selbst ({@value BerichtKaskade#SCHALTER}) bleibt davon unberührt. */
    public static final String SCHALTER = "voltpilot.uems.berichte.struktur.enabled";

    private static final Logger log = LoggerFactory.getLogger(StrukturAenderungLaeufer.class);

    private static final String KANDIDATEN = """
            SELECT 'ort_aenderung' AS protokoll, a.id, a.tenant_id, a.objekt_art, a.objekt_id, a.art, a.alt::text AS alt,
                   a.neu::text AS neu, a.gilt_ab AS gilt_ab_tag, CAST(NULL AS timestamptz) AS gilt_ab_zeit, a.rueckwirkend,
                   a.created_at
              FROM ort_aenderung a
             WHERE a.art = ANY (?)
               AND NOT EXISTS (SELECT 1 FROM bericht_struktur_gelesen g
                                WHERE g.protokoll = 'ort_aenderung' AND g.eintrag_id = a.id)
            UNION ALL
            SELECT 'messstelle_aenderung', m.id, m.tenant_id, 'messstelle', m.messstelle_id, m.art, m.alt::text, m.neu::text,
                   CAST(NULL AS date), m.gilt_ab, m.rueckwirkend, m.created_at
              FROM messstelle_aenderung m
             WHERE m.art = ANY (?)
               AND NOT EXISTS (SELECT 1 FROM bericht_struktur_gelesen g
                                WHERE g.protokoll = 'messstelle_aenderung' AND g.eintrag_id = m.id)
             ORDER BY created_at, protokoll, id
             LIMIT ?
            """;

    private final JdbcTemplate adminJdbc;
    private final BerichteNaht naht;
    private final int zeilenJeLauf;

    public StrukturAenderungLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, BerichteNaht naht,
            @Value("${voltpilot.uems.berichte.struktur.je-lauf:200}") int zeilenJeLauf) {
        this.adminJdbc = adminJdbc;
        this.naht = naht;
        this.zeilenJeLauf = zeilenJeLauf;
    }

    /**
     * Was ein Lauf tat: gelesene Zeilen (mit Urteil im Wasserzeichen), Einträge der Naht, und die Zeilen, deren Transaktion
     * scheiterte (Kennung → Grund) — sie kommen im nächsten Takt wieder.
     */
    public record Lauf(int gelesen, int berichte, Map<String, String> gescheitert) {}

    @Scheduled(fixedDelayString = "${voltpilot.uems.berichte.struktur.interval-ms:300000}",
            initialDelayString = "${voltpilot.uems.berichte.struktur.initial-delay-ms:240000}")
    public void takt() {
        try {
            Lauf l = lauf(Instant.now());
            if (l.berichte() > 0 || !l.gescheitert().isEmpty()) {
                log.info("UEMS Strukturänderungs-Läufer: {} Zeilen gelesen, {} Berichte benachrichtigt, {} gescheitert",
                        l.gelesen(), l.berichte(), l.gescheitert().size());
            }
        } catch (RuntimeException e) {
            log.warn("UEMS Strukturänderungs-Läufer übersprungen: {}", e.toString());
        }
    }

    public Lauf lauf(Instant jetzt) {
        List<StrukturAufloesung.Zeile> kandidaten = adminJdbc.query(KANDIDATEN, (rs, i) -> {
            Timestamp zeit = rs.getTimestamp("gilt_ab_zeit");
            return new StrukturAufloesung.Zeile(rs.getString("protokoll"), rs.getLong("id"),
                    rs.getObject("tenant_id", UUID.class), rs.getString("objekt_art"), rs.getObject("objekt_id", UUID.class),
                    rs.getString("art"), StrukturAufloesung.json(rs.getString("alt")),
                    StrukturAufloesung.json(rs.getString("neu")), rs.getObject("gilt_ab_tag", LocalDate.class),
                    zeit == null ? null : zeit.toInstant(), rs.getBoolean("rueckwirkend"),
                    rs.getTimestamp("created_at").toInstant());
        }, StrukturAufloesung.ORT_ARTEN.toArray(String[]::new), StrukturAufloesung.MESSSTELLE_ARTEN.toArray(String[]::new),
                zeilenJeLauf);
        int gelesen = 0;
        int berichte = 0;
        Map<String, String> gescheitert = new LinkedHashMap<>();
        for (StrukturAufloesung.Zeile z : kandidaten) {
            try {
                Integer n = inTransaktion(con -> lesen(con, z, jetzt));
                if (n != null) {
                    gelesen++;
                    berichte += n;
                }
            } catch (RuntimeException e) {
                gescheitert.put(z.protokoll() + "-" + z.id(), e.toString());
                log.warn("UEMS Strukturänderungs-Läufer: {}-{} nicht gelesen, nächster Takt: {}", z.protokoll(), z.id(),
                        e.toString());
            }
        }
        return new Lauf(gelesen, berichte, gescheitert);
    }

    /** EINE Protokollzeile in EINER Transaktion; {@code null} = ein anderer Läufer hat sie (oder hatte sie schon). */
    private Integer lesen(Connection con, StrukturAufloesung.Zeile z, Instant jetzt) throws SQLException {
        JdbcTemplate j = new JdbcTemplate(new SingleConnectionDataSource(con, true));
        Boolean frei = j.queryForObject("SELECT pg_try_advisory_xact_lock(hashtext(?), ?)", Boolean.class,
                "bericht_struktur_gelesen:" + z.protokoll(), (int) (z.id() % Integer.MAX_VALUE));
        if (!Boolean.TRUE.equals(frei) || j.queryForObject("SELECT count(*) FROM bericht_struktur_gelesen "
                + "WHERE protokoll = ? AND eintrag_id = ?", Integer.class, z.protokoll(), z.id()) > 0) {
            return null;
        }
        BerichtRegeln.Struktur urteil = BerichtRegeln.struktur(z.protokoll(), z.objektArt(), z.art(), z.rueckwirkend(),
                z.korrektur());
        int berichte = 0;
        if (urteil.anstossArt() != null) {
            ZoneId zone = StrukturAufloesung.zone(j, z.tenant());
            LocalDate giltAb = z.giltAb(zone);
            Set<UUID> objekte = StrukturAufloesung.objekte(j, z, urteil.anstossArt(), giltAb);
            if (!objekte.isEmpty()) {
                String anlass = BerichtRegeln.strukturKennung(urteil.anstossArt(),
                        StrukturAufloesung.kennzeichen(j, z.tenant(), z.objektArt(), z.objektId()), giltAb,
                        z.eingetragen().atZone(zone).toLocalDate(), z.protokoll(), z.id());
                BerichteNaht.StrukturBetroffen s = new BerichteNaht.StrukturBetroffen(z.tenant(), anlass,
                        urteil.anstossArt(), objekte, giltAb, z.eingetragen(), jetzt);
                List<BerichteNaht.Bericht> getroffen = naht.betroffene(con, s);
                benachrichtigen(con, naht, s, getroffen);
                berichte = getroffen.size();
            }
        }
        j.update("INSERT INTO bericht_struktur_gelesen (protokoll, eintrag_id, urteil, berichte) VALUES (?, ?, ?, ?)",
                z.protokoll(), z.id(), urteil.anstossArt() != null ? urteil.anstossArt() : urteil.grund(), berichte);
        return berichte;
    }

    /**
     * Die GRENZE von E9 für Pfad 2, an EINER Stelle — wie {@link KorrekturKaskade#berichteBenachrichtigen}: ein Entwurf
     * bildet sich neu, ein freigegebener Bericht bekommt NUR den Anstoß.
     */
    static void benachrichtigen(Connection con, BerichteNaht naht, BerichteNaht.StrukturBetroffen s,
            List<BerichteNaht.Bericht> berichte) throws SQLException {
        for (BerichteNaht.Bericht bericht : berichte) {
            switch (bericht.stand()) {
                case ENTWURF -> naht.entwurfNeuBilden(con, bericht, s);
                case FREIGEGEBEN -> naht.revisionAusloesen(con, bericht, s);
            }
        }
    }

    @FunctionalInterface
    private interface Schritt<T> {
        T fahren(Connection con) throws SQLException;
    }

    private <T> T inTransaktion(Schritt<T> schritt) {
        return adminJdbc.execute((ConnectionCallback<T>) con -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = schritt.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("UEMS Strukturänderungs-Läufer fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
