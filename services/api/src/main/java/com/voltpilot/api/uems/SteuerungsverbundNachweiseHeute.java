package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der Stand der Naht {@link SteuerungsverbundNachweise}: die Fähigkeit fragt {@link BoxFaehigkeiten#kann} (das Wort
 * kennt sie erst mit IP-17 — bis dahin nein), die Auslegung rechnet IP-7, G6 liest das erklärte Signal je Mitglied
 * und leitet die steuerbaren Verbraucher nach § 14a aus den Geräten je Box ab; die Sprungprobe hat noch keine Quelle
 * und fehlt. Damit wird keine Anlage scharf, bevor die Pakete ihre Quellen liefern.
 */
@Component
public class SteuerungsverbundNachweiseHeute implements SteuerungsverbundNachweise {

    /** Die Wörter des Signals je Mitglied ({@code steuerungsverbund_mitglied.vorgabe_signal}). */
    public static final String JA = "ja";
    public static final String NEIN = "nein";
    public static final String UNBEKANNT = "unbekannt";

    private final BoxFaehigkeiten faehigkeiten;
    private final SteuerungsverbundAnteilDienst anteile;
    private final SteuerungsverbundRepository verbuende;
    private final SteuerungsverbundAnteilRepository geraete;

    public SteuerungsverbundNachweiseHeute(BoxFaehigkeiten faehigkeiten, SteuerungsverbundAnteilDienst anteile,
            SteuerungsverbundRepository verbuende, SteuerungsverbundAnteilRepository geraete) {
        this.faehigkeiten = faehigkeiten;
        this.anteile = anteile;
        this.verbuende = verbuende;
        this.geraete = geraete;
    }

    @Override
    public boolean faehigkeit(UUID box) {
        return faehigkeiten.kann(box, FAEHIGKEIT);
    }

    /** IP-21 baut die Sprungprobe. */
    @Override
    public boolean sprungprobe(UUID verbundId, UUID box) {
        return false;
    }

    /**
     * IP-7: der Eingang aus Geräten je Box (Nennleistung, Schreibfreigabe), ihren Rückfällen (IP-6), der wirksamen
     * Grenze und dem gespeicherten Vorbehalt ({@link SteuerungsverbundAnteilDienst#auslegungFuer}); leer, solange eine
     * Richtung nicht rechenbar ist.
     */
    @Override
    public Optional<Map<Grenzart, SteuerungsverbundRegeln.Richtung>> auslegung(UUID siteId, List<UUID> boxen,
            LocalDate tag) {
        return anteile.auslegungFuer(siteId, boxen, tag);
    }

    /** G6, abgeleitet aus den Geräten der Box im Verbund der Anlage ({@link #verbraucher14aAus}). */
    @Override
    public Boolean verbraucher14a(UUID siteId, UUID box) {
        return verbuende.derAnlage(siteId).map(v -> verbraucher14aAus(geraete.geraete(v.id()).stream()
                .filter(g -> box.equals(g.deviceId())).toList())).orElse(null);
    }

    /** G6, erklärt je Mitglied ({@code PUT …/gemeinsame-steuerung}, Feld {@code vorgabe_signal}). */
    @Override
    public Boolean vorgabeSignal(UUID siteId, UUID box) {
        return verbuende.vorgabeSignalDerBox(siteId, box).map(SteuerungsverbundNachweiseHeute::signal).orElse(null);
    }

    /** {@code ja} → true, {@code nein} → false, {@code unbekannt} → null (unbekannt ist keine Null — G6 zählt es als nein). */
    public static Boolean signal(String wort) {
        return JA.equals(wort) ? Boolean.TRUE : NEIN.equals(wort) ? Boolean.FALSE : null;
    }

    /** Das Gegenstück von {@link #signal} für die Antwort: true → {@code ja}, false → {@code nein}, null → {@code unbekannt}. */
    public static String wort(Boolean wert) {
        return wert == null ? UNBEKANNT : wert ? JA : NEIN;
    }

    /**
     * Hat die Box steuerbare Verbraucher nach § 14a? Abgeleitet, nicht erklärt: die Gemeinsame Steuerung kennt nicht,
     * welches Gerät beim Netzbetreiber als § 14a-Einrichtung gemeldet ist, sie kennt nur, welche Geräte die Box in
     * Bezugsrichtung treiben darf. Darum zählt JEDES solche Gerät mit — Ladepunkt, Wärmepumpe/SG-Ready, Speicher mit
     * Netzladen, Heizstab, jede andere schaltbare Last (im Zweifel mit: mehr Boxen brauchen das Signal).
     *
     * @param geraeteDerBox die wirksamen Geräte-Angaben der Box ({@code steuerungsverbund_geraet}, IP-7)
     * @return true, wenn eine Angabe in Richtung {@code bezug} mit Komponente und Schreibfreigabe steht · false, wenn
     *     die Box Angaben hat, aber keine solche · null (unbekannt, zählt als ja), wenn für die Box keine Angabe steht
     */
    public static Boolean verbraucher14aAus(List<SteuerungsverbundAnteilRepository.GeraetZeile> geraeteDerBox) {
        if (geraeteDerBox.isEmpty()) {
            return null;
        }
        return geraeteDerBox.stream().anyMatch(g -> g.richtung() == Grenzart.BEZUG && g.schreibfreigabe()
                && g.entityId() != null);
    }
}
