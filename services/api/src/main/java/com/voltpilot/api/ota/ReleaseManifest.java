package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Der Java-Leser des signierten Release-Manifests
 * ({@code docs/contracts/ota-release-manifest.schema.json}) - der Zwilling von
 * {@code otaverify.ParseManifest} und {@code Manifest.NotApplicableReason} im
 * Go-Core. Mit ihm bestimmt die API die BOX-ART eines Release
 * ({@code compat.backends}: compose = Docker-Box, light = Edge Light), etwa um
 * einer Box nur Releases ihrer eigenen Box-Art zuzuweisen.
 *
 * <p><b>Die Regel ist geteilt, nicht doppelt erfunden:</b> beide Leser laufen
 * gegen {@code docs/contracts/ota-release-manifest-vectors.json} und müssen je
 * Fall dasselbe Urteil liefern ({@code ReleaseManifestVectorsTest} hier,
 * {@code TestManifestVectors} im Go-Core). Wer sie auf einer Seite ändert,
 * ändert beide Seiten und die Datei zusammen.
 *
 * <p><b>Tolerant gegenüber Unbekanntem, streng beim Bekannten:</b> ein
 * Artefakt-Typ oder Backend, das dieser Stand nicht kennt, ist KEIN
 * Formfehler - ein solches Release ist nur für ein Backend, das es nicht
 * anwendet, „nicht anwendbar". Die Felder eines bekannten Typs werden voll
 * geprüft.
 *
 * <p><b>Verhältnis zu {@link BoxArt}:</b> {@code BoxArt.ofRelease} schaut
 * bewusst nur roh in {@code compat.backends} und sperrt damit auch ein
 * unlesbares Manifest, das {@code light} nennt. Dieser Leser beantwortet die
 * genauere Frage, ob ein Release auf einem Backend ANWENDBAR ist - so, wie das
 * Gerät sie nach gültiger Signatur beantwortet.
 *
 * <p><b>Was hier NICHT passiert: keine Signaturprüfung.</b> Der einzige
 * Verifizierer, auf den es ankommt, ist das Gerät mit seiner eingebackenen
 * Wurzel (siehe {@code AdminEdgeReleaseController.readSigned}). Dieser Leser
 * beantwortet nur, was ein Manifest SAGT.
 */
public final class ReleaseManifest {

    /** Die Docker-Box. */
    public static final String BACKEND_COMPOSE = "compose";
    /** Edge Light: ein Programm je Architektur statt Container. */
    public static final String BACKEND_LIGHT = "light";

    public static final String TYPE_OCI_IMAGE = "oci-image";
    public static final String TYPE_BINARY = "binary";

    /** Welchen Artefakt-Typ ein Backend ANWENDET (Go: {@code appliedTypes}). */
    private static final Map<String, String> APPLIED_TYPES = Map.of(
            BACKEND_COMPOSE, TYPE_OCI_IMAGE,
            BACKEND_LIGHT, TYPE_BINARY);

    private static final Set<String> KNOWN_TYPES = Set.of(TYPE_OCI_IMAGE, TYPE_BINARY);

    /** Die Backends, die dieser Stand kennt (Go: {@code KnownBackend}). */
    private static final Set<String> KNOWN_BACKENDS = Set.of(BACKEND_COMPOSE, "quadlet", "mender", BACKEND_LIGHT);

    /** Präfix der Edge-Light-Linie (Entscheid E7, Go: {@code LightReleasePrefix}). */
    public static final String LIGHT_RELEASE_PREFIX = "edge-light-";

