package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.UncheckedIOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.flyway.FlywayProperties;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.io.ClassPathResource;

/**
 * The cheap, always-running guards around the migration set - the ones that cost
 * a second here instead of a production deploy.
 *
 * <p><b>The contract they enforce.</b> Since the 2026-08-26 incident the api
 * ships {@code spring.flyway.out-of-order: true}, so a migration whose version
 * sits below the already-applied high-water mark is APPLIED rather than
 * refused (see {@code FlywayOutOfOrderBootTest} for why: version = authoring
 * time, arrival = merge order, and parallel branches make those diverge). That
 * is deliberate - but it means a version number is no longer implicitly
 * validated by the order things run, so the two collisions it can no longer
 * catch have to be caught here:
 *
 * <ul>
 *   <li><b>two migrations with the SAME version</b> - Flyway aborts every boot
 *       with "Found more than one migration with version ...". This repo has hit
 *       it twice: once by two parallel PRs picking the same timestamp, once via
 *       a {@code git mv} whose stale copy survived in {@code target/classes}
 *       (Maven copies resources but never deletes them), where the real cause
 *       showed up only at the end of a {@code Caused by} chain under dozens of
 *       unrelated failing classes. Both source tree and built classpath are
 *       scanned, so both variants fail here by name;</li>
 *   <li><b>the same column added twice</b> without an {@code IF NOT EXISTS}
 *       guard - the second {@code ALTER TABLE ... ADD COLUMN} blows up whichever
 *       order the two migrations run in.</li>
 * </ul>
 *
 * <p><b>What these guards deliberately do NOT claim.</b> They are static: a
 * migration that merely DEPENDS on an earlier-versioned one (reading a column it
 * assumes exists) still succeeds in version order and fails in merge order, and
 * no filename scan can see that. The rule that covers it stays a review rule -
 * a migration must stand on its own against the schema as of ITS OWN version
 * (docs/deploy.md).
 *
 * <p>No Docker, no Spring context: this runs in every gate, including on a
 * machine with no container runtime.
 */
class MigrationHygieneTest {

    /** {@code V<version>__<description>.sql} - the only shape this project uses. */
    private static final Pattern VERSIONED = Pattern.compile("^V([0-9]+(?:\\.[0-9]+)*)__(.+)\\.sql$");

    private static final Pattern LINE_COMMENT = Pattern.compile("(?m)--[^\n]*");
    private static final Pattern BLOCK_COMMENT = Pattern.compile("(?s)/\\*.*?\\*/");
    private static final Pattern ALTER_TABLE =
            Pattern.compile("(?is)ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?([A-Za-z0-9_.\"]+)\\s+(.*?);");
    private static final Pattern ADD_COLUMN =
            Pattern.compile("(?i)ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?([A-Za-z0-9_\"]+)");

    /**
     * Die hoechste Version des eingefrorenen Satzes der ersten Produktfreigabe.
     * Am CODE festgemacht, nicht am Datum: es ist die groesste Version, die
     * {@code db/migration} am 19.09.2026 traegt. Alles bis hierher ist BESTAND
     * und bleibt ohne nachtraeglichen Marker gruen - der Bestand ist gebaut,
     * und das Fenster des Rollout-Tags (docs/rollout/uems-erste-freigabe.md)
     * macht ihn unschaedlich. Alles DARUEBER ist neu und faellt unter
     * Expand-Contract (Konzept AP-14 Regel D9, Kasten W1).
     */
    private static final String ERSTE_FREIGABE_HOECHSTE_VERSION = "20260918110000";

    /**
     * Der Marker, mit dem eine neue Migration ausdruecklich sagt: ich brauche
     * ein Wartungsfenster, der alte Code laeuft danach nicht mehr. Er steht als
     * eigene Kommentarzeile in der Migration.
     */
    private static final Pattern FREIGABE_FENSTER_MARKER =
            Pattern.compile("(?im)^[\\s]*--[\\s]*freigabe:[\\s]*fenster[\\s]*$");

