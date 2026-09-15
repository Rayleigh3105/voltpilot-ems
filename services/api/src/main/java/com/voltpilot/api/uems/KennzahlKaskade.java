package com.voltpilot.api.uems;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Die Kaskaden-Naht der KENNZAHLEN, Reihen-Pfad (UEMS AP-11 IP-8, E8 = A) — ersetzt {@link KennzahlenNaht.Keine}.
 *
 * <p>Die Korrektur-Kaskade ({@link KorrekturKaskade}) ruft sie nach allen Stufen und den berechneten Messstellen in
 * DERSELBEN Transaktion. Von den korrigierten Reihen über ihre Quellenbindung ({@code messstelle_quelle}, führend, im
 * Zeitraum der Korrektur) auf die gemessenen Messstellen, dazu die berechneten Messstellen, die eine neue Version
 * bekamen; von dort über die Eingänge auf die Kennzahlen und rekursiv auf jede, die eine davon liest. Gerechnet wird im
 * {@link KennzahlLauf#nachKorrektur} — dieselben Wege, dieselbe Regel, dieselbe Ordnung wie im Regellauf. Jede
 * endgültige Periode, die sich ändert, wird Version n + 1 „korrigiert (Version n + 1)“ mit dem Anlass der Kaskade und
 * meldet {@code kennzahl_neu_gebildet}; Version n bleibt lesbar ({@code …/werte/versionen}).
 *
 * <p>Wirft bei jedem Fehler — die Kaskade rollt dann alles zurück, auch die Stufen der Messreihe (keine halbe Wahrheit).
 * Der Nenner- und Definitions-Auslöser ({@code Betroffen.bezugsgroessen}, IP-9) ist hier noch nicht angeschlossen.
 */
@Component
public class KennzahlKaskade implements KennzahlenNaht {

    private static final Logger log = LoggerFactory.getLogger(KennzahlKaskade.class);

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
        if (messstellen.isEmpty()) {
            return;
        }
        KennzahlLauf.Neubildung n = lauf.nachKorrektur(con, betroffen, messstellen, beleg(con, betroffen));
        KennzahlNeuGebildet.melden(con, betroffen.tenant(), betroffen.anlass(), n.neu(), betroffen.jetzt());
        if (n.geschrieben() > 0 || !n.abgelehnt().isEmpty()) {
            log.info("UEMS Kennzahl-Kaskade {} (Fassung {}): {} Kennzahlen, {} Werte geschrieben, davon {} neue Versionen, "
                    + "{} unverändert, {} abgelehnt", betroffen.anlass(), betroffen.fassung(), n.kennzahlen(),
                    n.geschrieben(), n.neu().size(), n.unveraendert(), n.abgelehnt().size());
        }
    }

    /**
     * Die Messstellen, von denen eine Kennzahl leben kann: jede, die eine korrigierte Reihe im Zeitraum FÜHREND liest, und
     * jede berechnete, der die Kaskade eine neue Version gab.
     */
    static Set<UUID> messstellen(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
        Set<UUID> aus = new LinkedHashSet<>();
        for (KorrekturKaskade.Reihe r : b.reihen()) {
            try (PreparedStatement ps = con.prepareStatement("""
                    SELECT DISTINCT q.messstelle_id
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
     * ({@code KennzahlWerteService.kennungen}); die Meldung {@code kennzahl_neu_gebildet} trägt die Kennung allein.
     */
    static String beleg(Connection con, KorrekturKaskade.Betroffen b) throws SQLException {
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

    private static void sammeln(PreparedStatement ps, Set<UUID> aus) throws SQLException {
        try (ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                aus.add(rs.getObject(1, UUID.class));
            }
        }
    }
}
