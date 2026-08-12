package com.voltpilot.api.templates;

import com.voltpilot.api.web.dto.AdminComponentTemplateDto;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

/**
 * Der SCHREIB- und Betriebs-Zugang zum globalen Vorlagen-Register
 * (Einheitsmodell Stufe 6).
 *
 * <p><b>⚠ Ausschliesslich an der BYPASSRLS-Rolle {@code voltpilot_admin}.</b>
 * {@code V20260815000000} nimmt der App-Rolle INSERT/UPDATE/DELETE auf dieser
 * globalen Tabelle ausdrücklich WEG ({@code REVOKE}), und
 * {@code ComponentTemplateApiTest.theAppRoleMayReadTemplatesButNeverWriteThem}
 * nagelt das fest - dieselbe Disziplin wie {@code /admin/fleet}. Wer hier den
 * {@code @Primary}-Datenpfad nähme, bekäme „permission denied" und wäre
 * versucht, ein GRANT nachzuschieben; genau das wäre die offene Tür.
 *
 * <p>Getrennt von {@link ComponentTemplateRepository}, weil die beiden
 * verschiedene Fragen beantworten: dort „welche Vorlage kann ich gerade
 * wählen" (neueste Fassung je Schlüssel, nur öffentliche Herkunftsarten),
 * hier „welche Fassungen gibt es, wer hat sie eingetragen, wird eine benutzt".
 */
@Repository
public class ComponentTemplateAdminRepository {

    private static final String COLUMNS =
            "template_ref, kind, version, brand, brand_label, model, model_label, family, "
                    + "family_label, communication, communication_label, transport_schema, "
                    + "channels, writes, rated_kw, control_tier, certification_status, "
                    + "certified_at, certification_note, note, created_at, created_by, "
                    + "updated_at, withdrawn_at, withdrawn_by";

    private final JdbcTemplate jdbc;

