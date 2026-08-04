package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.EdgeTrustSetDto;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das AKTUELLE root-signierte Trust-Set (Tabelle {@code edge_trust_set},
 * Migration V20260806010000) - die eine Autorität, aus der eine NEUE Box beim
 * Einrichten ihren Vertrauens-Anker bekommt.
 *
 * <p><b>Zwei Verbindungen, mit Absicht</b> (die einzige Stelle im Repo, an der
 * ein Repository beide hält - deshalb hier begründet):
 *
 * <ul>
 *   <li><b>Gelesen</b> wird über die {@code @Primary} App-Rolle
 *       ({@code voltpilot_app}). Der Ausliefer-Endpunkt ist
 *       UNAUTHENTIFIZIERT (eine Box hat beim Einrichten kein Token - dieselbe
 *       Lage wie beim Enrollment, das aus demselben Grund über dieselbe Rolle
 *       liest). Eine BYPASSRLS-Verbindung aus einem anonymen Aufruf heraus
 *       wäre auch dann die falsche Gewohnheit, wenn diese Tabelle - wie
 *       {@code edge_release} - gar keine RLS trägt.</li>
 *   <li><b>Geschrieben</b> wird ausschließlich über die dedizierte
 *       BYPASSRLS-Rolle {@code voltpilot_admin} ({@code adminJdbcTemplate}) -
 *       exakt das Muster von {@link EdgeReleaseRepository}. Die App-Rolle hat
 *       auf dieser Tabelle KEIN Schreibrecht (die Migration entzieht es), der
 *       öffentliche Lesepfad kann also nicht einmal versehentlich schreiben.</li>
 * </ul>
 *
 * <p>Die Tabelle ist ein SINGLETON: {@link #replace} ersetzt die eine Zeile.
 * Der Verlauf liegt im Git ({@code edge-app/ota/}), nicht hier - Begründung in
 * der Migration.
 */
@Repository
public class EdgeTrustSetRepository {

    private static final String COLUMNS =
            "trust_set, signature, key_ids, signing_key_id, generated_at, uploaded_at, uploaded_by";

    private final JdbcTemplate readJdbc;
    private final JdbcTemplate writeJdbc;

    public EdgeTrustSetRepository(JdbcTemplate jdbcTemplate,
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.readJdbc = jdbcTemplate;
        this.writeJdbc = adminJdbcTemplate;
    }

    /** Das aktuell gültige Set, oder leer solange keines hochgeladen wurde. */
    public Optional<EdgeTrustSetDto> current() {
        return readJdbc.query("SELECT " + COLUMNS + " FROM edge_trust_set WHERE id",
                EdgeTrustSetRepository::map).stream().findFirst();
    }

    /**
     * Das aktuelle Set ERSETZEN. Die Bytes werden BYTEGENAU abgelegt
     * ({@code text}-Spalten, nie {@code jsonb}): die Wurzel-Signatur geht über
     * genau diese Bytes, und das Gerät prüft sie selbst.
     */
    public EdgeTrustSetDto replace(String trustSet, String signature, String keyIds,
            String signingKeyId, String generatedAt, String uploadedBy) {
        return writeJdbc.queryForObject(
                "INSERT INTO edge_trust_set (id, trust_set, signature, key_ids, signing_key_id, "
                        + "generated_at, uploaded_at, uploaded_by) "
                        + "VALUES (TRUE, ?, ?, ?, ?, ?, now(), ?) "
                        + "ON CONFLICT (id) DO UPDATE SET trust_set = EXCLUDED.trust_set, "
                        + "signature = EXCLUDED.signature, key_ids = EXCLUDED.key_ids, "
                        + "signing_key_id = EXCLUDED.signing_key_id, "
                        + "generated_at = EXCLUDED.generated_at, uploaded_at = now(), "
                        + "uploaded_by = EXCLUDED.uploaded_by "
                        + "RETURNING " + COLUMNS,
                EdgeTrustSetRepository::map,
                trustSet, signature, keyIds, signingKeyId, generatedAt, uploadedBy);
    }

    private static EdgeTrustSetDto map(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        return new EdgeTrustSetDto(
                rs.getString("trust_set"),
                rs.getString("signature"),
                rs.getString("key_ids"),
                rs.getString("signing_key_id"),
                rs.getString("generated_at"),
                rs.getTimestamp("uploaded_at").toInstant(),
                rs.getString("uploaded_by"));
    }
}
