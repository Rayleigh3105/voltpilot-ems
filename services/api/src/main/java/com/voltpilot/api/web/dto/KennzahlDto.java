package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Formen der Kennzahl-Schnittstelle (UEMS AP-11 IP-5, {@code /api/v1/kennzahlen}).
 *
 * <p>snake_case wie der Kennzahl-Vertrag ({@code docs/contracts/v2/kennzahl.md}); die Wörter (Rechenform,
 * Geltungsbereich-Art, Eingangs-Rolle und -Art, Periodenart) sind seine Vokabulare. Beträge reisen als
 * DEZIMALTEXT. Ein Eingang wird über das Kennzeichen seines Objekts genannt (MS-12, BZ-6, KZ-0001) — gespeichert
 * wird der Verweis auf das Objekt, eine spätere Umbenennung ändert die Berechnung nicht.
 */
public final class KennzahlDto {
    private KennzahlDto() {}

    /** Ein Eingang der Anfrage: {@code rolle} zaehler · nenner · paar, {@code art} messstelle · bezugsgroesse · kennzahl. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eingang(String rolle, String art, String kennzeichen) {}

    /**
     * {@code POST /api/v1/kennzahlen} und {@code POST …/vorschau}: Stammdaten, Geltungsbereich und die Berechnung
     * der Fassung 1. Ohne {@code kennzeichen} vergibt der Server KZ-0001 …; ohne {@code verantwortlich_name} ist der
     * Aufrufer verantwortlich. {@code periode_art} ist ein WUNSCH, der geprüft, aber nicht gespeichert wird — die
     * Kennzahl entsteht in allen bildbaren Perioden (P2). {@code komplement} nur beim Anteil.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anfrage(
            String kennzeichen,
            String name,
            String rechenform,
            String geltungArt,
            String geltungId,
            String verantwortlichName,
            String zweck,
            String periodeArt,
            Boolean komplement,
            List<Eingang> eingaenge) {}

    /** {@code PUT …/{id}}: die GANZEN Stammdaten (V4) — Geltungsbereich und Rechenform sind fest. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StammdatenAnfrage(String kennzeichen, String name, String verantwortlichName, String zweck) {}

    /** {@code POST …/{id}/fassungen}: die Berechnung ab einem Tag, mit Begründung, auch rückwirkend (V1). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungAnfrage(
            String gueltigAb,
            String begruendung,
            String periodeArt,
            Boolean komplement,
            List<Eingang> eingaenge) {}

    /** Wer eine Fassung eingetragen hat (Akteur-Vokabular AP-03). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(String name, String rolle, String art) {}

    /** Ein Eingang einer Fassung mit dem HEUTIGEN Kennzeichen und Namen seines Objekts. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record EingangAntwort(String rolle, String art, UUID id, String kennzeichen, String name) {}

    /**
     * Eine Fassung der Berechnung (V1): {@code gueltig_ab} {@code null} = gilt seit Beginn, {@code gueltig_bis} der
     * LETZTE Tag einschließlich; {@code abzeichen} „rückwirkend (n Tage)“ nur bei einer rückwirkenden.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Fassung(
            int nummer,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            OffsetDateTime aufgehobenAm,
            String herkunft,
            boolean rueckwirkend,
            String abzeichen,
            String begruendung,
            Person eingetragenVon,
            OffsetDateTime eingetragenAm,
            String rechenform,
            String einheit,
            String einheitAnzeige,
            boolean komplement,
            List<EingangAntwort> eingaenge) {}

    /**
     * Eine Kennzahl — das Lesemodell der Definition. {@code rechte_geltung} und {@code kennung} folgen aus dem
     * Geltungsbereich (G1); {@code standort_id} ist der Standort des Objekts heute ({@code null} beim Unternehmen).
     * {@code fassung}, {@code einheit}, {@code grundperiode} und {@code perioden} beschreiben die HEUTE geltende
     * Berechnung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Kennzahl(
            UUID id,
            String kennzeichen,
            String name,
            String rechenform,
            String geltungArt,
            UUID geltungId,
            String geltungName,
            String rechteGeltung,
            UUID standortId,
            String kennung,
            String verantwortlichName,
            String zweck,
            Integer fassung,
            String einheit,
            String einheitAnzeige,
            String grundperiode,
            List<String> perioden,
            boolean hatWerte,
            OffsetDateTime archiviertAm,
            OffsetDateTime angelegtAm,
            Bezugsbasis bezugsbasis,
            @JsonInclude(JsonInclude.Include.NON_NULL) Auswertung auswertung,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean leitkennzahl) {

        /** Die Kennzahl ohne Auswertung - so antwortet jede Route außer {@code GET …?mit=auswertung}. */
        public Kennzahl(UUID id, String kennzeichen, String name, String rechenform, String geltungArt, UUID geltungId,
                String geltungName, String rechteGeltung, UUID standortId, String kennung, String verantwortlichName,
                String zweck, Integer fassung, String einheit, String einheitAnzeige, String grundperiode,
                List<String> perioden, boolean hatWerte, OffsetDateTime archiviertAm, OffsetDateTime angelegtAm,
                Bezugsbasis bezugsbasis) {
            this(id, kennzeichen, name, rechenform, geltungArt, geltungId, geltungName, rechteGeltung, standortId, kennung,
                    verantwortlichName, zweck, fassung, einheit, einheitAnzeige, grundperiode, perioden, hatWerte,
                    archiviertAm, angelegtAm, bezugsbasis, null, null);
        }

