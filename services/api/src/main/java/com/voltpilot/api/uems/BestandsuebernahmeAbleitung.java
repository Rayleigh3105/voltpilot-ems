package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Die REINE Regel der BESTANDSÜBERNAHME der Standorte (UEMS AP-02 IP-9; Entscheide E5 = A,
 * E9, E10 = A; Abnahme A5/A6, §6.3): was ein Kundenbereich, der schon vor dem Unternehmens-
 * Energiemanagement Anlagen hatte, bei der Einführung bekommt — und was nie.
 *
 * <ol>
 *   <li>Kein Unternehmen, keine Anlage oder schon ein Standort — auch ein archivierter: die
 *       Rücknahme „automatisch angelegten Standort archivieren“ (§6.3) bleibt stehen —:
 *       NICHTS. Ein Standort ist erst da, wenn eine Anlage zugeordnet werden kann; eine
 *       zugeordnete Anlage hat also immer einen, und die Regel fragt nur nach ihm.</li>
 *   <li>Ein Kundenbereich, der schon VORSCHLÄGE hat, bleibt auf dem Vorschau-Weg: nur eine
 *       Anlage ohne Vorschlag bekommt ihren, nie einen Standort — auch wenn nur noch eine
 *       Anlage übrig ist (über die Vorschau entscheidet der Kunde, IP-10).</li>
 *   <li>GENAU EINE Anlage: ein Standort mit ihrem Namen, Zustand Entwurf, es fehlt: Adresse —
 *       nie eine erfundene (E10) —, in der Zeitzone des Unternehmens (so belegt auch das
 *       Anlegen vor, V20260911100000), und die Zuordnung ab dem TAG ihres Anlegens in
 *       dieser Zeitzone (E9; A5: ab 12.03.2024, bei der Einführung rückwirkend).</li>
 *   <li>MEHRERE Anlagen: je Anlage ein Vorschlag „ein Standort gleichen Namens“ ab demselben
 *       Tag — und KEINE Zuordnung: bis zur Bestätigung bleibt das Portfolio zeichengleich
 *       (E5, A6).</li>
 * </ol>
 *
 * <p>Der Name folgt der Namensregel des Standorts ({@link OrtFelder#NAME_HOECHSTENS}): ohne
 * Randleerzeichen, höchstens 120 Zeichen (gezählt und gekürzt nach Unicode-Zeichen, damit
 * kein Ersatzpaar zerbricht); ein leerer Anlagenname — über die API unmöglich — wird das
 * Kundenwort „Standort“ statt einer Ablehnung (dasselbe Muster wie das Unternehmen,
 * V20260911100000).
 *
 * <p>Ohne Spring, ohne Uhr: kein Ergebnis hängt an „heute“. Der Zwilling im Portal ist
 * {@code frontend/portal/src/uemsBestandsuebernahme.ts}; beide fahren die Familie
 * {@code bestandsuebernahme} der Vektor-Datei {@code docs/contracts/v2/ortsbaum-vectors.json}.
 * <b>Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.</b> Wer sie anwendet:
 * {@link BestandsuebernahmeService}.
 */
public final class BestandsuebernahmeAbleitung {

    /** Das Kundenwort, wenn die Anlage keinen Namen hat — nie eine Ablehnung. */
    public static final String NAME_OHNE_ANLAGENNAME = "Standort";

    private BestandsuebernahmeAbleitung() {}

    // ---------------------------------------------------------------- Vokabular
    // Jeder Code ist der Name in Kleinbuchstaben — genau das Wort der Vektor-Datei.

    /** Was der Lauf für den Kundenbereich tut. */
    public enum Art {
        NICHTS, STANDORT_ANLEGEN, VORSCHLAGEN;

        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** Warum — in der Reihenfolge, in der die Regel fragt. */
    public enum Grund {
        KEIN_UNTERNEHMEN, KEINE_ANLAGE, HAT_STANDORT, VORSCHAU_OFFEN, EINE_ANLAGE, MEHRERE_ANLAGEN;

        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    // ------------------------------------------------------------------ Eingang

    /** Das Unternehmen des Kundenbereichs — nur seine Zeitzone zählt hier. */
    public record Unternehmen(String zeitzone) {}

    /** Eine Anlage ({@code site}): Kennzeichen, Name und der Zeitpunkt ihres Anlegens. */
    public record Anlage(String kennzeichen, String name, OffsetDateTime angelegtUm) {}

    /** Ein Standort des Kundenbereichs — archiviert oder nicht, er zählt. */
    public record Standort(String kennzeichen, boolean archiviert) {}

    /**
     * Alles, was die Regel liest. {@code unternehmen} {@code null} = der Kundenbereich hat
     * keines; {@code vorschlaege} sind die Kennzeichen der Anlagen, die schon einen haben.
     */
    public record Eingang(Unternehmen unternehmen, List<Anlage> anlagen, List<Standort> standorte,
            List<String> vorschlaege) {

        public Eingang {
            anlagen = anlagen == null ? List.of() : List.copyOf(anlagen);
            standorte = standorte == null ? List.of() : List.copyOf(standorte);
            vorschlaege = vorschlaege == null ? List.of() : List.copyOf(vorschlaege);
        }
    }

    // ----------------------------------------------------------------- Ergebnis

    /** Der Standort, der entsteht: Codes, nie Kundenwörter ({@code entwurf}, {@code adresse}). */
    public record NeuerStandort(String name, String zustand, List<String> esFehlt, String zeitzone) {}

    /** Die Zuordnung der einen Anlage ab dem Tag ihres Anlegens (einschließlich, offen). */
    public record Zuordnung(String anlage, LocalDate gueltigAb) {}

    /** Ein Vorschlag „ein Standort gleichen Namens“ für eine Anlage — keine Zuordnung. */
    public record Vorschlag(String anlage, String name, LocalDate gueltigAb) {}

    /**
     * {@code standort} und {@code zuordnung} nur bei {@link Art#STANDORT_ANLEGEN};
     * {@code vorschlaege} nur bei {@link Art#VORSCHLAGEN} — sonst leer, nie {@code null}.
     */
    public record Plan(Art art, Grund grund, NeuerStandort standort, Zuordnung zuordnung,
            List<Vorschlag> vorschlaege) {

        public Plan {
            vorschlaege = List.copyOf(vorschlaege);
        }
    }

    // -------------------------------------------------------------------- Regel

    public static Plan plan(Eingang e) {
        if (e.unternehmen() == null) {
            return nichts(Grund.KEIN_UNTERNEHMEN);
        }
        if (e.anlagen().isEmpty()) {
            return nichts(Grund.KEINE_ANLAGE);
        }
        if (!e.standorte().isEmpty()) {
            return nichts(Grund.HAT_STANDORT);
        }
        ZoneId zone = ZoneId.of(e.unternehmen().zeitzone());
        if (!e.vorschlaege().isEmpty()) {
            Set<String> haben = new HashSet<>(e.vorschlaege());
            List<Vorschlag> neu = new ArrayList<>();
            for (Anlage a : e.anlagen()) {
                if (!haben.contains(a.kennzeichen())) {
                    neu.add(vorschlag(a, zone));
                }
            }
            return neu.isEmpty() ? nichts(Grund.VORSCHAU_OFFEN)
                    : new Plan(Art.VORSCHLAGEN, Grund.VORSCHAU_OFFEN, null, null, neu);
        }
        if (e.anlagen().size() == 1) {
            Anlage a = e.anlagen().get(0);
            return new Plan(Art.STANDORT_ANLEGEN, Grund.EINE_ANLAGE,
                    new NeuerStandort(standortName(a.name()), StandortService.ENTWURF,
                            List.of(StandortLesemodell.ES_FEHLT_ADRESSE), zone.getId()),
                    new Zuordnung(a.kennzeichen(), tag(a.angelegtUm(), zone)), List.of());
        }
        List<Vorschlag> alle = new ArrayList<>();
        for (Anlage a : e.anlagen()) {
            alle.add(vorschlag(a, zone));
        }
        return new Plan(Art.VORSCHLAGEN, Grund.MEHRERE_ANLAGEN, null, null, alle);
    }

    /** Der Name des Standorts aus dem Namen der Anlage — die Namensregel, nie eine Ablehnung. */
    public static String standortName(String anlagenName) {
        String n = anlagenName == null ? "" : anlagenName.strip();
        if (n.codePointCount(0, n.length()) > OrtFelder.NAME_HOECHSTENS) {
            n = n.substring(0, n.offsetByCodePoints(0, OrtFelder.NAME_HOECHSTENS)).strip();
        }
        return n.isEmpty() ? NAME_OHNE_ANLAGENNAME : n;
    }

    /** Der Kalendertag eines Zeitpunkts in der Zeitzone (E9) — nie der UTC-Tag. */
    public static LocalDate tag(OffsetDateTime zeitpunkt, ZoneId zone) {
        return zeitpunkt.atZoneSameInstant(zone).toLocalDate();
    }

    private static Vorschlag vorschlag(Anlage a, ZoneId zone) {
        return new Vorschlag(a.kennzeichen(), standortName(a.name()), tag(a.angelegtUm(), zone));
    }

    private static Plan nichts(Grund g) {
        return new Plan(Art.NICHTS, g, null, null, List.of());
    }
}
