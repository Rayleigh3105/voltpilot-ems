package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * UEMS EZ-6: die Formen der Anlagensteuerung (Konzept vp-erzeuger-wago-konzept §4.2, EW-3 A) — eine
 * Erzeugeranlage mit VoltPilot-Registerbild in der SPS, gezeigt in den bestehenden Seiten. Snake-Case wie
 * {@link GeraetDto}; „nicht erhoben“ ist null, nie abwesend und nie 0.
 */
public final class AnlagensteuerungDto {
    private AnlagensteuerungDto() {}

    /** {@code GET /api/v1/sites/{siteId}/anlagensteuerungen}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(Einrichtung einrichtung, List<Anlagensteuerung> steuerungen) {}

    /**
     * Ob das Portal den Weg „Steuerung verbinden“ anbieten darf (Mischbetrieb): erst, wenn eine Box der Anlage
     * das Fähigkeitswort {@code erzeuger_registerbild} meldet. {@code grund} nennt sonst den Grund
     * ({@code keine_box} · {@code box_ohne_faehigkeit}), null wenn möglich.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einrichtung(boolean moeglich, String grund, List<Box> boxen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Box(UUID deviceId, boolean faehig) {}

    /** Eine Anlagensteuerung: das Gerät, seine Datenquelle, die laufende Fassung und die Einheiten. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlagensteuerung(
            UUID geraetId,
            String kennzeichen,
            String einbauKennzeichen,
            String bezeichnung,
            String hersteller,
            String typ,
            OffsetDateTime eingebautAm,
            /* Die Komponente „Anlagensteuerung“, die die Messpunkte an die Datenquelle bindet. */
            UUID entityId,
            Datenquelle datenquelle,
            Fassung fassung,
            List<Einheit> einheiten,
            /* UEMS EZ-16: der Stand des SPS-Programms, gelesen gegen das Soll. */
            Programmstand programmstand) {}

    /**
     * UEMS EZ-16: welcher Stand des VoltPilot-SPS-Programms auf der Steuerung läuft (Kopf-Register 7, JJMM) gegen
     * den erwarteten. {@code zustand}: {@code aktuell} · {@code aelter} (älter als erwartet — Kandidat für die
     * Überwachung, {@code warnen}) · {@code unbekannt} (kein gültiger Wert; {@code ist} ist dann null, nie 0).
     * {@code sollQuelle}: {@code fassung} (die Registerbild-Fassung nennt ihn) · {@code bibliothek} (der Stand der
     * VoltPilot-Bibliothek). {@code gemessenAm} ist das Datenalter des Ist-Werts.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Programmstand(
            String zustand,
            Integer ist,
            String istText,
            int soll,
            String sollText,
            String sollQuelle,
            OffsetDateTime gemessenAm,
            boolean warnen) {}

    /** {@code unitId} = die Modbus-Geräte-ID der Steuerung hinter der Datenquelle; {@code boxId} liest sie jetzt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Datenquelle(UUID id, String kennzeichen, String adresse, Integer unitId, UUID boxId) {}

    /** Das Soll des Registerbilds ab {@code gueltigAb} (Bildart {@code erzeuger}). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(
            UUID id,
            String bildart,
            int basisadresse,
            int funktionscode,
            String wortfolge,
            int teAnzahl,
            String anlagenart,
            Long steuerungKennung,
            List<RseStufe> rseStufen,
            int veraltetNetzpunktS,
            /* UEMS EZ-16: der erwartete Programmstand (JJMM); null = folgt der VoltPilot-Bibliothek. */
            Integer programmstandSoll,
            OffsetDateTime gueltigAb) {}

    /** Bedeutung einer Rundsteuer-Stufe: Stufe n heißt {@code prozent} % Wirkleistung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RseStufe(
            @NotNull @Min(1) @Max(16) Integer stufe,
            @NotNull @DecimalMin("0") @DecimalMax("100") BigDecimal prozent) {}

    /** Eine Erzeugungseinheit (Wechselrichter oder BHKW-Motor) mit ihrer TE-Nr. im Bild. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einheit(
            UUID teilId,
            int teNr,
            String einheitArt,
            String bezeichnung,
            String typ,
            String typBild,
            BigDecimal nennleistungKw,
            String registryUnitId,
            OffsetDateTime eingebautAm) {}

    /** {@code POST /api/v1/sites/{siteId}/anlagensteuerungen}: Steuerung, Fassung und Einheiten in einem Schritt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(
            @NotNull UUID dataSourceId,
            @NotNull @Min(0) @Max(255) Integer unitId,
            @Size(max = 120) String bezeichnung,
            @Size(max = 200) String hersteller,
            @Size(max = 200) String typ,
            @Min(0) @Max(65535) Integer basisadresse,
            Integer funktionscode,
            String wortfolge,
            @NotNull String anlagenart,
            @Min(0) @Max(4294967295L) Long steuerungKennung,
            @Size(max = 16) List<@NotNull @Valid RseStufe> rseStufen,
            @Min(1) @Max(65534) Integer veraltetNetzpunktS,
            /* UEMS EZ-16: JJMM; leer = folgt der VoltPilot-Bibliothek. */
            @Min(1) @Max(9912) Integer programmstandSoll,
            @NotEmpty @Size(max = 10) List<@NotNull @Valid NeueEinheit> einheiten) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NeueEinheit(
            @NotNull @Min(1) @Max(10) Integer teNr,
            String einheitArt,
            @Size(max = 120) String bezeichnung,
            @Size(max = 200) String typ,
            @Size(max = 32) String typBild,
            @DecimalMin(value = "0", inclusive = false) BigDecimal nennleistungKw,
            @Pattern(regexp = "^SEE[0-9]{12}$") String registryUnitId) {}

    /**
     * {@code PUT /api/v1/geraete/{id}/anlagensteuerung/einheiten/{teNr}}: ersetzt die Angaben der Einheit.
     * Umbenennen ändert nur die Anzeige — Nummer und Messreihe bleiben dieselben.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record EinheitAendern(
            String einheitArt,
            @Size(max = 120) String bezeichnung,
            @Size(max = 200) String typ,
            @DecimalMin(value = "0", inclusive = false) BigDecimal nennleistungKw,
            @Pattern(regexp = "^SEE[0-9]{12}$") String registryUnitId) {}

    /**
     * {@code POST /api/v1/geraete/{id}/anlagensteuerung/namen}: was das Bild ab {@code beschreibung_ab} nennt
     * (Konzept §3.10), aus einer Lesung. Gespeichert als Vorbelegung: eine leere Anzeige wird gefüllt, eine
     * vorhandene nie überschrieben. Leer/null = das Bild nennt keinen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NamenAusBild(
            @Size(max = 32) String netzbetreiber,
            @Size(max = 32) String direktvermarkter,
            @Size(max = 10) List<@NotNull @Valid TypAusBild> einheiten) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record TypAusBild(@NotNull @Min(1) @Max(10) Integer teNr, @Size(max = 32) String typ) {}

    /** {@code GET /api/v1/sites/{siteId}/anlagensteuerungen/{geraetId}/werte}: der jüngste Wert je Punkt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Werte(
            UUID geraetId,
            UUID entityId,
            /* noch_keine_daten (kein einziger Wert) · daten. */
            String stand,
            OffsetDateTime abgerufenAm,
            List<Wert> werte) {}

    /**
     * Der jüngste Wert eines Punkts. {@code zustand}: {@code keine_daten} (kein Wert — {@code wert} ist null,
     * nie 0) · {@code aktuell} · {@code veraltet} (Qualität nicht gut oder älter als die Frist). Zustände tragen
     * ihr {@code wort}/{@code text}, Bitfelder die gesetzten {@code bits}; außerhalb des Vokabulars bleibt der
     * Rohwert ohne Wort.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wert(
            String pointKey,
            String abschnitt,
            String feld,
            Integer teNr,
            String art,
            String einheit,
            BigDecimal wert,
            OffsetDateTime gemessenAm,
            String qualitaet,
            String zustand,
            String wort,
            String text,
            List<Bit> bits) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bit(int bit, String wort, String text) {}

    /** {@code GET/PUT /api/v1/sites/{siteId}/netz-vermarktung}: Stammdaten Netz und Vermarktung der Anlage. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NetzVermarktung(
            UUID siteId,
            /* Der Netzbetreiber steht am Netzanschluss (heute gebunden); hier nur gelesen. */
            String netzbetreiber,
            String direktvermarkter,
            String direktvermarkterKanal,
            String einspeisemanagement,
            BigDecimal einspeisemanagementProzent,
            NamenImBild namenAusBild,
            List<Hinweis> hinweise,
            int revision) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NamenImBild(String netzbetreiber, String direktvermarkter, OffsetDateTime gelesenAm) {}

    /**
     * Ein Hinweis statt eines stillen Überschreibens: {@code netzbetreiber_abweichung} (das Bild nennt einen
     * anderen Netzbetreiber als der Netzanschluss) · {@code netzbetreiber_nicht_eingetragen} (das Bild nennt
     * einen, am Netzanschluss steht keiner).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Hinweis(String art, String text, String bild, String eintrag) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NetzVermarktungAendern(
            @NotNull Integer expectedRevision,
            @Size(max = 120) String direktvermarkter,
            String direktvermarkterKanal,
            String einspeisemanagement,
            @DecimalMin("0") @DecimalMax("100") BigDecimal einspeisemanagementProzent) {}
}
