package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Set;

/**
 * Die EINE Regel „welche Box-Art ist das, und passt dieses Release dazu?" -
 * rein, ohne DB, ohne Broker (das {@link RolloutStates}-Muster).
 *
 * <p><b>Zwei Box-Arten:</b> die Docker-Box ({@code edge-app}, Apply-Backend
 * {@code compose}/{@code quadlet}/{@code mender}) und Edge Light
 * ({@code vp-edge-light} auf dem Mango, Backend {@code light}). Die Box-Art ist
 * keine Zustands-Aussage über das Gerät, sondern seine Bauart; die Sperre hier
 * ist der Cloud-Zwilling von {@code compat.backends}, das jede Box ohnehin
 * selbst prüft - nur eben VOR dem Senden, statt dass eine falsche Zuweisung
 * als „fehlgeschlagen ⚠" auf der Box endet.
 *
 * <h2>Erkennen (Gerät)</h2>
 * <ol>
 *   <li>Meldet die Box {@code update.backend = "light"}, ist sie Edge Light.</li>
 *   <li><b>Übergang:</b> Heute meldet auch Edge Light noch {@code compose}
 *       (der Core trägt den Wert fest ein). Bis jede Edge-Light-Box ihr Backend
 *       selbst meldet, erkennt die API sie an ihrem Versionsstempel
 *       {@value #LIGHT_STAMP_PREFIX}… ({@code edge-light/scripts/lib.sh
 *       light_version}). Der Stempel gewinnt dabei über {@code compose}.</li>
 *   <li>Ein Docker-Backend oder ein gemeldeter Stand ohne Backend (ältere
 *       Docker-Kerne melden nur die Version) heißt Docker-Box.</li>
 *   <li>Sonst ist die Box-Art <b>unbekannt</b> ({@code null}): ein Gerät, das
 *       noch nichts gemeldet hat, oder ein Backend-Wort, das diese API nicht
 *       kennt. Unbekannt ist nie still „Docker".</li>
 * </ol>
 *
 * <h2>Erkennen (Release)</h2>
 * Ein Release gilt bis auf Weiteres als Docker. Edge Light ist es, wenn das
 * signierte Manifest {@code light} unter {@code compat.backends} führt oder der
 * Register-Name zur Linie {@value #LIGHT_STAMP_PREFIX}JJJJ.MM.N gehört (E7).
 * Ein Manifest, das neben {@code light} auch ein Docker-Backend nennt, gilt als
 * Edge Light: Ein heutiger Docker-Kern lehnt das unbekannte Backend
 * {@code light} als Prüffehler ab, statt es zurückzustellen.
 *
 * <h2>Zuweisen</h2>
 * Gesperrt wird, was belegt nicht passt. Ein Edge-Light-Release verlangt
 * zusätzlich den BELEG, dass die Box Edge Light ist - eine Box unbekannter Art
 * bekommt es nicht, weil eine Docker-Box es als Vorfall abweisen würde. Ein
 * Docker-Release bleibt einer Box unbekannter Art zuweisbar wie bisher (eine
 * Box, die sich noch nie gemeldet hat, holt ihre Zuweisung retained ab).
 *
 * <p>Der Zwilling im Portal ist {@code releaseSperre} in
 * {@code frontend/portal/src/adminEdgeUpdates.ts}; die Sätze dort und hier
 * dürfen nicht auseinanderlaufen (die Tests beider Seiten nageln sie fest).
 */
public final class BoxArt {

    /** Die Docker-Box ({@code edge-app}). */
    public static final String DOCKER = "docker";
    /** Edge Light ({@code vp-edge-light}). */
    public static final String LIGHT = "light";

    /** Das Apply-Backend, mit dem sich Edge Light meldet. */
    static final String BACKEND_LIGHT = "light";

    /** Die Apply-Backends der Docker-Box ({@code compat.backends} im Manifest-Schema). */
    static final Set<String> BACKENDS_DOCKER = Set.of("compose", "quadlet", "mender");

