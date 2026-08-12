import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const siteComponentTemplates = vi.fn();
const siteComponents = vi.fn();
const duplicateCustomComponent = vi.fn();
const renameSiteComponentTemplate = vi.fn();
const deleteSiteComponentTemplate = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      siteComponentTemplates: (s: string) => siteComponentTemplates(s),
      siteComponents: (s: string) => siteComponents(s),
      duplicateCustomComponent: (s: string, e: string, l?: string) =>
        duplicateCustomComponent(s, e, l),
      renameSiteComponentTemplate: (s: string, r: string, b: unknown) =>
        renameSiteComponentTemplate(s, r, b),
      deleteSiteComponentTemplate: (s: string, r: string) => deleteSiteComponentTemplate(s, r),
    },
  };
});

const { EigeneVorlagenPanel } = await import('./EigeneVorlagenPanel');

const VORLAGE = {
  templateRef: 'custom:abc',
  version: 1,
  label: 'Wärmepumpe (Vorlage)',
  communication: 'modbus_baukasten',
  connection: { port: 502, unit_id: 1 },
  channels: [{ label: 'Vorlauf', register: { address: 100 } }],
  note: null,
};

describe('EigeneVorlagenPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    siteComponentTemplates.mockResolvedValue([VORLAGE]);
    siteComponents.mockResolvedValue({ components: [] });
    duplicateCustomComponent.mockResolvedValue([VORLAGE]);
    renameSiteComponentTemplate.mockResolvedValue([{ ...VORLAGE, label: 'Wärmepumpe Keller' }]);
    deleteSiteComponentTemplate.mockResolvedValue([]);
  });

  it('zeigt die eigenen Vorlagen samt Umfang und dem Adress-Satz', async () => {
    render(<EigeneVorlagenPanel siteId="s1" />);
    expect(await screen.findByText('Wärmepumpe (Vorlage)')).toBeInTheDocument();
    expect(screen.getByText(/1 Messwert · Port 502/)).toBeInTheDocument();
    expect(screen.getByText(/beschreibt einen Gerätetyp/)).toBeInTheDocument();
  });

  it('ohne Vorlagen erklärt sie, wie eine entsteht - und zeigt keine leere Liste', async () => {
    siteComponentTemplates.mockResolvedValue([]);
    render(<EigeneVorlagenPanel siteId="s1" />);
    expect(await screen.findByText(/selbst angelegten Gerät/)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('benennt um - ein leerer Name wird VORHER abgefangen', async () => {
    render(<EigeneVorlagenPanel siteId="s1" />);
    fireEvent.click(await screen.findByLabelText(/umbenennen/));

    const feld = screen.getByLabelText('Name');
    fireEvent.change(feld, { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText(/Bitte geben Sie der Vorlage einen Namen/)).toBeInTheDocument();
    expect(renameSiteComponentTemplate).not.toHaveBeenCalled();

    fireEvent.change(feld, { target: { value: 'Wärmepumpe Keller' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(renameSiteComponentTemplate).toHaveBeenCalledWith('s1', 'custom:abc', {
        label: 'Wärmepumpe Keller',
        note: null,
      }),
    );
  });

  it('löschen fragt VORHER und nennt, was gleich bleibt', async () => {
    render(<EigeneVorlagenPanel siteId="s1" />);
    fireEvent.click(await screen.findByLabelText(/löschen/));

    const folgen = await screen.findByTestId('confirm-consequences');
    expect(folgen).toHaveTextContent(/laufen unverändert weiter/);
    expect(deleteSiteComponentTemplate).not.toHaveBeenCalled();

    const dialog = (folgen.closest('.vp-drawer') ?? document.body) as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }));
    await waitFor(() =>
      expect(deleteSiteComponentTemplate).toHaveBeenCalledWith('s1', 'custom:abc'),
    );
  });

  it('bietet „Gerät daraus anlegen" nur mit Messwerten und nur mit Wirt an', async () => {
    const onAnlegen = vi.fn();
    const { unmount } = render(<EigeneVorlagenPanel siteId="s1" />);
    await screen.findByText('Wärmepumpe (Vorlage)');
    expect(screen.queryByRole('button', { name: /Gerät daraus anlegen/ })).not.toBeInTheDocument();
    unmount();

    render(<EigeneVorlagenPanel siteId="s1" onAnlegen={onAnlegen} />);
    fireEvent.click(await screen.findByRole('button', { name: /Gerät daraus anlegen/ }));
    expect(onAnlegen).toHaveBeenCalledWith(VORLAGE);
  });

  it('eine Vorlage ohne Messwerte bietet keinen Anlege-Weg', async () => {
    siteComponentTemplates.mockResolvedValue([{ ...VORLAGE, channels: [] }]);
    render(<EigeneVorlagenPanel siteId="s1" onAnlegen={vi.fn()} />);
    await screen.findByText('Wärmepumpe (Vorlage)');
    expect(screen.queryByRole('button', { name: /Gerät daraus anlegen/ })).not.toBeInTheDocument();
  });

  it('aus einem selbst gebauten Gerät wird eine Vorlage - mit vorgeschlagenem Namen', async () => {
    siteComponents.mockResolvedValue({
      components: [
        { id: 'e1', label: 'Wärmepumpe', sourceKind: 'custom' },
        { id: 'e2', label: 'Deye', sourceKind: 'builtin' },
      ],
    });
    render(<EigeneVorlagenPanel siteId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Aus einem Gerät/ }));

    // Nur SELBST gebaute Geräte stehen zur Wahl.
    const wahl = screen.getByLabelText('Gerät') as HTMLSelectElement;
    expect(wahl.options).toHaveLength(1);
    expect(screen.getByLabelText('Name der Vorlage')).toHaveValue('Wärmepumpe (Vorlage)');

    fireEvent.click(screen.getByRole('button', { name: 'Vorlage anlegen' }));
    await waitFor(() =>
      expect(duplicateCustomComponent).toHaveBeenCalledWith('s1', 'e1', 'Wärmepumpe (Vorlage)'),
    );
  });

  it('ohne selbst gebautes Gerät gibt es keinen Duplizieren-Knopf', async () => {
    render(<EigeneVorlagenPanel siteId="s1" />);
    await screen.findByText('Wärmepumpe (Vorlage)');
    expect(screen.queryByRole('button', { name: /Aus einem Gerät/ })).not.toBeInTheDocument();
  });

  it('ein Ladefehler blockiert das Anlagen-Modell nicht', async () => {
    siteComponentTemplates.mockRejectedValue(new Error('boom'));
    render(<EigeneVorlagenPanel siteId="s1" />);
    expect(await screen.findByTestId('eigene-vorlagen')).toBeInTheDocument();
  });
});
