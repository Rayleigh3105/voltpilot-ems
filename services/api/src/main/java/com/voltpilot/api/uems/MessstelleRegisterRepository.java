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
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
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
