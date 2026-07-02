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
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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
 * reload ({@code tools/pki/reload-broker-authz.sh} - see docs/deploy.md).
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

    static final String END_ANCHOR = "%%<<END GENERATED DEVICE GRANTS>>";

    private final Path aclFile;

    AclGrantWriter(Path aclFile) {
        this.aclFile = aclFile;
    }

    synchronized void writeGrant(UUID tenantId, UUID siteId, UUID deviceId) {
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
    synchronized void removeGrant(UUID deviceId) {
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
        try {
            Files.write(tmp, lines, StandardCharsets.UTF_8);
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
    }
}