    private static final Pattern RELEASE = Pattern.compile("^edge(-light)?-\\d{4}\\.\\d{2}\\.\\d+$");
    private static final Pattern COMMIT = Pattern.compile("^[0-9a-f]{7,64}$");
    private static final Pattern KEY_ID = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");
    private static final Pattern NAME = Pattern.compile("^[a-z][a-z0-9-]{0,31}$");
    private static final Pattern TOKEN = NAME;
    private static final Pattern DIGEST_REF = Pattern.compile("^[^\\s@]+@sha256:[0-9a-f]{64}$");
    private static final Pattern ARCH = Pattern.compile("^[a-z0-9]+/[a-z0-9]+(/[a-z0-9]+)?$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Ein Bestandteil, so weit die API ihn braucht. {@code arch} nur bei binary. */
    public record Artifact(String type, String name, String arch) {
    }

    /**
     * Ein Programm eines Edge-Light-Release (Artefakt-Typ binary): was die Box
     * lädt ({@code gzSha256}, {@code gzSize}) und was sie danach entpackt hat
     * ({@code sha256}, {@code size}).
     */
    public record Program(String name, String arch, String sha256, long size, String gzSha256,
            long gzSize) {
    }

    /** Ein Manifest, das nicht die Form des Vertrags hat - mit deutschem Grund. */
    public static final class InvalidManifestException extends IllegalArgumentException {
        InvalidManifestException(String message) {
            super(message);
        }
    }

    private final String release;
    private final long releaseSeq;
    private final List<String> backends;
    private final List<Artifact> artifacts;
    private final List<Program> programs;

    private ReleaseManifest(String release, long releaseSeq, List<String> backends,
            List<Artifact> artifacts, List<Program> programs) {
        this.release = release;
        this.releaseSeq = releaseSeq;
        this.backends = List.copyOf(backends);
        this.artifacts = List.copyOf(artifacts);
        this.programs = List.copyOf(programs);
    }

    public String release() {
        return release;
    }

    public long releaseSeq() {
        return releaseSeq;
    }

    /** {@code compat.backends} in Manifest-Reihenfolge - die Box-Art(en). */
    public List<String> backends() {
        return backends;
    }

    public List<Artifact> artifacts() {
        return artifacts;
    }

    /** Die binary-Artefakte mit ihren Prüfsummen, in Manifest-Reihenfolge. */
    public List<Program> programs() {
        return programs;
    }

    /** Das Programm für eine Plattform ({@code linux/mipsle}), falls das Manifest eines nennt. */
    public Optional<Program> program(String arch) {
        return programs.stream().filter(p -> p.arch().equals(arch)).findFirst();
    }

    /** Ist dieses Release für das Backend bestimmt? */
    public boolean isFor(String backend) {
        return backends.contains(backend);
    }

    /**
     * Warum dieses Release auf einer Box mit dem genannten Backend NICHT
     * anwendbar ist - leer, wenn es anwendbar ist. Der Zwilling von
     * {@code Manifest.NotApplicableReason}: das Backend steht nicht in
     * {@code compat.backends} (andere Box-Art), oder ein Bestandteil hat einen
     * Typ, den dieses Backend nicht anwendet. Das Gerät stellt in beiden Fällen
     * zurück (deferred, Sperre {@code backend}).
     */
    public Optional<String> notApplicableReason(String backend) {
        if (!isFor(backend)) {
            return Optional.of("Release " + release + " ist nicht fuer das Apply-Backend '" + backend
                    + "' dieses Geraets bestimmt (gilt fuer: " + String.join(", ", backends)
                    + ") - es gehoert zu einer anderen Box-Art.");
        }
        String want = APPLIED_TYPES.get(backend);
        if (want == null) {
            return Optional.of("Fuer das Apply-Backend '" + backend + "' kennt dieser Stand keine "
                    + "Anwendung - Release " + release + " wird nicht angewandt.");
        }
        for (Artifact a : artifacts) {
            if (a.type().equals(want)) {
                continue;
            }
            if (!KNOWN_TYPES.contains(a.type())) {
                return Optional.of("Release " + release + " traegt den Bestandteil '" + a.name()
                        + "' vom Typ '" + a.type() + "', den dieser Stand nicht kennt - es wird "
                        + "nichts davon angewandt.");
            }
            return Optional.of("Release " + release + " traegt den Bestandteil '" + a.name()
                    + "' vom Typ '" + a.type() + "', den das Apply-Backend '" + backend
                    + "' nicht anwendet - es wird nichts davon angewandt.");
        }
        return Optional.empty();
    }

    /**
     * Liest ein Manifest und prüft seine Form wie das Gerät
     * ({@code otaverify.ParseManifest}).
     *
     * @throws InvalidManifestException mit deutschem Grund, wenn die Form nicht stimmt
     */
    public static ReleaseManifest read(String raw) {
        JsonNode m;
        try {
            m = JSON.readTree(raw);
        } catch (Exception e) {
            throw new InvalidManifestException("Manifest ist kein gueltiges JSON.");
        }
        if (m == null || !m.isObject()) {
            throw new InvalidManifestException("Manifest ist kein JSON-Objekt.");
        }

        String schemaVersion = text(m, "schema_version");
        if (schemaVersion == null || schemaVersion.isEmpty()) {
            throw new InvalidManifestException("schema_version fehlt");
        }
        String major = schemaVersion.contains(".")
                ? schemaVersion.substring(0, schemaVersion.indexOf('.')) : schemaVersion;
        if (!"1".equals(major)) {
            throw new InvalidManifestException("schema_version '" + schemaVersion
                    + "' wird von diesem Stand nicht unterstuetzt (erwartet 1.x)");
        }
        String release = text(m, "release");
        if (release == null || !RELEASE.matcher(release).matches()) {
            throw new InvalidManifestException("release '" + release
                    + "' folgt nicht dem Schema edge-JJJJ.MM.N oder edge-light-JJJJ.MM.N");
        }
        long seq = integer(m, "release_seq");
        if (seq < 1) {
            throw new InvalidManifestException("release_seq muss >= 1 sein");
        }
        String commit = text(m, "target_commit");
        if (commit == null || !COMMIT.matcher(commit).matches()) {
            throw new InvalidManifestException("target_commit '" + commit + "' ist kein Commit-Hash");
        }
        long minFrom = integer(m, "min_from_seq");
        if (minFrom < 0) {
            throw new InvalidManifestException("min_from_seq darf nicht negativ sein");
        }
        if (minFrom > seq) {
            throw new InvalidManifestException("min_from_seq (" + minFrom + ") liegt ueber release_seq ("
                    + seq + ")");
        }
        if (integer(m, "state_schema") < 1) {
            throw new InvalidManifestException("state_schema muss >= 1 sein");
        }
        String keyId = text(m, "signing_key_id");
        if (keyId == null || !KEY_ID.matcher(keyId).matches()) {
            throw new InvalidManifestException("signing_key_id '" + keyId
                    + "' ist keine gueltige Schluessel-Kennung");
        }
        bool(m, "allow_downgrade");
        bool(m, "urgent");
        text(m, "notes");
        String validUntil = text(m, "valid_until");
        if (validUntil != null && !validUntil.isEmpty()) {
            try {
                OffsetDateTime.parse(validUntil);
            } catch (DateTimeParseException e) {
                throw new InvalidManifestException("valid_until '" + validUntil
                        + "' ist kein RFC-3339-Zeitpunkt");
            }
        }

        List<Program> programs = new ArrayList<>();
        List<Artifact> artifacts = readArtifacts(m.get("artifacts"), programs);
        List<String> backends = readBackends(m.get("compat"));
        return new ReleaseManifest(release, seq, backends, artifacts, programs);
    }

    /**
     * Liest ein Manifest so streng, wie die Werkzeuge es ERZEUGEN dürfen - der
     * Zwilling von {@code otaverify.ParseManifestStrict} (Vektor-Feld
     * {@code erzeugbar}). Zusätzlich zu {@link #read}: jeder Typ und jedes
     * Backend ist bekannt, jeder Bestandteil trägt nur die Felder seines Typs,
     * und es gilt EIN MANIFEST JE BOX-ART (edge-light-… nur mit Backend light
     * und nur binary; jedes andere Release mit keinem von beiden).
     *
     * <p>Das Register liest Edge-Light-Releases so: ein Eintrag, den die Boxen
     * zwar tolerant lesen, den aber kein Werkzeug erzeugen darf, gehört nicht in
     * die Liste, aus der ein Mensch Releases zuweist.
     *
     * @throws InvalidManifestException mit deutschem Grund
     */
    public static ReleaseManifest readStrict(String raw) {
        ReleaseManifest m = read(raw);
        JsonNode root;
        try {
            root = JSON.readTree(raw);
        } catch (Exception e) {
            throw new InvalidManifestException("Manifest ist kein gueltiges JSON.");
        }
        boolean light = m.release.startsWith(LIGHT_RELEASE_PREFIX);
        for (String b : m.backends) {
            if (!KNOWN_BACKENDS.contains(b)) {
                throw new InvalidManifestException("compat.backends: unbekanntes Backend '" + b + "'");
            }
            if (BACKEND_LIGHT.equals(b) != light) {
                throw new InvalidManifestException(light
                        ? "Edge-Light-Release " + m.release + " gilt nur fuer das Backend 'light', nicht fuer '"
                                + b + "'"
                        : "das Backend 'light' gehoert zu Edge Light - das Release muss edge-light-JJJJ.MM.N "
                                + "heissen, nicht '" + m.release + "'");
            }
        }
        int i = 0;
        for (JsonNode a : root.get("artifacts")) {
            String type = a.get("type").asText();
            String name = a.get("name").asText();
            if (!KNOWN_TYPES.contains(type)) {
                throw new InvalidManifestException("artifacts[" + i + "]: unbekannter Typ '" + type + "'");
            }
            if (TYPE_BINARY.equals(type) != light) {
                throw new InvalidManifestException(light
                        ? "artifacts[" + i + "] (" + name + "): ein Edge-Light-Release traegt nur Artefakte "
                                + "vom Typ 'binary'"
                        : "artifacts[" + i + "] (" + name + "): Artefakte vom Typ 'binary' gehoeren in ein "
                                + "Edge-Light-Release (edge-light-JJJJ.MM.N)");
            }
            if (TYPE_OCI_IMAGE.equals(type)) {
                for (String f : List.of("arch", "sha256", "size", "gz_sha256", "gz_size")) {
                    if (present(a, f)) {
                        throw new InvalidManifestException("artifacts[" + i + "] (" + name
                                + "): ein oci-image traegt nur type, name und ref");
                    }
                }
            } else if (present(a, "ref")) {
                throw new InvalidManifestException("artifacts[" + i + "] (" + name + "): ein binary traegt kein ref");
            }
            i++;
        }
        return m;
    }

    /**
     * Ist das Feld GESETZT, so wie Go es sieht ({@code omitempty}-Nullwerte
     * gelten als fehlend: leerer Text, 0)?
     */
    private static boolean present(JsonNode n, String field) {
        JsonNode v = n.get(field);
        if (v == null || v.isNull()) {
            return false;
        }
        if (v.isTextual()) {
            return !v.asText().isEmpty();
        }
        if (v.isNumber()) {
            return v.asLong() != 0L;
        }
        return true;
    }

    private static List<Artifact> readArtifacts(JsonNode node, List<Program> programs) {
        if (node == null || node.isNull() || (node.isArray() && node.isEmpty())) {
            throw new InvalidManifestException(
                    "artifacts ist leer - ein Release ohne Artefakt beschreibt nichts");
        }
        if (!node.isArray()) {
            throw new InvalidManifestException("artifacts ist keine Liste");
        }
        List<Artifact> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int i = 0;
        for (JsonNode a : node) {
            if (!a.isObject()) {
                throw new InvalidManifestException("artifacts[" + i + "] ist kein Objekt");
            }
            String type = text(a, "type");
            String name = text(a, "name");
            // Die Felder der bekannten Typen tragen ihren JSON-Typ auf JEDEM
            // Bestandteil - wie das Go-Struct, das sie für jeden Typ dekodiert.
            String ref = text(a, "ref");
            String arch = text(a, "arch");
            String sha256 = text(a, "sha256");
            long size = integer(a, "size");
            String gzSha256 = text(a, "gz_sha256");
            long gzSize = integer(a, "gz_size");
            if (type == null || !TOKEN.matcher(type).matches()) {
                throw new InvalidManifestException("artifacts[" + i + "]: Typ '" + type
                        + "' ist kein gueltiger Typ-Name");
            }
            if (name == null || !NAME.matcher(name).matches()) {
                throw new InvalidManifestException("artifacts[" + i + "]: ungueltiger Name '" + name + "'");
            }
            String key = type + "\u0000" + name + "\u0000" + (arch == null ? "" : arch);
            if (!seen.add(key)) {
                throw new InvalidManifestException("artifacts: '" + name + "'"
                        + (arch == null || arch.isEmpty() ? "" : " fuer " + arch) + " kommt doppelt vor");
            }
            switch (type) {
                case TYPE_OCI_IMAGE -> {
                    if (ref == null || !DIGEST_REF.matcher(ref).matches()) {
                        throw new InvalidManifestException("artifacts[" + i + "] (" + name
                                + "): ref muss voll digest-gepinnt sein (…@sha256:…), ist '" + ref + "'");
                    }
                }
                case TYPE_BINARY -> {
                    if (arch == null || !ARCH.matcher(arch).matches()) {
                        throw new InvalidManifestException("artifacts[" + i + "] (" + name
                                + "): arch muss eine Plattform wie linux/mipsle sein, ist '" + arch + "'");
                    }
                    if (sha256 == null || !SHA256.matcher(sha256).matches()) {
                        throw new InvalidManifestException("artifacts[" + i + "] (" + name + ", " + arch
                                + "): sha256 muss 64 Hex-Zeichen haben");
                    }
                    if (size < 1) {
                        throw new InvalidManifestException("artifacts[" + i + "] (" + name + ", " + arch
                                + "): size muss >= 1 sein");
                    }
                    if (gzSha256 == null || !SHA256.matcher(gzSha256).matches()) {
                        throw new InvalidManifestException("artifacts[" + i + "] (" + name + ", " + arch
                                + "): gz_sha256 muss 64 Hex-Zeichen haben");
                    }
                    if (gzSize < 1) {
                        throw new InvalidManifestException("artifacts[" + i + "] (" + name + ", " + arch
                                + "): gz_size muss >= 1 sein");
                    }
                }
                default -> {
                    // Unbekannter Typ: kein Formfehler, sondern „nicht anwendbar".
                }
            }
            out.add(new Artifact(type, name, TYPE_BINARY.equals(type) ? arch : null));
            if (TYPE_BINARY.equals(type)) {
                programs.add(new Program(name, arch, sha256, size, gzSha256, gzSize));
            }
            i++;
        }
        return out;
    }

    private static List<String> readBackends(JsonNode compat) {
        if (compat != null && !compat.isNull() && !compat.isObject()) {
            throw new InvalidManifestException("compat ist kein Objekt");
        }
        JsonNode node = compat == null ? null : compat.get("backends");
        if (node == null || node.isNull() || (node.isArray() && node.isEmpty())) {
            throw new InvalidManifestException(
                    "compat.backends ist leer - ein Release muss sagen, fuer welches Apply-Backend es gilt");
        }
        if (!node.isArray()) {
            throw new InvalidManifestException("compat.backends ist keine Liste");
        }
        List<String> out = new ArrayList<>();
        for (JsonNode b : node) {
            if (!b.isTextual() || !TOKEN.matcher(b.asText()).matches()) {
                throw new InvalidManifestException("compat.backends: '" + b.asText()
                        + "' ist kein gueltiger Backend-Name");
            }
            out.add(b.asText());
        }
        JsonNode families = compat.get("inverter_families");
        if (families != null && !families.isNull()) {
            if (!families.isArray()) {
                throw new InvalidManifestException("compat.inverter_families ist keine Liste");
            }
            for (JsonNode f : families) {
                if (!f.isTextual()) {
                    throw new InvalidManifestException("compat.inverter_families traegt einen Nicht-Text");
                }
            }
        }
        return out;
    }

    /** Ein Textfeld; fehlend oder null = {@code null}, anderer JSON-Typ = Formfehler. */
    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        if (v == null || v.isNull()) {
            return null;
        }
        if (!v.isTextual()) {
            throw new InvalidManifestException(field + " ist kein Text");
        }
        return v.asText();
    }

    /** Eine Ganzzahl; fehlend oder null = 0 (wie der Go-Nullwert), sonst ganzzahlig. */
    private static long integer(JsonNode n, String field) {
        JsonNode v = n.get(field);
        if (v == null || v.isNull()) {
            return 0L;
        }
        if (!v.isIntegralNumber() || !v.canConvertToLong()) {
            throw new InvalidManifestException(field + " ist keine Ganzzahl");
        }
        return v.asLong();
    }

    private static void bool(JsonNode n, String field) {
        JsonNode v = n.get(field);
        if (v != null && !v.isNull() && !v.isBoolean()) {
            throw new InvalidManifestException(field + " ist kein Wahrheitswert");
        }
    }
}
