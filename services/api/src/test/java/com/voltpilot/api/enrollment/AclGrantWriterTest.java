package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Pure unit proof that the Java grant writer produces exactly the blocks
 * {@code tools/pki/voltpilot-ca.sh write_acl_grant} produces, in the same
 * generated region - so shell- and api-managed grants interoperate.
 */
class AclGrantWriterTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    @TempDir
    Path dir;

    private Path aclFile;
    private AclGrantWriter writer;

    @BeforeEach
    void setUp() throws Exception {
        aclFile = dir.resolve("acl.conf");
        Files.writeString(aclFile, """
                {allow, {username, "vp-internal"}, all, ["#"]}.
                %%<<BEGIN GENERATED DEVICE GRANTS>>
                %%<<END GENERATED DEVICE GRANTS>>
                {deny, all, subscribe, ["$SYS/#"]}.
                {allow, all}.
                """, StandardCharsets.UTF_8);
        writer = new AclGrantWriter(aclFile);
        originalInode = Files.getAttribute(aclFile, "unix:ino");
    }

    @Test
    void writesTheExactShellToolGrantBlockAboveTheEndAnchor() throws Exception {
        writer.writeGrant(TENANT, SITE, DEVICE);

        String content = Files.readString(aclFile);
        // Byte-identical block shape to voltpilot-ca.sh write_acl_grant. The
        // SAME fixed vector (tenant ...0001 / site ...0002 / device ...0003)
        // is pinned shell-side in tools/pki/test-acl-grants.sh - change both
        // together (the EdgeRef shared-vector discipline).
        assertThat(content).contains(block(DEVICE) + "%%<<END GENERATED DEVICE GRANTS>>");
        // The surrounding policy is untouched.
        assertThat(content).contains("vp-internal").contains("{allow, all}.");
    }

    @Test
    void reWritingADeviceReplacesItsBlockInsteadOfDuplicating() throws Exception {
        writer.writeGrant(TENANT, SITE, DEVICE);
        writer.writeGrant(TENANT, SITE, DEVICE);
        UUID other = UUID.randomUUID();
        writer.writeGrant(TENANT, SITE, other);

        String content = Files.readString(aclFile);
        assertThat(countOccurrences(content, "%%<<device " + DEVICE + " ")).isEqualTo(1);
        assertThat(countOccurrences(content, "%%<<device " + other + " ")).isEqualTo(1);
    }

    @Test
    void removeGrantDropsTheBlockAndIsIdempotent() throws Exception {
        writer.writeGrant(TENANT, SITE, DEVICE);
        writer.removeGrant(DEVICE);
        writer.removeGrant(DEVICE);

        String content = Files.readString(aclFile);
        assertThat(content).doesNotContain(DEVICE.toString());
        assertThat(content).contains("%%<<END GENERATED DEVICE GRANTS>>");
    }

    @Test
    void refusesAFileWithoutTheGeneratedRegionAnchor() throws Exception {
        Path noAnchor = dir.resolve("broken.conf");
        Files.writeString(noAnchor, "{allow, all}.\n");
        assertThatThrownBy(() -> new AclGrantWriter(noAnchor).writeGrant(TENANT, SITE, DEVICE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("anchor");
    }

    /**
     * Regression for the prod EBUSY failure: with the ACL file bind-mounted as
     * a SINGLE FILE into the container, rename(tmp -> target) fails with
     * {@code FileSystemException} ("Device or resource busy") because the
     * target is a mountpoint. A mountpoint cannot be fabricated in a unit
     * test, so the rename seam is forced to fail the way the kernel does; the
     * writer must fall back to the in-place rewrite instead of failing the
     * whole certificate issuance.
     */
    @Test
    void fallsBackToInPlaceRewriteWhenTheAtomicRenameIsRefused() throws Exception {
        AclGrantWriter mounted = writerWithRefusedRename();
        mounted.writeGrant(TENANT, SITE, DEVICE);

        Object inodeAfter = Files.getAttribute(aclFile, "unix:ino");
        String content = Files.readString(aclFile);
        assertThat(content).contains("%%<<device " + DEVICE + " tenant " + TENANT + " site " + SITE + ">>");
        // In-place: the write went through the ORIGINAL inode - on a single-file
        // bind mount that is the only write the broker's view ever sees.
        assertThat(inodeAfter).isEqualTo(originalInode);
        // The temp file of the failed rename does not leak into the ACL dir.
        try (var files = Files.list(dir)) {
            assertThat(files.filter(p -> p.getFileName().toString().endsWith(".tmp"))).isEmpty();
        }
    }

    @Test
    void fallbackRewriteProducesTheSameContentAsTheRenamePath() throws Exception {
        writer.writeGrant(TENANT, SITE, DEVICE);
        String renamed = Files.readString(aclFile);

        setUp(); // fresh base file
        AclGrantWriter mounted = writerWithRefusedRename();
        mounted.writeGrant(TENANT, SITE, DEVICE);
        assertThat(Files.readString(aclFile)).isEqualTo(renamed);

        mounted.removeGrant(DEVICE);
        assertThat(Files.readString(aclFile)).doesNotContain(DEVICE.toString());
    }

    /**
     * Regression for the prod boot-loop after PR #32: {@code createTempFile}
     * creates the temp file 0600 and the atomic rename carries that mode onto
     * acl.conf, so the broker (a DIFFERENT non-root uid on a read-only mount)
     * fails boot-time config validation on its next restart
     * ("failed_to_read_acl_file: Permission denied").
     */
    @Test
    void grantWriteLeavesTheFileReadableForTheBrokerUser() throws Exception {
        assumeTrue(posixFileSystem());
        writer.writeGrant(TENANT, SITE, DEVICE);
        assertThat(Files.getPosixFilePermissions(aclFile))
                .contains(PosixFilePermission.GROUP_READ, PosixFilePermission.OTHERS_READ);
    }

    @Test
    void fallbackInPlaceWriteRestoresBrokerReadability() throws Exception {
        assumeTrue(posixFileSystem());
        // The in-place rewrite inherits the existing file's mode; a prior 0600
        // rename may have left it broker-unreadable, so it must be restored.
        Files.setPosixFilePermissions(aclFile, PosixFilePermissions.fromString("rw-------"));
        AclGrantWriter mounted = writerWithRefusedRename();
        mounted.writeGrant(TENANT, SITE, DEVICE);
        assertThat(Files.getPosixFilePermissions(aclFile))
                .contains(PosixFilePermission.GROUP_READ, PosixFilePermission.OTHERS_READ);
    }

    private boolean posixFileSystem() {
        return aclFile.getFileSystem().supportedFileAttributeViews().contains("posix");
    }

    @Test
    void normalPathStaysAtomicByReplacingTheFile() throws Exception {
        writer.writeGrant(TENANT, SITE, DEVICE);
        // The rename path swaps in the temp file: a new inode replaces the old
        // one - the property that makes a half-written broker read impossible.
        assertThat(Files.getAttribute(aclFile, "unix:ino")).isNotEqualTo(originalInode);
    }

    // ---- Self-healing / grant-ordering regression (prod-down 2026-07-08) -----

    /**
     * The real ACL tail: a first-match default-deny for every UUID (device)
     * username, then {@code {allow, all}}. A device grant is only reachable if
     * it sits ABOVE this deny.
     */
    private static final String DEFAULT_DENY =
            "{deny, {username, {re, \"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
            + "-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$\"}}, all, [\"#\"]}.";

    /** A well-formed base ACL with the real default-deny tail. */
    private void writeBaseWithRealTail() throws Exception {
        Files.writeString(aclFile, ""
                + "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%% --- Per-device grants (GENERATED - do not hand-edit). ---\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n"
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + "%% --- Default-deny for devices. ---\n"
                + DEFAULT_DENY + "\n"
                + "{deny, all, subscribe, [\"$SYS/#\"]}.\n"
                + "{allow, all}.\n", StandardCharsets.UTF_8);
    }

    @Test
    void everyDeviceGrantLandsAboveTheDefaultDeny() throws Exception {
        writeBaseWithRealTail();
        UUID a = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000001");
        UUID b = UUID.fromString("bbbbbbbb-0000-0000-0000-000000000002");
        writer.writeGrant(TENANT, SITE, a);
        writer.writeGrant(TENANT, SITE, b);

        List<String> lines = Files.readAllLines(aclFile);
        int deny = indexOf(lines, DEFAULT_DENY);
        assertThat(deny).isGreaterThan(0);
        // Both devices' allow rules precede the catch-all deny -> reachable.
        assertThat(lastAllowLineFor(lines, a)).isLessThan(deny);
        assertThat(lastAllowLineFor(lines, b)).isLessThan(deny);
        // Exactly one region and one tail: no duplication.
        assertThat(countOccurrences(Files.readString(aclFile), "%%<<END GENERATED DEVICE GRANTS>>"))
                .isEqualTo(1);
        assertThat(countOccurrences(Files.readString(aclFile), "%%<<BEGIN GENERATED DEVICE GRANTS>>"))
                .isEqualTo(1);
        assertThat(countOccurrences(Files.readString(aclFile), DEFAULT_DENY)).isEqualTo(1);
        assertThat(countLines(lines, "{allow, all}.")).isEqualTo(1);
    }

    /**
     * The exact prod-down shape (captain's VM, 2026-07-08): the seed device's
     * grant sits correctly inside the region, but a later claim's grant was
     * written AFTER the default-deny + {@code {allow, all}} (so it is
     * unreachable and the device is kicked off the broker), and the whole
     * template tail is DUPLICATED. The next grant write must normalize it.
     */
    @Test
    void selfHealsAGrantWrittenBelowTheDenyWithADuplicatedTail() throws Exception {
        UUID seed = UUID.fromString("00000000-0000-0000-0000-000000000003");
        UUID broken = UUID.fromString("cdba2ee8-0000-0000-0000-000000000009");
        String seedBlock = block(seed);
        String brokenBlock = block(broken);
        String tail = "%% --- Default-deny for devices. ---\n"
                + DEFAULT_DENY + "\n"
                + "{deny, all, subscribe, [\"$SYS/#\"]}.\n"
                + "{allow, all}.\n";

        // grant below the deny + duplicated tail, exactly like the incident.
        Files.writeString(aclFile, ""
                + "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n"
                + seedBlock
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail
                + brokenBlock            // <-- unreachable: below the deny
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail,                  // <-- duplicated template tail
                StandardCharsets.UTF_8);

        // Any subsequent write self-heals: re-claim the broken device.
        writer.writeGrant(TENANT, SITE, broken);

        List<String> lines = Files.readAllLines(aclFile);
        String content = Files.readString(aclFile);
        int deny = indexOf(lines, DEFAULT_DENY);
        // Both grants now reachable, above the single default-deny.
        assertThat(lastAllowLineFor(lines, seed)).isLessThan(deny);
        assertThat(lastAllowLineFor(lines, broken)).isLessThan(deny);
        // No duplication left anywhere.
        assertThat(countOccurrences(content, "%%<<device " + broken + " ")).isEqualTo(1);
        assertThat(countOccurrences(content, "%%<<device " + seed + " ")).isEqualTo(1);
        assertThat(countOccurrences(content, "%%<<BEGIN GENERATED DEVICE GRANTS>>")).isEqualTo(1);
        assertThat(countOccurrences(content, "%%<<END GENERATED DEVICE GRANTS>>")).isEqualTo(1);
        assertThat(countOccurrences(content, DEFAULT_DENY)).isEqualTo(1);
        assertThat(countLines(lines, "{allow, all}.")).isEqualTo(1);
    }

    @Test
    void normalizingAnAlreadyCleanFileIsIdempotent() throws Exception {
        writeBaseWithRealTail();
        UUID a = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000001");
        UUID b = UUID.fromString("bbbbbbbb-0000-0000-0000-000000000002");
        writer.writeGrant(TENANT, SITE, a);
        writer.writeGrant(TENANT, SITE, b);
        String once = Files.readString(aclFile);

        // Re-writing an existing device rewrites the file to byte-identical.
        writer.writeGrant(TENANT, SITE, a);
        assertThat(Files.readString(aclFile)).isEqualTo(once);
    }

    /**
     * Documented EMQX first-match reasoning (the broker itself is not run here;
     * {@code verify_mqtt_security.py} exercises the live authorizer): EMQX
     * evaluates rules top-down and stops at the first match. After healing, a
     * granted device's own allow rule appears strictly BEFORE the UUID
     * catch-all deny, so it matches ALLOW first; an ungranted UUID has no allow
     * rule and falls straight to the deny. The ordering assertions below are
     * exactly the property that makes that outcome hold.
     */
    @Test
    void healedOrderingAllowsGrantedDeviceAndDeniesUngrantedUuid() throws Exception {
        writeBaseWithRealTail();
        UUID granted = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000001");
        UUID ungranted = UUID.fromString("ffffffff-0000-0000-0000-00000000000f");
        writer.writeGrant(TENANT, SITE, granted);

        List<String> lines = Files.readAllLines(aclFile);
        int deny = indexOf(lines, DEFAULT_DENY);
        // granted: an allow rule exists ABOVE the deny -> first match is ALLOW.
        assertThat(lastAllowLineFor(lines, granted)).isLessThan(deny);
        // ungranted: no allow rule anywhere -> first (and only) match is DENY.
        assertThat(lastAllowLineFor(lines, ungranted)).isEqualTo(-1);
    }

    // ---- Startup self-heal: a deploy repairs a broken acl.conf, no re-claim ---

    @Test
    void normalizeInPlaceHealsTheIncidentShapeAndReportsWhatItFixed() throws Exception {
        UUID seed = UUID.fromString("00000000-0000-0000-0000-000000000003");
        UUID broken = UUID.fromString("cdba2ee8-0000-0000-0000-000000000009");
        String tail = "%% --- Default-deny for devices. ---\n"
                + DEFAULT_DENY + "\n"
                + "{deny, all, subscribe, [\"$SYS/#\"]}.\n"
                + "{allow, all}.\n";
        Files.writeString(aclFile, ""
                + "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n"
                + block(seed)
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail
                + block(broken)          // below the deny -> unreachable
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + tail,                  // duplicated tail
                StandardCharsets.UTF_8);

        AclGrantWriter.NormalizeResult result = writer.normalizeInPlace();

        assertThat(result.healed()).isTrue();
        assertThat(result.grantsMovedAboveDeny()).isEqualTo(1); // the cdba block
        assertThat(result.tailCopies()).isEqualTo(2);           // collapsed to one

        List<String> lines = Files.readAllLines(aclFile);
        int deny = indexOf(lines, DEFAULT_DENY);
        assertThat(lastAllowLineFor(lines, broken)).isLessThan(deny);
        assertThat(lastAllowLineFor(lines, seed)).isLessThan(deny);
        assertThat(countLines(lines, "{allow, all}.")).isEqualTo(1);
        assertThat(countOccurrences(Files.readString(aclFile), "%%<<END GENERATED DEVICE GRANTS>>"))
                .isEqualTo(1);
    }

    @Test
    void normalizeInPlaceLeavesAHealthyFileByteUnchangedAndDoesNotRewrite() throws Exception {
        writeBaseWithRealTail();
        writer.writeGrant(TENANT, SITE, UUID.fromString("aaaaaaaa-0000-0000-0000-000000000001"));
        String before = Files.readString(aclFile);
        Object inodeBefore = Files.getAttribute(aclFile, "unix:ino");

        AclGrantWriter.NormalizeResult result = writer.normalizeInPlace();

        assertThat(result.healed()).isFalse();
        assertThat(result.skipped()).isFalse(); // UNCHANGED
        assertThat(Files.readString(aclFile)).isEqualTo(before);
        // No rewrite at all -> the atomic rename never ran, inode is the same.
        assertThat(Files.getAttribute(aclFile, "unix:ino")).isEqualTo(inodeBefore);
    }

    @Test
    void normalizeInPlaceOfTheCommittedAclFileIsANoOp() throws Exception {
        // Regression guard: the checked-in prod base is already canonical, so a
        // startup self-heal over it must never rewrite (no reload noise).
        Path committed = Path.of("../../infra/mqtt/acl/acl.conf");
        assumeTrue(Files.exists(committed));
        Path copy = dir.resolve("committed.conf");
        Files.copy(committed, copy);
        AclGrantWriter.NormalizeResult result = new AclGrantWriter(copy).normalizeInPlace();
        assertThat(result.healed()).isFalse();
        assertThat(result.skipped()).isFalse();
        assertThat(Files.readString(copy)).isEqualTo(Files.readString(committed));
    }

    @Test
    void normalizeInPlaceSkipsAFileWithoutTheGeneratedRegion() throws Exception {
        Path noAnchor = dir.resolve("plain.conf");
        Files.writeString(noAnchor, "{allow, all}.\n");
        AclGrantWriter.NormalizeResult result = new AclGrantWriter(noAnchor).normalizeInPlace();
        assertThat(result.skipped()).isTrue();
        assertThat(result.detail()).contains("anchor");
        assertThat(Files.readString(noAnchor)).isEqualTo("{allow, all}.\n"); // untouched
    }

    // --- regenerateGrants: rebuild the region from the DB source of truth -------

    @Test
    void regenerateGrantsRestoresAGrantThatIsEntirelyMissingFromTheFile() throws Exception {
        // The captain's live-VM shape (2026-07-08): structure intact, the device
        // grant ENTIRELY ABSENT - a prior buggy rebuild dropped it. Reorder-only
        // can't help; the grant must be regenerated from what the api KNOWS.
        writeBaseWithRealTail();
        UUID device = UUID.fromString("cdba2ee8-0000-0000-0000-000000000003");
        assertThat(Files.readString(aclFile)).doesNotContain(device.toString());

        AclGrantWriter.RegenerateResult result = writer.regenerateGrants(
                List.of(new AclGrantWriter.DeviceGrant(TENANT, SITE, device)));

        assertThat(result.changed()).isTrue();
        assertThat(result.restoredFromTruth()).isEqualTo(1);
        List<String> lines = Files.readAllLines(aclFile);
        assertThat(lastAllowLineFor(lines, device))
                .as("restored grant sits above the default-deny (reachable)")
                .isGreaterThanOrEqualTo(0).isLessThan(indexOf(lines, DEFAULT_DENY));
    }

    @Test
    void regenerateGrantsNeverDropsAGrantSittingAfterASecondEndMarkerInADuplicatedTail()
            throws Exception {
        // The malformed shape the amendment calls out: a device grant sitting
        // AFTER a SECOND END marker in a duplicated tail. The collect-from-
        // anywhere parse must PRESERVE it (and the DB list must restore it even if
        // it didn't) - never silently drop it, the root cause of the outage.
        UUID seed = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000001");
        UUID stray = UUID.fromString("cdba2ee8-0000-0000-0000-000000000003");
        Files.writeString(aclFile, ""
                + "{allow, {username, \"vp-internal\"}, all, [\"#\"]}.\n"
                + "%%<<BEGIN GENERATED DEVICE GRANTS>>\n"
                + block(seed)
                + "%%<<END GENERATED DEVICE GRANTS>>\n"
                + DEFAULT_DENY + "\n"
                + "{allow, all}.\n"
                + "%%<<END GENERATED DEVICE GRANTS>>\n"   // duplicated end marker
                + block(stray)                             // grant after the 2nd END
                + DEFAULT_DENY + "\n"
                + "{allow, all}.\n", StandardCharsets.UTF_8);

        // Regenerate from truth listing BOTH devices -> both end up in-region.
        AclGrantWriter.RegenerateResult result = writer.regenerateGrants(List.of(
                new AclGrantWriter.DeviceGrant(TENANT, SITE, seed),
                new AclGrantWriter.DeviceGrant(TENANT, SITE, stray)));

        assertThat(result.changed()).isTrue();
        List<String> lines = Files.readAllLines(aclFile);
        int deny = indexOf(lines, DEFAULT_DENY);
        assertThat(lastAllowLineFor(lines, seed)).as("seed preserved above deny")
                .isGreaterThanOrEqualTo(0).isLessThan(deny);
        assertThat(lastAllowLineFor(lines, stray)).as("the after-2nd-END grant is NOT dropped")
                .isGreaterThanOrEqualTo(0).isLessThan(deny);
        assertThat(countLines(lines, "{allow, all}.")).as("single tail").isEqualTo(1);
    }

    @Test
    void regenerateGrantsPreservesShellProvisionedGrantsNotInTheDbList() throws Exception {
        // A grant written out of band (tools/pki) is in-region but NOT in the DB
        // list; regenerating from truth must keep it (union, never a truth-only
        // replace that would revoke shell-provisioned devices).
        writeBaseWithRealTail();
        UUID shell = UUID.fromString("bbbbbbbb-0000-0000-0000-000000000002");
        writer.writeGrant(TENANT, SITE, shell);
        UUID db = UUID.fromString("cdba2ee8-0000-0000-0000-000000000003");

        writer.regenerateGrants(List.of(new AclGrantWriter.DeviceGrant(TENANT, SITE, db)));

        List<String> lines = Files.readAllLines(aclFile);
        int deny = indexOf(lines, DEFAULT_DENY);
        assertThat(lastAllowLineFor(lines, shell)).as("shell grant preserved")
                .isGreaterThanOrEqualTo(0).isLessThan(deny);
        assertThat(lastAllowLineFor(lines, db)).as("db grant present")
                .isGreaterThanOrEqualTo(0).isLessThan(deny);
    }

    @Test
    void regenerateGrantsLeavesACompleteCanonicalFileByteUnchanged() throws Exception {
        writeBaseWithRealTail();
        writer.writeGrant(TENANT, SITE, DEVICE);
        String before = Files.readString(aclFile);

        AclGrantWriter.RegenerateResult result = writer.regenerateGrants(
                List.of(new AclGrantWriter.DeviceGrant(TENANT, SITE, DEVICE)));

        assertThat(result.changed()).isFalse();
        assertThat(result.skipped()).isFalse();
        assertThat(result.restoredFromTruth()).isZero();
        assertThat(Files.readString(aclFile)).isEqualTo(before);
    }

    @Test
    void regenerateGrantsSkipsAFileWithoutTheGeneratedRegion() throws Exception {
        Path noAnchor = dir.resolve("plain.conf");
        Files.writeString(noAnchor, "{allow, all}.\n");
        AclGrantWriter.RegenerateResult result = new AclGrantWriter(noAnchor).regenerateGrants(
                List.of(new AclGrantWriter.DeviceGrant(TENANT, SITE, DEVICE)));
        assertThat(result.skipped()).isTrue();
        assertThat(Files.readString(noAnchor)).isEqualTo("{allow, all}.\n"); // untouched
    }

    private static String block(UUID device) {
        String base = "ems/" + TENANT + "/" + SITE + "/" + device;
        return "%%<<device " + device + " tenant " + TENANT + " site " + SITE + ">>\n"
                + "{allow, {username, \"" + device + "\"}, publish,   [\"" + base
                + "/telemetry\", \"" + base + "/status\"]}.\n"
                + "{allow, {username, \"" + device + "\"}, subscribe, [\"" + base
                + "/schedule\", \"" + base + "/command\", \"" + base + "/config\"]}.\n"
                + "{allow, {username, \"" + device + "\"}, publish,   [\"" + base + "/v2/#\"]}.\n"
                + "{allow, {username, \"" + device + "\"}, subscribe, [\"" + base + "/v2/#\"]}.\n"
                + "%%<<end device " + device + ">>\n";
    }

    private static int indexOf(List<String> lines, String exact) {
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i).equals(exact)) {
                return i;
            }
        }
        return -1;
    }

    /** Index of the last line that is an {@code {allow, {username, "<device>"}...}} rule, or -1. */
    private static int lastAllowLineFor(List<String> lines, UUID device) {
        String needle = "{allow, {username, \"" + device + "\"}";
        int found = -1;
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i).startsWith(needle)) {
                found = i;
            }
        }
        return found;
    }

    private static int countLines(List<String> lines, String exactTrimmed) {
        int n = 0;
        for (String line : lines) {
            if (line.trim().equals(exactTrimmed)) {
                n++;
            }
        }
        return n;
    }

    private Object originalInode;

    /** The writer as it behaves on a single-file bind mount: rename refused with EBUSY. */
    private AclGrantWriter writerWithRefusedRename() {
        return new AclGrantWriter(aclFile) {
            @Override
            void atomicMove(Path tmp, Path target) throws java.io.IOException {
                throw new java.nio.file.FileSystemException(tmp.toString(), target.toString(),
                        "Device or resource busy");
            }
        };
    }

    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
            count++;
        }
        return count;
    }
}
