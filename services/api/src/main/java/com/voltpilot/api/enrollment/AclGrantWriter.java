package com.voltpilot.api.enrollment;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Writes the per-device EMQX ACL grant on certificate issuance - the Java twin
 * of {@code write_acl_grant} in {@code tools/pki/voltpilot-ca.sh}, producing
 * byte-identical blocks in the same generated region of the ACL file, so the
 * shell tool's {@code revoke} (which removes the block) keeps working over
 * api-written grants and vice versa.
 *
 * <p>EMQX's file authorizer is FIRST-MATCH, top-to-bottom, and the ACL ends
 * with a catch-all default-deny for UUID (device) usernames followed by
 * {@code {allow, all}}. A device grant is therefore only reachable if it sits
 * ABOVE that default-deny - which is what the
 * {@code %%<<BEGIN..>> .. %%<<END GENERATED DEVICE GRANTS>>} region is for.
 * Every write is a full CANONICALIZING rebuild: all device grants are collected
 * (wherever they were), the current device's block is inserted/replaced, and
 * the file is re-emitted with exactly ONE generated region above exactly ONE
 * default-deny tail. This is deliberately self-healing: a file that was
 * previously corrupted - a grant appended AFTER the default-deny (unreachable),
 * a duplicated template tail - is normalized on the next grant write or removal
 * so the very next claim/unclaim/reload fixes it without touching the broker
 * host (a real prod-down incident, 2026-07-08: the captain's claimed device was
 * denied and kicked off the broker because its grant landed below the deny).
 *
 * <p>The rewrite is atomic (temp file + move) so the broker never reads a
 * half-written file. The broker applies changes on its next authz reload
 * ({@code tools/pki/reload-broker-authz.sh} / {@code BrokerAuthzReloader} - see
 * docs/deploy.md).
 *
 * <p><strong>Deployment constraint:</strong> the ACL file's DIRECTORY must be
 * bind-mounted into this container, never the file alone. A single-file bind
 * mount makes the target a mountpoint, so the atomic rename fails with EBUSY
 * ("Device or resource busy") - and even where a replace succeeds, the broker's
 * own single-file mount would stay pinned to the replaced inode and never see
 * updates. When the rename is refused anyway (a misconfigured mount), the
 * writer degrades to a NON-atomic in-place rewrite with a loud warning: on a
 * single-file mount that is the only write that propagates, and a torn read is
 * only possible during the broker's explicit authz reload.
 */
class AclGrantWriter {

    private static final Logger log = LoggerFactory.getLogger(AclGrantWriter.class);

    static final String BEGIN_ANCHOR = "%%<<BEGIN GENERATED DEVICE GRANTS>>";
    static final String END_ANCHOR = "%%<<END GENERATED DEVICE GRANTS>>";

    /** The terminal catch-all of the ACL; anything after the first one is a duplicated tail. */
    private static final String ALLOW_ALL = "{allow, all}.";

    /** A per-device block opens with {@code %%<<device <id> ...>>}; capture the id. */
    private static final Pattern DEVICE_BEGIN = Pattern.compile("^%%<<device (\\S+) ");

    /**
     * rw-r--r-- : the EMQX broker reads the file as a DIFFERENT non-root uid
     * through a read-only mount. {@link Files#createTempFile} creates 0600 and
     * the atomic rename carries that mode onto acl.conf; a running broker keeps
     * its compiled rules, so the breakage only surfaces at the next authz
     * reload or broker restart, which then fails boot-time config validation
     * ("failed_to_read_acl_file: Permission denied" - a real prod outage).
     */
    private static final Set<PosixFilePermission> ACL_FILE_PERMISSIONS =
            PosixFilePermissions.fromString("rw-r--r--");

    private final Path aclFile;

    AclGrantWriter(Path aclFile) {
        this.aclFile = aclFile;
    }

