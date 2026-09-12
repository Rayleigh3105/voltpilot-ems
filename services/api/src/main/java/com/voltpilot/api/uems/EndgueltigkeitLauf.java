package com.voltpilot.api.uems;

import java.sql.Timestamp;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der STUNDENLAUF der Endgültigkeit (UEMS AP-07 IP-13, Entscheid E5 vom 10.09.2026, Option A):
 * er setzt jede fällige Viertelstunde von {@code vorlaeufig} auf {@code endgueltig}.
 *
 * <p><b>Er schreibt nur nieder, was ohnehin schon gilt.</b> Die Frist steht seit IP-12 in der
 * Zeile ({@code endgueltig_ab} = Intervallende + 7 Tage, per CHECK gehalten) und gehört dem
 * INTERVALL, nicht der Zeile ({@link TagRegeln#geschlossen}). Ob dieser Lauf pünktlich war,
 * ändert deshalb nie eine Entscheidung — es ändert nur, wie aktuell die Spalte aussieht.
 *
 * <p><b>Was er NIE tut:</b> eine endgültige Zeile anfassen, einen Wert ändern, eine Zeile anlegen
 * oder löschen. Er setzt genau ein Wort in genau einer Spalte. {@code berechnet_am} bleibt stehen
 * — die Zahlen der Zeile wurden nicht neu berechnet, und eine Zeile, die sich nicht geändert hat,
 * bleibt Zeichen für Zeichen stehen.
 *
 * <p><b>Idempotent.</b> Das Prädikat ist {@code zustand = 'vorlaeufig'}; ein zweiter Lauf
 * unmittelbar danach findet nichts mehr und schreibt nichts.
 *
 * <p><b>Abbruchsicher.</b> Jeder Stapel ist seine eigene Transaktion. Bricht der Lauf nach dem
 * dritten Stapel ab, sind drei Stapel endgültig und der Rest steht unverändert da — beim nächsten
 * Takt macht er dort weiter, wo er aufhörte. Es gibt keinen Zwischenzustand, den er aufräumen
 * müsste.
 *
 * <p><b>Zwei Läufe gleichzeitig.</b> Die Entnahme greift unter {@code FOR UPDATE SKIP LOCKED}:
 * jeder bekommt einen anderen Stapel, keiner wartet, keiner schaltet dieselbe Zeile zweimal um.
 * Und selbst wenn zwei dieselbe Zeile griffen, stünde im {@code UPDATE} noch einmal
 * {@code zustand = 'vorlaeufig'} — der zweite schriebe null Zeilen.
 *
 * <p><b>Zum Fünf-Minuten-Lauf</b> ({@link ViertelstundeVerdichter}) stehen sie so: der
 * Verdichtungs-Lauf rührt eine endgültige Zeile grundsätzlich nicht an ({@code ON CONFLICT …
 * WHERE zustand = 'vorlaeufig'}, IP-12) und weist seit IP-13 einen Nachzügler für ein
 * GESCHLOSSENES Intervall schon vor dem Schreiben ab ({@link SpaetankunftMelder}). Beide Läufe
 * können darum gleichzeitig laufen: der eine baut nur offene Intervalle, der andere schließt nur
 * fällige — und wenn beide dieselbe Zeile treffen, gewinnt die Reihenfolge der Datenbank ohne
 * Schaden. Wird eine Zeile in genau dem Augenblick endgültig, in dem der Verdichter sie neu
 * bilden will, verliert der Verdichter seinen Schreibversuch (0 Zeilen) — der Wert ist dann
 * endgültig, und der Nachzügler holt sich beim nächsten Takt seine Meldung.
 */
@Component
public class EndgueltigkeitLauf {

    private static final Logger log = LoggerFactory.getLogger(EndgueltigkeitLauf.class);

    /** Der Laufstand-Schlüssel, unter dem er zählt, was er insgesamt umgeschaltet hat. */
    static final String STAND = "endgueltigkeit";

    /**
     * Fällig heißt: das Intervall liegt mindestens {@code FRIST} + Intervalllänge zurück. Das
     * Prädikat steht auf {@code intervall_beginn} statt auf {@code endgueltig_ab}, weil das die
     * Partitionierungs-Spalte der Hypertable ist (Chunk-Ausschluss) — die beiden sind durch den
     * CHECK aus V20260912170000 zeichengleich aneinander gebunden.
     */
    private static final String FAELLIG = """
            WITH faellig AS (
                SELECT tenant_id, entity_id, messkanal, intervall_beginn
                  FROM messreihe_viertelstunde
                 WHERE zustand = 'vorlaeufig'
                   AND intervall_beginn <= ?
                 ORDER BY intervall_beginn
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED)
            UPDATE messreihe_viertelstunde m
               SET zustand = 'endgueltig'
              FROM faellig f
             WHERE m.tenant_id = f.tenant_id AND m.entity_id = f.entity_id
               AND m.messkanal = f.messkanal AND m.intervall_beginn = f.intervall_beginn
               AND m.zustand = 'vorlaeufig'
            """;

    private final JdbcTemplate adminJdbc;
    private final int stapelGroesse;
    private final int stapelJeLauf;

    public EndgueltigkeitLauf(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            @Value("${voltpilot.uems.endgueltigkeit.stapel:2000}") int stapelGroesse,
            @Value("${voltpilot.uems.endgueltigkeit.stapel-je-lauf:200}") int stapelJeLauf) {
        this.adminJdbc = adminJdbc;
        this.stapelGroesse = stapelGroesse;
        this.stapelJeLauf = stapelJeLauf;
    }

    /**
     * Ein ganzer Lauf: Stapel für Stapel umschalten, bis nichts mehr fällig ist oder
     * {@code stapel-je-lauf} Stapel voll sind.
     *
     * @return wie viele Zeilen endgültig wurden
     */
    public int umschalten(Instant jetzt) {
        Timestamp schwelle = Timestamp.from(
                jetzt.minus(ViertelstundeRegeln.FRIST).minus(ViertelstundeRegeln.LAENGE));
        int gesamt = 0;
        for (int i = 0; i < stapelJeLauf; i++) {
            int n = adminJdbc.update(FAELLIG, schwelle, stapelGroesse);
            gesamt += n;
            if (n == 0) {
                break;
            }
        }
        if (gesamt > 0) {
            adminJdbc.update("UPDATE messreihe_tag_lauf SET zeitpunkt = ?, zahl = zahl + ?, "
                    + "geaendert_am = now() WHERE schluessel = ?",
                    Timestamp.from(jetzt), gesamt, STAND);
            log.info("UEMS Endgültigkeit: {} Viertelstundenwerte sind endgültig geworden", gesamt);
        }
        return gesamt;
    }
}
