package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Bezugsgrößen-Schnittstelle (UEMS AP-09 IP-5, {@code /api/v1/bezugsgroessen}).
 *
 * <p>snake_case wie der Bezugsdaten-Vertrag ({@code docs/contracts/v2/bezugsdaten.md}) und die
 * übrigen UEMS-Schnittstellen; die Wörter (Wertart, Einheit, Periodenart, Geltungsbereich-Art,
 * Vorgang, Status, Herkunft) sind die Vokabulare des Vertrags. Beträge reisen als DEZIMALTEXT.
 */
public final class BezugsgroesseDto {
    private BezugsgroesseDto() {}

    /**
     * {@code POST /api/v1/bezugsgroessen} und {@code PUT …/{id}}: die ganze Bezugsgröße. Beim
     * Anlegen darf {@code kennzeichen} fehlen (der Server vergibt BZ-0001 …, M2), beim Ändern nicht.
     * {@code periode_art} gibt es genau beim Periodenwert. {@code geltung_id} ist die ID des
     * Objekts (Unternehmen, Standort, Gebäude/Bereich, Messstelle).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anfrage(
            String kennzeichen,
            String name,
            String wertart,
            String einheit,
            String periodeArt,
            String geltungArt,
            String geltungId) {}

    /** Eine Bezugsgröße. {@code hat_werte} sagt, ob M1 greift und ob sie löschbar ist (M6). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezugsgroesse(
            UUID id,
            String kennzeichen,
            String name,
            String wertart,
            String einheit,
            String periodeArt,
            String geltungArt,
            UUID geltungId,
            String geltungName,
            boolean hatWerte,
            OffsetDateTime archiviertAm,
            OffsetDateTime angelegtAm) {}

    /**
     * {@code GET /api/v1/bezugsgroessen}: archivierte eingeschlossen, nach Kennzeichen — und, getrennt davon,
     * die Bezugsflächen, die in der Ortsstruktur stehen (AP-09 IP-6, E17). Sie haben keine ID und kein
     * Kennzeichen einer Bezugsgröße: sie werden GELESEN, nie hier gespeichert.
     */
    public record Liste(List<Bezugsgroesse> bezugsgroessen, List<Bezugsflaeche> bezugsflaechen) {}

    /**
     * Eine Bezugsfläche aus der Ortsstruktur ({@code flaeche_gueltigkeit}, AP-02) als Bezugsgröße: Wertart
     * {@code stammdatum}, Einheit m², Herkunft {@code stammdatum_ap02}. {@code schreibbar} ist immer
     * {@code false} — wer sie ändern will, ändert die Ortsstruktur ({@code pflegen} sagt es in Kundensprache).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezugsflaeche(
            String name,
            String wertart,
            String einheit,
            String herkunftArt,
            String geltungArt,
            UUID geltungId,
            String geltungKennzeichen,
            String geltungName,
            boolean schreibbar,
            String pflegen) {}

    /**
     * Der Wert eines Stammdatums für EINE Periode, gelesen am Stichtag = dem LETZTEN Tag der Periode (E17).
     * {@code betrag} {@code null} heißt „nicht erhoben“, nie 0. {@code kennzeichen}: jeder Übergang nach dem
     * ersten Tag der Periode (S3). {@code quelle} nur bei einer Bezugsfläche ({@code eigen} ·
     * {@code aus_gebaeuden_summiert}); {@code gilt_ab}/{@code eingetragen_am}/{@code abzeichen} beschreiben das
     * Intervall, das am Stichtag gilt — bei einer summierten Fläche gibt es keines.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stichtagwert(
            String periode,
            LocalDate von,
            LocalDate stichtag,
            String betrag,
            String quelle,
            LocalDate giltAb,
            LocalDate eingetragenAm,
            String abzeichen,
            List<String> kennzeichen) {}

    /** Eine Bezugsfläche mit ihren Werten je Periode. */
    public record BezugsflaecheWerte(Bezugsflaeche bezugsflaeche, List<Stichtagwert> perioden) {}

