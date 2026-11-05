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
 * Edge Light: Ein Docker-Kern vor dem Edge-Light-Update-Vertrag lehnt das
 * Backend {@code light} als Prüffehler ab ({@code failed}); ein neuerer stellt
 * ein solches Release nur zurück (Sperre {@code backend}). Solange ältere Kerne
 * in der Flotte sind, bleibt diese Sperre die sichere Seite. Erzeugen darf ein
 * Werkzeug ein gemischtes Manifest ohnehin nicht ({@code ParseManifestStrict}).
 * Den vollen Formleser hat {@link ReleaseManifest}; hier genügt bewusst der rohe
 * Blick in {@code compat.backends}, damit auch ein unlesbares Manifest mit
 * {@code light} als Edge Light gilt.
 *
 * <h2>Zuweisen</h2>
 * Gesperrt wird, was belegt nicht passt. Ein Edge-Light-Release verlangt
 * zusätzlich den BELEG, dass die Box Edge Light ist - eine Box unbekannter Art
 * bekommt es nicht, weil eine Docker-Box es als Vorfall abweisen würde. Ein
 * Docker-Release bleibt einer Box unbekannter Art zuweisbar wie bisher (eine
 * Box, die sich noch nie gemeldet hat, holt ihre Zuweisung retained ab).
 *
 * <p><b>Stufe 1 (Geräte &amp; Updates S0):</b> Eine Edge-Light-Box ohne
 * gekreuztes Vertrauen (Wurzel UND geprüftes Vertrauens-Set gemeldet) hat
 * Stufe 1: ihr Loader startet immer die Fassung aus dem Flash, und ohne
 * Vertrauens-Set lehnt sie jedes Release ab („Das Vertrauens-Set oder seine
 * Signatur fehlt", {@code otaverify.Verify}) - im Portal stand das als
 * „fehlgeschlagen ⚠". Ein Edge-Light-Release an sie wird deshalb vor dem Senden
 * gesperrt; der Weg ist das einmalige Nachrüsten
 * ({@code edge-light/docs/nachruesten.md}). Dieselbe Regel nennt das Portal
 * „Updates von Hand (Edge Light, Stufe 1)" ({@code crossoverState}).
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

    /**
     * Docker-Release an eine Edge-Light-Box. Seit Edge Light eigene Releases hat
     * (edge-light-JJJJ.MM.N), nennt der Satz nur noch die Bauart; ob die Box
     * Updates über das Portal annimmt, sagt {@link #GRUND_LIGHT_STUFE_1}.
     */
    public static final String GRUND_DOCKER_AUF_LIGHT =
            "Release für die Docker-Box – diese Box ist eine Edge Light.";
    /**
     * Edge-Light-Release an eine Edge-Light-Box, deren Loader nur die Fassung aus
     * dem Flash startet (Stufe 1, gemeldet als {@code update.geraet.loader = flash},
     * Geräte &amp; Updates G8) - auch mit geprüftem Vertrauens-Set.
     */
    public static final String GRUND_LIGHT_STUFE_1_LOADER =
            "Release für Edge Light – diese Box hat Stufe 1: ihr Loader startet immer die Fassung "
                    + "aus dem Flash und kennt keine Updates. Einmal über den Wartungstunnel "
                    + "nachrüsten, danach kommt jede Fassung über das Portal.";
    /** Edge-Light-Release an eine Edge-Light-Box mit Stufe 1 (kein gekreuztes Vertrauen). */
    public static final String GRUND_LIGHT_STUFE_1 =
            "Release für Edge Light – diese Box hat Stufe 1 und nimmt keine Updates aus dem "
                    + "Portal an (kein geprüftes Vertrauens-Set). Einmal über den Wartungstunnel "
                    + "nachrüsten, danach kommt jede Fassung über das Portal.";
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
     * Hat das Gerät sein Vertrauen GEKREUZT - Wurzel und geprüftes
     * Vertrauens-Set gemeldet? Zwilling von {@code crossoverState} im Portal
     * (beide Listen nicht leer).
     *
     * @param rootKeyIds     {@code root_key_ids}, kommagetrennt wie gespeichert
     *                       ({@code null} = nicht gemeldet)
     * @param trustSetKeyIds {@code trust_set_key_ids}, ebenso
     */
    public static boolean vertrauenGekreuzt(String rootKeyIds, String trustSetKeyIds) {
        return hatSchluessel(rootKeyIds) && hatSchluessel(trustSetKeyIds);
    }

    private static boolean hatSchluessel(String kommagetrennt) {
        if (kommagetrennt == null) {
            return false;
        }
        for (String k : kommagetrennt.split(",")) {
            if (!k.isBlank()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Warum dieses Release diesem Gerät NICHT zugewiesen werden darf.
     *
     * @param geraet            die Box-Art des Geräts ({@code null} = unbekannt)
     * @param release           die Box-Art des Releases
     * @param vertrauenGekreuzt ob das Gerät Wurzel und geprüftes Vertrauens-Set
     *                          gemeldet hat ({@link #vertrauenGekreuzt(String, String)});
     *                          zählt nur für Edge Light (Stufe 1)
     * @return {@code null}, wenn die Zuweisung passt, sonst der deutsche Grund
     */
    public static String sperrgrund(String geraet, String release, boolean vertrauenGekreuzt) {
        return sperrgrund(geraet, release, vertrauenGekreuzt, null);
    }

    /**
     * Wie oben, mit dem gemeldeten Loader-Stand (Geräte &amp; Updates G8):
     * {@code flash} heißt Stufe 1, auch wenn das Vertrauen gekreuzt ist - die
     * Box prüft das Release dann zwar, wendet es aber nie an. {@code null} =
     * nicht gemeldet (ältere Box): dann entscheidet allein das Vertrauen.
     */
    public static String sperrgrund(String geraet, String release, boolean vertrauenGekreuzt,
            String loader) {
        if (LIGHT.equals(release)) {
            if (LIGHT.equals(geraet)) {
                if (BoxGeraet.LOADER_FLASH.equals(loader)) {
                    return GRUND_LIGHT_STUFE_1_LOADER;
                }
                return vertrauenGekreuzt ? null : GRUND_LIGHT_STUFE_1;
            }
            return geraet == null ? GRUND_LIGHT_AUF_UNBEKANNT : GRUND_LIGHT_AUF_DOCKER;
        }
        return LIGHT.equals(geraet) ? GRUND_DOCKER_AUF_LIGHT : null;
    }

    /**
     * Hat eine Edge-Light-Box Stufe 1 - nimmt sie keine Updates aus dem Portal
     * an? Ohne gekreuztes Vertrauen, oder mit einem Loader, der nur die Fassung
     * aus dem Flash startet. Für andere Box-Arten {@code false}.
     */
    public static boolean stufe1(String geraet, boolean vertrauenGekreuzt, String loader) {
        return LIGHT.equals(geraet)
                && (!vertrauenGekreuzt || BoxGeraet.LOADER_FLASH.equals(loader));
    }
}
