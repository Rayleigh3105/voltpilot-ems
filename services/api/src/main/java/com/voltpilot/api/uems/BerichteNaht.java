package com.voltpilot.api.uems;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Die Anschlussstelle der Korrektur-Kaskade für die BERICHTE (AP-08 IP-17, E9 → AP-12).
 *
 * <p><b>Ein freigegebener Bericht wird NIE geändert.</b> Er ist schon aus dem Haus: ihn nachträglich umzuschreiben hieße,
 * dass zwei Menschen dasselbe Dokument mit verschiedenen Zahlen in der Hand halten und keiner es merkt. Er bekommt nur
 * den REVISIONS-AUSLÖSER ({@link #revisionAusloesen}) — die Meldung {@code correction}, die die Kaskade in derselben
 * Transaktion schreibt, steht in {@link KorrekturKaskade.Betroffen#ereignisse()}. Ein Bericht-ENTWURF dagegen
 * aktualisiert sich ({@link #entwurfNeuBilden}).
 *
 * <p>Welcher der beiden Wege gilt, entscheidet NICHT die Implementierung, sondern die Kaskade
 * ({@link KorrekturKaskade#berichteBenachrichtigen}): sie ruft für einen freigegebenen Bericht ausschließlich
 * {@link #revisionAusloesen}. Gefüllt ist die Naht seit AP-12 IP-8 mit {@link BerichtKaskade} (Pfad 1), solange
 * {@value BerichtKaskade#SCHALTER} an ist; {@link Keine} kennt keinen Bericht und gilt nur, wenn das Flag aus ist.
 */
public interface BerichteNaht {

    /** Wie weit ein Bericht ist — die eine Unterscheidung, die die Kaskade braucht. */
    enum Stand {
        ENTWURF,
        FREIGEGEBEN
    }

    /** Ein Bericht, den die Korrektur berührt. */
    record Bericht(String kennung, Stand stand) {}

    /** Die Berichte, deren Zeitraum und Messstellen die Kaskade berührt hat. */
    List<Bericht> betroffene(Connection con, KorrekturKaskade.Betroffen betroffen) throws SQLException;

    /** Nur für einen ENTWURF: er bildet sich aus den neuen Versionen neu. */
    void entwurfNeuBilden(Connection con, Bericht bericht, KorrekturKaskade.Betroffen betroffen) throws SQLException;

    /** Nur für einen FREIGEGEBENEN Bericht: er bleibt, wie er ist, und bekommt den Revisions-Auslöser. */
    void revisionAusloesen(Connection con, Bericht bericht, KorrekturKaskade.Betroffen betroffen) throws SQLException;

    /**
     * Was eine Zeile eines Änderungsprotokolls berührt — Pfad 2, der Strukturänderungs-Läufer (AP-12 IP-9, bericht.md B3).
     *
     * @param anlass die Kennung der Strukturänderung ({@link BerichtRegeln#strukturKennung}) — so steht sie am Anstoß
     * @param anstossArt das Urteil der Regel {@link BerichtRegeln#struktur}
     * @param objekte die IDs der Quellen, deren Zahl oder Zugehörigkeit die Änderung ab {@code giltAb} verschiebt
     *     ({@link StrukturAufloesung}) — Messstellen, Kostenstellen, Bezugsgrößen
     * @param giltAb der erste Tag, ab dem die Änderung gilt; Pfad 2 ist nach hinten offen
     * @param eingetragen wann die Änderung geschrieben wurde: ein Stand oder Entwurf mit späterem Datenstand kennt sie schon
     * @param jetzt der Zeitpunkt des Laufs (Datenstand einer Neubildung wie in Pfad 1)
     */
    record StrukturBetroffen(UUID tenant, String anlass, String anstossArt, Set<UUID> objekte, LocalDate giltAb,
            Instant eingetragen, Instant jetzt) {}

    /** Pfad 2: die Berichte, deren Quellen die Strukturänderung ab {@code giltAb} trifft — und die sie noch nicht kennen. */
    default List<Bericht> betroffene(Connection con, StrukturBetroffen betroffen) throws SQLException {
        return List.of();
    }

    /** Pfad 2, nur für einen ENTWURF — dieselbe Neubildung wie in Pfad 1. */
    default void entwurfNeuBilden(Connection con, Bericht bericht, StrukturBetroffen betroffen) throws SQLException {
        throw new IllegalStateException("Diese Berichts-Naht kennt keinen Strukturänderungs-Pfad: " + bericht.kennung());
    }

    /** Pfad 2, nur für einen FREIGEGEBENEN Bericht — derselbe Anstoß wie in Pfad 1, mit der Art der Strukturänderung. */
    default void revisionAusloesen(Connection con, Bericht bericht, StrukturBetroffen betroffen) throws SQLException {
        throw new IllegalStateException("Diese Berichts-Naht kennt keinen Strukturänderungs-Pfad: " + bericht.kennung());
    }

    /** Die Berichte abgeschaltet ({@value BerichtKaskade#SCHALTER} = false, Rückbau): kein Bericht, nichts zu tun. */
    @Component
    @ConditionalOnProperty(name = BerichtKaskade.SCHALTER, havingValue = "false")
    final class Keine implements BerichteNaht {

        @Override
        public List<Bericht> betroffene(Connection con, KorrekturKaskade.Betroffen betroffen) {
            return List.of();
        }

        @Override
        public void entwurfNeuBilden(Connection con, Bericht bericht, KorrekturKaskade.Betroffen betroffen) {
            throw new IllegalStateException("Die Berichts-Naht ist abgeschaltet (" + BerichtKaskade.SCHALTER
                    + "): es gibt keinen Bericht " + bericht.kennung());
        }

        @Override
        public void revisionAusloesen(Connection con, Bericht bericht, KorrekturKaskade.Betroffen betroffen) {
            throw new IllegalStateException("Die Berichts-Naht ist abgeschaltet (" + BerichtKaskade.SCHALTER
                    + "): es gibt keinen Bericht " + bericht.kennung());
        }
    }
}
