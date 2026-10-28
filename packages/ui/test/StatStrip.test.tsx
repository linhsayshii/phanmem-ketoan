import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatStrip } from '../src/StatStrip.js';

describe('StatStrip', () => {
  it('render các ô số liệu và hiện "Không có quyền xem" khi giá trị là null', () => {
    render(
      <StatStrip
        items={[
          { label: 'Tiền cuối tháng', value: '150.000.000 đ', testId: 'stat-cash' },
          { label: 'Phải thu', value: null, testId: 'stat-rec' },
          { label: 'Lợi nhuận lũy kế', value: '50.000.000 đ', hint: 'Đến hết tháng 10' },
        ]}
      />,
    );
    expect(screen.getByTestId('stat-cash')).toBeDefined();
    expect(screen.getByText('Tiền cuối tháng')).toBeDefined();
    expect(screen.getByText('150.000.000 đ')).toBeDefined();

    expect(screen.getByTestId('stat-rec')).toBeDefined();
    expect(screen.getByText('Phải thu')).toBeDefined();
    expect(screen.getByText('Không có quyền xem')).toBeDefined();

    expect(screen.getByText('Lợi nhuận lũy kế')).toBeDefined();
    expect(screen.getByText('Đến hết tháng 10')).toBeDefined();
  });
});
