import test from 'node:test';
import assert from 'node:assert/strict';
import { cardMarkdown } from './card-markdown.mjs';

test('renders local screenshot destinations as readable file references', () => {
  const source = '验收截图\n![手机端](D:/project/.tmp/acceptance/screenshot.png)\n\n**验证通过**';
  const rendered = cardMarkdown(source);
  assert.ok(!rendered.includes('!['));
  assert.ok(rendered.includes('D:/project/.tmp/acceptance/screenshot.png'));
  assert.ok(rendered.includes('手机端'));
  assert.ok(rendered.includes('**验证通过**'));
  assert.equal(cardMarkdown(rendered), rendered);
});

test('handles escaped destinations, references, spaces, and parentheses without invalid images', () => {
  for (const image of [
    '![截图](C:/My Project/capture (1).png)',
    '![截图](https://example.com/capture.png)',
    '![截图][capture]\n\n[capture]: D:/project/screenshot.png',
    '![截图](file:///D:/project/screenshot.png)',
  ]) assert.ok(!cardMarkdown(image).includes('!['));
});

test('preserves Markdown image syntax when it is shown as code', () => {
  const inline = '`![截图](D:/capture.png)`';
  const fenced = '```markdown\n![截图](D:/capture.png)\n```';
  assert.equal(cardMarkdown(inline), inline);
  assert.equal(cardMarkdown(fenced), fenced);
});
