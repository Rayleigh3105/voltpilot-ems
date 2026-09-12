package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.Nebengroesse;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.OrtZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Bestand des Messstellen-Registers (UEMS AP-04 IP-4) in EINER Abfrage: je Messstelle des
 * Kundenbereichs ihre Zeile samt ALLER Nebengrößen, Ort- und Stellungs-Intervalle und
 * Quellenbindungen — diese als JSON-Felder derselben Zeile. Die Zahl der Abfragen wächst nie mit
 * der Zahl der Messstellen (keine N+1); vorher las die Liste in fünf Zügen.
 *
 * <p><b>Dieselben Records wie die Einzel-Routen.</b> Die JSON-Schlüssel sind die Komponenten von
 * {@link OrtZeile}, {@link StellungZeile}, {@link Nebengroesse} und {@link Quelle} (mit denselben
 * Verknüpfungen wie deren Repositories); Jackson baut sie über den kanonischen Konstruktor und
 * lehnt jeden unbekannten Schlüssel ab. Welches Intervall an einem Tag gilt und welche Bindung zu
 * einem Zeitpunkt, urteilt der Dienst in Java ({@link MessstelleRegisterService}) — mit denselben
 * Regeln wie {@code …/standort?am=} und {@code …/quellen?stichtag=}, nie in einer zweiten SQL-Fassung.
 *
 * <p>Der Mandant ist die RLS: keine Abfrage trägt ein {@code tenant_id}-Prädikat.
 */
@Repository
public class MessstelleRegisterRepository {

    /**
     * Eine Quellenbindung mit dem, was nur das Register von ihr nennt: die Bezeichnung des Geräts
     * und die eigene Definition des Kanals (Selbstbau; {@code null} = Katalog-Kanal) — für den
     * Anzeigenamen nach derselben Regel wie das Messkanal-Read-Model.
     */
    public record QuelleZeile(Quelle quelle, String geraetBezeichnung, JsonNode kanalDefinition) {}

    /** Eine Messstelle mit allem, woraus ihre Register-Zeile und ihre Vertrags-Form entstehen. */
    public record Bestand(Messstelle messstelle, List<Nebengroesse> nebengroessen, List<OrtZeile> orte,
            List<StellungZeile> stellungen, List<QuelleZeile> quellen) {}

    /**
     * Der Messwert EINER führenden Bindung: Komponente + Kanal (unter diesem Paar kommen die Werte
     * an — {@code device_measurement_selection} sagt, welche Box ihn liest) und {@code ab}, der
     * Beginn der Bindung.
     *
     * <p><b>{@code ab} gehört zum Schlüssel, nicht zur Verzierung.</b> Ein Zählerwechsel tauscht
     * das Gerät, aber weder Komponente noch Kanal: die Werte von Z-5a und Z-5b liegen unter
     * derselben (Box, Kanal). Nur der Beginn der Bindung trennt sie — ohne ihn hielte der alte
     * Zähler die neue Bindung am Leben, statt „wartet auf erste Daten von Z-5b“ zu sagen
     * (AP-04 §5.13, Regel 4: ein Wert bleibt bei dem Gerät, unter dem er erfasst wurde).
     */
    public record Messwert(UUID komponente, String kanal, Instant ab) {}

    /**
     * Was über die Werte EINES Messwerts bis zu einem Zeitpunkt bekannt ist — die Eingänge von
     * {@link ZustandAbleitung#liefertDaten}, mehr nicht.
     *
     * @param kadenzS die Kadenz der Mess-Selektion; {@code null} = keine eigene (dann entscheidet
     *     der Katalog, dieselbe Regel wie im Messkanal-Read-Model)
     * @param letzterGuterWert Zeit des letzten Wertes mit Qualität „gut“; {@code null} = nie einer
     * @param zahl sein Zahlenwert (dekodiert, sonst roh); {@code null} bei einem Text-Kanal
     * @param text sein Textwert; {@code null} bei einem Zahlen-Kanal
     * @param jeEinWert ob überhaupt je ein Wert ankam — auch ein schlechter (ändert den Zustand
     *     NICHT, gezählt werden nur gute; der Vertrag will den Eingang trotzdem ehrlich)
     */
    public record Werte(Integer kadenzS, Instant letzterGuterWert, Double zahl, String text,
            boolean jeEinWert) {}

