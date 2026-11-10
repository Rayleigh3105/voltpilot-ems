package com.voltpilot.api.tenant;

/**
 * Markiert den aktuellen Thread als innerhalb einer HTTP-Anfrage, solange {@link TenantFilter}
 * sie laufen laesst. {@link AnfragePfadDataSource} liest das, um jede in dieser Zeit geborgte
 * Verbindung aus dem Anfrage-Pool (Statement- und Socket-Zeitgrenze, {@code application.yml}
 * {@code spring.datasource.hikari}) statt aus dem Hintergrund-Pool zu ziehen.
 *
 * <p>Naechtliche/geplante Hintergrundjobs, MQTT-Listener und Flyway (eigene Verbindung) laufen
 * nie durch {@link TenantFilter} und setzen diese Markierung nie - ihre Abfragen bleiben ohne
 * Zeitgrenze, unabhaengig davon, ob sie nebenbei {@link TenantContext} fuer RLS setzen (das ist
 * eine unabhaengige Markierung, siehe deren Klassenkommentar).
 *
 * <p>Ein einzelnes, bewusst langes Admin-Werkzeug auf einem HTTP-Pfad kann die Zeitgrenze fuer
 * den Rest der Anfrage mit {@link #ausnahme()} abschalten, bevor es seine erste Abfrage stellt -
 * noch kein Aufrufer tut das (Messung dieser Aufgabe fand keinen legitimen Leser nahe 30 s); die
 * Methode existiert als begruendeter Fluchtweg fuer einen kuenftigen Fall.
 */
public final class AnfrageZeitgrenze {

    private static final ThreadLocal<Boolean> AKTIV = new ThreadLocal<>();

    private AnfrageZeitgrenze() {
    }

    static void start() {
        AKTIV.set(Boolean.TRUE);
    }

    static void ende() {
        AKTIV.remove();
    }

    /** Schaltet die Zeitgrenze fuer den Rest dieser Anfrage auf diesem Thread ab. */
    public static void ausnahme() {
        AKTIV.set(Boolean.FALSE);
    }

    public static boolean istAktiv() {
        return Boolean.TRUE.equals(AKTIV.get());
    }
}
