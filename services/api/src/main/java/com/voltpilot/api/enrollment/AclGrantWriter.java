package com.voltpilot.api.enrollment;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Writes the per-device EMQX ACL grant on certificate issuance - the Java twin
 * of {@code write_acl_grant} in {@code tools/pki/voltpilot-ca.sh}, producing
 * byte-identical blocks in the same generated region of the ACL file, so the
 * shell tool's {@code revoke} (which removes the block) keeps working over
 * api-written grants and vice versa.
 *
 * <p>Each device owns a marked block inserted just above the
 * {@code %%<<END GENERATED DEVICE GRANTS>>} anchor (grants stay grouped above
 * the catch-all deny rules); re-issuing replaces the device's existing block
 * (idempotent). The rewrite is atomic (temp file + move) so the broker never
 * reads a half-written file. The broker applies changes on its next authz
 * reload ({@code emqx ctl conf reload} - see docs/deploy.md).
 */
class AclGrantWriter {

    static final String END_ANCHOR = "%%<<END GENERATED DEVICE GRANTS>>";

    private final Path aclFile;

    AclGrantWriter(Path aclFile) {
        this.aclFile = aclFile;
    }

    void writeGrant(UUID tenantId, UUID siteId, UUID deviceId) {
        try {
            List<String> lines = new ArrayList<>(Files.readAllLines(aclFile, StandardCharsets.UTF_8));
            removeBlock(lines, deviceId);
            int anchor = indexOfAnchor(lines);
            lines.addAll(anchor, grantBlock(tenantId, siteId, deviceId));
            writeAtomically(lines);
        } catch (IOException e) {
            throw new IllegalStateException("cannot write ACL grant for device " + deviceId
                    + " to " + aclFile + ": " + e.getMessage(), e);
        }
    }

    /**
     * Removes a device's grant block (the unclaim counterpart: an ungranted
     * device_id falls into the ACL's default-deny). No-op when absent.
     */
    void removeGrant(UUID deviceId) {
        try {
            List<String> lines = new ArrayList<>(Files.readAllLines(aclFile, StandardCharsets.UTF_8));
            removeBlock(lines, deviceId);
            writeAtomically(lines);
        } catch (IOException e) {
            throw new IllegalStateException("cannot remove ACL grant for device " + deviceId
                    + " from " + aclFile + ": " + e.getMessage(), e);
        }
    }

    private static List<String> grantBlock(UUID tenantId, UUID siteId, UUID deviceId) {
        String base = "ems/" + tenantId + "/" + siteId + "/" + deviceId;
        return List.of(
                "%%<<device " + deviceId + " tenant " + tenantId + " site " + siteId + ">>",
                "{allow, {username, \"" + deviceId + "\"}, publish,   [\"" + base
                        + "/telemetry\", \"" + base + "/status\"]}.",
                "{allow, {username, \"" + deviceId + "\"}, subscribe, [\"" + base
                        + "/schedule\", \"" + base + "/command\", \"" + base + "/config\"]}.",
                "%%<<end device " + deviceId + ">>");
    }

    private static void removeBlock(List<String> lines, UUID deviceId) {
        String begin = "%%<<device " + deviceId + " ";
        String end = "%%<<end device " + deviceId + ">>";
        List<String> kept = new ArrayList<>(lines.size());
        boolean skipping = false;
        for (String line : lines) {
            if (!skipping && line.startsWith(begin)) {
                skipping = true;
                continue;
            }
            if (skipping) {
                if (line.startsWith(end)) {
                    skipping = false;
                }
                continue;
            }
            kept.add(line);
        }
        lines.clear();
        lines.addAll(kept);
    }

    private int indexOfAnchor(List<String> lines) {
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i).contains(END_ANCHOR)) {
                return i;
            }
        }
        throw new IllegalStateException("ACL anchor '" + END_ANCHOR + "' missing in " + aclFile);
    }

    private void writeAtomically(List<String> lines) throws IOException {
        Path tmp = Files.createTempFile(aclFile.toAbsolutePath().getParent(), "acl", ".tmp");
        Files.write(tmp, lines, StandardCharsets.UTF_8);
        Files.move(tmp, aclFile, StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
    }
}