    /**
     * Die Abfrage. Je Tabelle EIN Durchgang, gruppiert je Messstelle (Hash-Verbund statt einer
     * Unterabfrage je Zeile); die Reihenfolgen innerhalb der Gruppen sind die der Repositories.
     */
    static final String ABFRAGE = """
            WITH neben AS (
                SELECT g.messstelle_id, json_agg(json_build_object(
                           'id', g.id, 'messstelleId', g.messstelle_id,
                           'groesse', json_build_object('groesse', g.groesse, 'richtung', g.richtung,
                                                        'einheit', g.einheit, 'wertart', g.wertart),
                           'archiviertAm', g.archiviert_am) ORDER BY g.created_at, g.id) AS j
                  FROM messstelle_groesse g
                 GROUP BY g.messstelle_id),
            orte AS (
                SELECT mo.messstelle_id, json_agg(json_build_object(
                           'id', mo.id, 'messstelleId', mo.messstelle_id,
                           'zielArt', CASE WHEN mo.unternehmen_id IS NOT NULL THEN 'unternehmen'
                                           WHEN mo.standort_id IS NOT NULL THEN 'standort' ELSE o.art END,
                           'zielId', coalesce(mo.unternehmen_id, mo.standort_id, mo.ort_id),
                           'kennzeichen', CASE WHEN mo.unternehmen_id IS NOT NULL THEN 'U'
                                               ELSE coalesce(s.kurzzeichen, o.kurzzeichen) END,
                           'gueltigAb', mo.gueltig_ab, 'gueltigBis', mo.gueltig_bis,
                           'aufgehobenAm', mo.aufgehoben_am, 'createdAt', mo.created_at)
                           ORDER BY mo.gueltig_ab, mo.created_at, mo.id) AS j
                  FROM messstelle_ort mo
                  LEFT JOIN standort s ON s.id = mo.standort_id
                  LEFT JOIN ort o ON o.id = mo.ort_id
                 GROUP BY mo.messstelle_id),
            stellungen AS (
                SELECT ms.messstelle_id, json_agg(json_build_object(
                           'id', ms.id, 'messstelleId', ms.messstelle_id, 'siteId', ms.site_id,
                           'stellung', ms.stellung, 'unterzaehlerVon', ms.unterzaehler_von,
                           'unterzaehlerVonKennzeichen', b.kennzeichen,
                           'gueltigAb', ms.gueltig_ab, 'gueltigBis', ms.gueltig_bis,
                           'aufgehobenAm', ms.aufgehoben_am, 'createdAt', ms.created_at)
                           ORDER BY ms.gueltig_ab, ms.created_at, ms.id) AS j
                  FROM messstelle_stellung ms
                  LEFT JOIN messstelle b ON b.id = ms.unterzaehler_von
                 GROUP BY ms.messstelle_id),
            quellen AS (
                SELECT q.messstelle_id, json_agg(json_build_object(
                           'quelle', json_build_object(
                               'id', q.id, 'messstelleId', q.messstelle_id, 'messstelle', m.kennzeichen,
                               'groesse', q.groesse, 'richtung', q.richtung, 'entityId', q.entity_id,
                               'siteId', p.site_id, 'komponenteName', p.label, 'geraetId', q.geraet_id,
                               'geraet', g.kennzeichen, 'einbau', g.einbau_kennzeichen, 'kanal', q.kanal,
                               'kanalWertart', q.kanal_wertart, 'herleitung', q.herleitung, 'rolle', q.rolle,
                               'zweck', q.zweck, 'gueltigAb', q.gueltig_ab, 'gueltigBis', q.gueltig_bis,
                               'anfangsstand', CASE WHEN q.anfangsstand IS NOT NULL THEN json_build_object(
                                   'wert', q.anfangsstand, 'einheit', q.anfangsstand_einheit) END,
                               'endstand', CASE WHEN q.endstand IS NOT NULL THEN json_build_object(
                                   'wert', q.endstand, 'einheit', q.endstand_einheit) END,
                               'rueckwirkend', q.rueckwirkend, 'eingetragenAm', q.eingetragen_am,
                               'eingetragenVon', q.actor_name),
                           'geraetBezeichnung', g.bezeichnung,
                           'kanalDefinition', (SELECT d.custom_definition FROM device_measurement_selection d
                                                WHERE d.entity_id = q.entity_id AND d.point_key = q.kanal
                                                ORDER BY d.device_id LIMIT 1))
                           ORDER BY q.groesse, q.richtung, q.rolle, q.gueltig_ab, q.id) AS j
                  FROM messstelle_quelle q
                  JOIN messstelle m ON m.id = q.messstelle_id
                  JOIN geraet g ON g.id = q.geraet_id
                  JOIN measurement_point p ON p.id = q.entity_id
                 GROUP BY q.messstelle_id)
            SELECT m.id, m.kennzeichen, m.name, m.art, m.medium, m.groesse, m.richtung, m.einheit,
                   m.wertart, m.notiz, m.angehalten_ab, m.archiviert_am,
                   coalesce(n.j, '[]') AS neben, coalesce(o.j, '[]') AS orte,
                   coalesce(s.j, '[]') AS stellungen, coalesce(q.j, '[]') AS quellen
              FROM messstelle m
              LEFT JOIN neben n ON n.messstelle_id = m.id
              LEFT JOIN orte o ON o.messstelle_id = m.id
              LEFT JOIN stellungen s ON s.messstelle_id = m.id
              LEFT JOIN quellen q ON q.messstelle_id = m.id
             ORDER BY m.kennzeichen
            """;