    /**
     * Die drei Aussagen, nach denen der Code der VORIGEN Auslieferung nicht mehr
     * laeuft - genau die drei aus Kasten W1: die Spalten-Umbenennung in
     * {@code ort_aenderung} (V20260916010000), der gefallene Primaerschluessel
     * von {@code entity_registry_state} (V20260915040000) und eine fallende
     * Spalte. Ein fallender CHECK oder Fremdschluessel ist NICHT dabei: er
     * nimmt dem alten Leser nichts weg.
     */
    private static final Map<String, Pattern> FENSTER_PFLICHTIG = Map.of(
            "RENAME COLUMN", Pattern.compile("(?is)\\bRENAME\\s+COLUMN\\b"),
            "DROP COLUMN", Pattern.compile("(?is)\\bDROP\\s+COLUMN\\b"),
            "DROP CONSTRAINT ..._pkey",
                    Pattern.compile("(?is)\\bDROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?\"?[A-Za-z0-9_.]*_pkey\\b"));

    /**
     * A duplicate version aborts EVERY boot of every environment, so it must
     * never reach main. Both Flyway locations are scanned as one set: under the
     * {@code local} profile {@code db/migration} and {@code db/dev} are loaded
     * together, so a collision across them is just as fatal as one within.
     */
    @Test
    void noTwoMigrationsShareAVersionNumber() {
        assertNoDuplicateVersions(sourceMigrations(), "source tree");
    }

    /**
     * The same check on what the CLASSPATH actually carries - the half a source
     * scan cannot see. Maven copies resources into {@code target/classes} and
     * never deletes them, so after renaming or deleting a migration the OLD file
     * is still there and Flyway sees both. Documented footgun; the fix is
     * {@code ./mvnw clean test}, and this test is what says so.
     */
    @Test
    void theBuiltClasspathCarriesNoDuplicateVersionEither() {
        List<Migration> onClasspath = classpathMigrations();
        // Packaged into a jar rather than exploded into target/classes: the
        // stale-leftover trap cannot apply there, so there is nothing to check.
        assumeTrue(onClasspath != null, "migrations are not served from a directory");
        assertNoDuplicateVersions(onClasspath,
                "built classpath (target/classes) - run './mvnw clean test' if a migration was renamed or deleted");
    }

    /** Anything that is not {@code V<version>__<description>.sql} is silently NOT a migration. */
    @Test
    void everyMigrationFileParsesAsAVersionedMigration() {
        List<String> malformed = sourceMigrations().stream()
                .filter(m -> !VERSIONED.matcher(m.file().getFileName().toString()).matches())
                .map(Migration::describe)
                .toList();
        assertThat(malformed)
                .as("files under db/migration + db/dev that Flyway would ignore instead of applying")
                .isEmpty();
    }

    /**
     * Two migrations adding the same column to the same table: whichever runs
     * second fails with "column already exists" unless it is guarded with
     * {@code IF NOT EXISTS}. Only an UNGUARDED duplicate is flagged - two guarded
     * ones are the deliberate idempotency this repo uses for its runtime twins
     * of another service's migration.
     */
    @Test
    void noMigrationAddsAColumnAnotherMigrationAlreadyAddsUnguarded() {
        Map<String, List<ColumnAdd>> byColumn = new TreeMap<>();
        for (Migration migration : sourceMigrations()) {
            for (ColumnAdd add : columnAdds(migration)) {
                byColumn.computeIfAbsent(add.table() + "." + add.column(), k -> new ArrayList<>()).add(add);
            }
        }

        List<String> collisions = new ArrayList<>();
        byColumn.forEach((column, adds) -> {
            boolean acrossFiles = adds.stream().map(ColumnAdd::source).distinct().count() > 1;
            boolean anyUnguarded = adds.stream().anyMatch(a -> !a.guarded());
            if (acrossFiles && anyUnguarded) {
                collisions.add(column + " added by "
                        + adds.stream().map(a -> a.source() + (a.guarded() ? " (guarded)" : " (UNGUARDED)")).toList());
            }
        });

        assertThat(collisions)
                .as("columns added by more than one migration without an IF NOT EXISTS guard - "
                        + "the second one to run fails whichever order they arrive in")
                .isEmpty();
    }

