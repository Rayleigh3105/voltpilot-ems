package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Kann diese Box dieses Release bekommen - und wenn nicht, warum? (Geräte &amp;
 * Updates G1, der Verteil-Dialog). Jede Box steht in GENAU einer Gruppe:
 * <ul>
 *   <li><b>bereit</b> - erreichbar, das Release passt;</li>
 *   <li><b>wartet</b> - das Release passt, die Box meldet sich gerade nicht; sie
 *       holt die Anfrage retained ab, sobald sie sich meldet;</li>
 *   <li><b>aktuell</b> - sie fährt dieses Release schon;</li>
 *   <li><b>kann_nicht</b> - mit Grund: andere Box-Art oder Stufe 1
 *       ({@link BoxArt#sperrgrund}), Kundenbereich beendet, oder sie fährt
 *       schon eine neuere Fassung derselben Linie und das Release erlaubt keinen
 *       Rückschritt (die Box lehnt es ab, {@code otaverify.Verify}).</li>
 * </ul>
 *
 * <p>Das Portal fragt an, die Box entscheidet: „bereit" ist keine Zusage, dass
 * die Box annimmt - nur, dass nichts Bekanntes dagegen spricht. Die Sperren
 * hier sind dieselben, mit denen die Schreibwege 409 antworten; der Rückschritt
 * ist die Regel der Box, hier VOR dem Klick benannt.
 *
 * <p>Rein (bis auf das Lesen von {@code allow_downgrade} aus dem Manifest).
 */
public final class UpdateEignung {

    public static final String BEREIT = "bereit";
    public static final String WARTET = "wartet";
    public static final String AKTUELL = "aktuell";
    public static final String KANN_NICHT = "kann_nicht";

    /** Der Grund einer Box, deren Kundenbereich beendet ist (AP-20, E10 = A). */
    public static final String GRUND_BEENDET =
            "Der Kundenbereich ist beendet – diese Box bekommt keine Zuweisung.";
    /** Der Grund, solange eine Box offline ist. */
    public static final String GRUND_WARTET =
            "Meldet sich gerade nicht – bekommt die Anfrage, sobald sie sich meldet.";

    private static final ObjectMapper JSON = new ObjectMapper();

    private UpdateEignung() {
    }

    /** Das Urteil: Gruppe und (außer bei „bereit"/„aktuell") ihr Grund. */
    public record Urteil(String gruppe, String grund) {
    }

    /** Das gewählte Release. */
    public record Release(String version, long releaseSeq, String boxArt, boolean erlaubtRueckschritt) {
    }

    /**
     * Eine Box.
     *
     * @param boxArt            ihre Box-Art ({@code null} = unbekannt)
     * @param vertrauenGekreuzt Wurzel und geprüftes Vertrauens-Set gemeldet
     * @param laeuft            der laufende Stempel ({@code null} = nichts gemeldet)
     * @param istRelease        das Register-Release, das sie fährt (derselben Linie), sonst {@code null}
     * @param istSeq            seine Sequenz, sonst {@code null}
     * @param offline           kein Lebenszeichen im Online-Fenster, oder nie gemeldet
     * @param beendet           ihr Kundenbereich ist beendet
     */
    public record Box(String boxArt, boolean vertrauenGekreuzt, String laeuft, String istRelease,
            Long istSeq, boolean offline, boolean beendet) {
    }

    public static Urteil of(Release release, Box box) {
        if (box.beendet()) {
            return new Urteil(KANN_NICHT, GRUND_BEENDET);
        }
        String sperre = BoxArt.sperrgrund(box.boxArt(), release.boxArt(), box.vertrauenGekreuzt());
        if (sperre != null) {
            return new Urteil(KANN_NICHT, sperre);
        }
        if (RolloutStates.releaseIsRunning(release.version(), box.laeuft())) {
            return new Urteil(AKTUELL, null);
        }
        if (box.istSeq() != null && box.istSeq() > release.releaseSeq()
                && !release.erlaubtRueckschritt()) {
            return new Urteil(KANN_NICHT, "Läuft schon " + box.istRelease()
                    + " (neuer). Eine ältere Fassung lehnt die Box ab.");
        }
        if (box.offline()) {
            return new Urteil(WARTET, GRUND_WARTET);
        }
        return new Urteil(BEREIT, null);
    }

    /**
     * Erlaubt das signierte Manifest einen Rückschritt ({@code allow_downgrade})?
     * Ohne lesbares Manifest nicht - die Box prüft ohnehin selbst.
     */
    public static boolean erlaubtRueckschritt(String manifest) {
        if (manifest == null || manifest.isBlank()) {
            return false;
        }
        try {
            JsonNode n = JSON.readTree(manifest).path("allow_downgrade");
            return n.isBoolean() && n.asBoolean();
        } catch (Exception e) {
            return false;
        }
    }
}