    private static final TypeReference<List<Nebengroesse>> NEBEN = new TypeReference<>() {};
    private static final TypeReference<List<OrtZeile>> ORTE = new TypeReference<>() {};
    private static final TypeReference<List<StellungZeile>> STELLUNGEN = new TypeReference<>() {};
    private static final TypeReference<List<QuelleZeile>> QUELLEN = new TypeReference<>() {};

    private final JdbcTemplate jdbc;
    private final ObjectMapper streng;

    public MessstelleRegisterRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Alle Messstellen des Kundenbereichs, archivierte eingeschlossen, nach Kennzeichen — in EINER Abfrage. */
    public List<Bestand> alle() {
        return List.copyOf(jdbc.query(ABFRAGE, this::bestand));
    }

    /**
     * Der EINE zusätzliche Lesezug der Beobachtung (IP-15): je Messwert (Komponente + Kanal +
     * Beginn der Bindung) die Kadenz seiner Mess-Selektion, sein letzter GUTER Wert SEIT dem
     * Beginn und bis {@code bis} und ob überhaupt je einer ankam. Die drei Felder kommen als
     * Felder herein ({@code unnest}) — die Abfrage rührt deshalb KEINE
     * Messstellen-Tabelle an, und ihre Zahl wächst nicht mit der Zahl der Messstellen (die
     * Eine-Abfrage-Zusage von IP-4 bleibt: 1 Abfrage auf den Messstellen-Tabellen, 1 hier).
     *
     * <p>Liest mehr als eine Box denselben Messwert, gilt der JÜNGSTE gute Wert (und die Kadenz
     * seiner Zeile) — nie eine Summe, nie ein Mittel. Ohne Zeile der Mess-Selektion fehlt der
     * Messwert in der Antwort: dann gibt es weder Kadenz noch Wert, und die Ableitung sagt
     * „wartet auf erste Daten“ statt eine 0 zu raten.
     */
    static final String WERTE = """
            WITH paare AS (
                SELECT DISTINCT komponente, kanal, ab
                  FROM unnest(?::uuid[], ?::text[], ?::timestamptz[]) AS p(komponente, kanal, ab)),
            lesend AS (
                SELECT p.komponente, p.kanal, p.ab, d.device_id, d.cadence_s
                  FROM paare p
                  JOIN device_measurement_selection d
                    ON d.entity_id = p.komponente AND d.point_key = p.kanal),
            gemessen AS (
                SELECT l.komponente, l.kanal, l.ab, l.device_id, l.cadence_s,
                       g.zeit, g.zahl, g.text, j.gab_es
                  FROM lesend l
                  LEFT JOIN LATERAL (
                      SELECT s.time AS zeit,
                             coalesce(s.decoded_numeric, s.raw_numeric) AS zahl,
                             coalesce(s.decoded_text, s.raw_text) AS text
                        FROM device_measurement_sample s
                       WHERE s.device_id = l.device_id AND s.point_key = l.kanal
                         AND s.quality = 'good' AND s.time >= l.ab AND s.time <= ?
                       ORDER BY s.time DESC
                       LIMIT 1) g ON TRUE
                  LEFT JOIN LATERAL (
                      SELECT true AS gab_es
                        FROM device_measurement_sample s
                       WHERE s.device_id = l.device_id AND s.point_key = l.kanal
                         AND s.time >= l.ab AND s.time <= ?
                       LIMIT 1) j ON TRUE),
            je_bindung AS (
                SELECT komponente, kanal, ab, bool_or(gab_es IS NOT NULL) AS je_ein_wert
                  FROM gemessen GROUP BY komponente, kanal, ab),
            juengste AS (
                SELECT DISTINCT ON (komponente, kanal, ab)
                       komponente, kanal, ab, cadence_s, zeit, zahl, text
                  FROM gemessen
                 ORDER BY komponente, kanal, ab, zeit DESC NULLS LAST, device_id)
            SELECT j.komponente, j.kanal, j.ab, j.cadence_s, j.zeit, j.zahl, j.text, k.je_ein_wert
              FROM juengste j
              JOIN je_bindung k
                ON k.komponente = j.komponente AND k.kanal = j.kanal AND k.ab = j.ab
            """;

