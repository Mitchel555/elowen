import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LanguageSwitcher } from '../../../components/ui/LanguageSwitcher';
import { createWrapper } from '../../test-utils';

beforeEach(() => localStorage.clear());

describe('LanguageSwitcher', () => {
  it('opens the menu and lists all languages', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('English')).toBeInTheDocument();
    expect(within(menu).getByText('Čeština')).toBeInTheDocument();
    expect(within(menu).getByText('Slovenčina')).toBeInTheDocument();
  });

  it('selects a locale via setLocale, persists it and closes the menu', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Čeština' }));

    expect(localStorage.getItem('elowen-locale')).toBe('cs');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on outside click', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper>
        <div>
          <LanguageSwitcher />
          <button>outside</button>
        </div>
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Language/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  // The collapsed button is what the top bar renders on a phone. It used to also move the menu
  // sideways and bottom-align it (a leftover from a sidebar-footer mount that no longer exists),
  // which pushed the menu off the right edge of a phone screen — the language became unreachable.
  it('drops the menu below the button even when collapsed, never sideways', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher collapsed /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('top-full');
    expect(menu.className).toContain('right-0');
    expect(menu.className).not.toContain('left-full');
    expect(menu.className).not.toContain('right-full');
  });

  it('positions the menu the same way when not collapsed', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('top-full');
    expect(menu.className).toContain('right-0');
  });
});
