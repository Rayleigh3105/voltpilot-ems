package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die DTOs der berechneten Messstelle (UEMS AP-10, Formel-Typ „gewichtete Summe"): das Anlegen mit
 * ihren Termen, das Lesen der Formel und das Lesen von Live-Wert und Verlauf. Vertrag
 * {@code docs/contracts/v2/messstelle-formel.md}. Kundentexte kommen erst im Frontend — hier keine.
 */
public final class MessstelleFormelDto {

    private MessstelleFormelDto() {}

    /**
     * Ein Term der Anfrage. {@code eingang_art} ist {@code messkanal} (dann {@code entity_id} +
     * {@code point_key}), {@code messstelle} (dann {@code quell_messstelle_id}) oder — seit AP-10
     * IP-5 — {@code verteilung} (dann {@code quell_messstelle_id} + {@code verteilung_ziel}, die
     * Kostenstelle). {@code faktor} fehlend = 1; {@code vorzeichen} {@code +} oder {@code -};
     * {@code anteil} fehlend = {@code gesamt}. Ein Anteil, der (noch) nicht lesbar ist, wird benannt
     * abgelehnt ({@code AnteilLeseweg}). {@code gilt_als_erzeugung} (AP-08, fehlend = false) macht
     * einen richtungslosen Messkanal als Term zulaessig und laesst ihn in der Summe als Erzeugung
     * zaehlen — nur an einem Kanal OHNE Katalog-Richtung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record TermEingabe(
            String eingangArt,
            UUID entityId,
            String pointKey,
            UUID quellMessstelleId,
            String vorzeichen,
            Double faktor,
            Boolean giltAlsErzeugung,
            UUID verteilungZiel,
            String anteil) {}

    /**
     * {@code POST /api/v1/messstellen/berechnet}. Das Kennzeichen wird automatisch vergeben (E7);
     * {@code name} leer = ein Entwurf. Die Hauptgröße wird aus den Termen abgeleitet, nie gewählt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String name, String notiz, List<TermEingabe> terme, RolleAnlegen rolle, Kontext kontext,
            String formelTyp, LocalDate gueltigAb) {
        public Anlegen(String name, String notiz, List<TermEingabe> terme, RolleAnlegen rolle, Kontext kontext) {
            this(name, notiz, terme, rolle, kontext, null, null);
        }
        public Anlegen(String name, String notiz, List<TermEingabe> terme, RolleAnlegen rolle) {
            this(name, notiz, terme, rolle, null);
        }
        public Anlegen(String name, String notiz, List<TermEingabe> terme) {
            this(name, notiz, terme, null);
        }
    }

    /** Additiver Einstieg; ohne Kontext bleiben bestehende Anlagen-Aufrufer gültig. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kontext(String art, UUID siteId, UUID boxId, String geraetId) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RolleAnlegen(UUID entityId, String role, Boolean ersetzen) {}

    public record GeraetSummenwert(MessstelleDto.Messstelle messstelle, String rolle, Wert wert) {}

    /** Eine Messgröße wie im Messstellen-Vertrag. */
    public record Groesse(String groesse, String richtung, String einheit, String wertart) {}

    /**
     * Ein Term, so wie er gespeichert ist, mit der aufgelösten Größe des Messwerts (für die Anzeige).
     * {@code eingerichtet} sagt, ob sein Eingang noch auflösbar ist. {@code verteilung_ziel} und
     * {@code anteil} (AP-10 IP-5) stehen NUR in der Antwort, wenn der Term sie trägt — ein Term ohne
     * sie (jeder Term von vor IP-5, {@code anteil} = {@code gesamt}) antwortet Zeichen für Zeichen wie
     * vorher; die Portal-Fläche aus PR #689 liest dieselben Felder.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Term(
            int position,
            String eingangArt,
            UUID entityId,
            String pointKey,
            UUID quellMessstelleId,
            String vorzeichen,
            double faktor,
            boolean giltAlsErzeugung,
            Groesse groesse,
            boolean eingerichtet,
            @JsonInclude(JsonInclude.Include.NON_NULL) UUID verteilungZiel,
            @JsonInclude(JsonInclude.Include.NON_NULL) String anteil) {}

    /**
     * {@code GET /api/v1/messstellen/{id}/formel}: die Formel einer berechneten Messstelle — die
     * Terme der Fassung, die am Tag gilt (ohne {@code am}: heute). {@code formel_vorhanden}/
     * {@code eingaenge_eingerichtet} sind die Eingänge des Lebenszyklus. {@code fassung_am} steht
     * NUR in der Antwort, wenn {@code am} gefragt war: ohne {@code am} ist die Antwort Zeichen für
     * Zeichen die von vor AP-10 IP-3 (die Portal-Fläche aus PR #689 liest sie unverändert).
     * {@code ausserhalb_zugriff} steht NUR, wenn ein Eingang außerhalb des Zugriffs des Lesers liegt (AP-03 R-A6):
     * dann fehlt jeder Term, der ihn nennt, die übrigen sind lückenlos durchnummeriert.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Formel(
            UUID messstelleId,
            String schemaVersion,
            Groesse hauptgroesse,
            List<Term> terme,
            boolean formelVorhanden,
            boolean eingaengeEingerichtet,
            @JsonInclude(JsonInclude.Include.NON_NULL) FassungAm fassungAm,
            @JsonInclude(JsonInclude.Include.NON_NULL) String ausserhalbZugriff,
            @JsonInclude(JsonInclude.Include.NON_EMPTY) List<GeteiltesRegister> geteilteRegister) {

        public Formel(UUID messstelleId, String schemaVersion, Groesse hauptgroesse, List<Term> terme,
                boolean formelVorhanden, boolean eingaengeEingerichtet, FassungAm fassungAm) {
            this(messstelleId, schemaVersion, hauptgroesse, terme, formelVorhanden, eingaengeEingerichtet, fassungAm,
                    null);
        }

        /** Ohne Summen-Wächter: auch die Antwort für einen Leser, der nicht jeden Eingang sieht (keine Positionen). */
        public Formel(UUID messstelleId, String schemaVersion, Groesse hauptgroesse, List<Term> terme,
                boolean formelVorhanden, boolean eingaengeEingerichtet, FassungAm fassungAm, String ausserhalbZugriff) {
            this(messstelleId, schemaVersion, hauptgroesse, terme, formelVorhanden, eingaengeEingerichtet, fassungAm,
                    ausserhalbZugriff, List.of());
        }
    }

    /**
     * Summen-Wächter des geteilten Punkts (AP-07 IP-18b): die Terme an den {@code positionen} tragen dasselbe
     * Vorzeichen und lesen denselben Messpunkt {@code register} derselben Box über zwei Komponenten. Liest jede
     * Komponente dasselbe Gerät, zählt die Formel den Wert zweimal. Eine Warnung NEBEN den Termen - sie ändert keine
     * Zahl; ohne Fund fehlt das Feld (Bestand Byte für Byte gleich).
     */
    public record GeteiltesRegister(String register, List<Integer> positionen) {}

    /**
     * Der Tag, nach dem gefragt war, und die Fassung, die an ihm gilt — {@code fassung} ist
     * {@code null} (nie weggelassen), wenn an dem Tag keine gilt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record FassungAm(LocalDate tag, Fassung fassung) {}

    /**
     * Eine Formel-Fassung (AP-10 IP-3, Vertrag §6). {@code gueltig_ab} {@code null} = gilt seit
     * Beginn (Fassung 1 des Bestands und des Anlegens); {@code gueltig_bis} ist der LETZTE Tag,
     * einschließlich ({@code null} = bis auf Weiteres). {@code rueckwirkend}/{@code abzeichen}: vor dem
     * Eintragstag eingetragen, samt Zahl der Tage („rückwirkend (5 Tage)“, die Wörter des Ortsbaums).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Fassung(
            int nummer,
            String formelTyp,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            String herkunft,
            boolean rueckwirkend,
            String abzeichen,
            String begruendung,
            OffsetDateTime eingetragenAm) {}

    /**
     * {@code POST /api/v1/messstellen/{id}/formel/fassungen}: eine neue Fassung ab dem Tag
     * {@code gueltig_ab} mit ihren vollständigen Termen (wie beim Anlegen). {@code formel_typ}
     * fehlend = {@code gewichtete_summe} (heute der einzige); {@code begruendung} optional.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungEintragen(
            LocalDate gueltigAb,
            String formelTyp,
            List<TermEingabe> terme,
            String begruendung) {}

    /** Ein fehlender/veralteter Term, genannt statt verschwiegen (Ehrlichkeit). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FehlenderTerm(int position, String grund) {}

    /**
     * {@code GET /api/v1/messstellen/{id}/wert}: der Live-Wert = gewichtete Summe der frischesten
     * Eingangswerte. Fehlt/veraltet EIN Pflicht-Term, ist {@code wert} {@code null}
     * ({@code unvollstaendig} = true) und {@code fehlende} nennt die Terme — NIE eine Teilsumme.
     * {@code stand} ist der jüngste Messzeitpunkt der Eingänge (null, wenn unvollständig).
     * Der Live-Wert wird nie gespeichert; die Periodenwerte liegen seit AP-10 IP-10 in der Speicherklasse
     * ({@code GET …/messstellen/{kennzeichen}/werte}). Ein Rest (Formel-Typ {@code rest})
     * rechnet seine Terme aus der Stellung des Tages und antwortet in kW (Wirkleistung).
     * Liegt ein Eingang außerhalb des Zugriffs (AP-03 R-A3), fehlt die Zahl ganz: {@code wert}/{@code stand}
     * {@code null}, {@code fehlende} leer, {@code ausserhalb_zugriff} der Hinweis — nie eine Teilsumme.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wert(
            Double wert,
            String einheit,
            boolean unvollstaendig,
            List<FehlenderTerm> fehlende,
            OffsetDateTime stand,
            @JsonInclude(JsonInclude.Include.NON_NULL) String ausserhalbZugriff) {

        public Wert(Double wert, String einheit, boolean unvollstaendig, List<FehlenderTerm> fehlende,
                OffsetDateTime stand) {
            this(wert, einheit, unvollstaendig, fehlende, stand, null);
        }
    }

    /** Ein 15-min-Bucket des Verlaufs; {@code wert} {@code null} = unvollständig (nicht 0). */
    public record VerlaufPunkt(OffsetDateTime zeit, Double wert) {}

    /**
     * {@code GET /api/v1/messstellen/{id}/verlauf}: je 15-min-Bucket die Summe, WENN alle Terme im
     * Bucket einen Wert haben, sonst {@code null} (nie eine stille Teilsumme). Der Verlauf bleibt der schnelle
     * Blick aus den Geräte-Verdichtungen; die gespeicherten Periodenwerte mit Zustand liefert
     * {@code GET …/messstellen/{kennzeichen}/werte} (AP-10 IP-10). Mit einem Eingang außerhalb des Zugriffs
     * (AP-03 R-A3): keine Punkte, {@code ausserhalb_zugriff} der Hinweis.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verlauf(UUID messstelleId, String einheit, List<VerlaufPunkt> punkte,
            @JsonInclude(JsonInclude.Include.NON_NULL) String ausserhalbZugriff) {

        public Verlauf(UUID messstelleId, String einheit, List<VerlaufPunkt> punkte) {
            this(messstelleId, einheit, punkte, null);
        }
    }
}