    /**
     * Die Werte-Fakten zu genau diesen Messwerten, bis zum Zeitpunkt {@code bis} — in EINER
     * Abfrage. Ein Messwert ohne Mess-Selektion (und ein leeres Feld) fehlt in der Karte; der
     * Aufrufer liest das als „nichts bekannt“, nie als 0.
     */
    public Map<Messwert, Werte> werte(Collection<Messwert> messwerte, Instant bis) {
        if (messwerte.isEmpty()) {
            return Map.of();
        }
        List<Messwert> paare = List.copyOf(new LinkedHashSet<>(messwerte));
        UUID[] komponenten = paare.stream().map(Messwert::komponente).toArray(UUID[]::new);
        String[] kanaele = paare.stream().map(Messwert::kanal).toArray(String[]::new);
        Timestamp[] ab = paare.stream().map(m -> Timestamp.from(m.ab())).toArray(Timestamp[]::new);
        Map<Messwert, Werte> out = new HashMap<>();
        jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement(WERTE);
            ps.setArray(1, con.createArrayOf("uuid", komponenten));
            ps.setArray(2, con.createArrayOf("text", kanaele));
            ps.setArray(3, con.createArrayOf("timestamptz", ab));
            ps.setTimestamp(4, Timestamp.from(bis));
            ps.setTimestamp(5, Timestamp.from(bis));
            return ps;
        }, (ResultSet rs) -> {
            Timestamp zeit = rs.getTimestamp("zeit");
            double zahl = rs.getDouble("zahl");
            boolean textwert = rs.wasNull();
            out.put(new Messwert(rs.getObject("komponente", UUID.class), rs.getString("kanal"),
                            rs.getTimestamp("ab").toInstant()),
                    new Werte((Integer) rs.getObject("cadence_s"),
                            zeit == null ? null : zeit.toInstant(),
                            textwert ? null : zahl, rs.getString("text"),
                            rs.getBoolean("je_ein_wert")));
        });
        return Map.copyOf(out);
    }

    private Bestand bestand(ResultSet rs, int n) throws SQLException {
        return new Bestand(MessstelleRepository.map(rs, n), lesen(rs, "neben", NEBEN), lesen(rs, "orte", ORTE),
                lesen(rs, "stellungen", STELLUNGEN), lesen(rs, "quellen", QUELLEN));
    }

    private <T> List<T> lesen(ResultSet rs, String spalte, TypeReference<List<T>> typ) throws SQLException {
        try {
            return List.copyOf(streng.readValue(rs.getString(spalte), typ));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Register-Spalte " + spalte + " passt nicht zu ihrem Record", e);
        }
    }
}
