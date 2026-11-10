package com.voltpilot.api.geraete;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Die EINE Regel des Dienstes „Verbindung lösen" (Konzept vp-plattform-admin-box-benutzer-konzept,
 * Teil 1, Abschnitt 3.2): <b>lösen geht nur, solange die Box sich nie gemeldet hat.</b> Reine Funktion,
 * geprüft gegen {@code docs/contracts/box-loesen-vectors.json} ({@code BoxLoesenRegelVectorsTest}) -
 * derselbe Vertrag für den Admin-Weg (B2 = A) und den künftigen Kunden-Weg (Box verbinden S4, der die
 * Bedingung {@code angemeldet} NIE übergeht).
 *
 * <p>Fünf Stufen (Abschnitt 3.2): kein Herzschlag, keine Messwerte, keine Software-Meldungen, keine
 * Zuständigkeit für Datenquellen (wie {@code DeviceRepository#ausbauen}), die Verknüpfung ist aktiv.
 * Eine sechste - der Schlüssel wurde nie abgeholt - gilt NUR auf dem Kunden-Weg; der Admin bekommt
 * dafür nur einen Hinweis (B2 = A, Grund {@code angemeldet} fehlt dann in {@link #gruende}).
 *
 * <p>Diese Funktion ist das SCHNELLE, erklärbare Urteil für die UI - die eigentliche Sicherheit liegt
 * in der Datenbank selbst: jede Box-Daten-Tabelle verweist mit {@code ON DELETE RESTRICT} auf
 * {@code device} (V20260913150000); fände die Regel hier doch nichts, aber eine Tabelle sehr wohl eine
 * Zeile, lehnt {@code DeviceRepository#loesen} das Löschen ab (23503), und {@code BoxLoesenService}
 * übersetzt das in denselben 409. {@code BoxLoesenTabellenInventarTest} hält diese Rückversicherung
 * vollständig: jede Tabelle mit {@code device_id} im tatsächlichen Schema ist entweder RESTRICT-
 * geschützt oder eingeordnet.
 */
public final class BoxLoesenRegel {

    private BoxLoesenRegel() {
    }

    /** Der Befund, auf dem das Urteil beruht - dieselben Fakten wie die Geräteakte zeigt sie. */
    public record BoxBefund(
            boolean aktiv,
            Instant herzschlagAm,
            Instant messwertAm,
            Instant meldungAm,
            boolean hatZustaendigkeiten,
            Instant schluesselAbgeholtAm) {
    }

    /**
     * Die Gründe, warum Lösen (noch) nicht geht - leer heißt lösbar. Reihenfolge wie der Vertrag
     * ({@code 409 box_hat_sich_gemeldet}): {@code verbund}, {@code herzschlag}, {@code messwerte},
     * {@code meldungen}, {@code zustaendigkeit}, {@code angemeldet}.
     *
     * @param adminWeg {@code true} = Plattform-Admin (B2 = A: ein abgeholter Schlüssel blockiert
     *     NICHT); {@code false} = Kunde (Box verbinden S4: blockiert IMMER).
     */
    public static List<String> gruende(BoxBefund befund, boolean adminWeg) {
        List<String> g = new ArrayList<>();
        if (!befund.aktiv()) {
            g.add("verbund");
        }
        if (befund.herzschlagAm() != null) {
            g.add("herzschlag");
        }
        if (befund.messwertAm() != null) {
            g.add("messwerte");
        }
        if (befund.meldungAm() != null) {
            g.add("meldungen");
        }
        if (befund.hatZustaendigkeiten()) {
            g.add("zustaendigkeit");
        }
        if (!adminWeg && befund.schluesselAbgeholtAm() != null) {
            g.add("angemeldet");
        }
        return g;
    }

    public static boolean loesbar(BoxBefund befund, boolean adminWeg) {
        return gruende(befund, adminWeg).isEmpty();
    }
}