    /**
     * The premise of this whole class, pinned at the SHIPPED file: a deployment
     * that silently lost this setting is back to the 2026-08-26 crash loop, and
     * the Docker-gated {@code FlywayOutOfOrderBootTest} cannot say so on a
     * machine without a container runtime.
     *
     * <p>It binds {@link FlywayProperties} the way Boot does rather than reading
     * the YAML as a map, because that is what actually has to be true: a key
     * Boot never binds ({@code outOfOrder:}, {@code out_of_order:}, one nesting
     * level off) reads fine as a map and does exactly nothing at startup.
     */
    @Test
    void theShippedFlywayConfigAllowsOutOfOrderWithoutLooseningValidation() throws Exception {
        MutablePropertySources sources = new MutablePropertySources();
        new YamlPropertySourceLoader()
                .load("application.yml", new ClassPathResource("application.yml"))
                .forEach(sources::addLast);
        FlywayProperties flyway = new Binder(ConfigurationPropertySources.from(sources))
                .bind("spring.flyway", FlywayProperties.class)
                .orElseThrow(() -> new AssertionError("spring.flyway is not bindable from application.yml"));

        assertThat(flyway.isOutOfOrder())
                .as("a migration merged out of version order must be APPLIED, not refused")
                .isTrue();
        // The two neighbours it has to coexist with, so a future edit cannot
        // quietly turn "tolerate a late arrival" into "tolerate anything".
        assertThat(flyway.getIgnoreMigrationPatterns())
                .as("still scoped to ':missing' only - checksum drift must keep failing")
                .containsExactly("*:missing");
        assertThat(flyway.isValidateOnMigrate())
                .as("validation stays ON; out-of-order is not a way to switch it off")
                .isTrue();
    }

    // --- Expand-Contract-Waechter (AP-14 IP-13, Kasten W1) --------------

    /**
     * <b>Der Waechter.</b> Ab dem Rollout-Tag arbeiten Kunden auf dem neuen
     * Stand, und der rollende Wechsel der api ({@code maxSurge 1 /
     * maxUnavailable 0}) laesst alten und neuen Pod fuer Sekunden nebeneinander
     * laufen. Eine NEUE Migration, die eine Spalte umbenennt, eine Spalte
     * fallen laesst oder einen Primaerschluessel fallen laesst, macht den
     * gerade noch laufenden alten Pod fachlich kaputt - lautlos, weil Flyway
     * selbst gruen bleibt.
     *
     * <p>Die erste Produktfreigabe ist die benannte Ausnahme: sie faehrt mit
     * Wartungsfenster und Wiederherstellungspunkt (Konzept AP-14 E2 = A), und
     * genau deshalb darf ihr Bestand hier nicht mitgezaehlt werden. Alles ueber
     * {@link #ERSTE_FREIGABE_HOECHSTE_VERSION} braucht entweder Expand-Contract
     * oder den Marker {@code -- freigabe: fenster}, mit dem die Migration
     * ausdruecklich ein Wartungsfenster anmeldet.
     */
    @Test
    void keineNeueMigrationBrichtDenAltenCodeOhneFreigabeMarker() {
        assertThat(ohneFreigabeMarkerAbgelehnt(neueMigrationen(sourceMigrations())))
                .as("""
                        Neue Migrationen mit RENAME COLUMN, DROP COLUMN oder fallendem Primaerschluessel.
                        Nach ihnen laeuft der zuletzt ausgelieferte Code nicht mehr - und beim rollenden
                        Wechsel der api laeuft er noch Sekunden neben dem neuen Pod (gitops
                        apps/voltpilot/base/api/deployment.yaml, maxSurge 1 / maxUnavailable 0).
                        Entweder Expand-Contract bauen (neue Spalte daneben, Leser/Schreiber umstellen,
                        erst spaeter entfernen) - oder die Migration meldet mit der Kommentarzeile
                        '-- freigabe: fenster' ein Wartungsfenster an. Das Drehbuch dafuer steht in
                        docs/rollout/uems-erste-freigabe.md""")
                .isEmpty();
    }