    public ComponentTemplateAdminRepository(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /**
     * ALLE Fassungen ALLER Herkunftsarten - der Betreiber sieht die Historie,
     * nicht nur die Auswahl. Sortiert wie der Assistent gruppiert (Marke,
     * Modell), innerhalb eines Schlüssels neueste Fassung zuerst.
     */
    public List<AdminComponentTemplateDto> findAll() {
        return jdbc.query("SELECT " + COLUMNS + " FROM component_template "
                + "ORDER BY brand, model, template_ref, version DESC",
                ComponentTemplateAdminRepository::map);
    }

    /** Eine bestimmte Fassung, egal ob zurückgezogen. */
    public Optional<AdminComponentTemplateDto> find(String templateRef, int version) {
        return jdbc.query("SELECT " + COLUMNS + " FROM component_template "
                        + "WHERE template_ref = ? AND version = ?",
                ComponentTemplateAdminRepository::map, templateRef, version).stream().findFirst();
    }

    /** Die höchste Fassung eines Schlüssels, {@code 0} wenn es ihn nicht gibt. */
    public int maxVersion(String templateRef) {
        Integer v = jdbc.queryForObject(
                "SELECT coalesce(max(version), 0) FROM component_template WHERE template_ref = ?",
                Integer.class, templateRef);
        return v == null ? 0 : v;
    }

    /** Die Herkunft eines Schlüssels ({@code builtin}/{@code certified}), sofern bekannt. */
    public Optional<String> kindOf(String templateRef) {
        return jdbc.queryForList(
                        "SELECT DISTINCT kind FROM component_template WHERE template_ref = ?",
                        String.class, templateRef)
                .stream().findFirst();
    }

    /**
     * Wie viele Komponenten der GANZEN Flotte auf einer Vorlage stehen, je
     * Schlüssel gezählt.
     *
     * <p>Der Betreiber muss das VOR einer Rücknahme sehen: sie bricht zwar
     * nichts (der Schnappschuss an der Komponente bleibt gültig), aber sie
     * ändert, was ab jetzt gewählt werden kann - und die Zahl ist der
     * Unterschied zwischen „niemand nutzt sie" und „sie läuft auf 40 Anlagen".
     * Cross-tenant, deshalb hier an der BYPASSRLS-Rolle.
     */
    public Map<String, Integer> usageByRef() {
        Map<String, Integer> out = new HashMap<>();
        each(rs -> out.put(rs.getString("template_ref"), rs.getInt("n")),
                "SELECT template_ref, count(*) AS n FROM measurement_point "
                        + "WHERE template_ref IS NOT NULL GROUP BY template_ref");
        return out;
    }

    /** Legt eine Fassung an. Der Schlüssel ist abgeleitet, die Fassung vorgegeben. */
    public void insert(String templateRef, int version, ComponentTemplateDefinition.Input in,
            ComponentTemplateDefinition.Result def, Instant certifiedAt, String actor) {
        jdbc.update("INSERT INTO component_template ("
                        + "kind, template_ref, version, brand, brand_label, model, model_label, "
                        + "family, family_label, communication, communication_label, "
                        + "transport_schema, channels, writes, rated_kw, control_tier, "
                        + "certification_status, certified_at, certification_note, note, "
                        + "created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, "
                        + "?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?)",
                ComponentTemplateDefinition.KIND_ADMIN, templateRef, version,
                trim(in.brand()), trim(in.brandLabel()), trim(in.model()), trim(in.modelLabel()),
                blankToNull(in.family()), blankToNull(in.familyLabel()),
                trim(in.communication()), blankToNull(in.communicationLabel()),
                def.transportSchemaJson(), def.channelsJson(), def.writesJson(),
                in.ratedKw(), in.controlTier() == null ? 0 : in.controlTier(),
                trim(in.certificationStatus()),
                certifiedAt == null ? null : java.sql.Timestamp.from(certifiedAt),
                blankToNull(in.certificationNote()), blankToNull(in.note()), actor);
    }

    /**
     * Zieht eine Fassung zurück bzw. gibt sie wieder frei.
     *
     * <p>Beides oder keines: Zeitpunkt und Urheber wandern zusammen (die
     * CHECK-Bedingung der Migration erzwingt es zusätzlich in der DB).
     *
     * @return wie viele Zeilen sich dadurch geändert haben ({@code 0} = die
     *     Fassung stand schon so)
     */
    public int setWithdrawn(String templateRef, int version, Instant at, String by) {
        return jdbc.update("UPDATE component_template SET withdrawn_at = ?, withdrawn_by = ?, "
                        + "updated_at = now() WHERE template_ref = ? AND version = ? "
                        + "AND withdrawn_at IS DISTINCT FROM ?",
                at == null ? null : java.sql.Timestamp.from(at), by, templateRef, version,
                at == null ? null : java.sql.Timestamp.from(at));
    }

    /**
     * {@code jdbc.query(sql, handler)} mit umgedrehten Argumenten - der Lambda
     * zuerst, damit der Compiler ihn eindeutig als {@link RowCallbackHandler}
     * liest. Ohne diese Naht ist {@code query(String, <lambda>)} mehrdeutig
     * (ein {@code ResultSetExtractor} passt formal genauso).
     */
    private void each(RowCallbackHandler handler, String sql) {
        jdbc.query(sql, handler);
    }

    private static String trim(String s) {
        return s == null ? null : s.trim();
    }

    private static String blankToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static AdminComponentTemplateDto map(ResultSet rs, int row) throws SQLException {
        // getBigDecimal liefert für SQL NULL bereits null - kein wasNull() nötig,
        // und die Reihenfolge der Spalten-Zugriffe bleibt damit unerheblich.
        BigDecimal rated = rs.getBigDecimal("rated_kw");
        return new AdminComponentTemplateDto(
                rs.getString("template_ref"), rs.getString("kind"), rs.getInt("version"),
                rs.getString("brand"), rs.getString("brand_label"),
                rs.getString("model"), rs.getString("model_label"),
                rs.getString("family"), rs.getString("family_label"),
                rs.getString("communication"), rs.getString("communication_label"),
                rs.getString("transport_schema"), rs.getString("channels"), rs.getString("writes"),
                rated, rs.getInt("control_tier"),
                rs.getString("certification_status"), instant(rs, "certified_at"),
                rs.getString("certification_note"), rs.getString("note"),
                instant(rs, "created_at"), rs.getString("created_by"), instant(rs, "updated_at"),
                instant(rs, "withdrawn_at"), rs.getString("withdrawn_by"), 0);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        java.sql.Timestamp ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }
}
