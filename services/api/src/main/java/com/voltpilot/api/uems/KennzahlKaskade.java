package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Die Kaskaden-Naht der KENNZAHLEN (UEMS AP-11 IP-8 Reihen-Pfad, IP-9 Nenner- und Definitions-Auslöser; E8 = A) —
 * ersetzt {@link KennzahlenNaht.Keine}.
 *
 * <p>Die Korrektur-Kaskade ({@link KorrekturKaskade}) ruft sie nach allen Stufen und den berechneten Messstellen in
 * DERSELBEN Transaktion. Von den korrigierten Reihen über ihre Quellenbindung ({@code messstelle_quelle}, führend, im
 * Zeitraum der Korrektur) auf die gemessenen Messstellen, dazu die berechneten Messstellen, die eine neue Version
 * bekamen; von dort über die Eingänge auf die Kennzahlen und rekursiv auf jede, die eine davon liest. Gerechnet wird im
 * {@link KennzahlLauf#nachKorrektur} — dieselben Wege, dieselbe Regel, dieselbe Ordnung wie im Regellauf. Jede
 * endgültige Periode, die sich ändert, wird Version n + 1 „korrigiert (Version n + 1)“ mit dem Anlass der Kaskade und
 * meldet {@code kennzahl_neu_gebildet}; Version n bleibt lesbar ({@code …/werte/versionen}).
 *
 * <p>Seit IP-9 (W1) ruft die Kaskade die Naht auch ohne Messreihe: mit {@code Betroffen.bezugsgroessen} nach der
 * Berichtigung oder Rücknahme eines Bezugsgrößen-Werts ({@code correction} mit Bezug {@code bezugsgroesse}) oder einem
 * rückwirkend eingetragenen Stammdatum — betroffen ist jede Kennzahl mit dieser Bezugsgröße als Eingang —, und mit dem
 * Status {@code berechnung_geaendert} nach einer rückwirkenden Fassung der Berechnung — betroffen ist die Kennzahl
 * {@code Betroffen.anlass} selbst. Ihr endgültiger Wert wird Version n + 1 „Berechnung geändert (Fassung n)“, jede
 * abhängige „korrigiert (Version n + 1)“. Die Meldung nennt als Auslöser die Kennung des Vorgangs bzw. das Kennzeichen.
 *
 * <p>Wirft bei jedem Fehler — die Kaskade rollt dann alles zurück, auch die Stufen der Messreihe (keine halbe Wahrheit).
 */
@Component
public class KennzahlKaskade implements KennzahlenNaht {

    private static final Logger log = LoggerFactory.getLogger(KennzahlKaskade.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Die Entscheidung im Beleg in Kundensprache, wie die Referenzdatei sie schreibt („freigegeben 12.11.2026“). */
    private static final Map<String, String> ENTSCHIEDEN = Map.of(KorrekturKaskade.FREIGEGEBEN, "freigegeben",
            KorrekturKaskade.ZURUECKGENOMMEN, "zurückgenommen", KorrekturKaskade.WIRKSAM, "wirksam");
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.uuuu");

    private final KennzahlLauf lauf;

    public KennzahlKaskade(KennzahlLauf lauf) {
        this.lauf = lauf;
    }

    @Override
    public void nachKorrektur(Connection con, KorrekturKaskade.Betroffen betroffen) throws SQLException {
        Set<UUID> messstellen = messstellen(con, betroffen);
        Set<UUID> bezugsgroessen = new LinkedHashSet<>();
        betroffen.bezugsgroessen().forEach(g -> bezugsgroessen.add(g.id()));
        boolean berechnung = KorrekturKaskade.BERECHNUNG_GEAENDERT.equals(betroffen.status());
        if (messstellen.isEmpty() && bezugsgroessen.isEmpty() && !berechnung) {
            return;
        }
        KennzahlLauf.Ausloeser ausloeser = new KennzahlLauf.Ausloeser(messstellen, bezugsgroessen,
                berechnung ? betroffen.anlass() : null, berechnung ? betroffen.fassung() : 0);
        KennzahlLauf.Neubildung n = lauf.nachKorrektur(con, betroffen, ausloeser, beleg(con, betroffen));
        KennzahlNeuGebildet.melden(con, betroffen.tenant(), ausloeser(betroffen), n.neu(), betroffen.jetzt());
        if (n.geschrieben() > 0 || !n.abgelehnt().isEmpty()) {
            log.info("UEMS Kennzahl-Kaskade {} (Fassung {}): {} Kennzahlen, {} Werte geschrieben, davon {} neue Versionen, "
                    + "{} unverändert, {} abgelehnt", betroffen.anlass(), betroffen.fassung(), n.kennzahlen(),
                    n.geschrieben(), n.neu().size(), n.unveraendert(), n.abgelehnt().size());
        }
    }

    /**
     * Der Auslöser der Meldung {@code kennzahl_neu_gebildet}: die Kennung des Vorgangs ({@code K-…}, {@code EW-…},
     * {@code BK-…}); ohne Vorgang die Kennzahl mit der Nummer ihrer neuen Fassung ({@code KZ-0004/Fassung-2}) bzw. die
     * Bezugsgröße mit dem Tag, ab dem das Stammdatum gilt ({@code BZ-8/ab-2027-01-01}) bzw. der Ort mit dem Tag, ab dem
     * die neue Bezugsfläche gilt ({@code G-2/ab-2027-01-01}) — ein bloßes Kennzeichen wäre eine Neubildung ohne
     * Ursache.
     */
    static String ausloeser(KorrekturKaskade.Betroffen b) {
        if (KorrekturKaskade.BERECHNUNG_GEAENDERT.equals(b.status())) {
            return b.anlass() + "/Fassung-" + b.fassung();
        }
        if (KorrekturKaskade.STAMMDATUM_EINGETRAGEN.equals(b.status())
                || KorrekturKaskade.FLAECHE_GEAENDERT.equals(b.status())) {
            return b.anlass() + "/ab-" + b.bezugsgroessen().get(0).periodeVon();
        }
        return b.anlass();
    }

    /**
     * Die Messstellen, von denen eine Kennzahl leben kann: jede, die eine korrigierte Reihe im Zeitraum FÜHREND liest, und
     * jede berechnete, der die Kaskade eine neue Version gab.
     */
    static Set<UUID> messstellen(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        Set<UUID> aus = new LinkedHashSet<>();
        for (KorrekturKaskade.Reihe r : b.reihen()) {
            try (PreparedStatement ps = con.prepareStatement("""
                    SELECT q.messstelle_id
                      FROM messstelle_quelle q
                     WHERE q.tenant_id = ? AND q.entity_id = ? AND q.kanal = ? AND q.rolle = 'fuehrend'
                       AND q.gueltig_ab < ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?)
                     ORDER BY q.messstelle_id
                    """)) {
                ps.setObject(1, b.tenant());
                ps.setObject(2, r.entity());
                ps.setString(3, r.kanal());
                ps.setTimestamp(4, Timestamp.from(b.bis()));
                ps.setTimestamp(5, Timestamp.from(b.von()));
                sammeln(ps, aus);
            }
        }
        if (!b.messstellen().isEmpty()) {
            try (PreparedStatement ps = con.prepareStatement("SELECT id FROM messstelle WHERE tenant_id = ? "
                    + "AND kennzeichen = ANY (?) ORDER BY kennzeichen")) {
                ps.setObject(1, b.tenant());
                ps.setArray(2, con.createArrayOf("text", b.messstellen().toArray()));
                sammeln(ps, aus);
            }
        }
        return aus;
    }

    /**
     * Der Beleg einer Neubildung, wie ihn {@code kennzahl_wert.anlass_kennung} trägt und die Herkunft als {@code anlass}
     * zeigt: die Kennung des Vorgangs mit seiner Entscheidung und deren Tag in der Zone des Kundenbereichs —
     * „K-2026-0007 (freigegeben 12.11.2026)“ (K7). Die Leseseite findet die Kennung darin wieder
     * ({@code KennzahlWerteService.kennungen}); die Meldung {@code kennzahl_neu_gebildet} trägt die Kennung allein. Die
     * Auslöser aus IP-9 haben ihren eigenen Satz ({@link #nenner}, {@link #stammdatum}, {@link #berechnung}).
     */
    static String beleg(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        if (KorrekturKaskade.BERECHNUNG_GEAENDERT.equals(b.status())) {
            return berechnung(con, b);
        }
        if (KorrekturKaskade.STAMMDATUM_EINGETRAGEN.equals(b.status())) {
            return stammdatum(con, b);
        }
        if (KorrekturKaskade.FLAECHE_GEAENDERT.equals(b.status())) {
            return flaeche(con, b);
        }
        if (!b.bezugsgroessen().isEmpty()) {
            return nenner(con, b);
        }
        String wort = ENTSCHIEDEN.get(b.status());
        if (wort == null) {
            throw new IllegalStateException("UEMS Kennzahl-Kaskade: unbekannte Entscheidung " + b.status());
        }
        String tabelle = b.anlass().startsWith("EW-") ? "messreihe_ersatzwert" : "messreihe_korrektur";
        try (PreparedStatement ps = con.prepareStatement("SELECT created_at FROM " + tabelle
                + " WHERE tenant_id = ? AND kennung = ? AND fassung = ?")) {
            ps.setObject(1, b.tenant());
            ps.setString(2, b.anlass());
            ps.setInt(3, b.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Kennzahl-Kaskade: " + b.anlass() + " Fassung " + b.fassung()
                            + " nicht gefunden");
                }
                return b.anlass() + " (" + wort + " " + TAG.format(rs.getTimestamp(1).toInstant().atZone(b.zone()))
                        + ")";
            }
        }
    }

    /**
     * Der Beleg einer Bezugsgrößen-Meldung, wie der Vertrag ihn schreibt: „correction BZ-1 2026-10 Fassung 1 → 2
     * (I-2026-0003)“ (K6) — in Klammern der Import, sonst die Berichtigung {@code BK-…} —, nach einer Rücknahme
     * „Rücknahme I-2026-0001“ (K19). Die Periode steht als Schlüssel der Bezugsgröße.
     */
    static String nenner(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        KorrekturKaskade.Bezugsgroesse g = b.bezugsgroessen().get(0);
        try (PreparedStatement ps = con.prepareStatement("SELECT e.nutzlast::text, (SELECT periode_art FROM bezugsgroesse "
                + "WHERE tenant_id = e.tenant_id AND id = ?) FROM messreihe_ereignis e WHERE e.tenant_id = ? "
                + "AND e.ereignis_id = ? AND e.art = 'correction' ORDER BY e.eingang LIMIT 1")) {
            ps.setObject(1, g.id());
            ps.setObject(2, b.tenant());
            ps.setObject(3, b.ereignisse().isEmpty() ? null : b.ereignisse().get(0));
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Kennzahl-Kaskade: " + b.anlass() + " ohne Meldung correction");
                }
                JsonNode nutzlast = JSON.readTree(rs.getString(1));
                String vorgang = nutzlast.hasNonNull("import") ? nutzlast.get("import").asText()
                        : nutzlast.path("korrektur").asText();
                if (KorrekturKaskade.ZURUECKGENOMMEN.equals(b.status())) {
                    return "Rücknahme " + vorgang;
                }
                return "correction " + g.kennzeichen() + " " + BezugsPeriode.schluesselVon(g.periodeVon(), rs.getString(2))
                        + " Fassung " + nutzlast.path("fassung_alt").asInt() + " → " + nutzlast.path("fassung_neu").asInt()
                        + " (" + vorgang + ")";
            } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
                throw new IllegalStateException("UEMS Kennzahl-Kaskade: Meldung zu " + b.anlass() + " unlesbar", x);
            }
        }
    }

    /** „Stammdatum BZ-8 ab 01.01.2026 (eingetragen 15.01.2026)“ — der Eintrag im Protokoll der Bezugsgröße. */
    static String stammdatum(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        KorrekturKaskade.Bezugsgroesse g = b.bezugsgroessen().get(0);
        try (PreparedStatement ps = con.prepareStatement("SELECT created_at FROM (SELECT created_at, "
                + "row_number() OVER (ORDER BY id)::int AS nr FROM bezugsgroesse_aenderung WHERE tenant_id = ? "
                + "AND bezugsgroesse_id = ? AND art = 'stammdatum_eingetragen') e WHERE e.nr = ?")) {
            ps.setObject(1, b.tenant());
            ps.setObject(2, g.id());
            ps.setInt(3, b.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Kennzahl-Kaskade: Stammdatum " + g.kennzeichen() + " Eintrag "
                            + b.fassung() + " nicht gefunden");
                }
                return "Stammdatum " + g.kennzeichen() + " ab " + TAG.format(g.periodeVon()) + " (eingetragen "
                        + TAG.format(rs.getTimestamp(1).toInstant().atZone(b.zone())) + ")";
            }
        }
    }

    /**
     * „Bezugsfläche G-2 ab 01.01.2027 (eingetragen 15.01.2027)“ — der Eintrag im Änderungsprotokoll des Orts
     * ({@code ort_aenderung} / {@code flaeche_geaendert}). Den Ort findet der Beleg über den Geltungsbereich der
     * Bezugsgröße, die als Zeiger auf seine Fläche gebunden ist.
     */
    static String flaeche(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        KorrekturKaskade.Bezugsgroesse g = b.bezugsgroessen().get(0);
        try (PreparedStatement ps = con.prepareStatement("SELECT created_at FROM (SELECT created_at, "
                + "row_number() OVER (ORDER BY id)::int AS nr FROM ort_aenderung WHERE tenant_id = ? "
                + "AND art = 'flaeche_geaendert' AND objekt_id = (SELECT coalesce(standort_id, ort_id) "
                + "FROM bezugsgroesse WHERE tenant_id = ? AND id = ?)) e WHERE e.nr = ?")) {
            ps.setObject(1, b.tenant());
            ps.setObject(2, b.tenant());
            ps.setObject(3, g.id());
            ps.setInt(4, b.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Kennzahl-Kaskade: Bezugsfläche " + b.anlass() + " Eintrag "
                            + b.fassung() + " nicht gefunden");
                }
                return "Bezugsfläche " + b.anlass() + " ab " + TAG.format(g.periodeVon()) + " (eingetragen "
                        + TAG.format(rs.getTimestamp(1).toInstant().atZone(b.zone())) + ")";
            }
        }
    }

    /** „KZ-0004 Fassung 2 ab 01.03.2027 (eingetragen 20.03.2027)“ — die Fassung der Berechnung, ab ihrem Tag. */
    static String berechnung(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT f.gueltig_ab, f.eingetragen_am FROM kennzahl_fassung f "
                + "JOIN kennzahl k ON k.id = f.kennzahl_id AND k.tenant_id = f.tenant_id "
                + "WHERE k.tenant_id = ? AND k.kennzeichen = ? AND f.nummer = ?")) {
            ps.setObject(1, b.tenant());
            ps.setString(2, b.anlass());
            ps.setInt(3, b.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Kennzahl-Kaskade: " + b.anlass() + " Fassung " + b.fassung()
                            + " nicht gefunden");
                }
                return b.anlass() + " Fassung " + b.fassung() + " ab " + TAG.format(rs.getObject(1, LocalDate.class))
                        + " (eingetragen " + TAG.format(rs.getTimestamp(2).toInstant().atZone(b.zone())) + ")";
            }
        }
    }

    private static void sammeln(PreparedStatement ps, Set<UUID> aus) throws SQLException {
        try (ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                aus.add(rs.getObject(1, UUID.class));
            }
        }
    }
}