    /**
     * Der BESTAND bleibt gruen, ohne dass ihm jemand nachtraeglich Marker
     * anheftet: er ist gebaut, angewandt und durch das Fenster der ersten
     * Freigabe unschaedlich. Der Test haelt das ausdruecklich fest - sonst
     * koennte eine spaetere Bequemlichkeit die Grenze nach oben schieben und
     * der Waechter waere still tot.
     */
    @Test
    void derBestandTraegtDieseAussagenUndBleibtOhneMarkerGruen() {
        List<Migration> bestand = sourceMigrations().stream()
                .filter(m -> version(m) != null && version(m).compareTo(ERSTE_FREIGABE_HOECHSTE_VERSION) <= 0)
                .toList();

        List<String> mitAussage = bestand.stream()
                .filter(m -> !fensterPflichtigeAussagen(lies(m)).isEmpty())
                .map(Migration::describe)
                .toList();
        assertThat(mitAussage)
                .as("der Bestand traegt solche Aussagen - genau darum gibt es das Fenster (W1)")
                .contains("migration/V20260916010000__uems_akteur_vokabular.sql");

        assertThat(bestand.stream().filter(m -> FREIGABE_FENSTER_MARKER.matcher(lies(m)).find()).toList())
                .as("kein Bestandsskript traegt einen nachtraeglich angehefteten Marker; "
                        + "die Grenze ist die Version, nicht ein Kommentar in einer angewandten Datei")
                .isEmpty();
    }

    /**
     * Die Grenze zeigt auf eine wirklich ausgelieferte Version. Ohne diese
     * Zusicherung koennte ein Tippfehler (oder eine ins Jahr 2999 gehobene
     * Zahl) den Waechter stumm schalten, ohne dass eine Zeile rot wird.
     */
    @Test
    void dieGrenzeDesEingefrorenenSatzesIstEineAusgelieferteVersion() {
        List<String> versionen = sourceMigrations().stream().map(this::version).filter(v -> v != null).toList();
        assertThat(versionen)
                .as("ERSTE_FREIGABE_HOECHSTE_VERSION muss eine Migration in db/migration sein")
                .contains(ERSTE_FREIGABE_HOECHSTE_VERSION);
        assertThat(versionen.stream().max(String::compareTo).orElseThrow())
                .as("die Grenze darf nicht UEBER dem ausgelieferten Satz liegen - sonst bewacht sie nichts")
                .isGreaterThanOrEqualTo(ERSTE_FREIGABE_HOECHSTE_VERSION);
    }

    /**
     * Die Probe: dieselben drei Aussagen, einmal ohne und einmal mit Marker.
     * Die Dateien liegen unter {@code src/test/resources/freigabe-fenster} und
     * damit ABSEITS des Flyway-Pfades - sie werden nie angewandt.
     */
    @Test
    void dieProbeMigrationOhneMarkerWirdAbgelehntUndMitMarkerDurchgelassen() {
        List<Migration> proben = probeMigrationen();
        assertThat(proben).as("Probe-Migrationen unter src/test/resources/freigabe-fenster").hasSize(3);

        assertThat(ohneFreigabeMarkerAbgelehnt(neueMigrationen(proben)))
                .as("nur die Probe ohne Marker wird abgelehnt; die mit Marker und die rein additive nicht")
                .hasSize(1)
                .allSatisfy(grund -> assertThat(grund)
                        .contains("V29990101000000__probe_ohne_marker.sql")
                        .contains("RENAME COLUMN")
                        .contains("DROP COLUMN")
                        .contains("DROP CONSTRAINT ..._pkey"));
    }

