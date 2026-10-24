/**
 * A doc as Markdown, for "Download as Markdown": headings, paragraphs with
 * their marks, lists (nested, numbered, to-dos), quotes, code, rules, tables
 * (GitHub's pipe tables). An image is named by its alt text (its bytes stay in
 * the folder); a card of another item by its title.
 */
import type { DocMark, DocNode } from '@sign/folders/types.js';

const escapeText = (s: string): string => s.replace(/([\\`*_[\]#<>|~])/g, '\\$1');

function marked(n: DocNode): string {
  let t = n.text ?? '';
  const marks = n.marks ?? [];
  const has = (type: string) => marks.some((m) => m.type === type);
  if (has('code')) return `\`${t.replace(/`/g, '\\`')}\``;
  t = escapeText(t);
  if (has('bold')) t = `**${t}**`;
  if (has('italic')) t = `*${t}*`;
  if (has('strike')) t = `~~${t}~~`;
  const link = marks.find((m): m is DocMark & { attrs: { href: string } } => m.type === 'link' && typeof m.attrs?.href === 'string');
  if (link) t = `[${t}](${link.attrs.href.replace(/[()\s]/g, encodeURIComponent)})`;
  return t;
}

function inline(n: DocNode): string {
  return (n.content ?? []).map((c) => (c.type === 'text' ? marked(c) : c.type === 'hardBreak' ? '  \n' : '')).join('');
}

export function docToMarkdown(doc: DocNode, titleOf: (id: string) => string | null = () => null): string {
  const out: string[] = [];
  const block = (n: DocNode, indent = ''): string[] => {
    switch (n.type) {
      case 'paragraph':
        return [indent + inline(n)];
      case 'heading':
        return [`${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inline(n)}`];
      case 'blockquote':
        return (n.content ?? []).flatMap((c) => block(c)).map((l) => `> ${l}`);
      case 'codeBlock':
        return ['```' + String(n.attrs?.language ?? ''), (n.content ?? []).map((c) => c.text ?? '').join(''), '```'];
      case 'horizontalRule':
        return ['---'];
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        const lines: string[] = [];
        let k = Number(n.attrs?.start ?? 1);
        for (const li of n.content ?? []) {
          const mark = n.type === 'orderedList' ? `${k++}.` : n.type === 'taskList' ? `- [${li.attrs?.checked ? 'x' : ' '}]` : '-';
          const kids = li.content ?? [];
          kids.forEach((c, i) => {
            if (c.type === 'bulletList' || c.type === 'orderedList' || c.type === 'taskList') lines.push(...block(c, `${indent}  `));
            else {
              const text = block(c).join('\n');
              lines.push(i === 0 ? `${indent}${mark} ${text}` : `${indent}  ${text}`);
            }
          });
          if (!kids.length) lines.push(`${indent}${mark}`);
        }
        return lines;
      }
      case 'table': {
        const rows = (n.content ?? []).map((r) => (r.content ?? []).map((cell) => (cell.content ?? []).map(inline).join(' ').replace(/\|/g, '\\|')));
        if (!rows.length) return [];
        const width = Math.max(...rows.map((r) => r.length));
        const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
        return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)];
      }
      case 'image':
        return [`*[image${n.attrs?.alt ? `: ${escapeText(String(n.attrs.alt))}` : ''}]*`];
      case 'itemRef': {
        const t = titleOf(String(n.attrs?.id ?? ''));
        return [`*[${t ? escapeText(t) : 'an item'}]*`];
      }
      default:
        return [];
    }
  };
  for (const n of doc.content ?? []) {
    const lines = block(n);
    if (lines.length) out.push(lines.join('\n'));
  }
  return out.join('\n\n') + '\n';
}