    /** {@code GET /api/v1/bezugsflaechen?periode_art&von&bis}: jede Bezugsfläche der Ortsstruktur mit ihren Werten. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezugsflaechen(String periodeArt, LocalDate von, LocalDate bis, List<BezugsflaecheWerte> bezugsflaechen) {}

    /** {@code PUT /api/v1/bezugsgroessen/{id}/stammdatum}: ein Wert ab einem Tag (E15). Beide Felder Text. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StammdatumAnfrage(String wert, String gueltigAb) {}

    /**
     * Ein Intervall eines Stammdatums: {@code gueltig_bis} ist der LETZTE Tag ({@code null} offen), ein
     * aufgehobenes ist eine Korrektur und bleibt lesbar. {@code abzeichen} „rückwirkend (n Tage)“, wenn der
     * Eintrag nach „gültig ab“ lag.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StammdatumIntervall(
            String wert,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            OffsetDateTime aufgehobenAm,
            OffsetDateTime eingetragenAm,
            String abzeichen) {}

    /**
     * {@code GET/PUT /api/v1/bezugsgroessen/{id}/stammdatum}: die Intervalle eines Stammdatums, das AP-09 selbst
     * hält (E15), und — wenn nach Perioden gefragt — der Wert je Periode am Stichtag.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stammdatum(
            UUID bezugsgroesseId,
            String kennzeichen,
            String name,
            String einheit,
            String zeitzone,
            boolean schreibbar,
            List<StammdatumIntervall> intervalle,
            String periodeArt,
            LocalDate von,
            LocalDate bis,
            List<Stichtagwert> perioden) {}

    /** Wer eine Fassung eingetragen oder freigegeben hat — im Akteur-Vokabular von AP-03, ohne Subject. */
    public record Person(String name, String rolle, String art) {}

    /**
     * Die Herkunft EINER Fassung (Invariante 7): woher sie kam ({@code art} aus dem Vokabular
     * {@code herkunft_art}), ob sie von Hand eingetragen wurde, und bei einem Import Datei-Kennung,
     * Zeile sowie das Gelieferte (Text und Einheit, U1).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Herkunft(
            String art,
            boolean vonHand,
            String importKennung,
            Integer importZeile,
            String geliefertText,
            String geliefertEinheit) {}

    /**
     * Eine Fassung, wie sie gespeichert ist ({@code status} = das Wort bei Entstehen), plus
     * {@code stand} — die Lesart der Regel {@code fassung} („wirksam“, „wirksam bis Fassung 2“,
     * „zurueckgenommen“); {@code null}, solange die Kette Vier-Augen-Fassungen trägt (IP-7).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(
            int fassung,
            String vorgang,
            String status,
            String stand,
            String betrag,
            Integer ersetztFassung,
            String begruendung,
            List<String> kennzeichen,
            Herkunft herkunft,
            Person urheber,
            Person freigeber,
            OffsetDateTime eingetragenAm) {}

    /**
     * Ein Wert = ein Schlüssel (Periode bzw. Zeitpunkt) mit seinen Fassungen. {@code wirksamer_betrag}
     * ist {@code null} nach einer Rücknahme — nie 0 — und solange {@code stand_offen}. {@code vorschlag}: die
     * offene Berichtigung (Vier-Augen an, AP-09 IP-7) — sie ist noch keine Fassung; {@code null}, wenn keine offen ist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wert(
            LocalDate periodeVon,
            LocalDate periodeBis,
            OffsetDateTime zeitpunkt,
            String zeitzone,
            String wirksamerBetrag,
            Integer wirksameFassung,
            boolean standOffen,
            List<Fassung> fassungen,
            Vorschlag vorschlag) {}

    /**
     * {@code POST /api/v1/bezugsgroessen/{id}/werte} (AP-09 IP-7): die Periode, wie die Regel {@code periode} sie liest
     * („2026-10“, „Oktober 2026“), und der Wert, wie ein Mensch ihn tippt („48.200“).
     */
    public record WertAnfrage(String periode, String wert) {}

    /** {@code POST …/{id}/werte/{periode}/berichtigung}: der neue Wert als Text und die Begründung (10 bis 500 Zeichen). */
    public record BerichtigungAnfrage(String wert, String begruendung) {}

    /** Ein Hinweis zu einem angenommenen Wert (U6 {@code wert_unplausibel}) — er informiert, er verhindert nichts. */
    public record Hinweis(String code, String satz) {}

    /** Die offene Berichtigung eines Werts (F3): bis zur Freigabe gilt die wirksame Fassung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschlag(
            String kennung,
            String betrag,
            int ersetztFassung,
            String begruendung,
            Person urheber,
            OffsetDateTime eingetragenAm) {}

    /**
     * Die Antwort auf eine Eingabe oder Berichtigung (AP-09 IP-7): {@code urteil} {@code neu} · {@code wiederholung} ·
     * {@code berichtigung} · {@code vorschlag} mit seinem Satz aus dem Vertrag, die Kennung des Vorgangs
     * ({@code BK-…}, nur bei einer Berichtigung), die Hinweise und der Wert mit allen Fassungen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eingabe(String urteil, String satz, String kennung, List<Hinweis> hinweise, Wert wert) {}

    /** {@code GET /api/v1/bezugsgroessen/{id}/werte}: der Zeitraum, die Lesart und die Werte. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Werte(
            UUID bezugsgroesseId,
            String kennzeichen,
            String wertart,
            String einheit,
            String periodeArt,
            LocalDate von,
            LocalDate bis,
            String fassungen,
            List<Wert> werte) {}
}
