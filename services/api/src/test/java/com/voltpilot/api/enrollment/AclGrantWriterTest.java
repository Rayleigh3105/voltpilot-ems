package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
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

        String base = "ems/" + TENANT + "/" + SITE + "/" + DEVICE;
        String content = Files.readString(aclFile);
        // Byte-identical block shape to voltpilot-ca.sh write_acl_grant.
        assertThat(content).contains(
                "%%<<device " + DEVICE + " tenant " + TENANT + " site " + SITE + ">>\n"
                + "{allow, {username, \"" + DEVICE + "\"}, publish,   [\"" + base
                + "/telemetry\", \"" + base + "/status\"]}.\n"
                + "{allow, {username, \"" + DEVICE + "\"}, subscribe, [\"" + base
                + "/schedule\", \"" + base + "/command\", \"" + base + "/config\"]}.\n"
                + "%%<<end device " + DEVICE + ">>\n"
                + "%%<<END GENERATED DEVICE GRANTS>>");
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
