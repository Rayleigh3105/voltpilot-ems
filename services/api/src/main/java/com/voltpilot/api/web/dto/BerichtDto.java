package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonRawValue;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * Die Formen der Berichts-Routen (UEMS AP-12 IP-7): {@code /api/v1/berichte…}. snake_case wie der Bericht-Vertrag;
 * Zeitpunkte mit Versatz (UTC). Ein Abzug steht als der gespeicherte kanonische Text in der Antwort ({@link JsonRawValue}) —
 * nie neu serialisiert, damit er Byte für Byte der Abzug bleibt, dessen Prüfsumme der Server geprüft hat.
 */
public final class BerichtDto {
    private BerichtDto() {}

    /**
     * {@code POST /api/v1/berichte}: Vorlage × Geltung × Zeitraum (Schlüssel {@code 2026-10} bzw. {@code 2026}) und — freiwillig
     * (V3, AP-12 IP-14) — die Kennungen der abgewählten Kennzahlen; fehlt die Liste oder ist sie leer, sind alle gewählt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String vorlage, String geltungId, String zeitraum, List<String> kennzahlenAbgewaehlt,
            String kennzahl) {}

    /** AP-16 S5: Wiedervorlage der energetischen Bewertung ändern. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wiedervorlage(@JsonProperty("wiedervorlage_monate") Integer wiedervorlageMonate,
            String begruendung) {}

    /** {@code POST …/freigeben}: der Datenstand des Entwurfs, den die Person sah (F2). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Freigeben(String entwurfDatenstand) {}

    /** {@code POST …/anstoesse/{id}/verwerfen}: die Begründung ist Pflicht (R4, 10 bis 500 Zeichen). */
    public record Verwerfen(String begruendung) {}

    /** Wer etwas tat: der Name und — wo sie gespeichert ist — die Rolle, die das Recht gab ({@code actor_*}-Muster). */
    public record Person(String name, String rolle) {}

    /**
     * Ein Bericht in der Liste und im Kopf: {@code stand_zeichen} ist der Vermerk aus R5 als Wort
     * ({@code entwurf · berichtsstand · revision_noetig · anstoss_verworfen}), {@code stand_text} sein Kundensatz.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bericht(String kennung, String vorlage, int vorlageFassung, String geltungArt, String geltungId,
            String geltungName, String zeitraumArt, String zeitraum, String zeitraumText, String zeitzone,
            Person angelegtVon, OffsetDateTime angelegtAm, OffsetDateTime archiviertAm, String standZeichen,
            String standText, Integer neuesteNr, OffsetDateTime entwurfDatenstand, Integer wiedervorlageMonate,
            Ueberpruefung ueberpruefung) {}

    /**
     * AP-16 S5/S6 (IP-24): die Überprüfung der energetischen Bewertung, beim Abruf abgeleitet — nur an einer Bewertung mit
     * freigegebenem Stand, sonst {@code null}. {@code faellig_am} = Freigabetag des jüngsten gültigen Stands +
     * {@code wiedervorlage_monate}; am Frist-Tag selbst {@code faellig_seit_tagen} 0. Eine abgelöste Bewertung
     * ({@code abgeloest_durch}) hat keine Frist. Einsätze, Verantwortliche und offene Bedarfe gelten am Abruftag.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ueberpruefung(int standNr, String standVom, int wiedervorlageMonate, String faelligAm,
            boolean ueberpruefungFaellig, Integer faelligSeitTagen, String abgeloestDurch, int wesentlicheEinsaetze,
            int offeneBedarfe, List<Verantwortliche> verantwortliche, List<String> ohneVerantwortliche) {}

    /** Eine verantwortliche Person und ihre wesentlichen Einsätze (Kennzeichen). */
    public record Verantwortliche(String name, List<String> einsaetze) {}

    /** {@code GET /api/v1/berichte}: die Berichte, die die Person lesen darf — archivierte nicht (V4). */
    public record Liste(List<Bericht> berichte) {}

    /** Ein Berichtsstand in einer Folgen-Karte: „BR-2026-0001 Nr. 2“. */
    public record StandRef(String kennung, int nr) {}

    /**
     * {@code GET /api/v1/berichte/betroffen} (AP-12 IP-9): die Zeile „Freigegebene Berichte: …“ der Folgen-Karten —
     * {@code betroffen} bekäme den Vermerk „Revision nötig“, {@code zitieren} nennt jeden Stand, der eine Quelle des Objekts
     * zitiert (B12); {@code berichte_vorhanden} = die Person liest hier mindestens einen Bericht.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Betroffen(String anlass, String giltAb, boolean berichteVorhanden, List<StandRef> betroffen,
            List<StandRef> zitieren) {}

    /** Ein Berichtsstand im Verlauf — ohne Abzug. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StandKurz(int nr, OffsetDateTime datenstand, OffsetDateTime freigegebenAm, Person freigegebenVon,
            String pruefsumme, Integer ersetztDurchNr, String anlassAnstossId) {}

    /** Ein Revisions-Anstoß an einem Stand (R1–R4) — {@code anlass_text} in Kundensprache. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anstoss(String id, int nr, String art, String anlassKennung, Integer anlassFassung, String anlassText,
            OffsetDateTime erkanntAm, String zustand, Integer erledigtDurchNr, String verworfenBegruendung,
            Person verworfenVon, OffsetDateTime verworfenAm) {}

    /** {@code GET /api/v1/berichte/{kennung}}: Kopf, Stände (Nr. 1 zuerst) und Anstöße (älteste zuerst). */
    public record Detail(Bericht bericht, List<StandKurz> staende, List<Anstoss> anstoesse) {}

    /**
     * {@code GET …/entwurf}: der gespeicherte Entwurf nach der D4-Prüfung — {@code neu_gebildet} = DIESER Abruf hat ihn neu
     * gebildet. {@code teilansicht}: die Standortnamen einer Teilansicht (G3), unternehmensweit {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entwurf(String kennung, OffsetDateTime datenstand, String gebildetVon, boolean neuGebildet,
            String pruefsumme, String kopf, List<String> teilansicht, @JsonRawValue String abzug) {}

    /** Eine Abweichung zwischen Stand und Entwurf (R1); Zahlen als Dezimaltext, ungerundet; fehlt eine Seite, {@code null}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Abweichung(String quelle, String mengeArt, String vorher, String nachher, String version, String anlass) {}

    /** {@code GET …/entwurf/vergleich?gegen=<nr>}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vergleich(String kennung, int gegen, OffsetDateTime entwurfDatenstand, List<Abweichung> abweichungen) {}

    /**
     * Ein freigegebener Berichtsstand: {@code pruefsumme_geprueft} ist immer {@code true} — ein Abzug, dessen Prüfsumme nicht
     * stimmt, verlässt den Server nie (500 {@code abzug_beschaedigt}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stand(String kennung, int nr, OffsetDateTime datenstand, OffsetDateTime freigegebenAm,
            Person freigegebenVon, String pruefsumme, boolean pruefsummeGeprueft, Integer ersetztDurchNr,
            String anlassAnstossId, int vorlageFassung, String kopf, List<String> teilansicht,
            @JsonRawValue String darstellung, @JsonRawValue String regelwerk, @JsonRawValue String abzug) {}
}
