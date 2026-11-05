package com.voltpilot.api.ota;

import com.voltpilot.api.repo.BoxVerlaufRepository;
import java.time.Instant;
import java.util.UUID;

/**
 * Ein Eintrag im Verlauf einer Box (Geräte &amp; Updates G3), aus einer rohen
 * Zeile übersetzt - rein und ohne DB.
 *
 * <p>Die drei Wörter der Seite bleiben getrennt: was das PORTAL tat
 * ({@code angefragt}, {@code zurueckgezogen}, {@code erneut_gesendet},
 * {@code entfernt}) und was die BOX meldete ({@code stand} - ein neuer laufender
 * Stand, {@code angenommen}/{@code abgelehnt}/{@code zurueckgestellt} - ihr
 * Prüfurteil zu einem Ziel, {@code fehlgeschlagen}/{@code zurueckgenommen}).
 * Ein „bestätigt" erfindet diese Klasse nicht: ob ein neuer Stand die damalige
 * Anfrage war, sagt die Seite aus den Einträgen selbst.
 *
 * <p>Unbekannte Wörter (ein neueres Journal-Ereignis, ein neuer Zustand) ergeben
 * {@code null} und werden ausgelassen, statt geraten zu werden.
 */
public final class BoxVerlauf {

    public static final String QUELLE_PORTAL = "portal";
    public static final String QUELLE_BOX = "box";

    public static final String ANGEFRAGT = "angefragt";
    public static final String ZURUECKGEZOGEN = "zurueckgezogen";
    public static final String ERNEUT_GESENDET = "erneut_gesendet";
    public static final String ENTFERNT = "entfernt";
    public static final String STAND = "stand";
    public static final String ANGENOMMEN = "angenommen";
    public static final String ABGELEHNT = "abgelehnt";
    public static final String ZURUECKGESTELLT = "zurueckgestellt";
    public static final String FEHLGESCHLAGEN = "fehlgeschlagen";
    public static final String ZURUECKGENOMMEN = "zurueckgenommen";

    private BoxVerlauf() {
    }

    /**
     * Ein Eintrag: {@code release} ist das betroffene Release (angefragt, Ziel des
     * Urteils, neuer Stand), {@code vorher} der vorige Stand (nur bei
     * {@code stand}; {@code null} = erste Meldung), {@code von} der Akteur einer
     * Portal-Handlung (JWT-Subjekt oder {@code system}).
     */
    public record Eintrag(Instant am, String quelle, String art, String release, String vorher,
            String grund, String von, UUID rolloutId) {
    }

    /** Die Übersetzung einer rohen Zeile; {@code null} für ein unbekanntes Wort. */
    public static Eintrag of(BoxVerlaufRepository.Zeile z) {
        if (QUELLE_PORTAL.equals(z.quelle())) {
            String art = switch (z.art()) {
                case "target_assigned" -> ANGEFRAGT;
                case "target_reverted" -> ZURUECKGEZOGEN;
                case "target_republished" -> ERNEUT_GESENDET;
                case "target_cleared_on_unclaim" -> ENTFERNT;
                default -> null;
            };
            if (art == null) {
                return null;
            }
            boolean mitRelease = ANGEFRAGT.equals(art) || ERNEUT_GESENDET.equals(art);
            return new Eintrag(z.am(), QUELLE_PORTAL, art, mitRelease ? z.wert() : null, null, null,
                    z.von(), z.rolloutId());
        }
        if (!QUELLE_BOX.equals(z.quelle())) {
            return null;
        }
        return switch (z.art()) {
            case "stand" -> new Eintrag(z.am(), QUELLE_BOX, STAND, z.wert(), z.vorher(), null, null, null);
            case "urteil" -> {
                String art = switch (z.wert() == null ? "" : z.wert()) {
                    case "ok" -> ANGENOMMEN;
                    case "rejected" -> ABGELEHNT;
                    case "deferred" -> ZURUECKGESTELLT;
                    default -> null;
                };
                yield art == null ? null
                        : new Eintrag(z.am(), QUELLE_BOX, art, z.ziel(), null, z.grund(), null, null);
            }
            case "zustand" -> {
                String art = switch (z.wert() == null ? "" : z.wert()) {
                    case "failed" -> FEHLGESCHLAGEN;
                    case "rolled_back" -> ZURUECKGENOMMEN;
                    default -> null;
                };
                yield art == null ? null
                        : new Eintrag(z.am(), QUELLE_BOX, art, z.ziel(), null, z.grund(), null, null);
            }
            default -> null;
        };
    }
}