    /**
     * Der Waechter liest SQL, nicht Prosa: eine Kommentarzeile, die
     * {@code DROP COLUMN} nur erwaehnt, darf keine Ablehnung ausloesen, und ein
     * fallender CHECK ist keine fensterpflichtige Aussage.
     */
    @Test
    void einKommentarUndEinFallenderCheckLoesenNichtAus() {
        Migration additiv = probeMigrationen().stream()
                .filter(m -> m.file().getFileName().toString().contains("probe_additiv"))
                .findFirst()
                .orElseThrow();
        assertThat(fensterPflichtigeAussagen(lies(additiv)))
                .as("rein additiv: ADD COLUMN und ein fallender CHECK nehmen dem alten Leser nichts weg")
                .isEmpty();
    }

    private List<Migration> neueMigrationen(List<Migration> migrations) {
        return migrations.stream()
                .filter(m -> version(m) != null && version(m).compareTo(ERSTE_FREIGABE_HOECHSTE_VERSION) > 0)
                .toList();
    }

    /** Ein Eintrag je abgelehnter Migration, mit den Aussagen, die sie ablehnen. */
    private List<String> ohneFreigabeMarkerAbgelehnt(List<Migration> migrations) {
        List<String> abgelehnt = new ArrayList<>();
        for (Migration migration : migrations) {
            String sql = lies(migration);
            List<String> aussagen = fensterPflichtigeAussagen(sql);
            if (!aussagen.isEmpty() && !FREIGABE_FENSTER_MARKER.matcher(sql).find()) {
                abgelehnt.add(migration.describe() + " " + aussagen);
            }
        }
        return abgelehnt;
    }

    /**
     * Gesucht wird im SQL, nicht im Kommentar: Zeilen- und Blockkommentare
     * fallen vorher weg. Der Marker dagegen IST ein Kommentar und wird am
     * unveraenderten Text gesucht.
     */
    private List<String> fensterPflichtigeAussagen(String rohesSql) {
        String sql = BLOCK_COMMENT.matcher(LINE_COMMENT.matcher(rohesSql).replaceAll("")).replaceAll("");
        return FENSTER_PFLICHTIG.entrySet().stream()
                .filter(e -> e.getValue().matcher(sql).find())
                .map(Map.Entry::getKey)
                .sorted()
                .toList();
    }

    private String version(Migration migration) {
        Matcher m = VERSIONED.matcher(migration.file().getFileName().toString());
        return m.matches() ? m.group(1) : null;
    }

