package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Grund;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 404 {@code zugriff_beendet} (UEMS AP-03 IP-9, §4.7, §5.9): der Aufrufer hatte diesen Zugang, und er ist vorbei.
 *
 * <p><b>Der Unterschied zur stummen 404.</b> „Außerhalb des Geltungsbereichs" bestätigt nichts — wer ein Objekt nie
 * sehen durfte, erfährt nicht einmal, dass es existiert (W2). Wer es SAH und es verloren hat, weiß es längst; ihm
 * eine stumme 404 zu geben, hieße, ihn raten zu lassen, ob die Seite kaputt ist. Er bekommt darum den Satz aus §4.7
 * und das Portal die Handhabe, die Startansicht neu zu rechnen (A6, N7).
 *
 * <p><b>Sofort heißt sofort.</b> Der {@link ZugriffKontextLader} liest die Zuweisungen bei JEDER Anfrage; es gibt
 * keinen Zwischenspeicher, der ein Ende verzögern könnte, und das Token wird nicht gefragt. Ein Entzug wirkt mit der
 * nächsten Anfrage, nicht mit der nächsten Anmeldung.
 *
 * <p>Der Körper folgt den UEMS-Ablehnungen: {@code code}, {@code message}, dazu {@code standort} bzw.
 * {@code kundenbereich} als Fakt. Die Sätze kommen aus {@link RechteAbleitung#TEXTE} — nie hier gebaut, damit API
 * und Portal ({@code rechte.ts}) denselben Wortlaut zeigen.
 */
public class ZugriffBeendet extends RuntimeException {

    public static final String CODE = Grund.ZUGRIFF_BEENDET.code();

    private final transient String standort;
    private final transient String kundenbereich;

    private ZugriffBeendet(String text, String standort, String kundenbereich) {
        super(text);
        this.standort = standort;
        this.kundenbereich = kundenbereich;
    }

    /**
     * „Ihr Zugriff auf Werk Ahrenberg Nord wurde beendet." — {@code standort} {@code null} (eine unternehmensweite
     * Zuweisung trägt keinen Standort) ergibt den Satz ohne Namen; er bleibt wahr.
     */
    public static ZugriffBeendet standort(String standortName) {
        String satz = standortName == null
                ? RechteAbleitung.TEXTE.get("zugriff_beendet").replace(" auf {standort}", "")
                : RechteAbleitung.TEXTE.get("zugriff_beendet").replace("{standort}", standortName);
        return new ZugriffBeendet(satz, standortName, null);
    }

    /** „Ihre Unterstützung für Kunststoffwerk Ahrenberg GmbH ist beendet." (§4.7, A4). */
    public static ZugriffBeendet unterstuetzung(String kundenbereich) {
        return new ZugriffBeendet(
                RechteAbleitung.TEXTE.get("unterstuetzung_beendet").replace("{kundenbereich}", kundenbereich),
                null, kundenbereich);
    }

    public Map<String, Object> koerper() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", CODE);
        body.put("message", getMessage());
        if (kundenbereich != null) {
            body.put("kundenbereich", kundenbereich);
        } else {
            body.put("standort", standort);
        }
        return body;
    }
}
