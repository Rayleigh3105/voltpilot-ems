package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.uems.BezugsbasisVergleich;
import com.voltpilot.api.uems.EnergiezielService;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import java.time.Instant;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Der {@code kennzahl}-Leser (Alerting Scheibe 5, Konzept §6.3): "Wert und Vergleich einer Kennzahl
 * gegen ihre Bezugsbasis, Stand eines Energieziels" - DIESELBEN Zahlen wie die Auswerten-Fläche
 * ({@link BezugsbasisVergleich#vergleich}, Σ gemessen ÷ Σ erwartet der zwölf abgeschlossenen Monate
 * vor dem laufenden) bzw. die Energieziel-Seite ({@link EnergiezielService#stand}, {@code kurs.lage}) -
 * nie eine eigene Berechnung. Ein eigener Leser statt einer Erweiterung von {@code menge}/{@code zustand}
 * (Hausregel "additiv"): Kennzahl und Energieziel haben ein anderes Standort-/Rechte-Modell als eine
 * Anlage und berühren so keinen bestehenden, ab Werk gesäten Eintrag.
 *
 * <p><b>Entscheid 9A:</b> kein Eintrag dieses Lesers trägt einen Vorschlag ab Werk
 * ({@code wertekatalog/katalog.json}) - nur eine selbst angelegte Überwachung liest ihn
 * ({@link UeberwachungAnlegenService}).
 */
@Component
public class KennzahlWerteLeser implements WerteLeser {

    static final String FELD_BEZUGSBASIS_ABWEICHUNG_PROZENT = "bezugsbasis_abweichung_prozent";
    static final String FELD_KURS_LAGE = "kurs_lage";

    private final BezugsbasisVergleich vergleich;
    private final EnergiezielService energieziele;

    public KennzahlWerteLeser(BezugsbasisVergleich vergleich, EnergiezielService energieziele) {
        this.vergleich = vergleich;
        this.energieziele = energieziele;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        String feld = eintrag.leser().feld();
        if (FELD_BEZUGSBASIS_ABWEICHUNG_PROZENT.equals(feld)) {
            return bezugsbasisAbweichung(bezug, jetzt);
        }
        if (FELD_KURS_LAGE.equals(feld)) {
            return kursLage(bezug, jetzt);
        }
        throw new IllegalArgumentException("KennzahlWerteLeser: unbekanntes Feld '" + feld + "'");
    }

    /**
     * Die Abweichung vom erwarteten Verhältnis (§6.3 "Abweichung vom erwarteten Verhältnis, nicht
     * nur Absolutwert"): {@code delta_prozent} der laufenden Bezugsbasis über die zwölf
     * abgeschlossenen Monate vor dem laufenden (Vorgabe der Fläche, kein eigener Zeitraum) -
     * UNBEKANNT ohne Bezugsbasis, ohne Werte oder ohne sichtbare/vorhandene Kennzahl (§6.1 Nr. 4,
     * UNBEKANNT IST KEINE NULL).
     */
    private Lesung bezugsbasisAbweichung(Bezug bezug, Instant jetzt) {
        if (!"kennzahl".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        BezugsbasisVergleichDto.Vergleich v;
        try {
            v = vergleich.vergleich(bezug.id(), Set.of(), null, null, null);
        } catch (KennzahlAbgelehnt e) {
            return Lesung.unbekannt();
        }
        BezugsbasisVergleichDto.Zeitraum zeitraum = v == null ? null : v.zeitraum();
        Double prozent = zeitraum == null ? null : alsZahl(zeitraum.deltaProzent());
        return prozent == null ? Lesung.unbekannt() : Lesung.zahl(prozent, "%", jetzt);
    }

    /**
     * Der Kurs zum Energieziel ({@code kurs.lage}): {@code noch_keine_aussage}, {@code auf_kurs},
     * {@code knapp_dahinter} oder {@code nicht_auf_kurs} über die bisher bewertbaren Monate
     * ({@link EnergiezielService#stand}) - "Ziel verfehlt sich abzeichnend" (§6.3) ist
     * {@code knapp_dahinter}/{@code nicht_auf_kurs} als Ziel-Zustand einer {@code zustand}-Bedingung.
     */
    private Lesung kursLage(Bezug bezug, Instant jetzt) {
        if (!"energieziel".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        EnergiezielDto.Stand stand;
        try {
            stand = energieziele.stand(bezug.id());
        } catch (VerbesserungAbgelehnt e) {
            return Lesung.unbekannt();
        }
        EnergiezielDto.Kurs kurs = stand == null ? null : stand.kurs();
        return kurs == null || kurs.lage() == null ? Lesung.unbekannt() : Lesung.zustand(kurs.lage(), jetzt);
    }

    private static Double alsZahl(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return Double.valueOf(text);
        } catch (NumberFormatException e) {
            try {
                return Double.valueOf(text.replace(",", "."));
            } catch (NumberFormatException e2) {
                return null;
            }
        }
    }
}
