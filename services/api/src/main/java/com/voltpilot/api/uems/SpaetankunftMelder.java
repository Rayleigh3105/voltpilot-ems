package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Die SPÄTANKUNFT (UEMS AP-07 IP-13, Entscheid E5 vom 10.09.2026, Option A): ein Rohwert, dessen
 * Viertelstunde ihre Frist schon hinter sich hat.
 *
 * <p><b>Speichern, melden, vorschlagen — nicht anwenden.</b>
 *
 * <ol>
 *   <li><b>Speichern</b> tut die Rohtabelle, und sie tut es längst: ein Rohwert wird bis 90 Tage
 *       zurück angenommen und nie wieder geändert. Diese Klasse fasst ihn nicht an.
 *   <li><b>Melden</b> heißt {@code late_arrival} über den vorhandenen Ereignis-Weg
 *       ({@code messreihe_ereignis}, AP-07 IP-8) — mit dem Vokabular-Urteil aus
 *       {@link EreignisVokabular} davor, damit hier kein Wort entsteht, das der Vertrag nicht
 *       kennt. Urheber ist {@code cloud}: den Lauf fährt die api.
 *   <li><b>Vorschlagen</b> heißt eine Zeile in {@code messreihe_korrektur_vorschlag} — die Liste,
 *       aus der AP-08 eine VERSIONIERTE Korrektur macht.
 *   <li><b>Nicht anwenden:</b> der Viertelstundenwert wird nicht gebildet und nicht geändert. Es
 *       gibt von hier aus keinen Weg, der eine Zeile der Viertelstunden- oder Tagesklasse
 *       schreibt.
 * </ol>
 *
 * <p><b>Alles in EINER Transaktion.</b> Melder und Vorschlag laufen auf der {@link Connection} des
 * {@link ViertelstundeVerdichter}, in derselben Transaktion, in der der Nachzügler abgelehnt und
 * sein Eintrag aus der Arbeitsliste entnommen wird. Sonst gäbe es einen Augenblick, in dem der
 * Wert abgelehnt, aber noch nicht gemeldet ist — und ein Absturz genau dort ließe ihn
 * verschwinden.
 *
 * <p><b>Wiederholbar.</b> Beide Zeilen sind eine FUNKTION der Rohwerte: Anzahl, früheste und
 * späteste Messzeit, erste und letzte Eingangszeit werden bei jedem Lauf neu gezählt. Die
 * Ereignis-Kennung wird daraus abgeleitet, also trifft eine Wiederholung denselben
 * Idempotenz-Schlüssel ({@code meldung}) und schreibt nichts Neues; kommt dagegen eine ZWEITE
 * Welle, ist es ein anderes Ereignis und wird als solches gemeldet.
 */
@Component
public class SpaetankunftMelder {

    private static final Logger log = LoggerFactory.getLogger(SpaetankunftMelder.class);

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Der eine Grund, aus dem dieses Paket einen Vorschlag schreibt (§4.5 Nachlieferung Nr. 4). */
    static final String GRUND = "nachlieferung_nach_endgueltigkeit";

    /** Was zu spät kam — gezählt, nie geschätzt. */
    record Nachzuegler(int anzahl, Instant fruehesteMesszeit, Instant spaetesteMesszeit,
            Instant ersteEingangszeit, Instant letzteEingangszeit, UUID siteId, UUID box) {}

    /** Was eine Meldung tat — für das Log und die Tests. */
    public record Ergebnis(boolean gemeldet, boolean vorgeschlagen, int anzahl) {

        static final Ergebnis NICHTS = new Ergebnis(false, false, 0);
    }

    /**
     * Meldet die Nachzügler EINES geschlossenen Intervalls und schreibt ihren Vorschlag.
     *
     * <p>„Nachzügler" sind genau die Rohwerte dieser Reihe in diesem Intervall, deren
     * EINGANGSZEIT nach der Frist liegt. Fand der Lauf keinen — weil der Eintrag der Arbeitsliste
     * aus der Überlappung des Zeigers stammt, nicht aus einer echten Nachlieferung —, entsteht
     * weder Meldung noch Vorschlag: eine Meldung ohne Nachzügler wäre eine erfundene Tatsache.
     */
    public Ergebnis melden(Connection con, UUID tenantId, UUID entityId, String messkanal,
            Instant intervallBeginn) throws SQLException {
        Instant ende = ViertelstundeRegeln.ende(intervallBeginn);
        Instant frist = ViertelstundeRegeln.endgueltigAb(intervallBeginn);
        Nachzuegler n = zaehlen(con, tenantId, entityId, messkanal, intervallBeginn, ende, frist);
        if (n == null) {
            return Ergebnis.NICHTS;
        }
        UUID ereignisId = ereignisKennung(tenantId, entityId, messkanal, intervallBeginn, n);
        boolean gemeldet = ereignisAnhaengen(con, tenantId, entityId, messkanal, intervallBeginn,
                ende, ereignisId, n);
        vorschlagen(con, tenantId, entityId, messkanal, intervallBeginn, frist, ereignisId, n);
        log.info("UEMS Spätankunft: {} Rohwerte für {} {} nach der Frist ({}) — gemeldet, "
                + "vorgeschlagen, NICHT angewendet",
                n.anzahl(), messkanal, intervallBeginn, frist);
        return new Ergebnis(gemeldet, true, n.anzahl());
    }

