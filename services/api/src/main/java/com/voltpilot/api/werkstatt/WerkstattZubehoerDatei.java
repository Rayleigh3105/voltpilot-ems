package com.voltpilot.api.werkstatt;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

/**
 * Die Zubehör-Druckdateien der Werkstatt-Box (vp-werkstatt-zubehoer-download): Hutschienen-Clip
 * und Bohrlehre, ohne Kennung und für jede Box gleich - anders als die Box-Druckdatei des
 * Gehäuses (mit Referenz und QR-Code, {@link WerkstattGehaeuseRepository}). Die Regel „nie eine
 * allgemeine Gehäuse-Datei ohne Kennung" ({@code docs/werkstatt.md}) betrifft nur das Gehäuse
 * selbst (Unterteil, Deckel) - Zubehör hat ohnehin keine Kennung.
 *
 * <p>Geladen aus genau den eingecheckten Dateien unter
 * {@code edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/} - {@code pom.xml} legt sie beim Bau
 * unverändert ins Jar, das {@code Dockerfile} kopiert sie in die Bau-Stufe. Keine von Hand
 * gepflegte Kopie: {@code WerkstattZubehoerDateiTest} erzwingt Byte- und Prüfsummen-Gleichheit
 * gegen {@code druck/SHA256SUMS}.
 */
public final class WerkstattZubehoerDatei {

    /** Ein Teil, das die Werkstatt-Box-Seite zum Download anbietet; Reihenfolge der Anzeige. */
    public enum Teil {
        HUTSCHIENEN_CLIP("hutschienen-clip", "hutschienen-clip.3mf"),
        BOHRLEHRE("bohrlehre", "bohrlehre.3mf");

        private final String slug;
        private final String dateiname;

        Teil(String slug, String dateiname) {
            this.slug = slug;
            this.dateiname = dateiname;
        }

        public String slug() {
            return slug;
        }

        public static Optional<Teil> vonSlug(String slug) {
            for (Teil t : values()) {
                if (t.slug.equals(slug)) {
                    return Optional.of(t);
                }
            }
            return Optional.empty();
        }
    }

    public record Datei(String name, byte[] daten, String sha256) {
    }

    private static final String KLASSENPFAD = "werkstatt/zubehoer/";

    private WerkstattZubehoerDatei() {
    }

    public static Datei lies(Teil teil) {
        byte[] daten = ladeBytes(KLASSENPFAD + teil.dateiname);
        return new Datei(teil.dateiname, daten, sha256(daten));
    }

    private static byte[] ladeBytes(String pfad) {
        try (InputStream in = WerkstattZubehoerDatei.class.getClassLoader().getResourceAsStream(pfad)) {
            if (in == null) {
                throw new IllegalStateException("Zubehör-Datei fehlt im Jar: " + pfad
                        + " (pom.xml legt edge-light/gehaeuse/glinet-gl-mt300n-v2/druck dorthin)");
            }
            return in.readAllBytes();
        } catch (IOException e) {
            throw new IllegalStateException("Zubehör-Datei nicht lesbar: " + pfad, e);
        }
    }

    private static String sha256(byte[] daten) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(daten));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
