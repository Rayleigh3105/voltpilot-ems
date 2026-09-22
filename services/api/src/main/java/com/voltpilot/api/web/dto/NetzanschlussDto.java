package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Netzanschluss-Schnittstelle (UEMS AP-10 IP-6): {@code /api/v1/standorte/{id}/netzanschluesse}
 * und {@code …/netzanschluesse/{id}/anlagen}. snake_case wie die übrigen UEMS-Schnittstellen und die
 * Vektor-Datei des Vertrags; Tage als {@code JJJJ-MM-TT}, {@code gueltig_bis} ist der LETZTE gültige Tag
 * (einschließlich), {@code null} = offen.
 */
public final class NetzanschlussDto {
    private NetzanschlussDto() {}

    /**
     * {@code POST …/netzanschluesse} und {@code PUT …/netzanschluesse/{id}} (die ganze Menge — ein fehlendes
     * Feld ist leer). Beim Anlegen heißt {@code kennzeichen = null}: automatisch vergeben ({@code NA-0001}).
     * Die Leistungen als Zahl oder Dezimaltext.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anschluss(String kennzeichen, String name, String malo, String netzbetreiber, BigDecimal anschlussKva,
            BigDecimal vereinbartKw, String messung, String gueltigAb, String gueltigBis) {}

    /** {@code POST …/netzanschluesse/{id}/anlagen}: ab diesem Tag hängt die Anlage an diesem Netzanschluss. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Binden(String anlageId, String gueltigAb, String grund) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschlag(UUID anlageId, String anlageName, LocalDate bindungAb, String kennzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Uebernehmen(String kennzeichen, String name, String malo, String netzbetreiber,
            BigDecimal anschlussKva, BigDecimal vereinbartKw, String messung, String gueltigAb,
            String gueltigBis, String bindungAb, String grund) {}

    /** Ein Verweis auf den Standort: ID und Kurzzeichen. */
    public record Standort(UUID id, String kurzzeichen) {}

    /** Die Anlage einer Bindung; {@code name} ist {@code null}, wenn die Anlage gelöscht ist. */
    public record Anlage(UUID id, String name) {}

    /** Ein Intervall Anlage ↔ Netzanschluss. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bindung(UUID id, Anlage anlage, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Ein Netzanschluss. {@code hinweise} sind die des Vertrags ({@code vereinbart_ueber_anschluss}) — sie
     * halten nichts an. {@code anlagen}: die wirksamen Bindungen (mit {@code stichtag} nur die an dem Tag).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Netzanschluss(UUID id, String kennzeichen, String name, Standort standort, String malo,
            String netzbetreiber, BigDecimal anschlussKva, BigDecimal vereinbartKw, String messung, LocalDate gueltigAb,
            LocalDate gueltigBis, List<String> hinweise, List<Bindung> anlagen, OffsetDateTime angelegtAm) {}

    /**
     * {@code GET …/netzanschluesse?stichtag=}: ohne Stichtag alle, mit nur die an dem Tag bestehenden.
     * {@code kennzeichen_vorschlag} ist das nächste automatische Kennzeichen — vergeben wird es erst beim Anlegen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Netzanschluesse(Standort standort, LocalDate stichtag, String kennzeichenVorschlag,
            List<Netzanschluss> netzanschluesse) {}

    /**
     * {@code POST …/netzanschluesse/{id}/grenzen} (UEMS AP-15 IP-3): ab {@code gueltig_ab} gilt diese Fassung des
     * Grenzblatts — bis zum Vortag der nächsten. {@code null} in einer Richtung = dort keine Grenze am Anschluss;
     * die Leistungen als Zahl oder Dezimaltext.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzeSetzen(String gueltigAb, BigDecimal einspeisegrenzeKw, BigDecimal bezugsgrenzeKw,
            String grund) {}

    /** Eine wirksame Fassung des Grenzblatts. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzFassung(LocalDate gueltigAb, BigDecimal einspeisegrenzeKw, BigDecimal bezugsgrenzeKw,
            OffsetDateTime eingetragenAm) {}

    /**
     * {@code GET …/netzanschluesse/{id}/grenzen}: alle wirksamen Fassungen und die am {@code stichtag} (ohne: heute am
     * Standort) gültige — {@code null}, wenn keine gilt. Was an der Anlage WIRKT, ist der engere Wert aus Anlage und
     * dieser Fassung ({@code GrenzeAufloesung}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Grenzblatt(UUID netzanschlussId, String kennzeichen, LocalDate stichtag, GrenzFassung gilt,
            List<GrenzFassung> fassungen) {}

    /**
     * {@code GET …/netzanschluesse/{id}/grenznachweis?monat=} (UEMS AP-15 IP-31, NW-8, M-1, M-2): je Richtung das
     * höchste Viertelstunden-Mittel am Hauptzähler gegen die an seinem Tag wirksame Grenze, die Viertelstunden darüber
     * und die Unterbrechungen — gerechnet über die abgeschlossenen Tage des Monats ({@code von}..{@code bis}, beide
     * eingeschlossen; {@code null}, wenn noch keiner abgeschlossen ist). {@code grenze_geprueft} ist wahr, wo in einer
     * Richtung Grenze UND Hauptzähler vorliegen; sonst sagt {@code grund}, warum nicht.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record GrenzNachweis(UUID netzanschlussId, String kennzeichen, String monat, LocalDate von, LocalDate bis,
            OffsetDateTime zeitraumVon, OffsetDateTime zeitraumBis, String zeitzone, boolean grenzeGeprueft,
            String grund, String urteil, List<GrenzNachweisRichtung> richtungen) {}

    /**
     * Eine Richtung ({@code bezug} · {@code einspeisung}). {@code viertelstunden} zählt nur die mit Grenze;
     * {@code belegt_prozent} ist abgerundet — 100 nur, wenn nichts fehlt. {@code augenblick} ist M-2.
     * {@code ausserhalb_zugriff} statt der Zahlen, wenn ein Hauptzähler außerhalb des Zugriffs liegt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record GrenzNachweisRichtung(String richtung, boolean grenzeGeprueft, String grund, String urteil,
            List<GrenzAbschnitt> grenzen, List<MessstelleKurz> hauptzaehler, GrenzViertelstunden viertelstunden,
            Integer belegtProzent, GrenzHoechstes hoechstesMittel, GrenzDarueber darueber,
            List<GrenzUnterbrechung> unterbrechungen, GrenzAugenblick augenblick,
            List<String> grenzherkunft, String grenzhinweis,
            @JsonInclude(JsonInclude.Include.NON_NULL) String ausserhalbZugriff) {}

    /** Die wirksame Grenze einer Richtung über zusammenhängende Tage (engerer Wert aus Anlage und Anschluss). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzAbschnitt(LocalDate von, LocalDate bis, BigDecimal kw, String quelle) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MessstelleKurz(UUID id, String kennzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzViertelstunden(int erwartet, int belegt, int unvollstaendig, int fehlend) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzHoechstes(OffsetDateTime von, OffsetDateTime bis, BigDecimal mittelKw, BigDecimal grenzeKw,
            BigDecimal abstandKw) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzDarueber(int viertelstunden, long minuten) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzUnterbrechung(OffsetDateTime von, OffsetDateTime bis, long minuten, BigDecimal hoechstwertKw,
            BigDecimal grenzeKw) {}

    /** M-2: {@code nicht_gemessen} mit dem Grund — die Mess-Welt hat heute keine Dauer über der Grenze. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GrenzAugenblick(String status, String grund) {}
}
