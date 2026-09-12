package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRegisterRepository.QuelleZeile;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Werte;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.time.Instant;
import java.time.ZoneId;

/**
 * Die Beobachtung EINER Größe einer Messstelle (UEMS AP-04 IP-15): „liefert Daten“ · „liefert
 * keine Daten seit …“ · „wartet auf erste Daten (von Z-5b)“ · „keine Datenquelle“, dazu ihr
 * letzter Wert.
 *
 * <p><b>Die Regel steht hier NICHT.</b> Welcher der vier Zustände gilt, entscheidet allein die
 * reine Ableitung des Zustandsvertrags ({@link ZustandAbleitung#liefertDaten}, Vektoren
 * {@code docs/contracts/v2/uems-zustand-vectors.json}, Zwilling {@code uemsZustand.ts}). Diese
 * Klasse sammelt nur ihre Eingänge — führende Bindung, letzter GUTER Wert, Kadenz, Zeitzone des
 * Standorts — und gibt das Ergebnis in der Form der Schnittstelle zurück.
 *
 * <p><b>⚠ 3 × Kadenz ist die Beobachtung, 2 × Kadenz ist die Lücke.</b> Die Toleranz ist
 * {@code min( max( 3 × Kadenz , 300 s ) , 86 400 s )} und die Kante gehört zu „liefert“
 * (AP-07 E9, in {@link ZustandAbleitung} umgesetzt). Der ältere Wortlaut „2 × Kadenz“ des
 * AP-04-Berichts meint die LÜCKE — eine andere Aussage ohne Boden und Deckel, die fehlende WERTE
 * zählt und kein Abzeichen zeigt (AP-07 IP-9). Sie kommt hier nicht vor.
 *
 * <p><b>Schweigen ist nie ein bewiesener Fehlschlag.</b> Es gibt keinen Fehler- und keinen
 * Störungszustand: eine Größe ohne Werte wartet, eine ohne Quelle hat keine — ein bekannter Grund
 * ist nie eine Störung, und „nicht gemessen“ wird nie zu „gemessen 0“.
 */
final class MessstelleBeobachtung {

    private MessstelleBeobachtung() {}

    /** Beobachtung und letzter Wert einer Größe — beide aus denselben Fakten. */
    record Ergebnis(MessstelleDto.RegisterBeobachtung beobachtung, MessstelleDto.RegisterWert letzterWert) {}

    /**
     * @param fuehrend die führende Bindung der Größe zum Zeitpunkt; {@code null} = keine
     * @param werte was über ihren Messwert bekannt ist; {@code null} = nichts (kein Wert, keine
     *     eigene Kadenz) — nie als 0 gelesen
     * @param kadenzS die wirksame Kadenz des Kanals (Mess-Selektion, sonst Katalog)
     * @param einheit die Einheit des Messkanals — ohne jede Umrechnung
     * @param zeitpunkt der Augenblick, zu dem gefragt wird (der {@code zeitpunkt} des Registers)
     * @param zeitzone die des Standorts, in der der Kundensatz seine Uhrzeit nennt
     */
    static Ergebnis ableiten(QuelleZeile fuehrend, Werte werte, long kadenzS, String einheit,
            Instant zeitpunkt, ZoneId zeitzone) {
        Instant letzterGuterWert = werte == null ? null : werte.letzterGuterWert();
        ZustandAbleitung.LiefertDatenErgebnis e = ZustandAbleitung.liefertDaten(
                new ZustandAbleitung.LiefertDatenEingang(fuehrend != null, letzterGuterWert,
                        werte != null && werte.jeEinWert(), kadenzS, zeitpunkt, zeitzone));
        String einbau = fuehrend == null ? null : fuehrend.quelle().einbau();
        // Ohne Quelle gibt es keinen Kanal — also auch keine Kadenz und kein Fenster. Die Vorgabe,
        // mit der die Ableitung gerufen wurde, ist eine RECHENGRÖSSE, keine Auskunft: sie bleibt drin.
        MessstelleDto.RegisterBeobachtung b = new MessstelleDto.RegisterBeobachtung(
                e.zustand().code(), satz(e, einbau), MessstelleService.zeit(e.seit()),
                fuehrend == null ? null : e.toleranzS(), fuehrend == null ? null : kadenzS, einbau);
        return new Ergebnis(b, wert(werte, einheit));
    }

    /**
     * Der Kundensatz. Er ist der des Vertrags — nur „Wartet auf erste Daten“ nennt zusätzlich das
     * Gerät, aus dem sie erwartet werden („Wartet auf erste Daten von Z-5b“, AP-04 §4.5/§5.13).
     * Das ist KEINE zweite Fassung der Regel: der Zustand kommt unverändert aus dem Vertrag, der
     * Name ist ein FAKT der führenden Bindung, der an genau dieser einen Stelle angehängt wird.
     */
    private static String satz(ZustandAbleitung.LiefertDatenErgebnis e, String einbau) {
        return e.zustand() == ZustandAbleitung.LiefertDaten.WARTET_AUF_ERSTE_DATEN && einbau != null
                ? e.text() + " von " + einbau
                : e.text();
    }

    /** Der letzte gute Wert; {@code null}, solange es keinen gibt — nie eine 0. */
    private static MessstelleDto.RegisterWert wert(Werte werte, String einheit) {
        if (werte == null || werte.letzterGuterWert() == null) {
            return null;
        }
        return new MessstelleDto.RegisterWert(werte.zahl(), werte.text(), einheit,
                MessstelleService.zeit(werte.letzterGuterWert()));
    }
}