    synchronized void writeGrant(UUID tenantId, UUID siteId, UUID deviceId) {
        try {
            List<String> lines = new ArrayList<>(Files.readAllLines(aclFile, StandardCharsets.UTF_8));
            Parsed parsed = parse(lines);
            // Insert or replace this device's block, keeping its position if it
            // was already present (idempotent re-claim), else appending it.
            parsed.blocks.put(deviceId.toString(), grantBlock(tenantId, siteId, deviceId));
            writeAtomically(rebuild(parsed));
        } catch (IOException e) {
            throw new IllegalStateException("cannot write ACL grant for device " + deviceId
                    + " to " + aclFile + ": " + e.getMessage(), e);
        }
    }

    /** Outcome of a startup {@link #normalizeInPlace()} self-heal. */
    record NormalizeResult(Status status, int grantsMovedAboveDeny, int tailCopies, String detail) {
        enum Status { UNCHANGED, HEALED, SKIPPED }

        static NormalizeResult unchanged() {
            return new NormalizeResult(Status.UNCHANGED, 0, 0, null);
        }

        static NormalizeResult healed(int grantsMovedAboveDeny, int tailCopies) {
            return new NormalizeResult(Status.HEALED, grantsMovedAboveDeny, tailCopies, null);
        }

        static NormalizeResult skipped(String detail) {
            return new NormalizeResult(Status.SKIPPED, 0, 0, detail);
        }

        boolean healed() {
            return status == Status.HEALED;
        }

        boolean skipped() {
            return status == Status.SKIPPED;
        }
    }

