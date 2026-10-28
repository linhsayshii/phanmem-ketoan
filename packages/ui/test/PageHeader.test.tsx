import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader, Toolbar } from '../src/PageHeader.js';

describe('PageHeader và Toolbar', () => {
  it('title render trong thẻ h1 duy nhất có lớp kt-page-title', () => {
    const { container } = render(
      <PageHeader
        title="Tổng quan"
        description="Số liệu kế toán"
        extra={<button type="button">Thao tác</button>}
      >
        <Toolbar>
          <span>Bộ lọc</span>
        </Toolbar>
      </PageHeader>,
    );
    const headings = container.querySelectorAll('h1');
    expect(headings.length).toBe(1);
    expect(headings[0]?.textContent).toBe('Tổng quan');
    expect(headings[0]?.classList.contains('kt-page-title')).toBe(true);
    expect(screen.getByText('Số liệu kế toán')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Thao tác' })).toBeDefined();
    expect(screen.getByText('Bộ lọc')).toBeDefined();
  });

  it('tags nằm ngoài h1, h1 vẫn duy nhất', () => {
    const { container } = render(<PageHeader title="Phiếu thu PT0001" tags={<span>Nháp</span>} />);
    expect(container.querySelectorAll('h1').length).toBe(1);
    expect(container.querySelector('h1')?.textContent).toBe('Phiếu thu PT0001');
    expect(screen.getByText('Nháp')).toBeDefined();
  });

  it('gốc luôn có lớp kt-page-header, giữ thêm className truyền vào', () => {
    const { container } = render(<PageHeader title="A" className="x" />);
    expect(container.querySelector('header')?.className).toBe('kt-page-header x');
    const { container: c2 } = render(<PageHeader title="B" />);
    expect(c2.querySelector('header')?.className).toBe('kt-page-header');
  });

  it('Toolbar gom các control con với kiểu flex', () => {
    const { container } = render(
      <Toolbar>
        <button type="button">Nút 1</button>
        <button type="button">Nút 2</button>
      </Toolbar>,
    );
    const tb = container.querySelector('.kt-toolbar');
    expect(tb).toBeDefined();
    expect(screen.getByRole('button', { name: 'Nút 1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Nút 2' })).toBeDefined();
  });
});
