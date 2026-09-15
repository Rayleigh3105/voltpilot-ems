package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/**
 * Die Kaskaden-Naht der BERICHTE, Pfad 1 (UEMS AP-12 IP-8, E6/E7/E8) — ersetzt {@link BerichteNaht.Keine}, solange
 * {@value #SCHALTER} an ist (Vorgabe an, im Testlauf aus).
 *
 * <p>Die Korrektur-Kaskade ({@link KorrekturKaskade}) ruft sie nach den Stufen, den berechneten Messstellen und den
 * Kennzahlen in DERSELBEN Transaktion, mit derselben Verbindung — der Verwaltungsrolle ohne RLS: jede Abfrage nennt den
 * Mandanten. Welcher der beiden Wege für einen Bericht gilt, entscheidet {@link KorrekturKaskade#berichteBenachrichtigen},
 * nie diese Klasse.
 *
 * <ul>
 *   <li>{@link #betroffene} (bericht.md B1): Zeitraum × Quellenverzeichnis. Die Messstellen der Reihen über ihre
 *       zeitgültige führende Quellenbindung und {@code Betroffen.messstellen} liest {@link KennzahlKaskade#messstellen}
 *       (eine Regel für beide Nähte); die Zeilen von {@code bericht_quelle} mit diesen Objekten, deren Tage
 *       {@code ersterTag … letzterTag} berühren, wählt und ordnet {@link BerichtRegeln#betroffene(List,
 *       KorrekturKaskade.Betroffen, java.util.function.Function)} — je Bericht der gültige Stand vor dem Entwurf, nie ein
 *       ersetzter Stand.</li>
 *   <li>{@link #entwurfNeuBilden} (EW1, EW3): {@link BerichtAbzugBildung#bilden} auf der Verbindung der Kaskade,
 *       {@code gebildet_von} = {@value #GEBILDET_VON}, dazu die Meldung {@code bericht_entwurf_neu_gebildet} mit dem
 *       Anlass — die Route liest ihn daraus ({@link BerichtRepository#anlassDerNeubildung}).</li>
 *   <li>{@link #revisionAusloesen} (R1, B7): der gültige Stand bleibt byte-gleich und bekommt EINEN Anstoß in
 *       {@code bericht_revision_anstoss} — idempotent über Stand, Art, Anlass, Fassung und Status — und, nur wenn der
 *       Anstoß neu ist, die Meldung {@code bericht_revision_angestossen}.</li>
 * </ul>
 *
 * <p>Wirft bei jedem Fehler: die Kaskade rollt dann alles zurück, auch die Stufen der Messreihe und die Kennzahlen, und
 * versucht es im nächsten Takt (keine halbe Wahrheit). Seit AP-11 IP-9 trägt Pfad 1 auch die Bezugsgrößen
 * ({@code Betroffen.bezugsgroessen}: Quellen der Art {@code bezugsgroesse} und {@code stammdatum}) und eine rückwirkend
 * geänderte Berechnung (Quellen der Art {@code kennzahl} mit dem Kennzeichen {@code Betroffen.anlass}).
 */
@Component
@ConditionalOnProperty(name = BerichtKaskade.SCHALTER, havingValue = "true", matchIfMissing = true)
public class BerichtKaskade implements BerichteNaht {

    /** Der Rückbau: aus → {@link BerichteNaht.Keine} kennt keinen Bericht; die Tabellen bleiben, wie sie sind. */
    public static final String SCHALTER = "voltpilot.uems.berichte.enabled";

    static final String ANGESTOSSEN = "bericht_revision_angestossen";
    static final String NEU_GEBILDET = "bericht_entwurf_neu_gebildet";
    /** bericht.md EW1: wer den Entwurf bildete. */
    static final String GEBILDET_VON = "kaskade";

