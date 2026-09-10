import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '../../designsystem/components/forms/Input';

describe('Input focus styling', () => {
  it('links validation feedback to the field without losing an existing description', () => {
    render(<><p id="help">Zusätzlicher Hinweis</p><Input label="Name" error="Name fehlt" aria-describedby="help" /></>);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Zusätzlicher Hinweis Name fehlt');
  });
  it('clears the focus ring on blur even when validation supplies an onBlur callback', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(<Input label="Name" onFocus={onFocus} onBlur={onBlur} />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.focus(input);
    expect(onFocus).toHaveBeenCalledOnce();
    expect(input.style.boxShadow).not.toBe('none');
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalledOnce();
    expect(input.style.boxShadow).toBe('none');
  });
});