    /** Ein Intervall einer Reihe — was die Vorprüfung eines Stapels braucht. */
    public record Intervall(UUID tenantId, UUID entityId, String messkanal, Instant beginn) {}

    /**
     * AP-08 IP-19: welche dieser Intervalle haben NACHZÜGLER? Dieselbe Bedingung wie die Zählung von
     * {@link #melden}, aber für einen ganzen Stapel in EINER Abfrage — die Verdichtung fragt damit jedes
     * geschlossene Intervall, gleich aus welchem Grund es in der Arbeitsliste steht (auch die Rückrechnung mit
     * ihren vielen Tausend geschlossenen Intervallen), und zählt genau nur dort nach, wo es etwas zu melden gibt.
     */
    public Set<Intervall> mitNachzueglern(Connection con, List<Intervall> intervalle) throws SQLException {
        Set<Intervall> aus = new HashSet<>();
        if (intervalle.isEmpty()) {
            return aus;
        }
        Instant von = null;
        Instant bis = null;
        StringBuilder werte = new StringBuilder();
        for (int i = 0; i < intervalle.size(); i++) {
            Instant b = intervalle.get(i).beginn();
            von = von == null || b.isBefore(von) ? b : von;
            bis = bis == null || b.isAfter(bis) ? b : bis;
            werte.append(i == 0 ? "(?::int, ?::uuid, ?::uuid, ?::text, ?::timestamptz, ?::timestamptz, ?::timestamptz)"
                    : ", (?, ?, ?, ?, ?, ?, ?)");
        }
        try (PreparedStatement ps = con.prepareStatement("""
                WITH intervall(nr, tenant_id, entity_id, messkanal, von, bis, frist) AS (VALUES %s)
                SELECT i.nr FROM intervall i
                 WHERE EXISTS (SELECT 1 FROM device_measurement_sample s
                                WHERE s.tenant_id = i.tenant_id AND s.entity_id = i.entity_id
                                  AND s.point_key = i.messkanal
                                  AND s.time >= i.von AND s.time < i.bis
                                  AND s.time >= ? AND s.time < ?
                                  AND s.role IS DISTINCT FROM 'spiegel'
                                  AND s.received_at > i.frist)
                """.formatted(werte))) {
            int p = 1;
            for (int i = 0; i < intervalle.size(); i++) {
                Intervall iv = intervalle.get(i);
                ps.setInt(p++, i);
                setzeUuid(ps, p++, iv.tenantId());
                setzeUuid(ps, p++, iv.entityId());
                ps.setString(p++, iv.messkanal());
                ps.setTimestamp(p++, Timestamp.from(iv.beginn()));
                ps.setTimestamp(p++, Timestamp.from(ViertelstundeRegeln.ende(iv.beginn())));
                ps.setTimestamp(p++, Timestamp.from(ViertelstundeRegeln.endgueltigAb(iv.beginn())));
            }
            ps.setTimestamp(p++, Timestamp.from(von));
            ps.setTimestamp(p, Timestamp.from(ViertelstundeRegeln.ende(bis)));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(intervalle.get(rs.getInt(1)));
                }
            }
        }
        return aus;
    }

    // ------------------------------------------------------------------- Die Zählung

    private Nachzuegler zaehlen(Connection con, UUID tenantId, UUID entityId, String messkanal,
            Instant von, Instant bis, Instant frist) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT count(*), min(s.time), max(s.time), min(s.received_at), max(s.received_at),
                       count(DISTINCT s.site_id), min(s.site_id::text),
                       count(DISTINCT s.device_id), min(s.device_id::text)
                  FROM device_measurement_sample s
                 WHERE s.tenant_id = ? AND s.entity_id = ? AND s.point_key = ?
                   AND s.time >= ? AND s.time < ?
                   AND s.role IS DISTINCT FROM 'spiegel'
                   AND s.received_at > ?
                """)) {
            setzeUuid(ps, 1, tenantId);
            setzeUuid(ps, 2, entityId);
            ps.setString(3, messkanal);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            ps.setTimestamp(6, Timestamp.from(frist));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                int anzahl = rs.getInt(1);
                if (anzahl == 0) {
                    return null;
                }
                return new Nachzuegler(anzahl,
                        rs.getTimestamp(2).toInstant(), rs.getTimestamp(3).toInstant(),
                        rs.getTimestamp(4).toInstant(), rs.getTimestamp(5).toInstant(),
                        // Die Anlage bzw. die Box NUR, wenn alle Nachzügler dieselbe nennen —
                        // sonst bleibt die Spalte leer, statt eine von beiden zu behaupten.
                        rs.getInt(6) == 1 ? uuid(rs.getString(7)) : null,
                        rs.getInt(8) == 1 ? uuid(rs.getString(9)) : null);
            }
        }
    }

    /**
     * Die Ereignis-Kennung wird ABGELEITET, nicht gewürfelt: dieselben Nachzügler ergeben dieselbe
     * Kennung, eine zweite Welle eine andere. Nur so ist ein wiederholter Lauf wirklich
     * wiederholbar — eine zufällige Kennung hinterließe bei jedem Takt ein weiteres Ereignis.
     */
    static UUID ereignisKennung(UUID tenantId, UUID entityId, String messkanal, Instant beginn,
            Nachzuegler n) {
        String saat = "late_arrival:" + tenantId + ':' + entityId + ':' + messkanal + ':'
                + beginn.getEpochSecond() + ':' + n.letzteEingangszeit().getEpochSecond() + ':'
                + n.anzahl();
        return UUID.nameUUIDFromBytes(saat.getBytes(StandardCharsets.UTF_8));
    }

    // ------------------------------------------------------------------- Die Meldung

    private boolean ereignisAnhaengen(Connection con, UUID tenantId, UUID entityId,
            String messkanal, Instant von, Instant bis, UUID ereignisId, Nachzuegler n)
            throws SQLException {
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", ereignisId.toString());
        e.put("art", "late_arrival");
        e.put("von", uhr(von));
        e.put("bis", uhr(bis));
        e.put("komponente", entityId.toString());
        e.put("messkanal", messkanal);
        if (n.box() != null) {
            e.put("box", n.box().toString());
        }
        e.put("eingangszeit", uhr(n.letzteEingangszeit()));
        e.put("anzahl", n.anzahl());

        Urteil urteil = EreignisVokabular.pruefe(e, Urheber.CLOUD);
        if (!urteil.angenommen()) {
            // Ein Urteil gegen die EIGENE Meldung ist ein Fehler im Code, kein Kundendatum. Es
            // wird laut protokolliert und NICHT verschwiegen — der Vorschlag entsteht trotzdem,
            // damit die Spätankunft nicht ganz verloren geht.
            log.error("UEMS Spätankunft: die eigene late_arrival-Meldung wurde vom Vokabular "
                    + "verworfen ({} {}) — der Vorschlag entsteht trotzdem",
                    urteil.grund(), urteil.hinweis());
            return false;
        }

        ObjectNode kennungen = JSON.createObjectNode();
        kennungen.put("komponente", entityId.toString());
        if (n.box() != null) {
            kennungen.put("box", n.box().toString());
        }
        ObjectNode nutzlast = JSON.createObjectNode();
        nutzlast.put("eingangszeit", uhr(n.letzteEingangszeit()));
        nutzlast.put("anzahl", n.anzahl());

        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber,
                       von, bis, site_id, kennungen, device_id, entity_id, messkanal, nutzlast,
                       eingang)
                VALUES (?, ?, ?, 'late_arrival', 'cloud', ?, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?)
                ON CONFLICT DO NOTHING
                """)) {
            ps.setTimestamp(1, Timestamp.from(von));
            setzeUuid(ps, 2, tenantId);
            setzeUuid(ps, 3, ereignisId);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            setzeUuid(ps, 6, n.siteId());
            ps.setString(7, kennungen.toString());
            setzeUuid(ps, 8, n.box());
            setzeUuid(ps, 9, entityId);
            ps.setString(10, messkanal);
            ps.setString(11, nutzlast.toString());
            ps.setTimestamp(12, Timestamp.from(n.letzteEingangszeit()));
            return ps.executeUpdate() > 0;
        }
    }

    // ------------------------------------------------------------------ Der Vorschlag

    private void vorschlagen(Connection con, UUID tenantId, UUID entityId, String messkanal,
            Instant beginn, Instant frist, UUID ereignisId, Nachzuegler n) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_korrektur_vorschlag (
                       tenant_id, entity_id, messkanal, intervall_beginn, site_id, grund,
                       endgueltig_ab, anzahl, frueheste_messzeit, spaeteste_messzeit,
                       erste_eingangszeit, letzte_eingangszeit, ereignis_id, version_bezug,
                       vorgeschlagen_am, geaendert_am, zustand)
                SELECT ?::uuid, ?::uuid, ?::text, ?::timestamptz, ?::uuid, ?::text,
                       ?::timestamptz, ?::int, ?::timestamptz, ?::timestamptz, ?::timestamptz,
                       ?::timestamptz, ?::uuid,
                       (SELECT v.version FROM messreihe_viertelstunde v
                         WHERE v.tenant_id = ?::uuid AND v.entity_id = ?::uuid
                           AND v.messkanal = ?::text AND v.intervall_beginn = ?::timestamptz),
                       now(), now(), 'offen'
                ON CONFLICT (tenant_id, entity_id, messkanal, intervall_beginn) DO UPDATE SET
                       site_id = EXCLUDED.site_id,
                       anzahl = EXCLUDED.anzahl,
                       frueheste_messzeit = EXCLUDED.frueheste_messzeit,
                       spaeteste_messzeit = EXCLUDED.spaeteste_messzeit,
                       erste_eingangszeit = EXCLUDED.erste_eingangszeit,
                       letzte_eingangszeit = EXCLUDED.letzte_eingangszeit,
                       ereignis_id = EXCLUDED.ereignis_id,
                       version_bezug = EXCLUDED.version_bezug,
                       geaendert_am = now()
                 WHERE messreihe_korrektur_vorschlag.zustand = 'offen'
                   AND (messreihe_korrektur_vorschlag.site_id,
                        messreihe_korrektur_vorschlag.anzahl,
                        messreihe_korrektur_vorschlag.frueheste_messzeit,
                        messreihe_korrektur_vorschlag.spaeteste_messzeit,
                        messreihe_korrektur_vorschlag.erste_eingangszeit,
                        messreihe_korrektur_vorschlag.letzte_eingangszeit,
                        messreihe_korrektur_vorschlag.ereignis_id,
                        messreihe_korrektur_vorschlag.version_bezug)
                       IS DISTINCT FROM
                       (EXCLUDED.site_id, EXCLUDED.anzahl, EXCLUDED.frueheste_messzeit,
                        EXCLUDED.spaeteste_messzeit, EXCLUDED.erste_eingangszeit,
                        EXCLUDED.letzte_eingangszeit, EXCLUDED.ereignis_id,
                        EXCLUDED.version_bezug)
                """)) {
            setzeUuid(ps, 1, tenantId);
            setzeUuid(ps, 2, entityId);
            ps.setString(3, messkanal);
            ps.setTimestamp(4, Timestamp.from(beginn));
            setzeUuid(ps, 5, n.siteId());
            ps.setString(6, GRUND);
            ps.setTimestamp(7, Timestamp.from(frist));
            ps.setInt(8, n.anzahl());
            ps.setTimestamp(9, Timestamp.from(n.fruehesteMesszeit()));
            ps.setTimestamp(10, Timestamp.from(n.spaetesteMesszeit()));
            ps.setTimestamp(11, Timestamp.from(n.ersteEingangszeit()));
            ps.setTimestamp(12, Timestamp.from(n.letzteEingangszeit()));
            setzeUuid(ps, 13, ereignisId);
            setzeUuid(ps, 14, tenantId);
            setzeUuid(ps, 15, entityId);
            ps.setString(16, messkanal);
            ps.setTimestamp(17, Timestamp.from(beginn));
            ps.executeUpdate();
        }
    }

    /** {@code min(uuid)} gibt es in Postgres nicht — gezählt wird über den Text. */
    private static UUID uuid(String s) {
        return s == null ? null : UUID.fromString(s);
    }

    /**
     * Eine UUID mit Typangabe setzen. Ohne sie könnte der Treiber ein {@code null} nicht
     * einordnen ("could not determine data type of parameter") — und {@code site_id} und
     * {@code box} sind ausdrücklich leer, wenn die Nachzügler nicht alle dieselbe nennen.
     */
    private static void setzeUuid(PreparedStatement ps, int stelle, UUID wert) throws SQLException {
        if (wert == null) {
            ps.setNull(stelle, Types.OTHER);
        } else {
            ps.setObject(stelle, wert, Types.OTHER);
        }
    }

    /** Die Zeitform des Vertrags: ISO-8601 UTC auf die SEKUNDE, ohne Bruchteil. */
    private static String uhr(Instant t) {
        return t.truncatedTo(ChronoUnit.SECONDS).toString();
    }
}
