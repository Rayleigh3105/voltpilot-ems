package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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

    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
            count++;
        }
        return count;
    }
}
