package com.voltpilot.api.uems;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
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
 * {@link #revisionAusloesen}. AP-12 gibt es noch nicht — {@link Keine} kennt keinen Bericht. Kein Vorgriff: keine Tabelle,
 * kein Berichtsformat.
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

    /** Solange es AP-12 nicht gibt: kein Bericht, nichts zu tun. */
    @Component
    final class Keine implements BerichteNaht {

        @Override
        public List<Bericht> betroffene(Connection con, KorrekturKaskade.Betroffen betroffen) {
            return List.of();
        }

        @Override
        public void entwurfNeuBilden(Connection con, Bericht bericht, KorrekturKaskade.Betroffen betroffen) {
            throw new IllegalStateException("AP-12 ist nicht gebaut: es gibt keinen Bericht " + bericht.kennung());
        }

        @Override
        public void revisionAusloesen(Connection con, Bericht bericht, KorrekturKaskade.Betroffen betroffen) {
            throw new IllegalStateException("AP-12 ist nicht gebaut: es gibt keinen Bericht " + bericht.kennung());
        }
    }
}
