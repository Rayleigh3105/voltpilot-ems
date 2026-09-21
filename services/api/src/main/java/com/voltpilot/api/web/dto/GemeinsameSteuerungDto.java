package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Gemeinsame Steuerung einer Anlage (UEMS AP-15 IP-5; Vertrag {@code docs/contracts/v2/steuerungsverbund.md} §6).
 * Wörter sind die des Vokabulars {@code SteuerungsverbundVokabular} — Codes, keine Kundensätze; die Kundenfläche
 * (IP-23/IP-24) übersetzt sie.
 */
public final class GemeinsameSteuerungDto {

    private GemeinsameSteuerungDto() {}

    /**
     * Der Zustand. Ohne Gemeinsame Steuerung: {@code eingerichtet = false}, {@code zustand = nicht_eingerichtet}, alle
     * anderen Felder leer — die Anlage merkt nichts (I6). {@code zustand} ist die Stufe ({@code erklaert} …
     * {@code anteile_aktiv}, {@code angehalten}) oder {@code aufgeloest} (keine wirksamen Mitglieder mehr).
     *
     * @param fehlt           was zum {@code naechsterSchritt} fehlt — je Bedingung ein Wort des Ablehnungs-Vokabulars
     * @param warnungFuehrung Z1/W2 — nur OHNE Gemeinsame Steuerung: führende Box und Speicher-Box fallen auseinander
     * @param bilanz          die Verbund-Bilanz (IP-12) — {@code null}, solange kein Tag gerechnet ist
     * @param vorbehalt       der Vorbehalt je Richtung mit Herkunft und offenem Vorschlag (IP-13) — {@code null} ohne
     *                        Gemeinsame Steuerung
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zustand(boolean eingerichtet, String zustand, String stufe, Long epoche, UUID netzanschlussId,
            List<Mitglied> mitglieder, String naechsterSchritt, List<Befund> fehlt, WarnungFuehrung warnungFuehrung,
            Bilanz bilanz, Vorbehalt vorbehalt) {}

    /**
     * Der Vorbehalt (IP-13, B4): je Richtung Zahl und Herkunft, dazu ein offener Vorschlag zum Senken. Die
     * Einspeiseseite ist heute immer {@code erklaert}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorbehalt(VorbehaltRichtung einspeisung, VorbehaltRichtung bezug, VorbehaltVorschlag vorschlag) {}

    /**
     * Eine Richtung: {@code kw} leer = unbekannt (keine Null); {@code herkunft} {@code erklaert} · {@code gemessen};
     * {@code seit} wann der Wert gilt; {@code zweischritt} nur bei {@code gemessen}: was der Zweischritt danach tat
     * ({@code veroeffentlicht}, {@code auslegung_passt_nicht}, … — Wörter von {@code SteuerungsverbundAnteilDienst.Grund}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VorbehaltRichtung(BigDecimal kw, String herkunft, OffsetDateTime seit, String zweischritt) {}

    /** Ein offener Vorschlag zum Senken: Zahl, Herkunft (Höchstwert, Viertelstunde, Zeitraum, Messtage), seit wann. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VorbehaltVorschlag(String richtung, BigDecimal altKw, BigDecimal neuKw, BigDecimal hoechstwertKw,
            OffsetDateTime hoechstwertVon, LocalDate zeitraumVon, LocalDate zeitraumBis, int messtage,
            OffsetDateTime erstelltAm) {}

    /**
     * Die Verbund-Bilanz (IP-12, A17): {@code zustand} des jüngsten gerechneten Tages ({@code plausibel} ·
     * {@code unplausibel} · {@code unbekannt}), {@code seit} dem ersten Tag, an dem sie ununterbrochen so steht,
     * {@code grund} nur bei {@code unbekannt} (Vokabular {@code VerbundBilanzRegel.Grund}), {@code gerechnetAm} wann.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bilanz(String zustand, LocalDate tag, LocalDate seit, String grund, OffsetDateTime gerechnetAm) {}

    /**
     * Ein wirksames Mitglied: Box, Rolle ({@code fuehrt} · {@code steuert_mit}), Messpunkt (Datenquelle, wahlfrei). G6:
     * {@code vorgabeSignal} — liegt das Signal des Netzbetreibers an der Box an ({@code ja} · {@code nein} ·
     * {@code unbekannt}, erklärt; {@code vorgabeSignalAm} wann zuletzt, null = nie) — und {@code verbraucher14a} —
     * hängen steuerbare Verbraucher nach § 14a hinter ihr (dieselben drei Wörter, abgeleitet aus den Geräten je Box).
     * {@code anteilVerlust} (IP-22) {@code null}, solange die Box an dieser Anlage keinen Tag gemeldet hat.
     * {@code wirksameAnteile} (IP-23-Folge): was der Box zugestellt und von ihr quittiert ist — {@code null}, solange
     * nichts quittiert ist (unbekannt, keine Null). {@code zuletztGehoert}: der letzte Status-Herzschlag der Box
     * ({@code null} = nie).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Mitglied(UUID boxId, String rolle, UUID messpunktId, OffsetDateTime gueltigAb,
            OffsetDateTime bestaetigtAm, String vorgabeSignal, OffsetDateTime vorgabeSignalAm, String verbraucher14a,
            AnteilVerlust anteilVerlust, Sprungprobe sprungprobe, WirksameAnteile wirksameAnteile,
            OffsetDateTime zuletztGehoert) {}

    /**
     * Die wirksamen Anteile einer Box je Richtung in kW (G4): der Stand ihres jüngsten QUITTIERTEN Anteils-Dokuments —
     * im Übergangsstand der Übergangswert, nach einer Abweichung des Betreibers beim Scharfschalten dessen Zahl. Eine
     * leere Richtung ist unbekannt, keine Null.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record WirksameAnteile(BigDecimal einspeisungKw, BigDecimal bezugKw) {}

    /**
     * Die jüngste Sprungprobe einer Box (IP-21, E3 = A, T5) — für das Betreiber-Blatt (IP-24): Urteil ({@code
     * ausgeloest} = Bericht steht aus), Grund, wann; {@code gilt} = sie trägt die Naht für die HEUTIGE Struktur
     * (bestanden, nicht entwertet, dieselbe führende Box). {@code null} ohne Probe. Beim Auslösen die Antwort der Route.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Sprungprobe(UUID probeId, UUID boxId, String art, BigDecimal sprungKw, int dauerS,
            int wiederholungen, OffsetDateTime ausgeloestAm, String urteil, String grund, OffsetDateTime ausgewertetAm,
            OffsetDateTime entwertetAm, boolean gilt) {}

    /**
     * Was der feste Einspeise-Anteil der Box zurückhielt (IP-22, E1 = A, R2) — für die Verlust-Zeile (IP-23) und das
     * Betreiber-Blatt (IP-24): {@code heute} und der laufende {@code monat} (Tage der Anlage, Europe/Berlin), je
     * {@code null} ohne gemeldeten Tag.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnteilVerlust(VerlustSumme heute, VerlustSumme monat) {}

    /**
     * {@code kwh} ist eine UNTERGRENZE (die Box kennt die verfügbare Erzeugung einer abgeregelten PV nur aus gemessenen
     * Werten); {@code gebundenS} — wie lange der Anteil die Erzeuger hielt — ist exakt; {@code tage} gemeldete Tage.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VerlustSumme(BigDecimal kwh, long gebundenS, int tage) {}

    /** Ein Grund aus dem Ablehnungs-Vokabular; {@code boxId} bzw. {@code richtung} nur, wo er daran hängt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Befund(String wort, UUID boxId, String richtung) {}

    /**
     * Z1 (W2): die Anlage hat keine Gemeinsame Steuerung, und ihre führende Box ist nicht die Box des Speichers —
     * Flows gehen an die eine, der Fahrplan an die andere. Wort {@code fuehrende_box_ist_nicht_speicher_box}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record WarnungFuehrung(String wort, UUID fuehrendeBoxId, UUID speicherBoxId) {}

    /**
     * Ein gewünschtes Mitglied aus {@code PUT {"mitglieder": […]}} — Mandant und Anlage kommen nie aus dem Körper.
     * {@code vorgabeSignal} wahlfrei ({@code ja} · {@code nein} · {@code unbekannt}); fehlt es, bleibt das erklärte.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MitgliedWunsch(UUID boxId, String rolle, UUID messpunktId, String vorgabeSignal) {}

    /**
     * Das Betreiber-Blatt (IP-24, §5.3/§5.4): je Box, was nur die Plattform sieht, dazu der Zweischritt und alle
     * Sprungprobe-Protokolle. Zustand, Mitglieder, {@code fehlt}, Bilanz und Vorbehalt stehen im {@link Zustand};
     * Geräte, Rückfall und Auslegung im Einrichten-Vorschlag — das Blatt liest alle drei, nichts doppelt.
     * {@code boxen} ist leer ohne Gemeinsame Steuerung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Betreiberblatt(List<BoxStand> boxen, Zweischritt zweischritt,
            List<SprungprobeProtokoll> sprungproben) {}

    /**
     * Eine Box des Verbunds. {@code zuletztGesehen} = letzter Herzschlag ({@code device.device_status_seen_at}, null =
     * nie); {@code waechter} null = kein Herzschlag-Block seit dem Start der api (alte Box oder noch keiner) — nie
     * eine Null-Stufe; {@code anteile.wirksamKw} null = nicht gemeldet.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record BoxStand(UUID boxId, String rolle, OffsetDateTime zuletztGesehen, Faehigkeit faehigkeit,
            Messpunkt messpunkt, Waechter waechter, PlanStand plan, AnteilStand anteile) {}

    /** Je Fähigkeit {@code gemeldet} · {@code versions_tabelle} · {@code fehlt}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Faehigkeit(String steuerungsverbundAnteil, String sprungprobe) {}

    /**
     * Der Messpunkt des Mitglieds und sein Alter: {@code zustand} {@code ok} · {@code stale} · {@code never} wie die
     * Box meldet, {@code nicht_gemeldet} ohne Meldung; {@code gelesenAm} der letzte gelesene Wert.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messpunkt(UUID dataSourceId, String zustand, OffsetDateTime gelesenAm) {}

    /** Wächter-Stufe je Richtung aus dem Herzschlag-Block (IP-10); eine fehlende Richtung ist null. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Waechter(String einspeisung, String bezug) {}

    /** Veröffentlicht gegen angenommen (R11); je Teil null, wenn es ihn nicht gibt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PlanStand(PlanZeile veroeffentlicht, PlanZeile angenommen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PlanZeile(UUID planId, OffsetDateTime erzeugtAm, OffsetDateTime am, String urteil, String grund) {}

    /**
     * Anteils-Dokument der Box: zuletzt gesendet und zuletzt quittiert (Epoche/Revision), die WIRKSAMEN Anteile, wie
     * die Box sie im Herzschlag meldet ({@code einspeisung}/{@code bezug} in kW; null = nicht gemeldet).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnteilStand(Revision gesendet, Revision quittiert, Map<String, BigDecimal> wirksamKw) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Revision(long epoche, long revision, OffsetDateTime am) {}

    /**
     * Das jüngste Anteils-Dokument (IP-7): {@code schritt} {@code uebergang} · {@code ziel}; {@code bestaetigt} die
     * Boxen, deren Quittung diesen Stand (oder später) trägt, {@code wartetAuf} die übrigen Mitglieder. Der Zielstand
     * gilt erst mit {@code schritt = ziel} und leerem {@code wartetAuf}. null ohne Dokument.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zweischritt(String schritt, long epoche, long revision, OffsetDateTime am, List<UUID> bestaetigt,
            List<UUID> wartetAuf) {}

    /** Ein Protokoll der Sprungprobe mit den Messungen je Sprung (leer, solange der Bericht aussteht). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SprungprobeProtokoll(Sprungprobe probe, List<SprungMessung> spruenge) {}

    /** {@code abweichungKw} = gesehen − erwartet; null, wenn nichts gesehen wurde. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SprungMessung(BigDecimal eigeneKw, BigDecimal erwartetKw, BigDecimal gesehenKw,
            BigDecimal toleranzKw, BigDecimal abweichungKw, String urteil, String grund) {}
}