    private static final Logger log = LoggerFactory.getLogger(BerichtKaskade.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    private final BerichtAbzugBildung bildung;

    public BerichtKaskade(BerichtAbzugBildung bildung) {
        this.bildung = bildung;
    }

    @Override
    public List<Bericht> betroffene(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        Set<UUID> messstellen = KennzahlKaskade.messstellen(con, b);
        List<UUID> bezugsgroessen = b.bezugsgroessen().stream().map(KorrekturKaskade.Bezugsgroesse::id).toList();
        String berechnung = KorrekturKaskade.BERECHNUNG_GEAENDERT.equals(b.status()) ? b.anlass() : null;
        if (messstellen.isEmpty() && bezugsgroessen.isEmpty() && berechnung == null) {
            return List.of();
        }
        List<String> gebunden = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT kennzeichen FROM messstelle WHERE tenant_id = ? "
                + "AND id = ANY (?) ORDER BY kennzeichen")) {
            ps.setObject(1, b.tenant());
            ps.setArray(2, con.createArrayOf("uuid", messstellen.toArray()));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    gebunden.add(rs.getString(1));
                }
            }
        }
        List<BerichtRegeln.Quelle> quellen = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT b.kennung, q.stand_nr, s.ersetzt_durch_nr IS NOT NULL AS ersetzt,
                       coalesce(m.kennzeichen, g.kennzeichen, k.kennzeichen, q.kennzeichen) AS kennzeichen, q.bezug,
                       q.erster_tag, q.letzter_tag
                  FROM bericht_quelle q
                  JOIN bericht b ON b.id = q.bericht_id AND b.tenant_id = q.tenant_id
                  LEFT JOIN messstelle m ON m.id = q.objekt_id AND m.tenant_id = q.tenant_id
                  LEFT JOIN bezugsgroesse g ON g.id = q.objekt_id AND g.tenant_id = q.tenant_id
                  LEFT JOIN kennzahl k ON k.id = q.objekt_id AND k.tenant_id = q.tenant_id
                  LEFT JOIN bericht_stand s ON s.tenant_id = q.tenant_id AND s.bericht_id = q.bericht_id
                       AND s.nr = q.stand_nr
                 WHERE q.tenant_id = ? AND q.erster_tag <= ? AND q.letzter_tag >= ?
                   AND ((m.id IS NOT NULL AND q.objekt_id = ANY (?))
                        OR (q.art IN ('bezugsgroesse', 'stammdatum') AND q.objekt_id = ANY (?))
                        OR (q.art = 'kennzahl' AND coalesce(k.kennzeichen, q.kennzeichen) = ?::text))
                 ORDER BY b.kennung, q.stand_nr NULLS LAST, 4, q.bezug
                """)) {
            ps.setObject(1, b.tenant());
            ps.setObject(2, b.letzterTag());
            ps.setObject(3, b.ersterTag());
            ps.setArray(4, con.createArrayOf("uuid", messstellen.toArray()));
            ps.setArray(5, con.createArrayOf("uuid", bezugsgroessen.toArray()));
            ps.setString(6, berechnung);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    quellen.add(new BerichtRegeln.Quelle(rs.getString("kennung"), (Integer) rs.getObject("stand_nr"),
                            rs.getBoolean("ersetzt"), rs.getString("kennzeichen"), rs.getString("bezug"),
                            rs.getObject("erster_tag", LocalDate.class), rs.getObject("letzter_tag", LocalDate.class)));
                }
            }
        }
        // Die Regel braucht nur die Vereinigung der gebundenen Messstellen — sie steht schon fest.
        return BerichtRegeln.betroffene(quellen, b, r -> gebunden);
    }

    @Override
    public void entwurfNeuBilden(Connection con, Bericht bericht, KorrekturKaskade.Betroffen b) throws SQLException {
        UUID id;
        // Die Sperre der Neubildung beim Abruf (D4): erst der Entwurf, dann lesen und schreiben — wer gleichzeitig neu
        // bildet, wartet und findet danach den Datenstand der Kaskade.
        try (PreparedStatement ps = con.prepareStatement("SELECT e.bericht_id FROM bericht_entwurf e JOIN bericht b "
                + "ON b.id = e.bericht_id AND b.tenant_id = e.tenant_id WHERE e.tenant_id = ? AND b.kennung = ? "
                + "FOR UPDATE OF e")) {
            ps.setObject(1, b.tenant());
            ps.setString(2, bericht.kennung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Bericht-Kaskade: " + bericht.kennung() + " hat keinen Entwurf");
                }
                id = rs.getObject(1, UUID.class);
            }
        }
        BerichtAbzugBildung.Ergebnis e = bildung.bilden(con, id, datenstand(con, b), GEBILDET_VON);
        ObjectNode m = meldung(NEU_GEBILDET, b.tenant() + ":" + bericht.kennung() + ":" + e.datenstand() + ":"
                + b.anlass() + ":" + b.fassung() + ":" + b.status(), e.datenstand(), bericht.kennung());
        m.put("datenstand", e.datenstand().toString());
        m.put("anlass_kennung", b.anlass());
        melden(con, b.tenant(), m, e.datenstand());
    }

    @Override
    public void revisionAusloesen(Connection con, Bericht bericht, KorrekturKaskade.Betroffen b) throws SQLException {
        UUID stand;
        int nr;
        try (PreparedStatement ps = con.prepareStatement("SELECT s.id, s.nr FROM bericht_stand s JOIN bericht b "
                + "ON b.id = s.bericht_id AND b.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND b.kennung = ? "
                + "AND s.ersetzt_durch_nr IS NULL ORDER BY s.nr DESC LIMIT 1")) {
            ps.setObject(1, b.tenant());
            ps.setString(2, bericht.kennung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Bericht-Kaskade: " + bericht.kennung()
                            + " hat keinen gültigen Berichtsstand");
                }
                stand = rs.getObject(1, UUID.class);
                nr = rs.getInt(2);
            }
        }
        String art = BerichtRegeln.anstossArt(b);
        Instant zeitpunkt = datenstand(con, b);
        String schluessel = b.tenant() + ":" + stand + ":" + art + ":" + b.anlass() + ":" + b.fassung() + ":" + b.status();
        ObjectNode m = meldung(ANGESTOSSEN, schluessel, zeitpunkt, bericht.kennung());
        boolean neu;
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO bericht_revision_anstoss (tenant_id, stand_id, art, anlass_kennung, anlass_fassung,
                       anlass_status, ereignis_id, erkannt_am)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT ON CONSTRAINT bericht_revision_anstoss_einmal DO NOTHING
                """)) {
            ps.setObject(1, b.tenant());
            ps.setObject(2, stand);
            ps.setString(3, art);
            ps.setString(4, b.anlass());
            ps.setInt(5, b.fassung());
            ps.setString(6, b.status());
            ps.setObject(7, UUID.fromString(m.get("ereignis_id").asText()));
            ps.setTimestamp(8, Timestamp.from(zeitpunkt));
            neu = ps.executeUpdate() == 1;
        }
        if (!neu) {
            return; // B7: derselbe Anstoß ist schon da — keine zweite Zeile, keine zweite Meldung.
        }
        m.put("nr", nr);
        m.put("anstoss_art", art);
        m.put("anlass_kennung", b.anlass());
        m.put("anlass_fassung", b.fassung());
        melden(con, b.tenant(), m, zeitpunkt);
        log.info("UEMS Bericht-Kaskade {} (Fassung {}): Revision nötig für {} Nr. {} ({})", b.anlass(), b.fassung(),
                bericht.kennung(), nr, art);
    }

    /**
     * Der Datenstand einer Bildung der Kaskade (D1) — auf die Sekunde, wie die Meldungen ihn tragen (ohne Bruchteile), und
     * AUFGERUNDET: {@code Betroffen.jetzt} nimmt die Kaskade VOR ihrer Transaktion, ihre Versionen tragen {@code created_at}
     * = Beginn der Transaktion. Ein Datenstand darunter läge vor ihnen, D2 würfe, und die Kaskade rollte in jedem Takt
     * zurück. Darum die spätere von {@code jetzt} und der Uhr der Datenbank, auf die nächste volle Sekunde.
     */
    static Instant datenstand(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        if (b.jetzt() == null) {
            throw new IllegalStateException("UEMS Bericht-Kaskade: " + b.anlass() + " ohne Zeitpunkt des Laufs");
        }
        Instant uhr;
        try (PreparedStatement ps = con.prepareStatement("SELECT clock_timestamp()");
                ResultSet rs = ps.executeQuery()) {
            rs.next();
            uhr = rs.getTimestamp(1).toInstant();
        }
        return aufDieSekunde(uhr.isAfter(b.jetzt()) ? uhr : b.jetzt());
    }

    static Instant aufDieSekunde(Instant t) {
        Instant sekunde = t.truncatedTo(ChronoUnit.SECONDS);
        return sekunde.equals(t) ? t : sekunde.plusSeconds(1);
    }

    /** Kopf einer Meldung: Kennung abgeleitet (eine Wiederholung ist dieselbe Meldung), Bezug nur der Bericht. */
    private static ObjectNode meldung(String art, String schluessel, Instant zeitpunkt, String kennung) {
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", UUID.nameUUIDFromBytes((art + ":" + schluessel).getBytes(StandardCharsets.UTF_8)).toString());
        e.put("art", art);
        e.put("zeitpunkt", zeitpunkt.toString());
        e.put("bericht", kennung);
        return e;
    }

    /** Über den einen Weg für Meldungen, auf der Verbindung der Kaskade — bricht die Kaskade ab, gibt es keine Meldung. */
    private static void melden(Connection con, UUID tenant, ObjectNode ereignis, Instant eingang) {
        MessreiheEreignisRepository.Ergebnis r = new MessreiheEreignisRepository(
                new JdbcTemplate(new SingleConnectionDataSource(con, true)))
                .anhaengen(tenant, null, Urheber.CLOUD, ereignis, null, eingang);
        if (r.ausgang() == MessreiheEreignisRepository.Ausgang.VERWORFEN) {
            throw new IllegalStateException(ereignis.get("art").asText() + "-Meldung verworfen: " + r.grund() + " "
                    + r.hinweis());
        }
    }
}
