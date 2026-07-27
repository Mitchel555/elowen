import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResizeHandle } from '../../../components/ui/ResizeHandle';

describe('ResizeHandle', () => {
  it('emits the pointer delta along the drag axis (vertical → dx)', () => {
    const onDelta = vi.fn();
    const onEnd = vi.fn();
    render(<ResizeHandle orientation="vertical" onDelta={onDelta} onEnd={onEnd} />);
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, clientY: 0, pointerId: 1 });
    expect(onDelta).toHaveBeenCalledWith(30);
    fireEvent.pointerUp(handle, { clientX: 130, clientY: 0, pointerId: 1 });
    expect(onEnd).toHaveBeenCalled();
  });

  it('emits dy for a horizontal handle and ignores moves before a pointerDown', () => {
    const onDelta = vi.fn();
    render(<ResizeHandle orientation="horizontal" onDelta={onDelta} />);
    const handle = screen.getByRole('separator');
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 50, pointerId: 1 }); // not dragging yet
    expect(onDelta).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 70, pointerId: 1 });
    expect(onDelta).toHaveBeenCalledWith(20);
  });

  it('stays out of the tab order and unlabelled when no range is given', () => {
    render(<ResizeHandle orientation="vertical" onDelta={vi.fn()} />);
    const handle = screen.getByRole('separator');
    expect(handle).not.toHaveAttribute('tabindex');
    expect(handle).not.toHaveAttribute('aria-valuenow');
  });

  it('exposes the range and moves on the arrow keys when labelled', () => {
    const onDelta = vi.fn();
    render(
      <ResizeHandle orientation="vertical" onDelta={onDelta} label="Width" value={300} min={240} max={560} step={16} />,
    );
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-label', 'Width');
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    expect(handle).toHaveAttribute('aria-valuemin', '240');
    expect(handle).toHaveAttribute('aria-valuemax', '560');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onDelta).toHaveBeenCalledWith(-16);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onDelta).toHaveBeenCalledWith(16);
    onDelta.mockClear();
    fireEvent.keyDown(handle, { key: 'ArrowUp' }); // wrong axis for a vertical divider
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('uses the vertical arrows for a horizontal divider', () => {
    const onDelta = vi.fn();
    render(<ResizeHandle orientation="horizontal" onDelta={onDelta} label="Height" value={200} min={100} max={400} step={10} />);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onDelta).toHaveBeenCalledWith(-10);
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onDelta).toHaveBeenCalledWith(10);
  });

  it('resets on a double click when a reset is offered', () => {
    const onReset = vi.fn();
    render(<ResizeHandle orientation="vertical" onDelta={vi.fn()} onReset={onReset} label="Width" value={300} min={240} max={560} />);
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onReset).toHaveBeenCalled();
  });
});
