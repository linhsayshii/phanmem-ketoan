import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Section } from '../src/Section.js';

describe('Section', () => {
  it('render tiêu đề, extra, nội dung con và data-testid', () => {
    render(
      <Section
        title="Việc cần làm"
        extra={<a href="/xem">Xem tất cả</a>}
        testId="section-todo"
      >
        <div>Nội dung kiểm tra</div>
      </Section>,
    );
    expect(screen.getByTestId('section-todo')).toBeDefined();
    expect(screen.getByText('Việc cần làm')).toBeDefined();
    expect(screen.getByText('Xem tất cả')).toBeDefined();
    expect(screen.getByText('Nội dung kiểm tra')).toBeDefined();
  });
});
