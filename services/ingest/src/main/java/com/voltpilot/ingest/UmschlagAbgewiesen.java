package com.voltpilot.ingest;

/**
 * Der GANZE Umschlag ist abgewiesen (Fassung, Form oder Kennung des Umschlags selbst), mit
 * einem Grund aus dem geschlossenen Vokabular. Die Datenannahme hält das als EIN
 * {@code rejected}-Ereignis auf {@code events.raw} fest; ein Fehler in EINEM Wert wirft das
 * nicht, sondern verwirft nur diesen Wert (siehe {@link Annahme}).
 */
public class UmschlagAbgewiesen extends InvalidTelemetryException {

    private final Grund grund;
    private final Long sequenz;
    private final Long anzahl;

    /**
     * @param sequenz die Sequenz des Umschlags, wenn sie lesbar war, sonst {@code null}
     * @param anzahl wie viele Werte (bzw. Ereignisse) er trug, wenn lesbar, sonst {@code null}
     */
    public UmschlagAbgewiesen(Grund grund, String hinweis, Long sequenz, Long anzahl) {
        super(grund.code() + ": " + hinweis);
        this.grund = grund;
        this.sequenz = sequenz;
        this.anzahl = anzahl;
    }

    public Grund grund() {
        return grund;
    }

    public Long sequenz() {
        return sequenz;
    }

    public Long anzahl() {
        return anzahl;
    }
}
