package com.voltpilot.api.templates;

import com.voltpilot.api.templates.BuiltinComponentTemplates.BuiltinTemplate;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Vorlagen-Register (Tabelle {@code component_template}, Migration
 * V20260815000000): welche Komponenten-Vorlagen es GIBT.
 *
 * <p><b>Zwei Verbindungen, mit Absicht.</b> Die Tabelle ist GLOBAL und trägt
 * keine RLS (Plattform-Betriebsdaten wie {@code edge_release} /
 * {@code provisioned_device}), deshalb:
 * <ul>
 *   <li><b>Lesen</b> läuft über die normale, mandantengebundene App-Rolle. Die
 *       Kunden-Route braucht dafür KEIN BYPASSRLS - die Migration gibt der
 *       App-Rolle genau ein {@code SELECT}. Der Zaun der Route ist die
 *       Authentifizierung plus die Filterung auf die öffentlichen
 *       Herkunftsarten, nicht die Datenbankrolle.</li>
 *   <li><b>Schreiben</b> läuft ausschließlich über die dedizierte
 *       BYPASSRLS-Rolle {@code voltpilot_admin} - die App-Rolle hat gar kein
 *       {@code INSERT} (die Migration nimmt es ihr ausdrücklich weg). Einziger
 *       Schreiber in dieser Stufe ist der {@link ComponentTemplateSeeder}.</li>
 * </ul>
 * Die beiden Wege in EINER Klasse zu halten ist bewusst: so liegt das ganze SQL
 * dieser Tabelle an einem Ort, und der Unterschied ist am Feldnamen ablesbar.
 */
@Repository
public class ComponentTemplateRepository {

    /**
     * Die INHALTS-Spalten einer Vorlage in fester Reihenfolge: der Upsert baut
     * daraus die Wertliste, die {@code SET}-Klausel UND den Änderungsvergleich.
     * Ein neues Feld hier einzutragen zieht alle drei automatisch mit - genau
     * das verhindert die Drift, an der ein handgepflegter Vergleich stirbt
     * (ein vergessenes Feld würde sonst nie aufgefrischt).
     */
    private static final List<String> CONTENT_COLUMNS = List.of(
            "brand", "brand_label", "model", "model_label", "family", "family_label",
            "communication", "communication_label", "transport_schema", "channels", "writes",
            "rated_kw", "control_tier", "certification_status", "note");

    /** Spalten, die als JSONB geschrieben werden (die Bindung braucht den Cast). */
    private static final List<String> JSON_COLUMNS =
            List.of("transport_schema", "channels", "writes");

    private static final String READ_COLUMNS =
            "template_ref, kind, version, brand, brand_label, model, model_label, family, "
                    + "family_label, communication, communication_label, transport_schema, "
                    + "channels, writes, rated_kw, control_tier, certification_status, "
                    + "certified_at, certification_note, note, updated_at";

    /**
     * Je Schlüssel die HÖCHSTE Fassung - die Frage der Oberfläche lautet „welche
     * Vorlagen kann ich gerade wählen", nicht „welche Fassungen gab es je".
     * {@code DISTINCT ON} ist dafür das Haus-Idiom (die Splice-Abfragen der
     * Historie/Erlöse nutzen es genauso).
     */
    private static final String SELECT_NEWEST =
            "SELECT " + READ_COLUMNS + " FROM ("
                    + "  SELECT DISTINCT ON (template_ref) " + READ_COLUMNS
                    + "  FROM component_template WHERE kind = ANY (?) "
                    + "  ORDER BY template_ref, version DESC"
                    + ") t ";

    private static final String UPSERT_BUILTIN = buildUpsert();

    private final JdbcTemplate read;
    private final JdbcTemplate write;

    public ComponentTemplateRepository(JdbcTemplate jdbcTemplate,
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.read = jdbcTemplate;
        this.write = adminJdbcTemplate;
    }

    /**
     * Alle Vorlagen der übergebenen Herkunftsarten, neueste Fassung je
     * Schlüssel, sortiert wie der Assistent sie gruppiert (Marke, dann Modell).
     */
    public List<ComponentTemplateDto> findNewest(Collection<String> kinds) {
        return read.query(SELECT_NEWEST + "ORDER BY brand, model",
                ps -> ps.setArray(1, ps.getConnection()
                        .createArrayOf("text", kinds.toArray(String[]::new))),
                ComponentTemplateRepository::map);
    }

