package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Der Wächter über die site-Join-Disziplin der {@code forecast}-Tabelle
 * (Skalierungs-Gutachten vp-scale-readiness-p4 §4.2, Captain-Freigabe
 * 31.08.2026).
 *
 * <p>{@code forecast} ist die EINZIGE Kundendaten-Tabelle mit {@code tenant_id},
 * aber ohne RLS - und sie kann RLS nicht mehr bekommen (komprimiert seit
 * V20260809000000; RLS und Kompression schließen sich aus). Ihr Mandanten-Zaun
 * ist deshalb CODE-Disziplin: <b>jede App-Rollen-Query auf {@code forecast}
 * muss über einen site-Join bzw. eine RLS-aufgelöste {@code site_id} gefenced
 * sein, und gelöscht wird ausschließlich über die tenant-gebundene
 * SECURITY-DEFINER-Funktion {@code purge_forecast_for_site}</b>
 * (V20260831010000 hat der App-Rolle das direkte DELETE entzogen).
 *
 * <p>Der Test ist bewusst REIN (kein Docker, keine DB - das
 * ConsumerAuditEventTypesTest-Muster): er zählt jede Referenz auf die nackte
 * Tabelle im Produktionscode und vergleicht sie mit der dokumentierten
 * Allowlist. <b>Eine NEUE forecast-Query macht ihn rot</b> - wer sie schreibt,
 * prüft ZUERST, dass sie den Zaun trägt (site-Join im selben Statement, eine
 * vorab RLS-aufgelöste site_id, oder der Admin-Datenpfad), und erweitert DANN
 * die Allowlist mit dieser Begründung.
 */
class ForecastTableDisciplineTest {

    private static final Path MAIN = Path.of("src/main/java");

    /**
     * Jede SQL-Referenz auf die nackte Tabelle. Der Lookahead schließt die
     * RLS-gefencten Nachbarn ({@code weather_forecast} matcht das Präfix nicht,
     * {@code forecast_model_state}/{@code forecast_accuracy} den Suffix nicht)
     * aus - gezielt bleibt genau {@code FROM/JOIN/INTO/UPDATE forecast}.
     */
    private static final Pattern SQL_REF =
            Pattern.compile("(?i)(from|join|into|update)\\s+forecast(?![_a-zA-Z0-9])");

    /**
     * Der nackte {@code "forecast"}-String-Literal - die Form, in der die
     * Tabelle in dynamischen Tabellen-Schleifen ({@code "DELETE FROM " + table})
     * reist und die der SQL-Ausdruck oben nicht sieht.
     */
    private static final Pattern BARE_LITERAL = Pattern.compile("\"forecast\"");

    /**
     * Die dokumentierte Allowlist: Datei -> erwartete Zahl der SQL-Referenzen.
     * Jeder Eintrag nennt seinen Zaun; eine Abweichung (neue Datei ODER
     * geänderte Zahl) ist der Review-Moment, den dieser Wächter erzwingt.
     */
    private static final Map<String, Integer> ALLOWED_SQL = Map.of(
            // expectedMarketValue: beide forecast-Zugriffe hängen im selben
            // Statement an `site` (RLS-Tabelle) - `FROM site s JOIN LATERAL
            // (... WHERE f.site_id = s.id ...)` bzw. `JOIN site s ON ...`.
            "EarningsRepository.java", 2,
            // previewForSite: `WHERE site_id = ?` mit einer site_id, die der
            // Controller vorher über die RLS-gefencte SiteRepository aufgelöst
            // hat (fremde Anlage = 404, bevor die Query läuft).
            "SeriesRepository.java", 1,
            // pvPrognose (Verlust-Schätzung, Läufer unter TenantContext): `FROM forecast f JOIN site s ON s.id =
            // f.site_id` im selben Statement, App-Rolle - fremde Anlage = leer (AnteilVerlustSchaetzungApiTest).
            "AnteilVerlustRepository.java", 1);

    /**
     * Nackte {@code "forecast"}-Literale: Datei -> erwartete Zahl + Zaun.
     * TenantRepository löscht in einer Tabellen-Schleife - über die
     * BYPASSRLS-Admin-Rolle (strukturell unten mitgeprüft), also der bewusste
     * Admin-Datenpfad des Offboardings. FlowTemplates' Literal ist gar kein
     * SQL (ein Flow-Port-Name im Starter-Graphen).
     */
    private static final Map<String, Integer> ALLOWED_LITERAL = Map.of(
            "TenantRepository.java", 1,
            "FlowTemplates.java", 1);

