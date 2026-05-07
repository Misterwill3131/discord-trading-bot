import { describe, expect, test } from 'vitest';
import { parseReplyMarkdown } from './parseReply';

describe('parseReplyMarkdown', () => {
  test('strips Discord reply markdown and extracts author', () => {
    const input = '> *Replying to ZZ [message](https://discord.com/channels/1/2/3)* RPGL +34%';
    const out = parseReplyMarkdown(input);
    expect(out.replyAuthor).toBe('ZZ');
    expect(out.content).toBe('RPGL +34%');
  });

  test('handles author with multi-word name', () => {
    const input = '> *Replying to Big Z [message](https://discord.com/channels/1/2/3)* TSLA out +20%';
    const out = parseReplyMarkdown(input);
    expect(out.replyAuthor).toBe('Big Z');
    expect(out.content).toBe('TSLA out +20%');
  });

  test('returns message as-is when not a reply', () => {
    const input = '$TSLA 150 entry long';
    const out = parseReplyMarkdown(input);
    expect(out.replyAuthor).toBeNull();
    expect(out.content).toBe('$TSLA 150 entry long');
  });

  test('handles empty string gracefully', () => {
    const out = parseReplyMarkdown('');
    expect(out.replyAuthor).toBeNull();
    expect(out.content).toBe('');
  });

  test('handles content with line breaks after reply prefix', () => {
    const input = '> *Replying to ZZ [message](https://discord.com/channels/1/2/3)* line1\nline2';
    const out = parseReplyMarkdown(input);
    expect(out.replyAuthor).toBe('ZZ');
    expect(out.content).toBe('line1\nline2');
  });
});
