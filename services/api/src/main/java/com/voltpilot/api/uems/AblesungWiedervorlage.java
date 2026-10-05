package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRegisterService.Ablesestelle;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Konzept Wiedervorlage w1, Entscheid 7 (Vertrag 1.2): die Wiedervorlage-Quelle „Zählerablesung“, die Messstellen,
 * deren Werte aus Ablesungen kommen, gelesen über das Messstellen-Register
 * ({@link MessstelleRegisterService#ablesestellen}) im Zaun des Aufrufers und mit seinem Leserecht je Messstelle, wie
 * die Route {@code GET /api/v1/messstellen}. Die Frist hat das Register schon ({@code faelligAb}: letzte Ablesung + zwei
 * Kalendermonate über {@link AblesungRegeln#ueberfaelligAb}, ohne Ablesung der Beginn der Quelle); hier wird sie nur
 * zum Tag in der Zeitzone ihres Standorts.
 *
 * <p>Eine Ablese-Runde, ein Eintrag: je Ort, an dem man abliest (Gebäude, ohne Gebäude der Standort), und
 * Fälligkeitstag eine Zeile. Was an verschiedenen Tagen abgelesen wurde, wird an verschiedenen Tagen wieder fällig und
 * steht deshalb getrennt; die Zahl der Zähler stimmt so immer. Kennzeichen ist das des Orts, {@code id} bei einem Zähler
 * die Messstelle (dort trägt man ab), bei mehreren der Ort.
 */
@Component
@Order(60)
public class AblesungWiedervorlage implements WiedervorlageQuelle {

    private final MessstelleRegisterService register;
    private final RechtPruefung rechte;

    public AblesungWiedervorlage(MessstelleRegisterService register, RechtPruefung rechte) {
        this.register = register;
        this.rechte = rechte;
    }

    @Override
    public List<Frist> fristen(LocalDate abruf) {
        // Bis zum Ende des Abruf-Tags zählt jede Ablesung, auch eine von heute (der Tag in Europe/Berlin wie im Register).
        List<Ablesestelle> stellen = register.ablesestellen(
                abruf.plusDays(1).atStartOfDay(MessstelleService.ZEITZONE).toInstant().minusMillis(1),
                id -> rechte.lesbar(RechtZiel.MESSSTELLE, id));
        Map<List<Object>, List<Ablesestelle>> runden = new LinkedHashMap<>();
        stellen.stream()
                .sorted(Comparator.comparing(Ablesestelle::faelligAb).thenComparing(Ablesestelle::kennzeichen))
                .forEach(s -> runden.computeIfAbsent(List.of(wo(s), faellig(s)), k -> new ArrayList<>()).add(s));
        return runden.values().stream().map(AblesungWiedervorlage::frist).toList();
    }

    /** Der Ort der Runde; ohne Ort an dem Tag steht der Zähler für sich. */
    private static String wo(Ablesestelle s) {
        return s.ort() == null ? "messstelle:" + s.kennzeichen() : s.ort().kennzeichen();
    }

    private static LocalDate faellig(Ablesestelle s) {
        return s.faelligAb().atZone(s.zone()).toLocalDate();
    }

    /**
     * Die Zeile einer Runde. Titel (so steht er auch in einer freigegebenen Managementbewertung): „Zählerablesung Halle 1
     * (8 Zähler)“, bei einem Zähler „Zählerablesung Halle 2 (MS-20 Spritzguss)“. Die Herkunft nennt die Ablesung, an
     * der die Frist hängt: bei mehreren die früheste, bei gleichem Zeitpunkt nach Kennzeichen (am selben
     * Fälligkeitstag liegen die Ablesungen einer Runde in der Regel am selben Tag; das Monatsende klemmt).
     */
    private static Frist frist(List<Ablesestelle> runde) {
        Ablesestelle erste = runde.get(0);
        int anzahl = runde.size();
        String ort = erste.ort() == null ? null
                : erste.ort().name() != null ? erste.ort().name() : erste.ort().kennzeichen();
        String zaehler = anzahl == 1 ? erste.kennzeichen() + " " + erste.name() : anzahl + " Zähler";
        String titel = "Zählerablesung " + (ort == null ? zaehler : ort + " (" + zaehler + ")");
        boolean abgelesen = erste.zuletzt() != null;
        Herkunft h = Herkunft.von(abgelesen ? "abgelesen" : "ablesebeginn",
                        (abgelesen ? erste.zuletzt() : erste.seit()).atZone(erste.zone()).toLocalDate())
                .mitMonaten(abgelesen ? AblesungRegeln.UEBERFAELLIG_NACH_MONATEN : null)
                .mitKennung(anzahl == 1 ? erste.kennzeichen() : null)
                .mitAnzahl(anzahl)
                .mitBezug(ort);
        return new Frist("zaehlerablesung", erste.ort() == null ? erste.kennzeichen() : erste.ort().kennzeichen(),
                titel, faellig(erste), null, anzahl == 1 || erste.ort() == null ? erste.id() : erste.ort().id(), null,
                h);
    }
}
