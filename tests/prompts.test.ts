/**
 * Prompt-regression guards. These lock in the load-bearing instructions that
 * fix real production bugs — if a prompt edit drops one, a test fails and
 * names the bug it would reintroduce.
 */
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, IMAGE_OCR_INSTRUCTION, buildLabelPrompt } from '@/lib/ai';

describe('SYSTEM_PROMPT', () => {
  it('excludes all beverages (drinks-in-results bug)', () => {
    expect(SYSTEM_PROMPT).toMatch(/EXCLUDE.*beverages/i);
  });

  it('states that menus are written text, not food photos', () => {
    expect(SYSTEM_PROMPT).toMatch(/WRITTEN TEXT/);
    expect(SYSTEM_PROMPT).toMatch(/decoration, not menu content/i);
  });

  it('forbids inventing dishes not present in the source', () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER invent, guess, or infer/i);
  });

  it('excludes section headers as dish names (header-items bug)', () => {
    expect(SYSTEM_PROMPT).toMatch(/section headers used as dish names/i);
  });
});

describe('IMAGE_OCR_INSTRUCTION (food-photo hallucination bug)', () => {
  it('reads only text written in the image', () => {
    expect(IMAGE_OCR_INSTRUCTION).toMatch(/ONLY the text visibly written/i);
    expect(IMAGE_OCR_INSTRUCTION).toMatch(/OCR/);
  });

  it('forbids inferring dishes from food photography', () => {
    expect(IMAGE_OCR_INSTRUCTION).toMatch(/NEVER infer or invent dishes from photographs/i);
  });

  it('returns empty sections when no menu text is readable', () => {
    expect(IMAGE_OCR_INSTRUCTION).toMatch(/return \{"sections": \[\]\}/);
  });
});

describe('buildLabelPrompt (incoherent picker bug)', () => {
  const prompt = buildLabelPrompt(
    [
      { ref: 'pdf|https://x.ie/dinner.pdf', hint: 'dinner', type: 'pdf', url: 'https://x.ie/dinner.pdf' },
      { ref: 'subpage|https://x.ie/menu', hint: 'menu', type: 'subpage', url: 'https://x.ie/menu' },
    ],
    'Test Restaurant'
  );

  it('forbids meta-labels like "Menu images"', () => {
    expect(prompt).toMatch(/NEVER use meta-labels/i);
    expect(prompt).toMatch(/Menu images/);
  });

  it('asks for isDrinkOnly (wine-list-in-picker bug)', () => {
    expect(prompt).toMatch(/isDrinkOnly/);
  });

  it('asks for duplicateOf (same menu in two formats)', () => {
    expect(prompt).toMatch(/duplicateOf/);
  });

  it('includes candidate URLs so the labeler can use slugs', () => {
    expect(prompt).toContain('https://x.ie/dinner.pdf');
  });

  it('treats online-ordering pages as menus (Notions-class sites)', () => {
    expect(prompt).toMatch(/online-ordering pages[\s\S]*ARE menus/i);
  });
});