    private String lies(Migration migration) {
        try {
            return Files.readString(migration.file());
        } catch (java.io.IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Die Probe-Dateien, aus dem Klassenpfad gelesen wie die echten Orte auch. */
    private List<Migration> probeMigrationen() {
        Path dir = classpathDir("/freigabe-fenster");
        assertThat(dir).as("Probe-Migrationen sind nicht in ein Jar gepackt").isNotNull();
        return sqlFiles(dir).map(f -> new Migration("freigabe-fenster", f)).toList();
    }

    // --- scanning -------------------------------------------------------

    private record Migration(String location, Path file) {
        String describe() {
            return location + "/" + file.getFileName();
        }
    }

    private record ColumnAdd(String table, String column, boolean guarded, String source) {}

    private void assertNoDuplicateVersions(List<Migration> migrations, String where) {
        Map<String, List<String>> byVersion = new TreeMap<>();
        for (Migration migration : migrations) {
            Matcher m = VERSIONED.matcher(migration.file().getFileName().toString());
            if (m.matches()) {
                byVersion.computeIfAbsent(m.group(1), k -> new ArrayList<>()).add(migration.describe());
            }
        }
        List<String> duplicates = byVersion.entrySet().stream()
                .filter(e -> e.getValue().size() > 1)
                .map(e -> "version " + e.getKey() + " used by " + e.getValue())
                .toList();

        assertThat(migrations).as("migrations found in the " + where).isNotEmpty();
        assertThat(duplicates)
                .as("duplicate migration versions in the " + where
                        + " - Flyway aborts every boot with 'Found more than one migration with version'")
                .isEmpty();
    }

    /** Both Flyway locations from the SOURCE tree, so the check is build-state independent. */
    private List<Migration> sourceMigrations() {
        Path db = firstExisting(
                Path.of("src/main/resources/db"),
                Path.of("services/api/src/main/resources/db"));
        return Stream.of("migration", "dev")
                .flatMap(location -> sqlFiles(db.resolve(location)).map(f -> new Migration(location, f)))
                .toList();
    }

    /**
     * Both Flyway locations as the RUNNING api sees them (target/classes), or
     * {@code null} when they are not exploded on disk.
     */
    private List<Migration> classpathMigrations() {
        List<Migration> found = new ArrayList<>();
        for (String location : List.of("migration", "dev")) {
            Path dir = classpathDir("/db/" + location);
            if (dir == null) {
                return null;
            }
            sqlFiles(dir).forEach(f -> found.add(new Migration(location, f)));
        }
        return found;
    }

    /** The exploded directory behind a classpath location, or null if it is inside a jar. */
    private Path classpathDir(String resource) {
        URL url = getClass().getResource(resource);
        assertThat(url).as("classpath resource " + resource).isNotNull();
        if (!"file".equals(url.getProtocol())) {
            return null;
        }
        try {
            return Path.of(url.toURI());
        } catch (URISyntaxException e) {
            throw new IllegalStateException("unreadable classpath location " + resource, e);
        }
    }

    private Path firstExisting(Path... candidates) {
        for (Path candidate : candidates) {
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("db migration directory not found next to the working directory "
                + Path.of("").toAbsolutePath());
    }

    private Stream<Path> sqlFiles(Path dir) {
        assertThat(dir).as("migration directory").isDirectory();
        try (Stream<Path> files = Files.list(dir)) {
            return files.filter(p -> p.getFileName().toString().endsWith(".sql")).sorted().toList().stream();
        } catch (java.io.IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Best-effort {@code ALTER TABLE ... ADD COLUMN} extraction. Deliberately
     * conservative: it may MISS an add hidden inside a {@code DO $$} block (a
     * false negative only weakens the guard), but it must never invent one -
     * that would block a legitimate PR.
     */
    private List<ColumnAdd> columnAdds(Migration migration) {
        String sql;
        try {
            sql = Files.readString(migration.file());
        } catch (java.io.IOException e) {
            throw new UncheckedIOException(e);
        }
        sql = BLOCK_COMMENT.matcher(LINE_COMMENT.matcher(sql).replaceAll("")).replaceAll("");

        List<ColumnAdd> adds = new ArrayList<>();
        Map<String, Boolean> seenInThisFile = new LinkedHashMap<>();
        Matcher alter = ALTER_TABLE.matcher(sql);
        while (alter.find()) {
            String table = normalize(alter.group(1));
            Matcher add = ADD_COLUMN.matcher(alter.group(2));
            while (add.find()) {
                String column = normalize(add.group(2));
                boolean guarded = add.group(1) != null;
                // Within ONE file an add is allowed to repeat (e.g. a guarded
                // re-declaration); only the guarded-ness of the file as a whole
                // matters to the cross-file comparison.
                seenInThisFile.merge(table + "." + column, guarded, (a, b) -> a && b);
            }
        }
        seenInThisFile.forEach((key, guarded) -> {
            int dot = key.lastIndexOf('.');
            adds.add(new ColumnAdd(key.substring(0, dot), key.substring(dot + 1), guarded, migration.describe()));
        });
        return adds;
    }

    private static String normalize(String identifier) {
        String cleaned = identifier.replace("\"", "").toLowerCase(java.util.Locale.ROOT);
        return cleaned.startsWith("public.") ? cleaned.substring("public.".length()) : cleaned;
    }
}
