package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * vp-werkstatt-zubehoer-download: die Zubehör-Dateien im Jar sind genau die eingecheckten unter
 * {@code edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/} - keine Kopie, die auseinanderlaufen
 * könnte. Prüft Byte- UND Prüfsummen-Gleichheit gegen {@code druck/SHA256SUMS}: Die Regel aus
 * {@code druck/README.md} ("ein geändertes Teil gilt bis zum nächsten Druck als unbestätigt")
 * setzt voraus, dass diese Datei die tatsächliche 3MF nie unbemerkt verfehlt.
 */
class WerkstattZubehoerDateiTest {

    private static final Path DRUCK = Path.of("../../edge-light/gehaeuse/glinet-gl-mt300n-v2/druck");
    private static final Pattern SHA256SUMS_ZEILE = Pattern.compile("^([0-9a-f]{64})\\s+\\*?(.+)$");

    @Test
    void packagedResourceIsExactlyTheCanonicalFileAndMatchesChecksumsFile() throws Exception {
        Map<String, String> checksums = sha256sums();
        for (WerkstattZubehoerDatei.Teil teil : WerkstattZubehoerDatei.Teil.values()) {
            WerkstattZubehoerDatei.Datei datei = WerkstattZubehoerDatei.lies(teil);
            byte[] kanonisch = Files.readAllBytes(DRUCK.resolve(datei.name()));
            assertThat(datei.daten()).as(datei.name()).isEqualTo(kanonisch);
            assertThat(datei.sha256()).as(datei.name()).isEqualTo(sha256(kanonisch));
            assertThat(checksums).as("SHA256SUMS kennt " + datei.name()).containsEntry(datei.name(), datei.sha256());
        }
    }

    private static String sha256(byte[] daten) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(daten));
    }

    /** {@code sha256sum -c}-Format: "<hex>  <name>". */
    private static Map<String, String> sha256sums() throws Exception {
        Map<String, String> aus = new LinkedHashMap<>();
        for (String zeile : Files.readAllLines(DRUCK.resolve("SHA256SUMS"))) {
            if (zeile.isBlank()) {
                continue;
            }
            Matcher m = SHA256SUMS_ZEILE.matcher(zeile.trim());
            if (m.matches()) {
                aus.put(m.group(2).trim(), m.group(1));
            }
        }
        return aus;
    }
}