    @Test
    @DisplayName("jede forecast-Query im App-Pfad ist allowlisted und damit bewusst gefenced")
    void everyForecastReferenceIsOnTheDocumentedAllowlist() throws IOException {
        Map<String, Integer> sqlRefs = occurrences(SQL_REF);
        Map<String, Integer> literals = occurrences(BARE_LITERAL);

        assertThat(sqlRefs)
                .as("SQL-Referenzen auf die nackte forecast-Tabelle. Eine NEUE Query braucht "
                        + "ihren Mandanten-Zaun (site-Join im Statement, RLS-aufgelöste site_id "
                        + "oder Admin-Datenpfad), BEVOR sie hier allowlisted wird - forecast hat "
                        + "kein RLS und kann keins bekommen (Kompression).")
                .containsExactlyInAnyOrderEntriesOf(ALLOWED_SQL);
        assertThat(literals)
                .as("nackte \"forecast\"-String-Literale (dynamische Tabellen-Schleifen). "
                        + "Dieselbe Zaun-Regel wie für SQL-Referenzen.")
                .containsExactlyInAnyOrderEntriesOf(ALLOWED_LITERAL);
    }

    @Test
    @DisplayName("kein App-Pfad enthält ein direktes DELETE/INSERT auf forecast")
    void noDirectForecastDmlExistsInMain() throws IOException {
        assertThat(occurrences(Pattern.compile("(?i)(delete\\s+from|insert\\s+into|update)\\s+forecast(?![_a-zA-Z0-9])")))
                .as("die App-Rolle hat kein DELETE auf forecast (V20260831010000) und schreibt "
                        + "sie nie - gelöscht wird ausschließlich über purge_forecast_for_site")
                .isEmpty();
    }

    @Test
    @DisplayName("die strukturellen Zäune der Allowlist-Einträge stehen wirklich im Code")
    void theDocumentedFencesActuallyExist() throws IOException {
        // TenantRepository ist an die BYPASSRLS-Admin-Rolle gebunden - der
        // bewusste Admin-Datenpfad; sein dynamisches DELETE ist damit gefenced.
        assertThat(read("com/voltpilot/api/repo/TenantRepository.java"))
                .contains("@Qualifier(\"adminJdbcTemplate\")");
        // EarningsRepository fenced beide forecast-Zugriffe im selben Statement
        // an der RLS-Tabelle site.
        String earnings = read("com/voltpilot/api/repo/EarningsRepository.java");
        assertThat(earnings).contains("FROM site s");
        assertThat(earnings).contains("WHERE f.site_id = s.id");
        // AnteilVerlustRepository fenced pvPrognose im selben Statement an der
        // RLS-Tabelle site und liest über die RLS-gebundene App-Rolle (kein
        // adminJdbcTemplate - sonst wäre der Join wirkungslos).
        String anteilVerlust = read("com/voltpilot/api/uems/AnteilVerlustRepository.java");
        assertThat(anteilVerlust).contains("FROM forecast f JOIN site s ON s.id = f.site_id");
        assertThat(anteilVerlust).doesNotContain("adminJdbcTemplate");
        // SeriesRepository löscht forecast NUR über die tenant-gebundene
        // SECURITY-DEFINER-Funktion, nie per direktem DELETE.
        assertThat(read("com/voltpilot/api/repo/SeriesRepository.java"))
                .contains("SELECT purge_forecast_for_site(?)");
    }

    private static Map<String, Integer> occurrences(Pattern pattern) throws IOException {
        Map<String, Integer> found = new LinkedHashMap<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            files.filter(p -> p.getFileName().toString().endsWith(".java"))
                    .sorted()
                    .forEach(p -> {
                        Matcher m = pattern.matcher(readQuietly(p));
                        int count = 0;
                        while (m.find()) {
                            count++;
                        }
                        if (count > 0) {
                            found.merge(p.getFileName().toString(), count, Integer::sum);
                        }
                    });
        }
        return found;
    }

    private static String read(String relative) throws IOException {
        return Files.readString(MAIN.resolve(relative));
    }

    private static String readQuietly(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