    /**
     * Der Stempel- und Namens-Anfang von Edge Light. Er beginnt nie wie ein
     * Docker-Release ({@code edge-JJJJ.MM.N}), damit die Präfix-Regel von
     * {@link RolloutStates#releaseIsRunning} beide Linien trennt.
     */
    public static final String LIGHT_STAMP_PREFIX = "edge-light-";

    /** Docker-Release an eine Edge-Light-Box. */
    public static final String GRUND_DOCKER_AUF_LIGHT =
            "Release für die Docker-Box – diese Box ist eine Edge Light. Updates von Hand "
                    + "(Edge Light, Stufe 1): Aktualisierung über den Wartungstunnel.";
    /** Edge-Light-Release an eine Docker-Box. */
    public static final String GRUND_LIGHT_AUF_DOCKER =
            "Release für Edge Light – diese Box ist eine Docker-Box.";
    /** Edge-Light-Release an eine Box, deren Art niemand belegt hat. */
    public static final String GRUND_LIGHT_AUF_UNBEKANNT =
            "Release für Edge Light – die Box-Art dieses Geräts ist unbekannt. Ein "
                    + "Edge-Light-Release geht nur an eine Box, die sich als Edge Light "
                    + "gemeldet hat.";

    private static final ObjectMapper JSON = new ObjectMapper();

    private BoxArt() {
    }

    /**
     * Die Box-Art eines Geräts aus seiner letzten Meldung.
     *
     * @param backend {@code update.backend}, verbatim gespeichert
     * @param stamps  die gemeldeten Stempel ({@code version}, {@code update.current});
     *                jeder darf {@code null} sein
     * @return {@link #DOCKER}, {@link #LIGHT} oder {@code null} = unbekannt
     */
    public static String ofDevice(String backend, String... stamps) {
        String b = backend == null ? null : backend.trim();
        if (BACKEND_LIGHT.equals(b)) {
            return LIGHT;
        }
        boolean reported = false;
        for (String s : stamps) {
            if (s == null || s.isBlank()) {
                continue;
            }
            reported = true;
            if (s.trim().startsWith(LIGHT_STAMP_PREFIX)) {
                return LIGHT;
            }
        }
        if (b != null && !b.isEmpty()) {
            return BACKENDS_DOCKER.contains(b) ? DOCKER : null;
        }
        return reported ? DOCKER : null;
    }

    /**
     * Die Box-Art eines Releases. Nie {@code null}: ohne Kennzeichnung ist es
     * ein Docker-Release.
     *
     * @param version  der Register-Name
     * @param manifest die signierten Manifest-Bytes ({@code null} = nicht signiert)
     */
    public static String ofRelease(String version, String manifest) {
        if (version != null && version.trim().startsWith(LIGHT_STAMP_PREFIX)) {
            return LIGHT;
        }
        if (manifest != null && !manifest.isBlank()) {
            try {
                JsonNode backends = JSON.readTree(manifest).path("compat").path("backends");
                if (backends.isArray()) {
                    for (JsonNode n : backends) {
                        if (BACKEND_LIGHT.equals(n.asText())) {
                            return LIGHT;
                        }
                    }
                }
            } catch (Exception e) {
                // Unlesbare Bytes kennzeichnen nichts - es bleibt beim Docker-Release.
                // Ob das Manifest gilt, entscheidet ohnehin die Box an ihrer Wurzel.
            }
        }
        return DOCKER;
    }

    /**
     * Warum dieses Release diesem Gerät NICHT zugewiesen werden darf.
     *
     * @param geraet  die Box-Art des Geräts ({@code null} = unbekannt)
     * @param release die Box-Art des Releases
     * @return {@code null}, wenn die Zuweisung passt, sonst der deutsche Grund
     */
    public static String sperrgrund(String geraet, String release) {
        if (LIGHT.equals(release)) {
            if (LIGHT.equals(geraet)) {
                return null;
            }
            return geraet == null ? GRUND_LIGHT_AUF_UNBEKANNT : GRUND_LIGHT_AUF_DOCKER;
        }
        return LIGHT.equals(geraet) ? GRUND_DOCKER_AUF_LIGHT : null;
    }
}