    /** Die neueste Fassung EINER Vorlage, sofern ihre Herkunft ausgeliefert wird. */
    public Optional<ComponentTemplateDto> findNewestByRef(Collection<String> kinds, String ref) {
        return read.query(SELECT_NEWEST + "WHERE template_ref = ?",
                ps -> {
                    ps.setArray(1, ps.getConnection()
                            .createArrayOf("text", kinds.toArray(String[]::new)));
                    ps.setString(2, ref);
                },
                ComponentTemplateRepository::map).stream().findFirst();
    }

    /**
     * Spiegelt eine eingebaute Vorlage in die Tabelle: anlegen oder AN ORT UND
     * STELLE auffrischen.
     *
     * <p>Bewusst kein neuer {@code version}-Eintrag bei einer Änderung: die
     * Fassung einer eingebauten Vorlage IST der Edge-Softwarestand (das
     * Release-Register), nicht eine eigene Zählung - ein Tippfehler im Katalog
     * würde sonst eine Versionshistorie erzeugen. Geprüfte/selbst gebaute
     * Vorlagen versionieren ausdrücklich (Stufe 6/3).
     *
     * <p>Ein UNVERÄNDERTER Katalog schreibt nichts (der Inhaltsvergleich in der
     * {@code WHERE}-Klausel des {@code DO UPDATE}) - sonst hätte jeder Neustart
     * alle Zeilen „geändert" und {@code updated_at} wäre wertlos.
     *
     * @return {@code true}, wenn die Zeile dadurch entstand oder sich änderte
     */
    public boolean upsertBuiltin(BuiltinTemplate t, String actor) {
        Object[] content = {
            t.brand(), t.brandLabel(), t.model(), t.modelLabel(), t.family(), t.familyLabel(),
            t.communication(), t.communicationLabel(), t.transportSchemaJson(), t.channelsJson(),
            t.writesJson(), t.ratedKw(), t.controlTier(), t.certificationStatus(), t.note()
        };
        Object[] args = Stream.concat(
                        Stream.of(t.templateRef(), (Object) t.version()),
                        Stream.concat(Stream.of(content), Stream.of((Object) actor)))
                .toArray();
        return write.update(UPSERT_BUILTIN, args) > 0;
    }

    /** Wie viele eingebaute Vorlagen aktuell im Register stehen. */
    public int countBuiltin() {
        Integer n = write.queryForObject(
                "SELECT count(*) FROM component_template WHERE kind = 'builtin'", Integer.class);
        return n == null ? 0 : n;
    }

    private static String buildUpsert() {
        String cols = String.join(", ", CONTENT_COLUMNS);
        String placeholders = CONTENT_COLUMNS.stream()
                .map(c -> JSON_COLUMNS.contains(c) ? "?::jsonb" : "?")
                .collect(Collectors.joining(", "));
        String setClause = CONTENT_COLUMNS.stream()
                .map(c -> c + " = EXCLUDED." + c)
                .collect(Collectors.joining(", "));
        String have = CONTENT_COLUMNS.stream()
                .map(c -> "component_template." + c)
                .collect(Collectors.joining(", "));
        String want = CONTENT_COLUMNS.stream()
                .map(c -> "EXCLUDED." + c)
                .collect(Collectors.joining(", "));
        return "INSERT INTO component_template (kind, template_ref, version, " + cols
                + ", created_by) VALUES ('builtin', ?, ?, " + placeholders + ", ?) "
                + "ON CONFLICT (template_ref, version) DO UPDATE SET " + setClause
                + ", updated_at = now() "
                + "WHERE (" + have + ") IS DISTINCT FROM (" + want + ")";
    }

    private static ComponentTemplateDto map(ResultSet rs, int rowNum) throws SQLException {
        return new ComponentTemplateDto(
                rs.getString("template_ref"),
                rs.getString("kind"),
                rs.getInt("version"),
                rs.getString("brand"),
                rs.getString("brand_label"),
                rs.getString("model"),
                rs.getString("model_label"),
                rs.getString("family"),
                rs.getString("family_label"),
                rs.getString("communication"),
                rs.getString("communication_label"),
                rs.getString("transport_schema"),
                rs.getString("channels"),
                rs.getString("writes"),
                rs.getBigDecimal("rated_kw"),
                rs.getInt("control_tier"),
                rs.getString("certification_status"),
                instant(rs, "certified_at"),
                rs.getString("certification_note"),
                rs.getString("note"),
                instant(rs, "updated_at"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime v = rs.getObject(column, OffsetDateTime.class);
        return v == null ? null : v.toInstant();
    }
}