    /**
     * Idempotent self-heal, meant to run once at api startup so a DEPLOY repairs
     * an already-corrupted acl.conf on its own - WITHOUT any grant write or
     * device re-claim. Canonicalizes the file exactly like a grant write
     * (collapse duplicated default-deny/allow-all tails to one, exactly one
     * generated region, every device grant moved above the default-deny) and
     * rewrites it ONLY when that changes something - a healthy file is left
     * byte-for-byte untouched (so the caller can skip the authz reload and stay
     * quiet). Never throws: a file we do not recognize (no region anchors) or an
     * IO failure is reported as {@code SKIPPED}, never a crashed api boot.
     */
    synchronized NormalizeResult normalizeInPlace() {
        List<String> original;
        try {
            original = Files.readAllLines(aclFile, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return NormalizeResult.skipped("cannot read " + aclFile + ": " + e.getMessage());
        }
        List<String> healed;
        try {
            healed = rebuild(parse(new ArrayList<>(original)));
        } catch (IllegalStateException e) {
            // No region anchors - not the file we own; leave it for a human.
            return NormalizeResult.skipped(e.getMessage());
        }
        if (healed.equals(original)) {
            return NormalizeResult.unchanged();
        }
        int grantsBelowDeny = deviceBlocksBelowDefaultDeny(original);
        int tailCopies = countTail(original);
        try {
            writeAtomically(healed);
        } catch (IOException e) {
            return NormalizeResult.skipped("cannot rewrite " + aclFile + ": " + e.getMessage());
        }
        return NormalizeResult.healed(grantsBelowDeny, tailCopies);
    }

    /** One device that MUST have an in-region grant (from the DB source of truth). */
    record DeviceGrant(UUID tenantId, UUID siteId, UUID deviceId) {}

    /** Outcome of a startup {@link #regenerateGrants(Collection)}. */
    record RegenerateResult(NormalizeResult.Status status, int authoritative, int restoredFromTruth,
            int grantsMovedAboveDeny, int tailCopies, String detail) {

        static RegenerateResult skipped(String detail) {
            return new RegenerateResult(NormalizeResult.Status.SKIPPED, 0, 0, 0, 0, detail);
        }

        boolean skipped() {
            return status == NormalizeResult.Status.SKIPPED;
        }

        boolean changed() {
            return status == NormalizeResult.Status.HEALED;
        }
    }

    /**
     * Rebuild the generated-grant region from the AUTHORITATIVE device list (the
     * DB source of truth), meant to run once at api startup. For EVERY given
     * device an correct in-region grant is emitted, so a grant that a prior buggy
     * rebuild DROPPED from the file is RESTORED - not merely reordered (you cannot
     * reload a grant that is not in the file; the 2026-07-08 residual outage:
     * device {@code cdba2ee8}'s grant was entirely absent from the live acl.conf).
     * This is a superset of {@link #normalizeInPlace()}: it ALSO canonicalizes
     * (single region above a single default-deny tail, duplicate tails collapsed,
     * misordered grants moved up) and preserves any grants NOT in the list (e.g.
     * shell-provisioned via {@code tools/pki} - collected from anywhere in the
     * file). Rewrites ONLY when something changed; never throws - a file without
     * the region anchors (not one we own, or a fully-wiped file the DB alone
     * cannot reconstruct) is reported {@code SKIPPED}.
     */
    synchronized RegenerateResult regenerateGrants(Collection<DeviceGrant> authoritative) {
        List<String> original;
        try {
            original = Files.readAllLines(aclFile, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return RegenerateResult.skipped("cannot read " + aclFile + ": " + e.getMessage());
        }
        Parsed parsed;
        try {
            parsed = parse(new ArrayList<>(original));
        } catch (IllegalStateException e) {
            return RegenerateResult.skipped(e.getMessage());
        }
        int restored = 0;
        for (DeviceGrant g : authoritative) {
            List<String> desired = grantBlock(g.tenantId(), g.siteId(), g.deviceId());
            List<String> existing = parsed.blocks.get(g.deviceId().toString());
            // Missing entirely (dropped) or present but not byte-identical
            // (misformatted/stale identity) -> (re)write it from truth.
            if (!desired.equals(existing)) {
                restored++;
            }
            parsed.blocks.put(g.deviceId().toString(), desired);
        }
        List<String> rebuilt;
        try {
            rebuilt = rebuild(parsed); // throws when the region anchors are missing
        } catch (IllegalStateException e) {
            return RegenerateResult.skipped(e.getMessage());
        }
        if (rebuilt.equals(original)) {
            return new RegenerateResult(NormalizeResult.Status.UNCHANGED, authoritative.size(),
                    0, 0, 0, null);
        }
        int grantsBelowDeny = deviceBlocksBelowDefaultDeny(original);
        int tailCopies = countTail(original);
        try {
            writeAtomically(rebuilt);
        } catch (IOException e) {
            return RegenerateResult.skipped("cannot rewrite " + aclFile + ": " + e.getMessage());
        }
        return new RegenerateResult(NormalizeResult.Status.HEALED, authoritative.size(), restored,
                grantsBelowDeny, tailCopies, null);
    }

    /** How many device grant blocks open BELOW the first default-deny (unreachable). */
    private static int deviceBlocksBelowDefaultDeny(List<String> lines) {
        int deny = -1;
        for (int i = 0; i < lines.size(); i++) {
            if (isDefaultDenyLine(lines.get(i))) {
                deny = i;
                break;
            }
        }
        if (deny < 0) {
            return 0;
        }
        int count = 0;
        for (int i = deny + 1; i < lines.size(); i++) {
            if (lines.get(i).startsWith("%%<<device ")) {
                count++;
            }
        }
        return count;
    }

    /** Number of terminal {@code {allow, all}.} lines (a healthy file has exactly one). */
    private static int countTail(List<String> lines) {
        int n = 0;
        for (String line : lines) {
            if (line.trim().equals(ALLOW_ALL)) {
                n++;
            }
        }
        return n;
    }

    /**
     * Removes a device's grant block (the unclaim counterpart: an ungranted
     * device_id falls into the ACL's default-deny). No-op when absent. Still
     * canonicalizes the file, so an unclaim also self-heals prior corruption.
     */
    synchronized void removeGrant(UUID deviceId) {
        try {
            List<String> lines = new ArrayList<>(Files.readAllLines(aclFile, StandardCharsets.UTF_8));
            Parsed parsed = parse(lines);
            parsed.blocks.remove(deviceId.toString());
            writeAtomically(rebuild(parsed));
        } catch (IOException e) {
            throw new IllegalStateException("cannot remove ACL grant for device " + deviceId
                    + " from " + aclFile + ": " + e.getMessage(), e);
        }
    }

    /**
     * The per-device grant template. MUST stay byte-identical to
     * {@code write_acl_grant} in {@code tools/pki/voltpilot-ca.sh} (the shell
     * twin); both sides pin the same fixed vector in their tests
     * ({@code AclGrantWriterTest} / {@code tools/pki/test-acl-grants.sh}).
     * The two v2 wildcard lines are the E1a/D-2 decision
     * (docs/contracts/v2/mqtt-schedule-2.0.md §1): ONE {@code v2/#} subtree
     * per device covers every current and future v2 topic (plan, entities,
     * telemetry, flows, prices), so this template never changes again for a
     * new v2 topic kind. The security property is unchanged - a device may
     * only touch its own subtree.
     */
    private static List<String> grantBlock(UUID tenantId, UUID siteId, UUID deviceId) {
        String base = "ems/" + tenantId + "/" + siteId + "/" + deviceId;
        return List.of(
                "%%<<device " + deviceId + " tenant " + tenantId + " site " + siteId + ">>",
                "{allow, {username, \"" + deviceId + "\"}, publish,   [\"" + base
                        + "/telemetry\", \"" + base + "/status\"]}.",
                "{allow, {username, \"" + deviceId + "\"}, subscribe, [\"" + base
                        + "/schedule\", \"" + base + "/command\", \"" + base + "/config\"]}.",
                "{allow, {username, \"" + deviceId + "\"}, publish,   [\"" + base + "/v2/#\"]}.",
                "{allow, {username, \"" + deviceId + "\"}, subscribe, [\"" + base + "/v2/#\"]}.",
                "%%<<end device " + deviceId + ">>");
    }

    /** The file split into its non-device "skeleton" and the device grant blocks (ordered). */
    private record Parsed(List<String> skeleton, LinkedHashMap<String, List<String>> blocks) {}

    /**
     * Splits the file into the ordered device grant blocks (keyed by device id,
     * last occurrence wins on a corrupt duplicate) and the skeleton - every
     * other line, INCLUDING the region anchors and the tail, in order and
     * verbatim. Device blocks may appear anywhere (inside the region, or - the
     * corruption we heal - after the default-deny tail); all are collected.
     */
    private static Parsed parse(List<String> lines) {
        LinkedHashMap<String, List<String>> blocks = new LinkedHashMap<>();
        List<String> skeleton = new ArrayList<>(lines.size());
        String openId = null;
        List<String> current = null;
        for (String line : lines) {
            if (openId != null) {
                current.add(line);
                if (line.startsWith("%%<<end device " + openId + ">>")) {
                    blocks.put(openId, current);
                    openId = null;
                    current = null;
                }
                continue;
            }
            Matcher m = DEVICE_BEGIN.matcher(line);
            if (m.find()) {
                openId = m.group(1);
                current = new ArrayList<>();
                current.add(line);
                continue;
            }
            // Drop stray, unpaired device-block debris; keep everything else.
            if (line.startsWith("%%<<end device ")) {
                continue;
            }
            skeleton.add(line);
        }
        if (openId != null) {
            // Unterminated block (truncated corruption): keep what we captured.
            blocks.put(openId, current);
        }
        return new Parsed(skeleton, blocks);
    }

    /**
     * Re-emits the file canonically: preamble up to and including the FIRST
     * {@link #BEGIN_ANCHOR}, then every device grant, then the FIRST
     * {@link #END_ANCHOR}, then a single collapsed tail. Any further anchors and
     * any duplicated tail below the first {@code {allow, all}.} are dropped, so
     * all grants end up ABOVE the default-deny and the structure is idempotent.
     */
    private List<String> rebuild(Parsed parsed) {
        List<String> skeleton = parsed.skeleton;
        int begin = indexOfContaining(skeleton, BEGIN_ANCHOR, 0);
        int end = begin < 0 ? -1 : indexOfContaining(skeleton, END_ANCHOR, begin + 1);
        if (begin < 0 || end < 0) {
            throw new IllegalStateException("ACL region anchors '" + BEGIN_ANCHOR + "' / '"
                    + END_ANCHOR + "' missing in " + aclFile);
        }

        List<String> out = new ArrayList<>(skeleton.subList(0, begin + 1)); // preamble + BEGIN
        for (List<String> block : parsed.blocks.values()) {
            out.addAll(block);
        }
        out.add(skeleton.get(end)); // exact END line text

        List<String> rest = new ArrayList<>(skeleton.subList(end + 1, skeleton.size()));
        rest.removeIf(l -> l.contains(BEGIN_ANCHOR) || l.contains(END_ANCHOR)); // duplicate anchors
        out.addAll(collapseTail(rest));
        return out;
    }

    /**
     * Collapses a possibly-duplicated tail to a single one: keep everything up
     * to and including the first {@code {allow, all}.} (the ACL's terminal
     * line) and drop the rest. If there is no terminal allow-all (a customized
     * ACL), fall back to removing repeated default-deny lines, keeping the first.
     */
    private static List<String> collapseTail(List<String> rest) {
        for (int i = 0; i < rest.size(); i++) {
            if (rest.get(i).trim().equals(ALLOW_ALL)) {
                return new ArrayList<>(rest.subList(0, i + 1));
            }
        }
        List<String> deduped = new ArrayList<>(rest.size());
        boolean seenDeny = false;
        for (String line : rest) {
            if (isDefaultDenyLine(line)) {
                if (seenDeny) {
                    continue;
                }
                seenDeny = true;
            }
            deduped.add(line);
        }
        return deduped;
    }

    private static boolean isDefaultDenyLine(String line) {
        return line.trim().startsWith("{deny, {username, {re,");
    }

    private static int indexOfContaining(List<String> lines, String needle, int from) {
        for (int i = Math.max(0, from); i < lines.size(); i++) {
            if (lines.get(i).contains(needle)) {
                return i;
            }
        }
        return -1;
    }

    private void writeAtomically(List<String> lines) throws IOException {
        Path tmp = Files.createTempFile(aclFile.toAbsolutePath().getParent(), "acl", ".tmp");
        try {
            Files.write(tmp, lines, StandardCharsets.UTF_8);
            ensureBrokerReadable(tmp);
            try {
                atomicMove(tmp, aclFile);
            } catch (FileSystemException e) {
                // rename() refused - the classic cause is the target being a
                // mountpoint (single-file bind mount -> EBUSY). Degrade to the
                // in-place rewrite: non-atomic, but on a single-file mount it
                // is the only write the broker's view of the file ever sees.
                log.warn("Atomic replace of {} failed ({}) - falling back to a non-atomic "
                        + "in-place rewrite. Mount the ACL file's directory into this "
                        + "container instead of the file itself (see docker-compose.prod.yml).",
                        aclFile, e.getMessage());
                writeInPlace(lines);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    /** Seam for tests: the rename that cannot be provoked to fail without a mountpoint. */
    void atomicMove(Path tmp, Path target) throws IOException {
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
    }

    /**
     * Truncate-and-rewrite the ACL file through its existing inode, fsynced.
     * NOT atomic - a concurrent reader can observe a truncated file - but it
     * propagates through a single-file bind mount, which pins that inode.
     */
    private void writeInPlace(List<String> lines) throws IOException {
        byte[] content = (String.join(System.lineSeparator(), lines) + System.lineSeparator())
                .getBytes(StandardCharsets.UTF_8);
        try (FileChannel channel = FileChannel.open(aclFile, StandardOpenOption.WRITE,
                StandardOpenOption.TRUNCATE_EXISTING)) {
            ByteBuffer buffer = ByteBuffer.wrap(content);
            while (buffer.hasRemaining()) {
                channel.write(buffer);
            }
            channel.force(true);
        }
        // The rewrite inherits the existing file's mode, which a prior 0600
        // rename may have left broker-unreadable - restore it here too.
        ensureBrokerReadable(aclFile);
    }

    /** Forces {@link #ACL_FILE_PERMISSIONS}; no-op on non-POSIX filesystems. */
    private static void ensureBrokerReadable(Path file) throws IOException {
        try {
            Files.setPosixFilePermissions(file, ACL_FILE_PERMISSIONS);
        } catch (UnsupportedOperationException e) {
            // non-POSIX filesystem (tests may run anywhere; prod is Linux)
        }
    }
}
