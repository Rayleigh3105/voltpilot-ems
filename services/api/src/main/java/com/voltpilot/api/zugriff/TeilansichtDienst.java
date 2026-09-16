package com.voltpilot.api.zugriff;

import com.voltpilot.api.web.dto.TeilansichtDto;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Bildet das additive Feld {@link TeilansichtDto} der Flotten-Antworten (UEMS AP-03 IP-10, Regel R-A2):
 * {@code sichtbar} = die Standorte, über die die Antwort gebildet wurde, {@code gesamt} = die Standorte des
 * Kundenbereichs.
 *
 * <p>{@code sichtbar} zählt die Datenbank unter dem Standort-Zaun ({@code site_scope}, IP-5) — dieselbe Menge,
 * über die jede Liste und jede Summe der Antwort entsteht. {@code gesamt} braucht die eine Zahl, die der Zaun
 * verdeckt, und hebt ihn dafür auf ({@link Geltungsbereich#ganzenKundenbereichLesen()}).
 *
 * <p><b>Die Aufhebung bleibt in DIESER Methode</b>: sie läuft in einer EIGENEN Transaktion
 * ({@code PROPAGATION_REQUIRES_NEW}), damit das {@code set_config(…, true)} mit ihr endet und keine Abfrage des
 * Aufrufers ohne Zaun weiterliest. Ausgegeben wird daraus ausschließlich eine Kardinalzahl — nie ein Name, nie
 * eine Kennung, nie ein Wert eines Standorts außerhalb des Zugriffs.
 *
 * <p>Gezählt wird ohne archivierte Standorte, genau wie {@code ZugriffRepository.standorte()}, aus dem die
 * Selbstauskunft ihre Kopfzeile „Teilansicht: n von m Standorten“ bildet — sonst widersprächen sich Kopfzeile
 * und Antwort.
 */
@Service
public class TeilansichtDienst {

    private static final String ZAEHLEN = "SELECT count(*) FROM standort WHERE zustand <> 'archiviert'";

    private final JdbcTemplate jdbc;
    private final Geltungsbereich geltungsbereich;
    private final TransactionTemplate eigeneTransaktion;

    public TeilansichtDienst(JdbcTemplate jdbc, Geltungsbereich geltungsbereich,
            PlatformTransactionManager transaktionen) {
        this.jdbc = jdbc;
        this.geltungsbereich = geltungsbereich;
        TransactionTemplate vorlage = new TransactionTemplate(transaktionen);
        vorlage.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        vorlage.setReadOnly(true);
        this.eigeneTransaktion = vorlage;
    }

    /** Die Teilansicht über ALLE sichtbaren Standorte — die Antwort ohne eigene Auswahl. */
    public TeilansichtDto jetzt() {
        return bilden(null);
    }

    /**
     * Die Teilansicht über eine ENGERE Menge: der Aufrufer hat selbst gewählt (die Standort-Menge an
     * {@code /earnings}). {@code sichtbar} beschreibt immer die Menge, über die diese Antwort gebildet wurde.
     */
    public TeilansichtDto ueber(int sichtbar) {
        return bilden(sichtbar);
    }

    private TeilansichtDto bilden(Integer vorgabe) {
        return eigeneTransaktion.execute(status -> {
            int sichtbar = vorgabe != null ? vorgabe : zaehlen();
            geltungsbereich.ganzenKundenbereichLesen();
            // Der Zaun kann `gesamt` nie kleiner machen als `sichtbar`; das Maximum hält die Zahl auch dann
            // stimmig, wenn zwischen den beiden Abfragen ein Standort archiviert wird.
            return new TeilansichtDto(sichtbar, Math.max(sichtbar, zaehlen()));
        });
    }

    private int zaehlen() {
        Integer n = jdbc.queryForObject(ZAEHLEN, Integer.class);
        return n == null ? 0 : n;
    }
}