        /** Dieselbe Kennzahl mit ihrer Auswertung. */
        public Kennzahl mitAuswertung(Auswertung a) {
            return new Kennzahl(id, kennzeichen, name, rechenform, geltungArt, geltungId, geltungName, rechteGeltung,
                    standortId, kennung, verantwortlichName, zweck, fassung, einheit, einheitAnzeige, grundperiode, perioden,
                    hatWerte, archiviertAm, angelegtAm, bezugsbasis, a, leitkennzahl);
        }

        /**
         * Nur an {@code GET …/{id}?mit=auswertung} (die Seite einer Kennzahl): ob sie die Leitkennzahl der Übersicht ist
         * (Konzept Auswerten a1 §10.8) - die Liste nennt sie stattdessen als {@code leitkennzahl} der Liste.
         */
        public Kennzahl alsLeitkennzahl(boolean leit) {
            return new Kennzahl(id, kennzeichen, name, rechenform, geltungArt, geltungId, geltungName, rechteGeltung,
                    standortId, kennung, verantwortlichName, zweck, fassung, einheit, einheitAnzeige, grundperiode, perioden,
                    hatWerte, archiviertAm, angelegtAm, bezugsbasis, auswertung, leit);
        }
    }

    /**
     * Die laufende Bezugsbasis am Register-Eintrag (AP-17 IP-8, B3) oder {@code null}: {@code fassung} ist die laufende
     * freigegebene Fassung, sonst die jüngste. Das Wort „Energieleistungskennzahl“ leitet der Leser aus
     * {@code freigabe_status = freigegeben} ab — es steht an der Kennzahl, nicht in ihr.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezugsbasis(String kennzeichen, Integer fassung, String freigabeStatus, boolean vorlaeufig) {}

    /** Nur Anzahl und Kundensatz, keine Identität einer verborgenen Kennzahl. */
    public record ZugriffHinweis(int anzahl, String text) {}

    /**
     * {@code GET /api/v1/kennzahlen}: archivierte eingeschlossen, nach Kennzeichen (ein Objekt, additiv erweiterbar).
     *
     * @param leitkennzahl nur mit {@code mit=auswertung}: die Kennzahl, die die Leitkachel der Übersicht zeigt (Konzept
     *     Auswerten a1 §10.8, dieselbe Wahl wie {@code GET /api/v1/portfolio/kpis}); fehlt ohne eine
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(List<Kennzahl> kennzahlen,
            @JsonInclude(JsonInclude.Include.NON_NULL) ZugriffHinweis ausserhalbZugriff,
            @JsonInclude(JsonInclude.Include.NON_NULL) UUID leitkennzahl) {

        public Liste(List<Kennzahl> kennzahlen, ZugriffHinweis ausserhalbZugriff) {
            this(kennzahlen, ausserhalbZugriff, null);
        }
    }

    // ============================================================================ Auswertung (Konzept Auswerten a1, PR1)

    /**
     * Wie eine Kennzahl steht - für die Liste „Kennzahlen“ (Konzept Auswerten a1 §6.4), die Seite einer Kennzahl (§6.5)
     * und die Leitkachel der Übersicht (§10.8: ein Urteil, eine Ableitung). Nur mit {@code mit=auswertung} an
     * {@code GET /api/v1/kennzahlen} oder {@code GET /api/v1/kennzahlen/{id}} und nur an einer nicht archivierten Kennzahl
     * mit Monatswerten; sonst fehlt das Feld. Urteil und Abweichungen sind die Operation {@code vergleich} des
     * Bezugsbasis-Lesers, die Veränderungen zu Vorjahr und Vormonat die Operation {@code roh} (ohne Urteil, VG3), der
     * Zeitraum die Operation {@code zeitraum} (U5), der Stand des Energieziels der Leser des Ziels. Selbst gerechnet
     * werden nur die Mengen je Monat ({@link AuswertungMonat}).
     *
     * @param monat der letzte abgeschlossene Monat ({@code JJJJ-MM}) in der Zone der Geltung - für ihn gilt das Urteil
     * @param wert der jüngste Monatswert der zwölf Monate bis {@code monat}; {@code null} ohne jeden
     * @param vorjahr die Veränderung von {@code wert} gegen denselben Monat ein Jahr davor; {@code null} ohne beide Werte
     * @param vormonat die Veränderung von {@code wert} gegen den Monat davor; {@code null} ohne beide Werte
     * @param monate die zwölf Monate bis {@code monat}, der älteste zuerst
     * @param vergleich {@code null} ohne freigegebene Bezugsbasis
     * @param zeitraum der Vergleich über die Monate der zwölf, für die schon eine Fassung gilt (§10.6); {@code null}
     *     ohne Bezugsbasis oder solange noch keine Fassung gilt
     * @param energieziel das offene Energieziel der Kennzahl mit seinem Stand; {@code null} ohne
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Auswertung(String monat, AuswertungWert wert, AuswertungRoh vorjahr, AuswertungRoh vormonat,
            List<AuswertungMonat> monate, AuswertungVergleich vergleich, AuswertungZeitraum zeitraum,
            AuswertungZiel energieziel) {}

    /**
     * Ein Monatswert der Kennzahl, wie {@code …/werte} ihn zeigt ({@link Wert}): ungerundeter Dezimaltext, Einheit der
     * Fassung, Zustand und bei „unvollständig“ die Richtung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AuswertungWert(String periode, String wert, String einheit, String zustand, String richtung) {}

    /**
     * Die rohe Veränderung gegen den Monat {@code periode} (Vorjahresmonat oder Vormonat; Prozent mit einer Stelle) mit
     * dessen Wert; trägt nie ein Urteil.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AuswertungRoh(String periode, String wert, String deltaProzent, String richtung) {}

    /**
     * Ein Monat der zwölf: der Kennzahlwert ({@code null} = keiner) und - mit Bezugsbasis - die bereinigte Abweichung mit
     * Urteil und Grund aus dem Vergleich. Dazu die Mengen, die die Seite der Kennzahl zeigt; sie rechnet der Server exakt
     * aus der Zeile des Vergleichs (ungerundeter Dezimaltext, das Portal rundet nur zur Anzeige):
     *
     * @param erwartetWert der erwartete Kennzahlwert: erwartet ÷ Nenner des Monats, wie der Kennzahlwert gerundet
     *     ({@link com.voltpilot.api.uems.KennzahlRegeln#WERT_NACHKOMMASTELLEN}); {@code null} ohne erwartet oder Nenner
     * @param abweichung gemessen − erwartet in der Einheit des Zählers (positiv = mehr als erwartet); {@code null} ohne
     *     beide
     * @param zusammen die Abweichungen aller Monate mit Urteil von den zwölf bis hierher zusammengezählt; {@code null}
     *     an einem Monat ohne Urteil (er zählt nicht mit, die Linie hat dort eine Lücke)
     * @param vorjahr der Wert desselben Monats ein Jahr früher mit der rohen Veränderung (Operation {@code roh}, nie ein
     *     Urteil) - Vorjahrespunkt, Infozeile und Spalte „ggü. Vorjahr“; {@code null} ohne beide Werte oder mit 0 davor
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AuswertungMonat(String periode, String wert, String deltaProzent, String urteil, String grund,
            String erwartetWert, String abweichung, String zusammen, AuswertungRoh vorjahr) {}

    /**
     * Das Urteil des Monats {@code monat} gegen die Bezugsbasis {@code bezugsbasis} (U1-U6) mit dem Kundensatz des Monats.
     *
     * @param ersterMonat nur, solange noch keine Fassung gilt: der erste Monat ({@code JJJJ-MM}), für den eine freigegebene
     *     Fassung am letzten Tag gilt (P4) - „Vergleich ab …“
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AuswertungVergleich(String bezugsbasis, String urteil, String deltaProzent, String bandProzent,
            String richtung, String grund, String satz, String ersterMonat) {}

    /**
     * Der Vergleich über {@code von} … {@code bis} (Operation {@code zeitraum}, Σ gemessen ÷ Σ erwartet, U5) - beginnt
     * mit dem ersten der zwölf Monate, für den eine freigegebene Fassung gilt (§10.6), nie davor.
     *
     * @param monate „x von y“ Monaten mit Vergleich, wie der Leser es zählt
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AuswertungZeitraum(String von, String bis, String deltaProzent, String bandProzent, String richtung,
            String urteil, String grund, String monate, String satz) {}

    /**
     * Das offene Energieziel der Kennzahl und sein Stand (Z3): die Summe über die bewertbaren Monate der Zielperiode
     * ({@code delta_prozent}, {@code richtung}, {@code urteil}; {@code null} ohne bewertbaren Monat) und „x von y“.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AuswertungZiel(UUID id, String kennzeichen, String zielwertProzent, String zielperiode,
            String deltaProzent, String richtung, String urteil, int monateBewertbar, int monateSoll) {}

    /**
     * {@code GET /api/v1/kennzahlen/paare}: die möglichen Paare einer Zusammenfassung (AP-11 IP-11, R4) — gruppiert nach
     * Rechenform und Einheit; eine Zusammenfassung nimmt mindestens zwei aus EINER Gruppe.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Paare(List<PaarGruppe> gruppen) {}

    /** Eine Gruppe: dieselbe Rechenform, dieselbe Einheit der heute geltenden Fassung; Kennzahlen nach Kennzeichen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record PaarGruppe(String rechenform, String einheit, String einheitAnzeige, List<Kennzahl> kennzahlen) {}

    /** {@code GET …/{id}/fassungen}: jede Fassung, nach Nummer. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassungen(UUID kennzahlId, String kennzeichen, List<Fassung> fassungen) {}

    /** {@code GET …/{id}/berechnung?am=}: die Fassung, die an dem Tag galt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Berechnung(UUID kennzahlId, String kennzeichen, LocalDate am, Fassung fassung) {}

    /** Ein Befund der Vorschau: dieselbe Ablehnung, die das Anlegen antworten würde. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Befund(String code, String message, Map<String, Object> fakten) {}

    /** Eine Periode der Vorschau, gerechnet wie die Regel {@code wert} — nichts davon wird gespeichert. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record VorschauPeriode(
            String periodeArt,
            String schluessel,
            String beschriftung,
            LocalDate von,
            LocalDate bis,
            String wert,
            String zaehler,
            String nenner,
            String zustand,
            String richtung,
            String grund,
            String abdeckungProzent,
            String fassung,
            List<String> kennzeichen,
            String anzeige,
            String kundensatz) {}

    /**
     * {@code POST …/vorschau}: die Befunde (leer = das Anlegen würde gelingen) und — nur ohne Befund — die letzten
     * drei abgeschlossenen Perioden. Die Vorschau läuft in einer Nur-Lese-Transaktion und schreibt nichts.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Vorschau(
            List<Befund> befunde,
            String rechteGeltung,
            UUID standortId,
            String kennung,
            String einheit,
            String einheitAnzeige,
            String grundperiode,
            List<String> perioden,
            String periodeArt,
            List<VorschauPeriode> letztePerioden) {}

    // ============================================================================ Werte (IP-7)

    /** Die Kennzahl im Kopf ihrer Werte — Einheit und Anzeige-Wort der HEUTE geltenden Berechnung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record WerteKennzahl(UUID id, String kennzeichen, String name, String rechenform, String einheit,
            String einheitAnzeige) {}

    /**
     * {@code GET …/{id}/werte?periode=&von=&bis=[&version=]} (AP-11 IP-7): je Periode von {@code von} (ihr erster Tag)
     * bis {@code bis} (der LETZTE Tag, einschließlich) ein Schritt. {@code version} ist die angefragte — ohne Angabe
     * {@code null}, dann zeigt jeder Schritt seine neueste.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Werte(WerteKennzahl kennzahl, String periode, LocalDate von, LocalDate bis, String zeitzone,
            Integer version, List<Wert> werte,
            @JsonInclude(JsonInclude.Include.NON_EMPTY) List<GeteiltesRegister> geteilteRegister) {

        public Werte(WerteKennzahl kennzahl, String periode, LocalDate von, LocalDate bis, String zeitzone,
                Integer version, List<Wert> werte) {
            this(kennzahl, periode, von, bis, zeitzone, version, werte, List.of());
        }
    }

    /**
     * Summen-Wächter des geteilten Punkts (AP-07 IP-18b) an einer Zusammenfassung: in der Summe {@code rolle}
     * ({@code zaehler} · {@code nenner} der Paare) lesen die {@code messstellen} denselben Messpunkt {@code register}
     * derselben Box über zwei Komponenten. Liest jede Komponente dasselbe Gerät, zählt Σ den Wert zweimal. Eine
     * Warnung NEBEN den Werten - sie ändert keine; ohne Fund fehlt das Feld (Bestand Byte für Byte gleich).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GeteiltesRegister(String rolle, String register, List<String> messstellen) {}

    /**
     * Ein Schritt — die Trägerform des Messstellen-Werts ({@code MessstelleWerteDto.Wert}) für eine Kennzahl: statt
     * Menge und Mittel der Wert mit Zähler und Nenner, dazu {@code richtung}, {@code definition_fassung} und die
     * Einheit der gelesenen Fassung. Jedes Feld steht immer da; {@code null} heißt „nicht bekannt“ oder „nicht
     * gebildet“ — nie 0.
     *
     * @param wert ungerundet als Dezimaltext — gerundet wird nur im Portal (U4)
     * @param einheit die Einheit der Fassung, mit der der Wert gebildet wurde (U1)
     * @param zustand das Wort des Ergebnis-Zustands; {@code null} NUR zusammen mit einem {@code grund} des Lesers
     * @param richtung untergrenze · obergrenze · unbestimmt — genau bei „unvollständig“ (Q3)
     * @param fassung {@code vorlaeufig} | {@code endgueltig} (Q6) — eine andere Aussage als {@code definition_fassung}
     * @param version die Version, deren Zahl der Schritt zeigt — ohne Anfrage die neueste; {@code null} = noch keine
     *     (ohne Zahl und ohne früheren Wert, K8)
     * @param definitionFassung die Fassung der Berechnung, die am letzten Tag der Periode galt (V2, V6)
     * @param grund warum der Schritt keine Zahl trägt: ein Wort von {@code grund_ohne_zahl} aus der gespeicherten Zeile
     *     oder eines des Lesers ({@code KennzahlWerteService.GRUENDE_DES_LESERS})
     * @param herkunft die Hülle {@code {satz, fehlt}} nach {@code kennzahlwert-herkunft.schema.json} an jeder Version,
     *     auch ohne Zahl (K19); {@code null} ohne Zeile oder ohne Version
     * @param versionen wie viele Versionen die Periode hat — ab 2 gibt es eine Historie unter {@code …/werte/versionen};
     *     {@code null}, solange keine gebildet ist
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Wert(
            LocalDate von,
            LocalDate bis,
            String schluessel,
            String beschriftung,
            String wert,
            String zaehler,
            String nenner,
            String einheit,
            String zustand,
            String richtung,
            List<String> kennzeichen,
            String abdeckungProzent,
            String fassung,
            String endgueltigAb,
            Integer version,
            Integer definitionFassung,
            String berechnetAm,
            String grund,
            Map<String, Object> herkunft,
            Integer versionen) {}

    /**
     * {@code GET …/{id}/werte/versionen?periode=&von=}: die Versions-Historie EINER Periode (Muster AP-08 IP-18) — je
     * Version der Wert davor und danach, wer, wann, warum. {@code grund} nur, wenn die Periode keine Version hat.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Historie(WerteKennzahl kennzahl, String periode, LocalDate von, LocalDate bis, String zeitzone,
            String grund, List<Version> versionen) {}

    /**
     * Eine Version der Periode.
     *
     * @param wertAlt Version n − 1, genau wie {@code version=n-1} sie zeigt; an Version 1 {@code null}
     * @param gebildetAm die erste Zeile dieser Version
     * @param nachgezogenAm eine vorläufige Version zieht als weitere Zeile derselben Nummer nach (V3) — die jüngste;
     *     sonst {@code null}
     * @param anlass an Version 1 {@code null}
     * @param entscheidungen wer wann warum — aus dem Vorgang, den der Anlass nennt
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Version(int version, Wert wertAlt, Wert wertNeu, String gebildetAm, String nachgezogenAm,
            Anlass anlass, List<Entscheidung> entscheidungen) {}

    /** Warum Version n ≥ 2 entstand, wie gespeichert: {@code art} eingang · definition, {@code beleg} der Text. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Anlass(String art, String beleg) {}

    /**
     * Eine Entscheidung hinter einer Version — die Form von {@code MessstelleWerteDto.Entscheidung} mit einem
     * weiteren Vorgang {@code berechnung} (die Fassung der Kennzahl). {@code fassung} ist {@code null}, wenn der Beleg
     * einen Vorgang nennt, dessen Fassung nicht lesbar ist ({@code fehlt} nennt es).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Entscheidung(
            String vorgang,
            String kennung,
            Integer fassung,
            String status,
            String methode,
            String art,
            MessstelleWerteDto.Urheber wer,
            String wann,
            String warum,
            String beleg,
            List<String> fehlt,
            MessstelleWerteDto.Angelegt angelegt) {}
}
